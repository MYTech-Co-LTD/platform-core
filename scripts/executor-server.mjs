#!/usr/bin/env node
// executor-server.mjs — 独立执行器（#2574 方案 A：派发 / 执行拆分）。
//
// 为什么要有它：调度器容器同时承担「派发」和「跑作业」两件事，任何一次发版都会重建容器，
// 把在跑的 dbt 作业一起带走（2026-11-20 一天三次，全是 dur=0s）。拆开后：
//   · 派发器（scheduler）随时可重启——它容器里没有作业子进程；
//   · 执行器（本进程）只在「执行时读的东西」（dbt/scripts/镜像）变更时才重建，且可先排空再重建。
//
// 安全边界（重要）：请求体只带 **runId + 排班元数据**；脚本/参数/环境一律由本进程**自己的
// JOB_REGISTRY** 解析——调用方传什么 key 就只能跑那个已登记的作业，不是「任意命令执行」。
// 另加 `EXECUTOR_TOKEN`（Bearer）做最基本的服务间鉴权；缺失即拒绝启动（fail-closed）。
//
// 台账语义与拆分前逐字一致：终态一次 finishRun、重试记账、事件 fail-open ——全部复用
// apps/server/src/scheduler/execute.ts 的同一份实现。
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { JOB_REGISTRY } from '../apps/server/src/scheduler/registry.ts'
import { executeJob } from '../apps/server/src/scheduler/execute.ts'
import { reapLostRunners } from '../apps/server/src/scheduler/store.ts'
import { enqueueEvent } from '../modules/notify/storage.ts'

/**
 * 请求体（派发器 → 执行器）。只含排班元数据；**不含** script/args/env。
 * @param {unknown} body
 * @returns {{ok: true, job: import('../apps/server/src/scheduler/store.ts').ClaimedJob & {manual: boolean}} | {ok: false, error: string}}
 */
export function parseRunRequest(body) {
  if (body === null || typeof body !== 'object') return { ok: false, error: 'body 必须是 JSON 对象' }
  const b = /** @type {Record<string, any>} */ (body)
  /** @param {unknown} v */
  const num = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null)
  const runId = num(b.runId)
  const scheduleId = num(b.scheduleId)
  if (runId === null) return { ok: false, error: 'runId 必须是正整数' }
  if (scheduleId === null) return { ok: false, error: 'scheduleId 必须是正整数' }
  if (typeof b.key !== 'string' || b.key === '') return { ok: false, error: 'key 必填' }
  const occurrence = new Date(String(b.occurrence ?? ''))
  if (Number.isNaN(occurrence.getTime())) return { ok: false, error: 'occurrence 必须是可解析的时间' }
  return {
    ok: true,
    job: {
      runId, scheduleId, key: b.key, occurrence,
      attempt: num(b.attempt) ?? 1,
      maxAttempts: num(b.maxAttempts) ?? 1,
      timeoutMs: num(b.timeoutMs) ?? 300_000,
      params: b.params && typeof b.params === 'object' ? b.params : {},
      isRetry: Boolean(b.isRetry),
      ownerOrg: typeof b.ownerOrg === 'string' ? b.ownerOrg : null,
      ownerNamespace: typeof b.ownerNamespace === 'string' ? b.ownerNamespace : null,
      // 手动触发不参与重试槽（与拆分前 loop.ts 的语义一致）——由派发器在请求体里给。
      manual: Boolean(b.manual),
    },
  }
}

/**
 * 鉴权：`Authorization: Bearer <EXECUTOR_TOKEN>`。
 * @param {unknown} headerValue
 * @param {string} token
 */
export function authorized(headerValue, token) {
  if (!token) return false
  const got = String(headerValue ?? '')
  return got === `Bearer ${token}`
}

export async function main(env = process.env) {
  const dbUrl = env.DATABASE_URL
  if (!dbUrl) {
    console.error('executor: 缺 DATABASE_URL（从 project env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  // 服务间令牌：优先 env；否则用**两容器共享卷**里的文件（首次启动自动生成）。
  // 为什么不用「让人在 project env 里写一个密钥」：那要一层人工审批，而这里的威胁模型只是
  // 「同 compose 网络里的其它容器别乱调执行器」。共享卷令牌等价强度、零人工步骤、卷重置即轮换。
  const tokenFile = env.EXECUTOR_TOKEN_FILE ?? ''
  let token = String(env.EXECUTOR_TOKEN ?? '')
  if (token === '' && tokenFile !== '') {
    try {
      token = readFileSync(tokenFile, 'utf8').trim()
    } catch {
      token = randomBytes(32).toString('hex')
      mkdirSync(dirname(tokenFile), { recursive: true })
      writeFileSync(tokenFile, token, { mode: 0o600 })
    }
  }
  if (token === '') {
    console.error('executor: 既没有 EXECUTOR_TOKEN 也没有可用的 EXECUTOR_TOKEN_FILE（无鉴权的执行端点等于任意命令执行）')
    process.exit(2)
  }
  const port = Number(env.EXECUTOR_PORT ?? '13100')
  const maxConcurrency = Number(env.EXECUTOR_MAX_CONCURRENCY ?? env.SCHEDULER_MAX_CONCURRENCY ?? '2')
  const instanceId = env.EXECUTOR_INSTANCE_ID ?? 'executor'
  const drainMs = Number(env.WORKER_DRAIN_TIMEOUT_MS ?? '') > 0 ? Number(env.WORKER_DRAIN_TIMEOUT_MS) : 600_000

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dbUrl })
  // 池的错误监听：断连是常态，留痕即可，进程不能死（#2484 实测教训）。
  pool.on('error', /** @param {Error} err */ (err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), pgPoolError: err.message }))
  })

  // 启动对账：本实例上一次化身留下的 running 行要当场收口（与调度器同语义，只是实例 id 不同）。
  const reaped = await reapLostRunners(pool, new Date(), instanceId)
  if (reaped > 0) console.log(JSON.stringify({ ts: new Date().toISOString(), executorReapedLost: reaped }))

  // 事件发射：与 notify-worker 同构造（fail-open；execute.ts 内部已 try/catch）。
  /** @type {{ rows: Array<{ casdoor_org: string }> }} */
  const { rows: tenantRows } = await pool.query('select casdoor_org from platform.tenant order by id')
  const instanceOrg = tenantRows[0]?.casdoor_org ?? ''
  /** @param {import('../apps/server/src/scheduler/execute.ts').JobEventInput} input */
  const emit = async (input) => enqueueEvent(pool, {
    org: input.org || instanceOrg,
    eventId: input.eventId,
    eventKey: input.eventKey,
    scope: '*',
    payload: input.payload,
    producer: 'platform.executor',
  })

  const running = new Set()
  let stopping = false

  const server = createServer(/** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */ (req, res) => {
    /** @param {number} code @param {unknown} obj */
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url === '/healthz') {
      send(200, { ok: true, running: running.size, stopping })
      return
    }
    if (req.method !== 'POST' || req.url !== '/run') { send(404, { error: 'not found' }); return }
    if (!authorized(req.headers.authorization, token)) { send(401, { error: 'unauthorized' }); return }
    if (stopping) { send(503, { error: 'stopping' }); return }
    if (running.size >= maxConcurrency) { send(429, { error: 'busy' }); return }
    let raw = ''
    req.on('data', /** @param {Buffer} c */ (c) => { raw += c; if (raw.length > 64 * 1024) req.destroy() })
    req.on('end', () => {
      let body
      try { body = JSON.parse(raw) } catch { send(400, { error: 'invalid JSON' }); return }
      const parsed = parseRunRequest(body)
      if (!parsed.ok) { send(400, { error: parsed.error }); return }
      const job = parsed.job
      const def = JOB_REGISTRY.find((d) => d.key === job.key)
      if (!def) {
        // 未登记的 key：**不接受**。台账行留给派发器按「dispatch failed」收口（它知道这次派发没成）。
        send(404, { error: `unknown job key: ${job.key}` })
        return
      }
      running.add(job.runId)
      send(202, { accepted: true, runId: job.runId })
      // 起进程即返回；收尾（终态/重试/事件）在 executeJob 内完成。
      void executeJob({ pool, emit, log: (o) => console.log(JSON.stringify(o)) }, job, job.manual)
        .finally(() => running.delete(job.runId))
    })
  })

  await new Promise((resolve) => server.listen(port, '0.0.0.0', () => resolve(undefined)))
  console.log(JSON.stringify({ ts: new Date().toISOString(), executor: 'listening', port, maxConcurrency, instanceId }))

  /** @param {string} sig */
  const onStop = (sig) => {
    if (stopping) return
    stopping = true
    console.log(JSON.stringify({ ts: new Date().toISOString(), stopping: sig, inFlight: running.size }))
    const deadline = Date.now() + drainMs
    const timer = setInterval(() => {
      if (running.size === 0 || Date.now() > deadline) {
        clearInterval(timer)
        server.close(() => { pool.end().finally(() => process.exit(0)) })
      }
    }, 1000)
  }
  process.on('SIGTERM', () => onStop('SIGTERM'))
  process.on('SIGINT', () => onStop('SIGINT'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
