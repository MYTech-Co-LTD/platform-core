#!/usr/bin/env node
// scripts/notify-worker.mjs — 薄 CLI；组合根在 modules/notify/worker-deps.ts。
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runOnceCli } from '../modules/notify/worker-deps.ts'

/**
 * 停机等待：轮询 `inFlight()` 直到归零或超时，返回**仍未收尾的条数**（0 = 干净退出）。
 *
 * 为什么要它（#2567）：`docker stop` 发 SIGTERM 后只等 `stop_grace_period`（默认 10s）就 SIGKILL，
 * 而采集/物化/审计子进程动辄 20–90 分钟。父进程只要活着，容器就不会停、子进程就能跑完
 * ——所以「等」这件事必须发生在进程内。
 *
 * 抽出纯函数是为了能单测（注入时钟与 sleep，不真睡）。
 *
 * @param {{ inFlight: () => number }} sched
 * @param {number} timeoutMs
 * @param {(msg: Record<string, unknown>) => void} [log]
 * @param {{ sleepMs?: number, now?: () => number }} [opts]
 * @returns {Promise<number>}
 */
export async function drainInFlight(sched, timeoutMs, log = () => {}, opts = {}) {
  const sleepMs = opts.sleepMs ?? 2000
  const now = opts.now ?? (() => Date.now())
  const startedAt = now()
  const deadline = startedAt + Math.max(0, timeoutMs)
  let left = sched.inFlight()
  while (left > 0 && now() < deadline) {
    await new Promise((r) => setTimeout(r, sleepMs))
    left = sched.inFlight()
  }
  const waitedMs = now() - startedAt
  log(left > 0
    ? { drain: 'timeout', inFlight: left, waitedMs }
    : { drain: 'done', waitedMs })
  return left
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('notify-worker: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  // pg 的 Pool 没有 'error' 监听时，空闲连接被断开 = 未捕获异常 = **整进程退出**。
  // 2026-11-18 实测（#2484）：postgres 后端被 SIGTERM、集群 reinit ⇒ worker 崩 ⇒ 正跑的
  // data.dbt_hourly 被启动对账收成 timeout（run 6725）。断连是常态，留痕即可，进程不能死。
  // 本文件被 `typecheck:scripts`（checkJs）检查 ⇒ 回调参数需显式标类型（TS7006）。
  pool.on('error', /** @param {Error} err */ (err) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), pgPoolError: err.message }))
  })
  // scripts/ 可以读 platform schema（B1 只约束 modules/**）；module 侧只收注入
  /**
   * 平台事件在 platform.event_catalog；agent 事件在 notify.event_decl（N1 双平面）。
   * @param {string} org
   * @param {string} key
   */
  const getEventDecl = async (org, key) => {
    const platform = await pool.query(
      'select payload_schema, recipients, scope_key from platform.event_catalog where key=$1 and active',
      [key],
    )
    let r = platform.rows[0]
    let title = ''
    let description
    let defaults
    if (r === undefined) {
      const tenant = await pool.query(
        `select title, description, payload_schema, recipients, scope_key, defaults
           from notify.event_decl where org=$1 and key=$2 and status='active'`,
        [org, key],
      )
      r = tenant.rows[0]
      if (r !== undefined) {
        title = r.title
        description = r.description ?? undefined
        defaults = r.defaults ?? undefined
      }
    }
    return r
      ? {
          key, title,
          description,
          payload: r.payload_schema,
          recipients: r.recipients,
          scope: r.scope_key ? { key: r.scope_key } : undefined,
          defaults,
        }
      : null
  }
  // 权限码持有者（Casdoor 直挂 ∪ 角色展开）：宿主侧能力，缺凭据时降级为「不解析」
  // （→ 只能靠 manual literal 规则；**不静默假装没人持有**，有 warn）
  let resolveScopeHolderNames
  /** 部门 → 成员展开（缺 Casdoor 凭据时不注入 ⇒ 部门规则显式阻塞，不静默发 0 人） */
  let deptMembers
  if (process.env.CASDOOR_URL && process.env.CASDOOR_ADMIN_USER && process.env.CASDOOR_ADMIN_PWD) {
    const { createScopeHolderResolver } = await import('../apps/server/src/scope-holders.ts')
    const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
    /** @param {string} org */
    const casdoorFor = (org) => new CasdoorClient({
      origin: String(process.env.CASDOOR_URL),
      clientId: process.env.CASDOOR_CLIENT_ID ?? '',
      clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
      org,
      adminUser: String(process.env.CASDOOR_ADMIN_USER),
      adminPwd: String(process.env.CASDOOR_ADMIN_PWD),
    })
    resolveScopeHolderNames = createScopeHolderResolver(casdoorFor)
    // 部门展开（组织架构 Phase C）：平台 org 表（只读视图）+ Casdoor isForbidden 过滤。
    // 同一份 casdoorFor 工厂，语义与宿主装载期一致（缺凭据 ⇒ 不注入 ⇒ 部门规则显式阻塞）。
    const { createChannelAddressResolver } = await import('../apps/server/src/channel-address.ts')
    deptMembers = createChannelAddressResolver({ pool, casdoorFor }).resolveDeptMembers
  } else {
    console.warn('notify-worker: 缺 CASDOOR_* 凭据 ⇒ scope_holders / 部门收件人不解析（仅 manual literal 规则可用）')
  }

  // ── 业务调度 loop（Wave 6 P1）：与投递 loop 同进程、独立节拍、独立 try/catch ──
  // 不 await 子进程完成（tick 只起进程）；长任务因此不会饿死投递。
  // SCHEDULER_ENABLED=0 只停调度 loop（不 tick），投递照跑；healthz 也不因调度而红。
  //
  // 2026-11-19 起两处生产部署各跑一半（#2504）：调度在数据单元、投递在应用单元，
  // 同一个入口 + 两个角色开关。上面这条「同进程」描述只在单机未拆缝时成立。
  // `--once` 是「跑一轮投递就退出」的运维入口：**不构造调度 loop**、healthz 也不看调度。
  // 否则首拍会 claim 任务、起子进程 ref 住事件循环 ⇒ 进程不退出，
  // 且 finally 的 pool.end() 早于 finishRun ⇒ job_run 永远停在 running（挡 claim 到 reapStale）。
  const once = process.argv.includes('--once')
  const { parseSchedulerConfig, parseDeliveryEnabled, resolveWorkerRole, selectRunnableJobs, shouldRunTick } = await import('../apps/server/src/scheduler/worker-config.ts')
  const { workerHealthz } = await import('../apps/server/src/scheduler/worker-healthz.ts')
  const { JOB_REGISTRY } = await import('../apps/server/src/scheduler/registry.ts')
  const schedCfg = parseSchedulerConfig(process.env)
  // 本进程负责的作业域（#2511）：应用单元 = platform，数据单元 = data。
  // 选出来的集合同时决定三件事：seed 哪些排班、claim 哪些排班、健康面判哪些排班——
  // 三者同源，才不会出现「A 判 B 的作业该跑没跑」这类跨单元误红。
  const { runnable, blocked } = selectRunnableJobs(JOB_REGISTRY, schedCfg.groups, process.env)
  // 角色拆分（#2504）：投递 loop 与调度 loop 分处两个部署单元。
  //   应用单元（unit A）：`SCHEDULER_ENABLED=0`，只跑投递——随应用发版重建，不再打断采集/物化；
  //   数据单元（unit B）：`NOTIFY_DELIVERY_ENABLED=0`，只跑调度——不随应用部署重启。
  // 缺省两个都开，与拆分前的单进程行为逐字相同（老部署不做任何事也不会变）。
  const deliveryEnabled = parseDeliveryEnabled(process.env)
  const schedulerEnabled = !once && schedCfg.enabled
  const role = resolveWorkerRole({ once, deliveryEnabled, schedulerEnabled })
  if (!role.ok) {
    console.error(`notify-worker: ${role.error}`)
    process.exit(2)
  }
  /** @type {null | { tick: () => Promise<import('../apps/server/src/scheduler/loop.ts').TickStats>, inFlight: () => number }} */
  let scheduler = null
  // 停机闸（#2567）：docker stop 先 SIGTERM、等 `stop_grace_period` 再 SIGKILL——**默认只有 10s**。
  // 2026-11-20 实测：01:05 / 03:05 两条 hourly 都是「发版触发 → 构建 5 分钟 → 重启调度器」这个窗口
  // 里被砍成 0s timeout（`output_tail` 全空 = 进程没来得及收尾）。闸门（#2548）只挡得住**触发时**
  // 有作业在跑，「构建期间新起的那条」它看不见。这里在进程侧补一刀：收到 SIGTERM 就不再 claim
  // 新作业，等在跑的**独立子进程**自然收尾（父进程活着容器就不停），到上限才退。
  let stopping = false
  const drainEnvMs = Number(process.env.WORKER_DRAIN_TIMEOUT_MS ?? '')
  const drainMs = Number.isFinite(drainEnvMs) && drainEnvMs > 0 ? drainEnvMs : 600_000
  // 只置标志位（不在这里 await / 退出）：主循环看到 stopping 就停止 claim，走 finally 收尾。
  const onStopSignal = /** @param {string} sig */ (sig) => {
    if (stopping) return
    stopping = true
    console.log(JSON.stringify({
      ts: new Date().toISOString(), stopping: sig,
      inFlight: scheduler ? scheduler.inFlight() : 0, drainBudgetMs: drainMs,
    }))
  }
  process.on('SIGTERM', () => onStopSignal('SIGTERM'))
  process.on('SIGINT', () => onStopSignal('SIGINT'))
  /** @type {null | typeof import('../apps/server/src/scheduler/health.ts').jobHealth} */
  let jobHealthFn = null
  let lastSchedulerTick = 0
  if (schedulerEnabled) {
    const { createSchedulerLoop } = await import('../apps/server/src/scheduler/loop.ts')
    const { jobHealth } = await import('../apps/server/src/scheduler/health.ts')
    jobHealthFn = jobHealth
    // 启动对账（#2442）：容器重启会连子进程一起杀掉，上一轮的 running 行必须当场收口，
    // 否则要等 reapStale 的 2×timeout（长任务 90 分钟 ⇒ 3 小时）。
    const { reapLostRunners } = await import('../apps/server/src/scheduler/store.ts')
    const reapedLost = await reapLostRunners(pool, new Date(), schedCfg.instanceId)
    if (reapedLost > 0) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), schedulerReapedLost: reapedLost }))
    }
    // 部署排空信号（#2567）：**本容器能起来 = 上一次部署已落地** ⇒ 清掉信号、恢复 claim。
    // 只由数据单元的清（CI 只为数据单元写这个信号；应用单元清掉会把数据单元一起放行）。
    if (schedCfg.groups.includes('data')) {
      try {
        const cleared = await pool.query("delete from platform.scheduler_control where key='drain'")
        if ((cleared.rowCount ?? 0) > 0) {
          console.log(JSON.stringify({ ts: new Date().toISOString(), schedulerDrainCleared: cleared.rowCount }))
        }
      } catch (e) {
        // 42P01 = 表还没建（应用单元先起、迁移还没跑）。清不了 = 本来也没有信号，**不能因此起不来**。
        if (/** @type {{ code?: string }} */ (e).code !== '42P01') throw e
      }
    }
    // 孤儿排班（#2511）：代码里已删的 key 仍留在 job_schedule 且 enabled ⇒ 由于 claim 按 key 收口，
    // 它**不会被任何单元领取**（改造前是每个 occurrence 刷一条必然失败的台账）。这里启动时点名，
    // 让「删了代码忘了停排班」在部署日志里可见，而不是变成一条永远不跑的静默行。
    /** @type {{ rows: Array<{ key: string }> }} */
    const { rows: schedKeys } = await pool.query(
      "select key from platform.job_schedule where source='system' and enabled and deleted_at is null",
    )
    const known = new Set(JOB_REGISTRY.map((d) => d.key))
    const orphans = schedKeys.map((r) => String(r.key)).filter((k) => !known.has(k)).sort()
    if (orphans.length > 0) {
      console.error(JSON.stringify({ ts: new Date().toISOString(), schedulerError: 'orphan-schedules', keys: orphans }))
    }

    // 任务生命周期事件（W6-P4a）：与 integration.stale 同路径——直接入 outbox，不新起子进程。
    // org 取排班 owner（系统排班 owner 为空 ⇒ 本实例租户），由 loop 传入。
    const { enqueueEvent } = await import('../modules/notify/storage.ts')
    /** @type {{ rows: Array<{ casdoor_org: string }> }} */
    const { rows: tenantRows } = await pool.query('select casdoor_org from platform.tenant order by id')
    const instanceOrg = tenantRows[0]?.casdoor_org ?? ''
    // 派发模式（#2574）：配了 EXECUTOR_URL ⇒ 作业交给独立执行器，本容器不再 spawn。
    // 这样本容器（派发器）重建时，在跑的作业留在执行器里，完全不受影响。
    const executorUrl = String(process.env.EXECUTOR_URL ?? '').trim().replace(/\/+$/, '')
    // 令牌与执行器同源：env 优先，否则读**两容器共享卷**里的文件（执行器首次启动自动生成）。
    // 每次派发都读一次：卷里的小文件，代价可忽略；换成缓存反而要处理轮换。
    const executorTokenFile = String(process.env.EXECUTOR_TOKEN_FILE ?? '')
    const readExecutorToken = () => {
      if (String(process.env.EXECUTOR_TOKEN ?? '') !== '') return String(process.env.EXECUTOR_TOKEN)
      if (executorTokenFile === '') return ''
      try { return readFileSync(executorTokenFile, 'utf8').trim() } catch { return '' }
    }
    /** @type {undefined | ((job: import('../apps/server/src/scheduler/store.ts').ClaimedJob, manual: boolean) => Promise<void>)} */
    const dispatch = executorUrl === '' ? undefined : async (job, manual) => {
      const res = await fetch(`${executorUrl}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${readExecutorToken()}` },
        body: JSON.stringify({
          runId: job.runId, scheduleId: job.scheduleId, key: job.key,
          occurrence: job.occurrence.toISOString(), attempt: job.attempt,
          maxAttempts: job.maxAttempts, timeoutMs: job.timeoutMs,
          params: job.params, isRetry: job.isRetry,
          ownerOrg: job.ownerOrg, ownerNamespace: job.ownerNamespace, manual,
        }),
      })
      if (res.status !== 202) {
        const text = await res.text().catch(() => '')
        throw new Error(`executor ${res.status} ${text.slice(0, 200)}`)
      }
    }
    if (dispatch) {
      console.log(JSON.stringify({ ts: new Date().toISOString(), schedulerMode: 'dispatch', executorUrl }))
    }
    scheduler = createSchedulerLoop({
      pool, cwd: process.cwd(), maxConcurrency: schedCfg.maxConcurrency,
      registry: runnable, instanceId: schedCfg.instanceId, dispatch,
      emit: async (input) => enqueueEvent(pool, {
        org: input.org || instanceOrg,
        eventId: input.eventId,
        eventKey: input.eventKey,
        scope: '*',
        payload: input.payload,
        producer: 'platform.scheduler',
      }),
    })
    for (const b of blocked) {
      // 缺 env ⇒ 该作业不进 claim 集合（健康面同时报红）。显式打一行，便于 `docker logs` 直接取证。
      console.error(JSON.stringify({ ts: new Date().toISOString(), job: b.key, error: 'missing env, not scheduled', missing: b.missing }))
    }
    console.log(JSON.stringify({
      ts: new Date().toISOString(), scheduler: 'enabled', tickMs: schedCfg.tickMs,
      instance: schedCfg.instanceId, groups: schedCfg.groups,
      jobs: runnable.length, blocked: blocked.length,
    }))
  } else {
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      scheduler: once ? 'skipped(--once)' : 'disabled',
      delivery: deliveryEnabled,
    }))
  }

  // 健康端点：镜像的 HEALTHCHECK 打 `127.0.0.1:${PORT:-13000}/healthz`（与 server 同镜像继承），
  // worker 本无 HTTP 面 ⇒ 恒 unhealthy（2026-10-27 生产实测 Up 26m (unhealthy)）。
  // 这里起一个**只读**的极简端点，回答「worker 进程还活着 + 心跳新鲜」。
  // 端口用 WORKER_HEALTH_PORT（缺省 13000，与镜像 HEALTHCHECK 的 ${PORT:-13000} 对齐）；
  // 只绑回环，不对外暴露。
  // 端口回退（含空串兜底）在 worker-config.ts 的 parseSchedulerConfig 里，已有纯函数用例。
  const healthPort = schedCfg.healthPort
  const { createServer } = await import('node:http')
  const healthServer = createServer(async (req, res) => {
    if (req.url !== '/healthz') { res.writeHead(404); res.end('not found'); return }
    try {
      const { rows } = await pool.query(
        "select 1 from notify.worker_heartbeat where beat_at > now()-interval '2 minutes'")
      // 判定是纯函数（worker-healthz.ts）：调度关闭时不看 jobHealth；
      // 开着就必须求值（求值抛错走 catch ⇒ 503，不假绿）。
      // 排空期要告诉健康判据（#2574）：否则「有意不跑」会被判成「该跑没跑」⇒ 503 ⇒ 容器 unhealthy。
      const { isDraining } = await import('../apps/server/src/scheduler/store.ts')
      const draining = schedulerEnabled ? await isDraining(pool, new Date()).catch(() => false) : false
      const schedulerHealth = schedulerEnabled && jobHealthFn
        ? await jobHealthFn(pool, new Date(), {
            instanceId: schedCfg.instanceId, keys: runnable.map((d) => d.key), draining,
          })
        : null
      const h = workerHealthz({
        notifyFresh: rows.length > 0,
        deliveryEnabled,
        schedulerEnabled,
        jobHealth: schedulerHealth,
        blockedJobs: blocked,
      })
      res.writeHead(h.status, { 'content-type': 'text/plain' })
      res.end(h.body)
    } catch (e) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end(e instanceof Error ? e.message : String(e))
    }
  })
  healthServer.listen(healthPort, '127.0.0.1', () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), health: `127.0.0.1:${healthPort}/healthz` }))
  })

  /**
   * 集成健康 STALE → 事件入队（spec 2026-10-31-integration-health-design.md §2.4）。
   *
   * 为什么在脚本里而不是模块里：装填位在 `platform.integration`，**模块不许读 platform schema**
   * （B1）；`scripts/` 没有这条限制（与 `notify-seed-builtin.mjs` 同款）。
   *
   * 语义 = **至少一次**：入队成功才落 `stale_notified=true`；worker 恰好死在两步之间，
   * 下一轮用同一个 event_id 重入队（`notify.event` 主键去重）⇒ 不双发、不丢。
   */
  const drainStaleAlerts = async () => {
    const { rows } = await pool.query(
      `select id, org, kind, sla_seconds, coalesce(last_error, '') as last_error
         from platform.integration
        where stale_notified = false
        order by id`,
    )
    if (rows.length === 0) return 0
    const { enqueueEvent } = await import('../modules/notify/storage.ts')
    // 装填位是租户无关的（org 常为空串）：本实例的租户从 platform.tenant 取，
    // 事件按租户入队（通知模型是租户级的），单租户实例就是一行。
    // ⚠️ 本文件被 `typecheck:scripts`（checkJs）检查：`pool.query` 返回 `any`，
    //    map 回调参数必须显式标类型（TS7006），否则 gates 的 typecheck 步红。
    /** @type {{ rows: Array<{ casdoor_org: string }> }} */
    const { rows: tenants } = await pool.query('select casdoor_org from platform.tenant order by id')
    const orgs = tenants.map((t) => t.casdoor_org)
    let sent = 0
    for (const r of rows) {
      // 租户维度：集成行带 org 就只发给它；否则发给本实例全部租户
      const targets = r.org ? [r.org] : orgs
      for (const org of targets) {
        await enqueueEvent(pool, {
          org,
          // 确定性 event_id：同一集成同一次「进入 STALE」只入队一次（撞键即去重）
          eventId: `integration-stale:${r.id}:${r.last_error || 'no-error'}`,
          eventKey: 'notify.integration.stale',
          scope: r.id,
          payload: {
            integrationId: r.id,
            integrationKind: r.kind,
            reason: r.last_error || '超过允许静默时长没有活性证据',
            slaSeconds: Number(r.sla_seconds),
          },
          producer: 'integration-probe',
        })
        sent += 1
      }
      // 入队成功才落标志位（尤其一次：worker 死在两步之间，下一轮 event_id 去重兜底）
      await pool.query('update platform.integration set stale_notified = true where id = $1 and org = $2',
        [r.id, r.org])
    }
    return sent
  }

  try {
    do {
      if (stopping) break
      // 调度 loop 与本拍投递**顺序串行**：tick 只起子进程即返回（不 await 子进程），
      // 但这里仍 await tick 本身 ⇒ 不会叠加并发 tick（本进程单节拍）。
      if (scheduler && shouldRunTick(Date.now(), lastSchedulerTick, schedCfg.tickMs)) {
        lastSchedulerTick = Date.now()
        try {
          const stats = await scheduler.tick()
          if (stats.claimed > 0 || stats.reaped > 0) {
            console.log(JSON.stringify({ ts: new Date().toISOString(), schedulerTick: stats }))
          }
        } catch (e) {
          // 调度一拍失败不能拖垮投递（各自 try/catch），但必须留痕。
          console.error('scheduler tick 失败:', e instanceof Error ? e.message : e)
        }
      }
      // 投递 loop（outbox 轮询 + 集成 STALE 入队）：调度专用容器整段跳过——
      // 投递由应用单元的 worker 独占，两个进程同时轮询只会放大租约竞争。
      if (deliveryEnabled) {
        try {
          const s = await runOnceCli(pool, getEventDecl, process.env, resolveScopeHolderNames, deptMembers)
          const staleQueued = await drainStaleAlerts()
          console.log(JSON.stringify({ ts: new Date().toISOString(), ...s, staleQueued }))
        } catch (e) {
          console.error('notify-worker 本轮投递失败:', e instanceof Error ? e.message : e)
          if (once) process.exitCode = 1
        }
      }
      if (once) break
      await new Promise((r) => setTimeout(r, 2000))
    } while (true)
    // 停机收尾（#2567）：先不 claim 新作业（上面 `if (stopping) break`），再等在跑的子进程自然收尾。
    // 已在跑的 dbt 审计是**独立子进程**，只要父进程活着、容器就不停 ⇒ 它们能跑完。
    // 有上限：到点没跑完就照常退出（docker 退到 stop_grace_period 再 SIGKILL，与改动前同）。
    if (stopping && scheduler) {
      await drainInFlight(scheduler, drainMs, (msg) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...msg })))
    }
  } finally {
    healthServer.close()
    await pool.end()
  }
}
