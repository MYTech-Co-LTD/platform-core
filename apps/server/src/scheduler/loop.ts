// loop.ts — 一次 tick 的编排。**不等子进程结束**：
// 起进程即返回，完成回调里写台账/排重试。长任务因此不会阻塞投递 loop。
//
// 并发上限的判据是**在跑集合**（`running`，按 scheduleId 去重）：
//   claim（两种触发）已在 SQL 层保证「同排班同时只有一条 running 行」，
//   所以这里只管本进程还能再起几个子进程，不再重复查库。
import type { Pool } from 'pg'
import { nextRunAt } from './cron'
import { JOB_REGISTRY, seedSchedules, type JobDef } from './registry'
import { classify, defaultSpawn, envFor, paramsStdin, type SpawnFn } from './runner'
import {
  beat, claimDue, claimQueuedManual, clearRetry, finishRun, reapQueued, reapStale, scheduleRetry,
  type ClaimedJob, type RunOutcome,
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
   * 任务生命周期事件发射器（宿主注入；生产由 `scripts/notify-worker.mjs` 用 notify 的 enqueueEvent 构造）。
   * **fail-open**：它抛错不得影响 run 终态、重试决策或日志——见 `emitJobEvents`。
   */
  emit?: (input: {
    eventKey: string; eventId: string; org: string; payload: Record<string, unknown>
  }) => Promise<unknown>
}

/**
 * 失败/超时/死信发事件（W6-P4a）。
 *
 * 三条判据（与 health 的「连续失败 ≥3」**不是同一回事**，两者可并存）：
 *   failed  ⇒ jobs.job.failed（每次失败都发）
 *   timeout ⇒ jobs.job.timeout
 *   尝试耗尽（attempt >= maxAttempts）⇒ 追加 jobs.job.dead
 *
 * 幂等：failed/timeout 按 **runId** 去重（同一 run 重发只一行）；dead 按 **格**（scheduleId+occurrence）
 * 去重——同一格的重试链只发一条死信。
 *
 * fail-open：整段 try/catch，异常只 log；**绝不**改变 outcome、不改重试槽。
 */
async function emitJobEvents(
  deps: SchedulerDeps,
  job: ClaimedJob,
  outcome: RunOutcome,
  log: (o: unknown) => void,
): Promise<void> {
  if (!deps.emit) return
  if (outcome.status !== 'failed' && outcome.status !== 'timeout') return
  const org = job.ownerOrg ?? ''
  const payload = {
    scheduleId: String(job.scheduleId),
    key: job.key,
    runId: String(job.runId),
    exitCode: outcome.exitCode ?? null,
    error: outcome.error ?? null,
    durationMs: outcome.durationMs ?? null,
    ownerOrg: job.ownerOrg ?? null,
    ownerNamespace: job.ownerNamespace ?? null,
  }
  try {
    const kind = outcome.status === 'timeout' ? 'timeout' : 'failed'
    await deps.emit({
      eventKey: `jobs.job.${kind}`,
      eventId: `jobs.job.${kind}:${job.runId}`,
      org,
      payload,
    })
    if (job.attempt >= job.maxAttempts) {
      await deps.emit({
        eventKey: 'jobs.job.dead',
        eventId: `jobs.job.dead:${job.scheduleId}:${job.occurrence.toISOString()}`,
        org,
        payload: { ...payload, attempts: job.attempt },
      })
    }
  } catch (e) {
    // fail-open：通知入队失败不影响任何业务判定（AGENTS.md「通知不参与业务分支」）。
    log({ ts: new Date().toISOString(), job: job.key, error: `emit job events failed: ${e instanceof Error ? e.message : String(e)}` })
  }
}

export interface TickStats {
  claimed: number
  started: number
  reaped: number
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
  const running = new Set<number>()
  let seeded = false

  /** manual=true：手动触发的运行**不参与重试**（重试槽属于排班侧，手动成功不许清掉排班待跑的重试）。 */
  const runOne = async (job: ClaimedJob, manual: boolean): Promise<void> => {
    const def = registry.find((d) => d.key === job.key)
    if (!def) {
      log({ ts: now().toISOString(), job: job.key, error: 'unknown registry key' })
      // claim 已建 running 行，必须收尾，否则会一直挡住该排班的下一次 claim。
      // 代码里已删的 key 无法执行，重试也不会好 ⇒ 判 failed、不排重试。
      await finishRun(deps.pool, job.runId, { status: 'failed', error: 'unknown registry key' }).catch(() => {})
      return
    }
    running.add(job.scheduleId)
    try {
      // spawn 抛错（含同步抛，如 ENAMETOOLONG）也要落到一个终态；
      // **终态只由下面这一次 finishRun 写**（catch 分支里绝不再写，否则可能覆盖 reap 的判定）。
      let outcome: RunOutcome & { retryable?: boolean }
      try {
        const res = await spawn({
          command: 'pnpm', args: ['exec', 'tsx', def.script],
          env: envFor(job), stdin: paramsStdin(job), timeoutMs: job.timeoutMs, cwd,
        })
        outcome = classify(res)
      } catch (e) {
        // 同步抛 = 参数/环境配置错（重试同一输入不会好）⇒ retryable=false。
        outcome = { status: 'failed', error: e instanceof Error ? e.message : String(e), retryable: false }
      }
      await finishRun(deps.pool, job.runId, outcome) // 自带 where status='running'，不会覆盖 reap 的终态
      // 事件发射在终态之后、重试记账之前：两者互不依赖，但**发射必须 fail-open**。
      await emitJobEvents(deps, job, outcome, log)
      if (!manual) {
        if (outcome.status !== 'ok' && outcome.retryable && job.attempt < job.maxAttempts) {
          // 用注入的 now 算重试时间：确定性测试才能固定这个值。
          await scheduleRetry(deps.pool, job.scheduleId, job.occurrence, job.attempt, new Date(now().getTime() + 60_000))
        } else {
          await clearRetry(deps.pool, job.scheduleId)
        }
      }
      log({
        ts: now().toISOString(), job: job.key, occurrence: job.occurrence.toISOString(),
        status: outcome.status, exitCode: outcome.exitCode ?? null, durationMs: outcome.durationMs ?? null,
      })
    } catch (e) {
      // finishRun / 重试记账 / 日志自身异常：只记日志，**绝不再调 finishRun**（否则可能覆盖终态）。
      const msg = e instanceof Error ? e.message : String(e)
      log({ ts: now().toISOString(), job: job.key, error: `post-run bookkeeping failed: ${msg}` })
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
      await beat(deps.pool, t)
      stats.reaped = await reapStale(deps.pool, t)
      stats.reaped += await reapQueued(deps.pool, t)

      const free = Math.max(0, max - running.size)
      if (free === 0) return stats
      const manual = await claimQueuedManual(deps.pool, free, t)
      // claimQueuedManual 已把行置 running 并带回 runId，这里直接起进程。
      for (const job of manual) { void runOne(job, true); stats.started += 1 }
      stats.claimed += manual.length

      // runOne 在首个 await 前已 running.add ⇒ 这里直接按 running.size 算，别再扣 manual.length（那是双重扣减）。
      const room = Math.max(0, max - running.size)
      if (room === 0) return stats
      const due = await claimDue(deps.pool, room, t, nextRunAt)
      stats.claimed += due.length
      // claim 的 SELECT 已排除「同 schedule 有 running」的排班（该格不消费、下一拍再来），
      // 这里无需再查 hasRunning、也不写 skipped 台账（否则每拍刷一行）。
      for (const job of due) { void runOne(job, false); stats.started += 1 }
      return stats
    },
  }
}
