// loop.ts — 一次 tick 的编排。**不等子进程结束**：
// 起进程即返回，完成回调里写台账/排重试。长任务因此不会阻塞投递 loop。
//
// 并发上限的判据是**在跑集合**（`running`，按 scheduleId 去重）：
//   claim（两种触发）已在 SQL 层保证「同排班同时只有一条 running 行」，
//   所以这里只管本进程还能再起几个子进程，不再重复查库。
import type { Pool } from 'pg'
import { nextRunAt } from './cron'
import { JOB_REGISTRY, seedSchedules, type JobDef } from './registry'
import { defaultSpawn, type SpawnFn } from './runner'
import { executeJob, type JobEventInput } from './execute'
import {
  beat, claimDue, claimQueuedManual, countRunning, finishRun, isDraining, reapQueued, reapStale,
  scheduleRetry, type ClaimedJob,
} from './store'

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
      await beat(deps.pool, t, instanceId)
      stats.reaped = await reapStale(deps.pool, t)
      stats.reaped += await reapQueued(deps.pool, t)

      // 部署排空（#2567）：CI 在触发数据单元部署前写 `scheduler_control(key='drain')`，构建期间
      // 这里**不再 claim**——否则新起的 hourly/审计会在容器重启时被砍成 0s timeout（容器侧优雅停机
      // 指望不上：docker 的宽限期由部署方定，实测 openship 只等 10s 就 SIGKILL）。
      // 心跳/对账照跑（上面那两行）：排空不是停摆，台账仍要新鲜。
      if (await isDraining(deps.pool, t)) {
        stats.draining = true
        return stats
      }

      // 并发判据：本地模式看进程内在跑；派发模式看 DB 的 running 行（进程内 Set 恒空）。
      const inFlight = deps.dispatch ? await countRunning(deps.pool, keys) : running.size
      const free = Math.max(0, max - inFlight)
      if (free === 0) return stats
      const manual = await claimQueuedManual(deps.pool, free, t, { runnerId: instanceId, keys })
      // claimQueuedManual 已把行置 running 并带回 runId，这里直接起进程。
      for (const job of manual) { void runOne(job, true); stats.started += 1 }
      stats.claimed += manual.length

      // runOne 在首个 await 前已 running.add ⇒ 这里直接按 running.size 算，别再扣 manual.length（那是双重扣减）。
      const room = Math.max(0, max - (deps.dispatch ? await countRunning(deps.pool, keys) : running.size))
      if (room === 0) return stats
      const due = await claimDue(deps.pool, room, t, nextRunAt, { runnerId: instanceId, keys })
      stats.claimed += due.length
      // claim 的 SELECT 已排除「同 schedule 有 running」的排班（该格不消费、下一拍再来），
      // 这里无需再查 hasRunning、也不写 skipped 台账（否则每拍刷一行）。
      for (const job of due) { void runOne(job, false); stats.started += 1 }
      return stats
    },
  }
}
