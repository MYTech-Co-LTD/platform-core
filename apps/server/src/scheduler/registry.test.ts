import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { seedSchedules, type JobDef } from './registry'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

const defs: JobDef[] = [
  { key: 'jobtest-registry:alpha', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't' },
]

describePg('seedSchedules', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest-registry:%'"); await pool.end() })

  it('首次插入：enabled=false 且 next_run_at 为空（登记不跑）', async () => {
    await pool.query("delete from platform.job_schedule where key like 'jobtest-registry:%'")
    const r = await seedSchedules(pool, defs)
    expect(r.inserted).toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select enabled, next_run_at, params, source from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].next_run_at).toBeNull()
    expect(rows[0].params).toEqual({})
    expect(rows[0].source).toBe('system')
  })

  it('★ 二次 seed 不覆盖人改过的 cron / enabled', async () => {
    await pool.query("update platform.job_schedule set cron='*/5 * * * *', enabled=true where key='jobtest-registry:alpha'")
    await seedSchedules(pool, defs)
    const { rows } = await pool.query("select cron, enabled from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].cron).toBe('*/5 * * * *')
    expect(rows[0].enabled).toBe(true)
  })

  it('★ 已启用但 next_run_at 为空 ⇒ 补算（不立即跑）', async () => {
    await pool.query("update platform.job_schedule set next_run_at=null where key='jobtest-registry:alpha'")
    const r = await seedSchedules(pool, defs)
    expect(r.filled).toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select next_run_at from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(new Date(rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('★ 非法 cron 在 seed 期炸（fail-closed）', async () => {
    await expect(seedSchedules(pool, [{ ...defs[0], key: 'jobtest-registry:bad', cron: '0 0 * * MON' }]))
      .rejects.toThrow(/cron/)
  })
})
