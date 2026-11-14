// store.ts — 排班与台账的 SQL 面（无业务判断；判断在 loop / 健康面里）。
//
// 为什么 claimDue 是「事务内 SELECT … FOR UPDATE SKIP LOCKED + 逐行 JS 计算 + UPDATE + COMMIT」：
//   next_run_at 的下一次值必须由 cron 解析算出（SQL 算不了），所以不能像伪代码那样一条 UPDATE 搞定；
//   但**锁必须覆盖「读到期行 → 算出下一次 → 写回」整段**，否则两个副本会读到同一格各算一遍。
//   计算是纯 JS、微秒级，放在事务里安全。**spawn 一律在 COMMIT 之后**——本层只碰数据。
//
// 两条不变量：
//   ① 同一格（schedule × occurrence）只能被 claim 一次；
//      schedule 触发的 claim 靠 next_run_at 前推「消耗」这一格，
//      重试的 claim 同理靠清空 retry_at「消耗」这次重试（否则 retry_at 仍在过去 ⇒ 会被反复抢到）。
//   ② 重试不改 next_run_at：重试与下一格是两件事，各自的时间线互不覆盖。
import type { Pool } from 'pg'

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
  retry_attempt: number
  owner_org: string | null
  owner_namespace: string | null
}

const SELECT_COLS = `id,key,cron,timezone,params,timeout_ms,max_attempts,expected_interval_secs,
  next_run_at,retry_at,retry_attempt,owner_org,owner_namespace`

function toClaimed(r: Row, p: { occurrence: Date; attempt: number; isRetry: boolean }): ClaimedJob {
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
  }
}

/** 抢到期排班（含到期的重试）。返回即代表这些格已被本进程独占。 */
export async function claimDue(pool: Pool, limit: number, now: Date, next: NextFn): Promise<ClaimedJob[]> {
  const client = await pool.connect()
  const out: ClaimedJob[] = []
  try {
    await client.query('begin')
    const { rows } = await client.query<Row>(
      `select ${SELECT_COLS} from platform.job_schedule
        where enabled and (
          (retry_at is not null and retry_at <= $2)
          or (retry_at is null and next_run_at is not null and next_run_at <= $2))
        order by coalesce(retry_at, next_run_at)
        limit $1
        for update skip locked`,
      [limit, now],
    )
    for (const r of rows) {
      if (r.retry_at) {
        // 重试：沿用原 occurrence（取该 schedule 最近一次运行），**不动 next_run_at**。
        const occ = await client.query<{ occurrence: Date }>(
          `select occurrence from platform.job_run
            where schedule_id = $1 order by started_at desc limit 1`,
          [r.id],
        )
        const occurrence = occ.rows[0]?.occurrence
          ? new Date(occ.rows[0].occurrence)
          : new Date(r.next_run_at ?? now)
        const attempt = r.retry_attempt + 1
        // 清 retry_at = 「消耗这次重试」。留着它（即使同步递增 attempt）会让下一次 claimDue 再抢到同一行。
        await client.query(
          'update platform.job_schedule set retry_at=null, retry_attempt=$2, updated_at=now() where id=$1',
          [r.id, attempt],
        )
        out.push(toClaimed(r, { occurrence, attempt, isRetry: true }))
      } else {
        const occurrence = new Date(r.next_run_at as Date)
        const from = occurrence.getTime() > now.getTime() ? occurrence : now
        const nextAt = next(r.cron, r.timezone, from)
        await client.query(
          'update platform.job_schedule set next_run_at=$2, retry_at=null, retry_attempt=0, updated_at=now() where id=$1',
          [r.id, nextAt],
        )
        out.push(toClaimed(r, { occurrence, attempt: 1, isRetry: false }))
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

/** 手动触发只入队（trigger='manual'）；执行仍在 worker 进程。 */
export async function claimQueuedManual(pool: Pool, limit: number, now: Date): Promise<ClaimedJob[]> {
  const client = await pool.connect()
  const out: ClaimedJob[] = []
  try {
    await client.query('begin')
    const { rows } = await client.query<Row & { run_id: string; occurrence: Date }>(
      `select r.id as run_id,
              ${SELECT_COLS.split(',').map((c) => 's.' + c.trim()).join(', ')},
              r.occurrence
         from platform.job_run r
         join platform.job_schedule s on s.id = r.schedule_id
        where r.status = 'queued' and s.enabled
        order by r.id
        limit $1
        for update of r skip locked`,
      [limit],
    )
    for (const r of rows) {
      await client.query(
        `update platform.job_run set status='running', started_at=$2, attempt=1 where id=$1`,
        [r.run_id, now],
      )
      out.push(toClaimed(r, { occurrence: new Date(r.occurrence), attempt: 1, isRetry: false }))
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

/** 调度触发的运行：新建 run 行（收尾时写终态），返回 runId。 */
export async function recordRun(pool: Pool, job: ClaimedJob, o: RunOutcome): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into platform.job_run
       (schedule_id,key,occurrence,owner_org,owner_namespace,params_snapshot,trigger,status,attempt,
        started_at,finished_at,exit_code,duration_ms,output_tail,error)
     values ($1,$2,$3,$4,$5,$6::jsonb,'schedule',$7,$8, now(), now(), $9,$10,$11,$12) returning id`,
    [job.scheduleId, job.key, job.occurrence, job.ownerOrg, job.ownerNamespace,
      JSON.stringify(job.params ?? {}), o.status, job.attempt,
      o.exitCode ?? null, o.durationMs ?? null, o.outputTail ?? null, o.error ?? null],
  )
  return Number(rows[0].id)
}

/** 手动触发的运行行已由 claimQueuedManual 建好（running），这里只回填终态，**不新建行**。 */
export async function finishRun(pool: Pool, runId: number, o: RunOutcome): Promise<void> {
  await pool.query(
    `update platform.job_run set status=$2, finished_at=now(), exit_code=$3, duration_ms=$4,
       output_tail=$5, error=$6 where id=$1`,
    [runId, o.status, o.exitCode ?? null, o.durationMs ?? null, o.outputTail ?? null, o.error ?? null],
  )
}

/** 安排一次重试（只动 retry_at / retry_attempt，绝不碰 next_run_at）。 */
export async function scheduleRetry(
  pool: Pool,
  scheduleId: number,
  _occurrence: Date,
  attempt: number,
  at: Date,
): Promise<void> {
  await pool.query(
    'update platform.job_schedule set retry_at=$2, retry_attempt=$3, updated_at=now() where id=$1',
    [scheduleId, at, attempt],
  )
}

export async function clearRetry(pool: Pool, scheduleId: number): Promise<void> {
  await pool.query(
    'update platform.job_schedule set retry_at=null, retry_attempt=0, updated_at=now() where id=$1',
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

export async function beat(pool: Pool, now: Date, id = 'scheduler'): Promise<void> {
  await pool.query(
    `insert into platform.job_heartbeat(id, beat_at) values ($1,$2)
     on conflict (id) do update set beat_at = excluded.beat_at`,
    [id, now],
  )
}
