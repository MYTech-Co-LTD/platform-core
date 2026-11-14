import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { nextRunAt } from './cron'
import {
  beat, claimDue, claimQueuedManual, clearRetry, finishRun, hasRunning, reapQueued, reapStale, scheduleRetry,
} from './store'

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
        "select count(*)::int as n from platform.job_run where schedule_id=$1 and trigger='schedule' and status='running'", [id])
      // claim 与台账同生共死：赢家恰好建 1 条 running 行，输家一行都不建。
      expect(rows[0].n).toBe(1)
    } finally {
      await Promise.all(pools.map((p) => p.end()))
    }
  })

  it('★ retry 路径：不改 next_run_at，attempt 递增，claim 后重试槽清空', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:retry')
    const [j] = (await claimDue(pool, 5, new Date(), nextRunAt)).filter((x) => x.scheduleId === id)
    const before = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    await finishRun(pool, j.runId, { status: 'failed', exitCode: 1, durationMs: 10, outputTail: '', error: 'boom' })
    await scheduleRetry(pool, id, j.occurrence, 1, new Date(Date.now() - 1000))
    const retries = await claimDue(pool, 5, new Date(), nextRunAt)
    const r = retries.find((x) => x.scheduleId === id)!
    expect(r.isRetry).toBe(true)
    expect(r.attempt).toBe(2)
    expect(r.occurrence.toISOString()).toBe(j.occurrence.toISOString())
    const after = await pool.query('select next_run_at, retry_at, retry_occurrence from platform.job_schedule where id=$1', [id])
    expect(after.rows[0].next_run_at.toISOString()).toBe(before.rows[0].next_run_at.toISOString())
    // ★ 重试被 claim 即「消耗」：retry_at 与 retry_occurrence 必须一起清空。
    expect(after.rows[0].retry_at).toBeNull()
    expect(after.rows[0].retry_occurrence).toBeNull()
    await clearRetry(pool, id)
  })

  it('★ 重试 occurrence 不被手动 queued 行劫持（重试槽归属排班侧）', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:retry-occ')
    const [j] = (await claimDue(pool, 5, new Date(), nextRunAt)).filter((x) => x.scheduleId === id)
    await finishRun(pool, j.runId, { status: 'failed', error: 'boom' })
    await scheduleRetry(pool, id, j.occurrence, 1, new Date(Date.now() - 1000))
    // 重试挂起期间入队一条手动行：它的 started_at 比失败的排班运行更新。
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       values ($1,'jobtest-store:retry-occ',now(),'manual','queued', now() + interval '1 second')`, [id])
    const r = (await claimDue(pool, 5, new Date(), nextRunAt)).find((x) => x.scheduleId === id)!
    expect(r.isRetry).toBe(true)
    // 旧实现「select occurrence ... order by started_at desc」会取到手动行的 now() ⇒ 断言会红。
    expect(r.occurrence.toISOString()).toBe(j.occurrence.toISOString())
  })

  it('★ 调度触发执行期间有 running 行，超时后被 reapStale 改判 timeout（终态守卫）', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:sched-running', { timeoutMs: 1000 })
    const [j] = (await claimDue(pool, 5, new Date(), nextRunAt)).filter((x) => x.scheduleId === id)
    // spawn 还没返回：库里就应有 running 行 ⇒ hasRunning 对调度触发同样成立。
    expect(await hasRunning(pool, id)).toBe(true)
    const { rows } = await pool.query(
      'select status, trigger, attempt from platform.job_run where id=$1', [j.runId])
    expect(rows[0]).toEqual({ status: 'running', trigger: 'schedule', attempt: 1 })
    // 模拟子进程卡死超过 2×timeout_ms。
    await pool.query("update platform.job_run set started_at = now() - interval '1 hour' where id=$1", [j.runId])
    expect(await reapStale(pool, new Date())).toBeGreaterThanOrEqual(1)
    const after = await pool.query('select status from platform.job_run where id=$1', [j.runId])
    expect(after.rows[0].status).toBe('timeout')
    expect(await hasRunning(pool, id)).toBe(false)
    // 迟到的回调不许覆盖已被 reap 判定的终态。
    await finishRun(pool, j.runId, { status: 'ok' })
    const guarded = await pool.query('select status from platform.job_run where id=$1', [j.runId])
    expect(guarded.rows[0].status).toBe('timeout')
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

  it('★ 卡住的 queued 行被 reapQueued 改判 timeout', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:stale-queued', { nextRunAt: new Date(Date.now() + 86_400_000) })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       values ($1,'jobtest-store:stale-queued',now(),'manual','queued', now() - interval '1 hour')`, [id])
    expect(await reapQueued(pool, new Date(), 60_000)).toBeGreaterThanOrEqual(1)
    const { rows } = await pool.query('select status, error from platform.job_run where schedule_id=$1', [id])
    expect(rows[0].status).toBe('timeout')
    expect(rows[0].error).toBe('stale queued reaped')
  })

  it('手动入队：只有 queued 行能被 claim，且带 trigger=manual / 回填 params_snapshot', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:manual', { nextRunAt: new Date(Date.now() + 86_400_000) })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status) values ($1,'jobtest-store:manual',now(),'manual','queued')`, [id])
    const jobs = await claimQueuedManual(pool, 5, new Date())
    const j = jobs.find((x) => x.scheduleId === id)!
    expect(j.occurrence).toBeInstanceOf(Date)
    expect(typeof j.runId).toBe('number')
    expect(await hasRunning(pool, id)).toBe(true)
    const { rows } = await pool.query('select trigger,status,attempt,params_snapshot from platform.job_run where schedule_id=$1', [id])
    expect(rows[0].trigger).toBe('manual')
    expect(rows[0].status).toBe('running')
    expect(rows[0].attempt).toBe(1)
    expect(rows[0].params_snapshot).toEqual({})
    // 已 claim 过的 queued 行不会再被抢第二次。
    expect((await claimQueuedManual(pool, 5, new Date())).some((x) => x.scheduleId === id)).toBe(false)
  })

  it('★ 有 retry 挂起时，手动入队仍能被 claim（手动与重试是两条时间线）', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:manual-vs-retry', { nextRunAt: new Date(Date.now() + 86_400_000) })
    // retry_at 已到期：旧实现用 `s.retry_at is null` 过滤会把这条排班的手动入队永远挡住。
    await pool.query(
      "update platform.job_schedule set retry_at = now() - interval '1 second', retry_occurrence = now(), retry_attempt = 1 where id=$1", [id])
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
       values ($1,'jobtest-store:manual-vs-retry',now(),'manual','queued')`, [id])
    const jobs = await claimQueuedManual(pool, 5, new Date())
    const j = jobs.find((x) => x.scheduleId === id)
    expect(j).toBeDefined()
    expect(typeof j!.runId).toBe('number')
    expect(await hasRunning(pool, id)).toBe(true)
  })

  it('★ 手动与排班互斥：同 schedule 已有 running 时 queued 行不被抢，结束后再来', async () => {
    const id = await mkSchedule(pool, 'jobtest-store:mutex')
    // 排班侧 claim：事务内已建 running 行。
    const [sched] = (await claimDue(pool, 5, new Date(), nextRunAt)).filter((x) => x.scheduleId === id)
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
       values ($1,'jobtest-store:mutex',now(),'manual','queued')`, [id])
    const first = await claimQueuedManual(pool, 5, new Date())
    expect(first.some((x) => x.scheduleId === id)).toBe(false)
    const held = await pool.query(
      "select status from platform.job_run where schedule_id=$1 and trigger='manual'", [id])
    expect(held.rows[0].status).toBe('queued')
    // 排班运行结束（running 行消失）后，手动行才能被 claim。
    await finishRun(pool, sched.runId, { status: 'ok' })
    const second = await claimQueuedManual(pool, 5, new Date())
    expect(second.some((x) => x.scheduleId === id)).toBe(true)
  })

  it('心跳 upsert：同 id 只一行', async () => {
    await beat(pool, new Date(), 'jobtest')
    await beat(pool, new Date(), 'jobtest')
    const { rows } = await pool.query("select count(*)::int as n from platform.job_heartbeat where id='jobtest'")
    expect(rows[0].n).toBe(1)
    await pool.query("delete from platform.job_heartbeat where id='jobtest'")
  })
})
