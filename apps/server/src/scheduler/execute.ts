// execute.ts — 「一条已 claim 的作业」的执行与收尾。**派发器本地模式与独立执行器共用这一份**（#2574 方案 A）。
//
// 为什么抽出来：拆分后，谁来跑作业不改变台账语义——`finishRun` 只写一次、重试记账与事件发射
// 在终态之后、fail-open。把这些留在 loop.ts 里，执行器就得复制一份，迟早漂移。
//
// 约定（与拆分前逐字一致）：
//   · registry 里查不到 key ⇒ 判 failed、**不排重试**（重试同一输入不会好）；
//   · spawn 同步抛错 ⇒ 判 failed、retryable=false；
//   · 终态**只由一次 finishRun 写**（自带 `where status='running'`，不会覆盖 reap 的判定）；
//   · 手动触发（manual=true）不参与重试槽（重试槽属于排班侧）。
import type { Pool } from 'pg'
import { JOB_REGISTRY, type JobDef } from './registry'
import { classify, defaultSpawn, envFor, paramsStdin, type SpawnFn } from './runner'
import { clearRetry, finishRun, scheduleRetry, type ClaimedJob, type RunOutcome } from './store'

/** 任务生命周期事件（W6-P4a）。执行器与派发器都把同一个 enqueueEvent 包成这个形状。 */
export interface JobEventInput {
  eventKey: string
  eventId: string
  org: string
  payload: Record<string, unknown>
}

export interface ExecuteDeps {
  pool: Pool
  registry?: JobDef[]
  spawn?: SpawnFn
  now?: () => Date
  cwd?: string
  log?: (o: unknown) => void
  /** 返回值有意放宽为 unknown：宿主注入的是 enqueueEvent（返回 {accepted}），事件侧不消费其返回值。 */
  emit?: (input: JobEventInput) => Promise<unknown>
  /** 重试退避；缺省 60s（与拆分前一致）。 */
  retryDelayMs?: number
}

/**
 * 失败/超时/死信发事件（W6-P4a）。三条判据与 health 的「连续失败 ≥3」**不是同一回事**：
 *   failed ⇒ jobs.job.failed（每次失败都发）／timeout ⇒ jobs.job.timeout／
 *   尝试耗尽（attempt >= maxAttempts）⇒ 追加 jobs.job.dead。
 * 幂等：failed/timeout 按 runId 去重；dead 按「格」（scheduleId+occurrence）去重。
 * fail-open：整段 try/catch，异常只 log，**绝不**改变 outcome、不改重试槽。
 */
async function emitJobEvents(
  deps: ExecuteDeps,
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
    log({ ts: new Date().toISOString(), job: job.key, error: `emit job events failed: ${e instanceof Error ? e.message : String(e)}` })
  }
}

/**
 * 跑一条已 claim 的作业并收尾（终态 + 重试记账 + 事件）。**永不抛**：所有异常都收在本函数内，
 * 调用方只关心「这条 run 有没有落终态」。
 */
export async function executeJob(deps: ExecuteDeps, job: ClaimedJob, manual: boolean): Promise<void> {
  const registry = deps.registry ?? JOB_REGISTRY
  const spawn = deps.spawn ?? defaultSpawn
  const now = deps.now ?? (() => new Date())
  const cwd = deps.cwd ?? process.cwd()
  const log = deps.log ?? ((o: unknown) => console.log(JSON.stringify(o)))
  const retryDelayMs = deps.retryDelayMs ?? 60_000

  const def = registry.find((d) => d.key === job.key)
  if (!def) {
    log({ ts: now().toISOString(), job: job.key, error: 'unknown registry key' })
    // claim 已建 running 行，必须收尾，否则会一直挡住该排班的下一次 claim。
    await finishRun(deps.pool, job.runId, { status: 'failed', error: 'unknown registry key' }).catch(() => {})
    return
  }
  try {
    // spawn 抛错（含同步抛，如 ENAMETOOLONG）也要落到一个终态；
    // **终态只由下面这一次 finishRun 写**（catch 分支里绝不再写，否则可能覆盖 reap 的判定）。
    let outcome: RunOutcome & { retryable?: boolean }
    try {
      const res = await spawn({
        command: 'pnpm', args: ['exec', 'tsx', def.script, ...(def.args ?? [])],
        env: { ...envFor(job), ...(def.env ?? {}) }, stdin: paramsStdin(job), timeoutMs: job.timeoutMs, cwd,
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
        await scheduleRetry(deps.pool, job.scheduleId, job.occurrence, job.attempt, new Date(now().getTime() + retryDelayMs))
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
  }
}
