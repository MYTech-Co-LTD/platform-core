#!/usr/bin/env node
// scripts/notify-emit-job.mjs — 调度器 handler：到点把一条通知事件入队（W6-P2）。
//
// 为什么在 scripts/ 而不是通知模块里：本脚本只做「形状 + 归属」两件事，读的是**平台级**的
// 归属 env（JOB_OWNER_ORG），而模块层拿不到（也不该拿）调度器注入的进程环境。事件目录校验
// 不在这里——那属于宿主 `notify-port` 的模块面；本 handler 假设 key 已由上游按目录声明过。
//
// 参数**只从 stdin 读**一行 JSON（调度器把 JOB_PARAMS 写进 stdin）。不走 env：
// `/proc/<pid>/environ` 对同机进程可见，把业务参数写进 env 等于广播，且有长度上限。
//
// 退出码（调度器据此决定是否重试，spec §8）：
//   0 = 已入队，或同一 occurrence 的重复投递（主键幂等，`reason:'duplicate'`）——都不重试；
//   1 = DB/入队异常（可重试，调度器在 max_attempts 内重排）；
//   2 = 缺 env / params 形状非法 / 超限 / 归属判不了（**不重试**——重试不会变好）。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { enqueueEvent } from '../modules/notify/storage.ts'

/** spec §8：JOB_PARAMS ≤16KB；payload 序列化同口径。 */
const MAX_PARAMS_BYTES = 16 * 1024

/** 读尽 stdin（调度器每次都会 close 写端；job 形态下 stdin 恒为管道）。 */
async function readStdin() {
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 形状校验（不做事件目录校验）。成功返回 `{ value }`，失败返回 `{ error }`（调用方 exit 2）。
 * @param {string} raw
 * @returns {{ value?: { eventKey: string, scope: string, payload: Record<string, unknown>, eventId: string }, error?: string }}
 */
function parseParams(raw) {
  let params
  try {
    params = JSON.parse(raw)
  } catch {
    return { error: 'stdin 不是合法 JSON（JOB_PARAMS 应为一行 JSON）' }
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return { error: 'JOB_PARAMS 必须是 JSON 对象' }
  }

  const { eventKey, scope, payload, eventId } = params
  if (typeof eventKey !== 'string' || eventKey.trim() === '') {
    return { error: `eventKey 必填且非空，得到 ${JSON.stringify(eventKey)}` }
  }
  // 归一化而不是拒绝：`" report.due "` 若原样入库，规则匹配（按 event_key 精确比）永远落空，
  // 事件静默无人接收。接收方宽容——存去空白形态。
  const normalizedKey = eventKey.trim()
  if (scope !== undefined && (typeof scope !== 'string' || scope === '')) {
    return { error: `scope 必须是非空字符串，得到 ${JSON.stringify(scope)}` }
  }
  if (payload !== undefined && (typeof payload !== 'object' || payload === null || Array.isArray(payload))) {
    return { error: 'payload 必须是 JSON 对象' }
  }
  const payloadObj = /** @type {Record<string, unknown>} */ (payload ?? {})
  try {
    if (Buffer.byteLength(JSON.stringify(payloadObj), 'utf8') > MAX_PARAMS_BYTES) {
      return { error: `payload 序列化超过 ${MAX_PARAMS_BYTES} 字节` }
    }
  } catch {
    return { error: 'payload 无法序列化为 JSON' }
  }

  if (eventId !== undefined && (typeof eventId !== 'string' || eventId === '')) {
    return { error: `eventId 必须是非空字符串，得到 ${JSON.stringify(eventId)}` }
  }
  if (eventId !== undefined) {
    return { value: { eventKey: normalizedKey, scope: scope ?? '*', payload: payloadObj, eventId } }
  }

  // 缺省 eventId 必须由 occurrence 决定：重试沿用同一 occurrence ⇒ 幂等键稳定。
  // 任一缺失就不猜——拼出 `schedule:undefined:undefined` 会让幂等静默失效（每次都新事件）。
  const scheduleId = process.env.JOB_SCHEDULE_ID
  const occurrence = process.env.JOB_OCCURRENCE
  if (!scheduleId || !occurrence) {
    return { error: '缺 eventId 且缺 JOB_SCHEDULE_ID / JOB_OCCURRENCE，无法生成幂等 event_id' }
  }
  return { value: { eventKey: normalizedKey, scope: scope ?? '*', payload: payloadObj, eventId: `schedule:${scheduleId}:${occurrence}` } }
}

/** @returns {Promise<number>} 退出码 */
async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) {
    console.error('notify-emit: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    return 2
  }
  const org = process.env.JOB_OWNER_ORG
  if (!org) {
    console.error('notify-emit: 缺 JOB_OWNER_ORG（归属只来自调度器注入的身份，不从 params 读）')
    return 2
  }

  const raw = await readStdin()
  if (Buffer.byteLength(raw, 'utf8') > MAX_PARAMS_BYTES) {
    console.error(`notify-emit: JOB_PARAMS 超过 ${MAX_PARAMS_BYTES} 字节`)
    return 2
  }
  const parsed = parseParams(raw)
  if (!parsed.value) {
    console.error(`notify-emit: ${parsed.error}`)
    return 2
  }

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: dbUrl })
  try {
    const r = await enqueueEvent(pool, { org, producer: 'scheduler', ...parsed.value })
    if (r.accepted) {
      console.log(`notify-emit: org=${org} event=${parsed.value.eventId} accepted=1`)
      return 0
    }
    if (r.reason === 'duplicate') {
      // 同一 occurrence 已入队 = 上一次投递成功但台账没来得及落定；不是失败。
      console.log(`notify-emit: org=${org} event=${parsed.value.eventId} duplicate=1`)
      return 0
    }
    console.error(`notify-emit: 入队被拒 reason=${r.reason ?? 'unknown'}（不重试）`)
    return 2
  } catch (e) {
    // DB 异常才可重试：params 问题在上面已 exit 2，不会走到这里。
    console.error('notify-emit 入队失败（可重试）:', e instanceof Error ? e.message : e)
    return 1
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main()
}
