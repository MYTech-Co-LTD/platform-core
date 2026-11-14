import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { nextRunAt } from './cron'
import { beat, claimDue, claimQueuedManual, clearRetry, hasRunning, reapStale, recordRun, scheduleRetry } from './store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

/** 夹具清理：job_run 对 job_schedule 有外键（无级联），必须先删运行行再删排班行。
 *  顺序反过来会在第二个用例的 mkSchedule 上撞 `violates foreign key constraint`。 */
async function clearFixtures(pool: Pool) {
  await pool.query(
    `delete from platform.job_run where schedule_id in
       (select id from platform.job_schedule where key like 'jobtest-store:%')`)
  await pool.query("delete from platform.job_schedule where key like 'jobtest-store:%'")
}

async function mkSchedule(pool: Pool, key: string, over: Record<string, unknown> = {}) {
  await clearFixtures(pool)
  const { rows } = await pool.query(
    `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
     values ($1,$2,'UTC','system',true,$3,$4,$5,$6) returning id`,
    [key, over.cron ?? '7 * * * *', over.nextRunAt ?? new Date(Date.now() - 60_000), over.timeoutMs ?? 5000, over.maxAttempts ?? 2, over.expectedIntervalSecs ?? 3600],
  )
  return Number(rows[0].id)
}

describePg('scheduler store', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await clearFixtures(pool); await pool.end() })

  it('到期 job 被 claim，且 next_run_at 前推', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:claim')
    const jobs = await claimDue(pool, 5, new Date(), nextRunAt)
    const j = jobs.find((x) => x.scheduleId === id)!
    expect(j.key).toBe('jobtest-store:claim')
    expect(j.attempt).toBe(1)
    const { rows } = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    expect(new Date(rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('★ 同一 job 不会被第二次 claim（并发安全）', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:once')
    await claimDue(pool, 5, new Date(), nextRunAt)
    const again = await claimDue(pool, 5, new Date(), nextRunAt)
    expect(again.some((x) => x.scheduleId === id)).toBe(false)
  })

  it('★ 真并发：8 个 claimDue 同时抢，同一格只被抢到一次', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:race')
    // 每个并发调用用独立 Pool = 独立会话，才真正走到 `FOR UPDATE SKIP LOCKED` 的行锁判定。
    const pools = Array.from({ length: 8 }, () => new Pool({ connectionString: dbUrl, max: 1 }))
    try {
      const results = await Promise.all(
        pools.map((p) => claimDue(p, 5, new Date(), nextRunAt)),
      )
      const hits = results.flat().filter((x) => x.scheduleId === id)
      expect(hits).toHaveLength(1)
      const { rows } = await pool.query(
        "select count(*)::int as n from platform.job_run where schedule_id=$1 and trigger='schedule'", [id])
      // claim 只改排班行、不建 run 行（run 行由 recordRun 收尾时建）⇒ 这里自然为 0。
      expect(rows[0].n).toBe(0)
    } finally {
      await Promise.all(pools.map((p) => p.end()))
    }
  })

  it('★ retry 路径：不改 next_run_at，attempt 递增', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:retry')
    const [j] = (await claimDue(pool, 5, new Date(), nextRunAt)).filter((x) => x.scheduleId === id)
    const before = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    await recordRun(pool, j, { status: 'failed', exitCode: 1, durationMs: 10, outputTail: '', error: 'boom' })
    await scheduleRetry(pool, id, j.occurrence, 1, new Date(Date.now() - 1000))
    const retries = await claimDue(pool, 5, new Date(), nextRunAt)
    const r = retries.find((x) => x.scheduleId === id)!
    expect(r.isRetry).toBe(true)
    expect(r.attempt).toBe(2)
    expect(r.occurrence.toISOString()).toBe(j.occurrence.toISOString())
    const after = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    expect(after.rows[0].next_run_at.toISOString()).toBe(before.rows[0].next_run_at.toISOString())
    await clearRetry(pool, id)
  })

  it('★ 僵尸 running 被回收成 timeout', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:zombie', { timeoutMs: 1000 })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       values ($1,'jobtest-store:zombie',now(),'schedule','running', now() - interval '1 hour')`, [id])
    expect(await reapStale(pool, new Date())).toBeGreaterThanOrEqual(1)
    const { rows } = await pool.query("select status from platform.job_run where schedule_id=$1", [id])
    expect(rows[0].status).toBe('timeout')
  })

  it('手动入队：只有 queued 行能被 claim，且带 trigger=manual', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:manual', { nextRunAt: new Date(Date.now() + 86_400_000) })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status) values ($1,'jobtest-store:manual',now(),'manual','queued')`, [id])
    const jobs = await claimQueuedManual(pool, 5, new Date())
    const j = jobs.find((x) => x.scheduleId === id)!
    expect(j.occurrence).toBeInstanceOf(Date)
    expect(await hasRunning(pool, id)).toBe(true)
    const { rows } = await pool.query('select trigger,status,attempt from platform.job_run where schedule_id=$1', [id])
    expect(rows[0].trigger).toBe('manual')
    expect(rows[0].status).toBe('running')
    expect(rows[0].attempt).toBe(1)
    // 已 claim 过的 queued 行不会再被抢第二次。
    expect((await claimQueuedManual(pool, 5, new Date())).some((x) => x.scheduleId === id)).toBe(false)
  })

  it('心跳 upsert：同 id 只一行', async () => {
    await beat(pool, new Date(), 'jobtest')
    await beat(pool, new Date(), 'jobtest')
    const { rows } = await pool.query("select count(*)::int as n from platform.job_heartbeat where id='jobtest'")
    expect(rows[0].n).toBe(1)
    await pool.query("delete from platform.job_heartbeat where id='jobtest'")
  })
})
