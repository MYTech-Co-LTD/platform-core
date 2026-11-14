import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { JOB_REGISTRY, seedSchedules, type JobDef } from './registry'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

const defs: JobDef[] = [
  { key: 'jobtest-registry:alpha', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't' },
]

/** handler-only 条目：只登记 handler，不建系统排班行（cron/timezone 是 schema 必填的占位，不进库）。 */
const handlerOnlyDef: JobDef = {
  key: 'jobtest-registry:handler-only', script: 'scripts/x.mjs', cron: '0 0 1 1 *', timezone: 'UTC',
  timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 86400, description: 't', noSystemSchedule: true,
}

/** 用例的前置行由用例自己造（beforeEach 先清空本前缀）——单独跑任意一条都不依赖别的用例。 */
async function insertAlpha(pool: Pool, cron: string, enabled: boolean, nextRunAt: Date | null = null): Promise<void> {
  await pool.query(
    `insert into platform.job_schedule
       (key, cron, timezone, params, source, enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs)
     values ('jobtest-registry:alpha', $1, 'UTC', '{}'::jsonb, 'system', $2, $3, 1000, 1, 3600)`,
    [cron, enabled, nextRunAt],
  )
}

describePg('seedSchedules', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  beforeEach(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest-registry:%'") })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest-registry:%'"); await pool.end() })

  it('首次插入：enabled=false 且 next_run_at 为空（登记不跑）', async () => {
    const r = await seedSchedules(pool, defs)
    expect(r.inserted).toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select enabled, next_run_at, params, source from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].next_run_at).toBeNull()
    expect(rows[0].params).toEqual({})
    expect(rows[0].source).toBe('system')
  })

  it('★ 二次 seed 不覆盖人改过的 cron / enabled', async () => {
    await insertAlpha(pool, '*/5 * * * *', true)
    await seedSchedules(pool, defs)
    const { rows } = await pool.query("select cron, enabled from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(rows[0].cron).toBe('*/5 * * * *')
    expect(rows[0].enabled).toBe(true)
  })

  it('★ 已启用但 next_run_at 为空 ⇒ 补算（不立即跑）', async () => {
    await insertAlpha(pool, '7 * * * *', true)
    const r = await seedSchedules(pool, defs, new Date('2026-11-14T07:00:00Z'))
    expect(r.filled).toContain('jobtest-registry:alpha')
    const { rows } = await pool.query("select next_run_at from platform.job_schedule where key='jobtest-registry:alpha'")
    // cron `7 * * * *` @ UTC，从固定 now 07:00 起的下一个触发点是 07:07。
    expect(new Date(rows[0].next_run_at).toISOString()).toBe('2026-11-14T07:07:00.000Z')
  })

  it('★ 非法 cron 在 seed 期炸（fail-closed）', async () => {
    await expect(seedSchedules(pool, [{ ...defs[0], key: 'jobtest-registry:bad', cron: '0 0 * * MON' }]))
      .rejects.toThrow(/cron/)
  })

  it('★ script 不在 scripts/ 下也在 seed 期炸（fail-closed）', async () => {
    await expect(seedSchedules(pool, [{ ...defs[0], key: 'jobtest-registry:badscript', script: 'app/x.mjs' }]))
      .rejects.toThrow(/script/)
    const { rows } = await pool.query("select count(*)::int as n from platform.job_schedule where key='jobtest-registry:badscript'")
    expect(rows[0].n).toBe(0)
  })

  it('★ noSystemSchedule 条目只登记 handler，不建系统排班行；普通条目照旧插入', async () => {
    const r = await seedSchedules(pool, [...defs, handlerOnlyDef])
    expect(r.inserted).toContain('jobtest-registry:alpha')
    expect(r.inserted).not.toContain('jobtest-registry:handler-only')
    const { rows } = await pool.query("select count(*)::int as n from platform.job_schedule where key='jobtest-registry:handler-only'")
    expect(rows[0].n).toBe(0)
    const alpha = await pool.query("select count(*)::int as n from platform.job_schedule where key='jobtest-registry:alpha'")
    expect(alpha.rows[0].n).toBe(1)
  })
})

describe('JOB_REGISTRY', () => {
  // 不依赖 DB：纯目录断言（无 DATABASE_URL 的裸跑也保这层覆盖）。
  it('★ 含 handler-only 的 notify.emit，且 script 指向仓内真实文件', () => {
    const def = JOB_REGISTRY.find((d) => d.key === 'notify.emit')
    expect(def).toBeDefined()
    expect(def!.noSystemSchedule).toBe(true)
    expect(def!.script).toBe('scripts/notify-emit-job.mjs')
    // 用测试文件位置锚定仓根（apps/server/src/scheduler → ../../../..），防手滑写错路径。
    const scriptPath = fileURLToPath(new URL(`../../../../${def!.script}`, import.meta.url))
    expect(existsSync(scriptPath)).toBe(true)
  })
})
