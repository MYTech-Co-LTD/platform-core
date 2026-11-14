// apps/server/src/scheduler/migrate.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

describePg('018_platform_jobs', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
  })
  afterAll(async () => { await pool.end() })

  it('幂等：连跑两次不报错', async () => {
    await runMigrations(pool, 'platform', dir)
    await runMigrations(pool, 'platform', dir)
    const { rows } = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_schema='platform' and table_name in ('job_schedule','job_run','job_heartbeat')")
    expect(rows[0].n).toBe(3)
  })

  it('系统 job 一 key 一条：部分唯一索引生效', async () => {
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    await pool.query(
      "insert into platform.job_schedule(key,cron,source,enabled,expected_interval_secs) values ('jobtest:uq','* * * * *','system',false,60)")
    await expect(pool.query(
      "insert into platform.job_schedule(key,cron,source,enabled,expected_interval_secs) values ('jobtest:uq','* * * * *','system',false,60)",
    )).rejects.toThrow(/uq_job_schedule_system_key/)
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
  })

  it('status/trigger 闭集：非法值被**约束**拒绝（不是被外键拒绝）', async () => {
    const { rows } = await pool.query(
      "insert into platform.job_schedule(key,cron,source,enabled,expected_interval_secs) values ('jobtest:cl','* * * * *','system',false,60) returning id")
    const id = rows[0].id
    await expect(pool.query(
      "insert into platform.job_run(schedule_id,key,occurrence,trigger,status) values ($1,'jobtest:cl',now(),'nope','ok')", [id],
    )).rejects.toThrow(/job_run_trigger_check/)
    await expect(pool.query(
      "insert into platform.job_run(schedule_id,key,occurrence,trigger,status) values ($1,'jobtest:cl',now(),'schedule','nope')", [id],
    )).rejects.toThrow(/job_run_status_check/)
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
  })
})
