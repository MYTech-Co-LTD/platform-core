// store.ts — 排班与台账的 SQL 面（无业务判断；判断在 loop / 健康面里）。
//
// 为什么 claimDue 是「事务内 SELECT … FOR UPDATE SKIP LOCKED + 逐行 JS 计算 + UPDATE + COMMIT」：
//   next_run_at 的下一次值必须由 cron 解析算出（SQL 算不了），所以不能像伪代码那样一条 UPDATE 搞定；
//   但**锁必须覆盖「读到期行 → 算出下一次 → 写回 → 建 running 行」整段**，否则两个副本会读到同一格
//   各算一遍。计算是纯 JS、微秒级，放在事务里安全。**spawn 一律在 COMMIT 之后**——本层只碰数据。
//
// 不变量：
//   ① 同一格（schedule × occurrence）只能被 claim 一次；
//      schedule 触发的 claim 靠 next_run_at 前推「消耗」这一格，
//      重试的 claim 靠清空 retry_at + retry_occurrence「消耗」这次重试。
//   ② 重试不改 next_run_at：重试与下一格是两件事，各自的时间线互不覆盖；
//      且**重试槽只属于排班侧**（occurrence 存在 retry_occurrence，不从 job_run 反查，
//      否则会被并发/手动行劫持）。
//   ③ 台账与 claim 同生共死：claim 事务内就插好 status='running' 的 run 行（返回 runId），
//      spawn 失败/进程崩溃后由 reapStale 兜底判 timeout；终态只能由 finishRun 从 running 回填。
//   ④ 同一 schedule 同时只有一条 running 行：claim（两种触发）都在 SQL 里排除已有 running 的排班，
//      该格不消费、下一拍再来。
import type { Pool, PoolClient } from 'pg'

export interface ClaimedJob {
  scheduleId: number
  key: string
  occurrence: Date
  attempt: number
  params: Record<string, unknown>
  timeoutMs: number
  maxAttempts: number
  isRetry: boolean
  ownerOrg: string | null
  ownerNamespace: string | null
  /** 本次运行在 job_run 的行 id：claim 事务内已建好 running 行，终态用 finishRun 回填。 */
  runId: number
}

export interface RunOutcome {
  status: 'ok' | 'failed' | 'timeout' | 'skipped'
  exitCode?: number | null
  durationMs?: number
  outputTail?: string
  error?: string
}

type NextFn = (cron: string, timezone: string, from: Date) => Date

interface Row {
  id: string
  key: string
  cron: string
  timezone: string
  params: unknown
  timeout_ms: number
  max_attempts: number
  expected_interval_secs: number
  next_run_at: Date | null
  retry_at: Date | null
  retry_occurrence: Date | null
  retry_attempt: number
  owner_org: string | null
  owner_namespace: string | null
}

const SCHED_COLS = `s.id,s.key,s.cron,s.timezone,s.params,s.timeout_ms,s.max_attempts,
  s.expected_interval_secs,s.next_run_at,s.retry_at,s.retry_occurrence,s.retry_attempt,
  s.owner_org,s.owner_namespace`

function toClaimed(
  r: Row,
  p: { occurrence: Date; attempt: number; isRetry: boolean; runId: number },
): ClaimedJob {
  return {
    scheduleId: Number(r.id),
    key: r.key,
    occurrence: p.occurrence,
    attempt: p.attempt,
    params: (r.params ?? {}) as Record<string, unknown>,
    timeoutMs: r.timeout_ms,
    maxAttempts: r.max_attempts,
    isRetry: p.isRetry,
    ownerOrg: r.owner_org,
    ownerNamespace: r.owner_namespace,
    runId: p.runId,
  }
}

/** 建 running 行（claim 事务内调用 ⇒ 与「消耗这一格」同生共死）。 */
async function insertRunning(
  client: PoolClient,
  r: Row,
  occurrence: Date,
  attempt: number,
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `insert into platform.job_run
       (schedule_id,key,occurrence,owner_org,owner_namespace,params_snapshot,trigger,status,attempt,started_at)
     values ($1,$2,$3,$4,$5,$6::jsonb,'schedule','running',$7, now()) returning id`,
    [r.id, r.key, occurrence, r.owner_org, r.owner_namespace,
      JSON.stringify(r.params ?? {}), attempt],
  )
  return Number(rows[0].id)
}

/** 抢到期排班（含到期的重试）。返回即代表这些格已被本进程独占，且 running 行已落库。 */
export async function claimDue(pool: Pool, limit: number, now: Date, next: NextFn): Promise<ClaimedJob[]> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    // 配置错（到期的重试却没有原格 occurrence）先清槽、提交后再抛：若在事务内直接抛，
    // 清槽会随回滚消失 ⇒ 每个 tick 都撞同一行。清槽 = 丢掉这次重试（它已无法还原到原格）。
    const bad = await client.query<{ key: string }>(
      `update platform.job_schedule
          set retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=now()
        where enabled and retry_at is not null and retry_at <= $1
          and retry_occurrence is null
        returning key`,
      [now],
    )
    if (bad.rows.length > 0) {
      const keys = bad.rows.map((r) => r.key).join(', ')
      await client.query('commit')
      throw new Error(`claimDue: 重试槽缺 retry_occurrence，已清空（${keys}）`)
    }

    const { rows } = await client.query<Row>(
      `select ${SCHED_COLS} from platform.job_schedule s
        where s.enabled
          and not exists (select 1 from platform.job_run r
                           where r.schedule_id = s.id and r.status = 'running')
          and (
            (s.retry_at is not null and s.retry_at <= $2 and s.retry_occurrence is not null)
            or (s.retry_at is null and s.next_run_at is not null and s.next_run_at <= $2))
        order by coalesce(s.retry_at, s.next_run_at)
        limit $1
        for update of s skip locked`,
      [limit, now],
    )
    const out: ClaimedJob[] = []
    for (const r of rows) {
      if (r.retry_at) {
        // 重试：occurrence 取自 retry_occurrence（排班侧自己的槽），**不动 next_run_at**。
        const occurrence = new Date(r.retry_occurrence as Date)
        const attempt = r.retry_attempt + 1
        await client.query(
          `update platform.job_schedule
              set retry_at=null, retry_occurrence=null, retry_attempt=$2, updated_at=now()
            where id=$1`,
          [r.id, attempt],
        )
        const runId = await insertRunning(client, r, occurrence, attempt)
        out.push(toClaimed(r, { occurrence, attempt, isRetry: true, runId }))
      } else {
        const occurrence = new Date(r.next_run_at as Date)
        const from = occurrence.getTime() > now.getTime() ? occurrence : now
        const nextAt = next(r.cron, r.timezone, from)
        await client.query(
          `update platform.job_schedule
              set next_run_at=$2, retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=now()
            where id=$1`,
          [r.id, nextAt],
        )
        const runId = await insertRunning(client, r, occurrence, 1)
        out.push(toClaimed(r, { occurrence, attempt: 1, isRetry: false, runId }))
      }
    }
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 手动触发只入队（trigger='manual'）；执行仍在 worker 进程。
 *
 *  **按 schedule 去重**：先锁排班行（`for update of s skip locked`，与 claimDue 的排班锁串行），
 *  一个排班最多返回一条 ⇒ 同 schedule 的多条 queued 每拍只跑一条，其余保持 queued 留给下一拍。
 *  （`DISTINCT ON` 与 `FOR UPDATE` 在 PostgreSQL 不能共存，所以用「锁排班行」天然去重。） */
export async function claimQueuedManual(pool: Pool, limit: number, now: Date): Promise<ClaimedJob[]> {
  const client = await pool.connect()
  const out: ClaimedJob[] = []
  try {
    await client.query('begin')
    // ① 锁排班行：`not exists running` ⇒ 同 schedule 已有在跑的（无论谁触发）本拍跳过。
    //    **不看 `s.enabled`**：手动排队行是运维显式动作，启停只约束自动排班（claimDue）；
    //    切流程序正是「登记（disabled）→ 手动跑一次比对 → 关 openship → 再启用」。
    //    若这里筛 enabled，disabled 排班的手动 queued 行会永远不被领取（最终被 reapQueued 判 timeout），
    //    端点返回的 200「已排队」就成了谎话。
    const sched = await client.query<Row>(
      `select ${SCHED_COLS}
         from platform.job_schedule s
        where exists (select 1 from platform.job_run r
                       where r.schedule_id = s.id and r.status = 'queued')
          and not exists (select 1 from platform.job_run x
                           where x.schedule_id = s.id and x.status = 'running')
        order by s.id
        limit $1
        for update of s skip locked`,
      [limit],
    )
    if (sched.rows.length === 0) {
      await client.query('commit')
      return out
    }
    // ② 拿到锁后按新快照复查 running：若期间有运行启动，本拍跳过该排班（queued 原样保留）。
    const ids = sched.rows.map((r) => r.id)
    const stillFree = await client.query<{ id: string }>(
      `select s.id from platform.job_schedule s
        where s.id = any($1::bigint[])
          and not exists (select 1 from platform.job_run x
                           where x.schedule_id = s.id and x.status = 'running')`,
      [ids],
    )
    const free = new Set(stillFree.rows.map((r) => String(r.id)))
    for (const s of sched.rows) {
      if (!free.has(String(s.id))) continue
      // ③ 每个排班只取最老的一条 queued；剩余保持 queued，下一拍再来。
      const { rows } = await client.query<{ id: string; occurrence: Date; params_snapshot: unknown }>(
        `select id, occurrence, coalesce(params_snapshot, $2::jsonb) as params_snapshot
           from platform.job_run
          where schedule_id = $1 and status = 'queued'
          order by id
          limit 1
          for update skip locked`,
        [s.id, JSON.stringify(s.params ?? {})],
      )
      const run = rows[0]
      if (!run) continue
      await client.query(
        `update platform.job_run
            set status='running', started_at=$2, attempt=1, params_snapshot=$3::jsonb
          where id=$1`,
        [run.id, now, JSON.stringify(run.params_snapshot ?? {})],
      )
      const job = toClaimed(s, {
        occurrence: new Date(run.occurrence), attempt: 1, isRetry: false, runId: Number(run.id),
      })
      job.params = (run.params_snapshot ?? {}) as Record<string, unknown>
      out.push(job)
    }
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 回填运行终态。行由 claim（两种触发）预先建好且为 running，**不新建行**。
 *  `where status='running'` 守卫：已被 reapStale 判 timeout 的行不许被迟到的回调覆盖。 */
export async function finishRun(pool: Pool, runId: number, o: RunOutcome): Promise<void> {
  await pool.query(
    `update platform.job_run set status=$2, finished_at=now(), exit_code=$3, duration_ms=$4,
       output_tail=$5, error=$6 where id=$1 and status='running'`,
    [runId, o.status, o.exitCode ?? null, o.durationMs ?? null, o.outputTail ?? null, o.error ?? null],
  )
}

/** 安排一次重试（只动重试槽，绝不碰 next_run_at）。occurrence 原样存进 retry_occurrence。 */
export async function scheduleRetry(
  pool: Pool,
  scheduleId: number,
  occurrence: Date,
  attempt: number,
  at: Date,
): Promise<void> {
  await pool.query(
    `update platform.job_schedule
        set retry_at=$2, retry_occurrence=$3, retry_attempt=$4, updated_at=now()
      where id=$1`,
    [scheduleId, at, occurrence, attempt],
  )
}

export async function clearRetry(pool: Pool, scheduleId: number): Promise<void> {
  await pool.query(
    `update platform.job_schedule
        set retry_at=null, retry_occurrence=null, retry_attempt=0, updated_at=now()
      where id=$1`,
    [scheduleId],
  )
}

export async function hasRunning(pool: Pool, scheduleId: number): Promise<boolean> {
  const { rows } = await pool.query(
    "select 1 from platform.job_run where schedule_id=$1 and status='running' limit 1",
    [scheduleId],
  )
  return rows.length > 0
}

/** 回收「running 超时」的僵尸行：阈值取 2× timeout_ms（给正常执行留一倍余量）。 */
export async function reapStale(pool: Pool, now: Date): Promise<number> {
  const { rowCount } = await pool.query(
    `update platform.job_run r set status='timeout', finished_at=$1, error='stale running reaped'
       from platform.job_schedule s
      where r.schedule_id = s.id
        and r.status = 'running'
        and r.started_at < $1::timestamptz - make_interval(secs => 2 * s.timeout_ms / 1000.0)`,
    [now],
  )
  return rowCount ?? 0
}

/** 回收卡住的 `queued` 行。两条**同时**满足才判死（否则会误杀合法排队）：
 *   ① 年龄 > 2 × 该排班的 timeout_ms；
 *   ② 该 schedule 当前**没有** running 行（有在跑 ⇒ 调度器活着，排队是正常的）。
 *  不回收的话它会永久占住路由的 busy 判定（queued 也算「未完成」）。 */
export async function reapQueued(pool: Pool, now: Date): Promise<number> {
  const { rowCount } = await pool.query(
    `update platform.job_run r
        set status='timeout', finished_at=$1, error='stale queued reaped'
       from platform.job_schedule s
      where r.schedule_id = s.id
        and r.status = 'queued'
        and r.started_at < $1::timestamptz - make_interval(secs => 2 * s.timeout_ms / 1000.0)
        and not exists (select 1 from platform.job_run x
                         where x.schedule_id = r.schedule_id and x.status = 'running')`,
    [now],
  )
  return rowCount ?? 0
}

export async function beat(pool: Pool, now: Date, id = 'scheduler'): Promise<void> {
  await pool.query(
    `insert into platform.job_heartbeat(id, beat_at) values ($1,$2)
     on conflict (id) do update set beat_at = excluded.beat_at`,
    [id, now],
  )
}
