// query-stats.test.ts — 查询性能口径（R4）：p95 / 慢查询占比 / 按指标排名 / 无样本。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { writeAudit } from './audit-store'
import { queryStats } from './query-stats'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-query-stats'

describePg('queryStats（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  const row = (metricId: string, durationMs?: number | null) => writeAudit(pool, {
    org: ORG, userId: 'u1', channel: 'session', keyId: null,
    metricId, params: {}, rowCount: 1, verdict: 'ok', reason: null, masking: null,
    ...(durationMs === undefined ? {} : { durationMs }),
  })

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_audit where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ p95 / 慢查询占比 / 按指标排名；无耗时旧行不计入样本', async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await row('m:slow', 6000)
    await row('m:slow', 800)
    await row('m:fast', 100)
    await row('m:fast', 200)
    await row('m:fast', 300)
    await row('m:legacy')            // 旧形态：没有 duration_ms

    const s = await queryStats(pool, ORG, 7)
    expect(s.total).toBe(6)
    expect(s.sampled).toBe(5)
    expect(s.slow).toBe(2)
    expect(s.slowRate).toBeCloseTo(2 / 6, 5)
    expect(s.p95Ms).toBeGreaterThan(4000)
    expect(s.breaches).toContain('p95')
    expect(s.breaches).toContain('slow_rate')
    // 最慢的指标排第一
    expect(s.byMetric[0]).toMatchObject({ metricId: 'm:slow', total: 2, slow: 2 })
    expect(s.byDay.length).toBeGreaterThan(0)
  })

  it('健康窗口 ⇒ breaches 为空；无样本 ⇒ p95 null 不画 0', async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await row('m:fast', 200)
    await row('m:fast', 300)
    const healthy = await queryStats(pool, ORG, 7)
    expect(healthy.breaches).toEqual([])
    expect(healthy.p95Ms).not.toBeNull()

    await pool.query('delete from data.query_audit where org = $1', [ORG])
    const empty = await queryStats(pool, ORG, 7)
    expect(empty.total).toBe(0)
    expect(empty.p95Ms).toBeNull()
    expect(empty.slowRate).toBeNull()
    expect(empty.breaches).toEqual([])
  })

  it('按租户隔离', async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG])
    await row('m:fast', 100)
    const s = await queryStats(pool, 'org-query-stats-other', 7)
    expect(s.total).toBe(0)
  })
})
