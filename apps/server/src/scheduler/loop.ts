// loop.ts — 一次 tick 的编排。**不等子进程结束**：
// 起进程即返回，完成回调里写台账/排重试。长任务因此不会阻塞投递 loop。
//
// 并发上限的判据是**在跑集合**（`running`，按 scheduleId 去重）：
//   claim（两种触发）已在 SQL 层保证「同排班同时只有一条 running 行」，
//   所以这里只管本进程还能再起几个子进程，不再重复查库。
import type { Pool } from 'pg'
import { nextRunAt } from './cron'
import { JOB_REGISTRY, fillNextRunAt, seedSchedules, type JobDef } from './registry'
import { defaultSpawn, type SpawnFn } from './runner'
import { executeJob, type JobEventInput } from './execute'
import {
  beat, claimDue, claimQueuedManual, countRunning, finishRun, hasDueSoon, isDraining, reapQueued, reapStale,
  scheduleRetry, type ClaimedJob,
} from './store'

/**
 * 实时车道的留槽窗口（B2）：到期前 90 秒起，批量车道不得占用最后一个槽。
 * 为什么是 90 秒：调度拍 30 秒 + 派发/领取抖动（实测 p50 46s）留一倍余量；再长会让批量车道
 * 每小时被挡 1.5 分钟 × 6 拍，而 10m 车道本身只占 6% 的槽时。
 */
export const REALTIME_RESERVE_WINDOW_MS = 90_000

export interface SchedulerDeps {
  pool: Pool
  registry?: JobDef[]
  spawn?: SpawnFn
  now?: () => Date
  maxConcurrency?: number
  log?: (o: unknown) => void
  /** 子进程工作目录；生产 = `/app`。 */
  cwd?: string
  /**
   * 本进程的实例标识（#2511）：写进 `job_run.runner_id` 与 `job_heartbeat.id`，
   * 启动对账只收自己这个 id 的 running 行。缺省读 `SCHEDULER_INSTANCE_ID`，再缺省 'scheduler'。
   */
  instanceId?: string
  /**
   * 任务生命周期事件发射器（宿主注入；生产由 `scripts/notify-worker.mjs` 用 notify 的 enqueueEvent 构造）。
   * **fail-open**：它抛错不得影响 run 终态、重试决策或日志——见 `emitJobEvents`。
   */
  emit?: (input: JobEventInput) => Promise<unknown>
  /**
   * 派发模式（#2574）：把作业交给**独立执行器**，本地不 spawn。
   * 给了它就完全走这条路径：并发闸门改用 DB 计数（`countRunning`），进程内 Set 只服务本地模式。
   * 解析（成功/失败）即「派发结果」；执行结果由执行器写台账。
   */
  dispatch?: (job: ClaimedJob, manual: boolean) => Promise<void>
}

export interface TickStats {
  claimed: number
  started: number
  reaped: number
  /** 本拍因「部署排空信号」而没有 claim（#2567）。只有为 true 时才算「有意不跑」。 */
  draining?: boolean
}

/** 并发上限必须是**正整数**：`Number('') === 0` 会把调度静默停掉，`NaN` 会让 claimDue 的 limit 报库错。 */
function positiveInt(v: unknown, label: string): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`${label} 必须是正整数（当前 ${JSON.stringify(v)}）`)
  }
  return n
}

export function createSchedulerLoop(deps: SchedulerDeps) {
  const registry = deps.registry ?? JOB_REGISTRY
  const spawn = deps.spawn ?? defaultSpawn
  const now = deps.now ?? (() => new Date())
  const max = deps.maxConcurrency === undefined
    ? positiveInt(process.env.SCHEDULER_MAX_CONCURRENCY ?? '2', 'SCHEDULER_MAX_CONCURRENCY')
    : positiveInt(deps.maxConcurrency, 'maxConcurrency')
  const log = deps.log ?? ((o: unknown) => console.log(JSON.stringify(o)))
  const cwd = deps.cwd ?? process.cwd()
  const instanceId = deps.instanceId ?? process.env.SCHEDULER_INSTANCE_ID ?? 'scheduler'
  // claim 的作用域 = 本进程 registry 的 key 集合：**不属于我的作业，连碰都不碰**。
  // 这是两个部署单元能并存的结构性保证（不是靠两个进程「自觉」）。
  const keys = registry.map((d) => d.key)
  const running = new Set<number>()
  let seeded = false

  /** manual=true：手动触发的运行**不参与重试**（重试槽属于排班侧，手动成功不许清掉排班待跑的重试）。 */
  const runOne = async (job: ClaimedJob, manual: boolean): Promise<void> => {
    if (deps.dispatch) {
      // 派发模式：把作业交给执行器，**本地不 spawn**。派发失败要当场收口成 failed，
      // 否则这行会一直卡 running（执行器从没收到，没人会写终态）。
      try {
        await deps.dispatch(job, manual)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        await finishRun(deps.pool, job.runId, { status: 'failed', error: `dispatch failed: ${msg}` }).catch(() => {})
        if (!manual && job.attempt < job.maxAttempts) {
          await scheduleRetry(deps.pool, job.scheduleId, job.occurrence, job.attempt, new Date(now().getTime() + 60_000)).catch(() => {})
        }
        log({ ts: now().toISOString(), job: job.key, error: `dispatch failed: ${msg}` })
      }
      return
    }
    running.add(job.scheduleId)
    try {
      // 执行与收尾的全部语义（终态/重试/事件）在 execute.ts 里，与独立执行器共用同一份实现（#2574）。
      await executeJob({
        pool: deps.pool, registry, spawn, now, cwd, log, emit: deps.emit,
      }, job, manual)
    } finally {
      running.delete(job.scheduleId)
    }
  }

  return {
    inFlight: () => running.size,
    async tick(): Promise<TickStats> {
      const t = now()
      const stats: TickStats = { claimed: 0, started: 0, reaped: 0 }
      if (!seeded) { await seedSchedules(deps.pool, registry, t); seeded = true }
      // 补算 `next_run_at` **每拍都做**（#2598）：切流的最后一步是人工在 DB 置 `enabled=true`，
      // 而 seed 只发生一次；只在首拍补算 ⇒ 那条排班永远不到期，且健康面无红灯（不是「该跑没跑」，
      // 是「从来没排上」）。正常情况 0 行。
      const filled = await fillNextRunAt(deps.pool, t)
      if (filled.length > 0) log({ ts: t.toISOString(), event: 'schedulerFilledNextRun', keys: filled })
      await beat(deps.pool, t, instanceId)
      stats.reaped = await reapStale(deps.pool, t)
      stats.reaped += await reapQueued(deps.pool, t)

      // 车道分级（B2，2026-11-25）：实时车道（`realtime: true`）到期前 90 秒，**给它留一个槽**——
      // 这一拍批量车道最多只用「空闲槽 − 1」。根因是排队而非容量：实测利用率仅 39%，却有 p90
      // 220 秒的领取迟到，因为一条 500 秒的批量作业能把两个槽都占住、让 38 秒的 tick 干等。
      const realtimeKeys = registry.filter((d) => d.realtime).map((d) => d.key)
      const batchKeys = realtimeKeys.length === 0 ? keys : keys.filter((k) => !realtimeKeys.includes(k))

      // 部署排空（#2567 / 2026-11-26 收窄）：CI 在触发数据单元部署前写 `scheduler_control(key='drain')`。
      // 原语义是**整段不 claim**——但排空覆盖的是整个构建+发布（实测 10–20 分钟），而真正的容器重启只有
      // 十几秒 ⇒ 一天 11 次部署 = **295 分钟**没有任何 tick（实测：排空窗内 tick 迟到 p90 438s、
      // 正常拍 p90 27s）。现在只拦**批量车道**（20–90 分钟的 hourly/审计，被砍代价大）；
      // 实时车道（38 秒的 tick）照常 claim——最坏情况丢一拍，远好过整段停摆。
      const draining = await isDraining(deps.pool, t)
      if (draining) {
        stats.draining = true
        if (realtimeKeys.length === 0) return stats
      }

      const reserve = await hasDueSoon(deps.pool, realtimeKeys, t, REALTIME_RESERVE_WINDOW_MS)

      /** 当前还能起几个（本地模式看进程内，派发模式看 DB——进程内 Set 在派发模式下恒空）。 */
      const freeSlots = async (): Promise<number> =>
        deps.dispatch ? Math.max(0, max - await countRunning(deps.pool, keys)) : Math.max(0, max - running.size)

      /** 批量车道可用额度：留槽期内扣掉 1 个（留槽是给**尚未领取**的实时作业的）。 */
      const batchCap = (free: number): number => (reserve ? Math.max(0, free - 1) : free)

      const startManual = async (laneKeys: string[], limit: number): Promise<number> => {
        if (limit <= 0 || laneKeys.length === 0) return 0
        const jobs = await claimQueuedManual(deps.pool, limit, t, { runnerId: instanceId, keys: laneKeys })
        // claimQueuedManual 已把行置 running 并带回 runId，这里直接起进程。
        for (const job of jobs) { void runOne(job, true); stats.started += 1 }
        stats.claimed += jobs.length
        return jobs.length
      }

      // 排空期：批量车道不 claim（不新起会被重启砍掉的长作业）；实时车道照跑。
      const activeBatchKeys = draining ? [] : batchKeys

      const free0 = await freeSlots()
      if (free0 === 0) return stats
      // 手动（人的显式动作）先领，实时车道排在批量前：留槽期批量最多 free−1。
      await startManual(realtimeKeys, free0)
      await startManual(activeBatchKeys, batchCap(await freeSlots()))

      const room = await freeSlots()
      if (room === 0) return stats
      // 到期作业同样先实时后批量；`claimDue` 的 SELECT 已排除「同 schedule 有 running」的排班
      // （该格不消费、下一拍再来），所以这里无需再查 hasRunning、也不写 skipped 台账。
      const dueRealtime = realtimeKeys.length === 0
        ? []
        : await claimDue(deps.pool, room, t, nextRunAt, { runnerId: instanceId, keys: realtimeKeys })
      stats.claimed += dueRealtime.length
      for (const job of dueRealtime) { void runOne(job, false); stats.started += 1 }

      const room2 = batchCap(await freeSlots())
      const dueBatch = room2 <= 0 || activeBatchKeys.length === 0
        ? []
        : await claimDue(deps.pool, room2, t, nextRunAt, { runnerId: instanceId, keys: activeBatchKeys })
      stats.claimed += dueBatch.length
      for (const job of dueBatch) { void runOne(job, false); stats.started += 1 }
      return stats
    },
  }
}
