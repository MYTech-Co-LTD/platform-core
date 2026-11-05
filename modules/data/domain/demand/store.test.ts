import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import pg from 'pg'
import { applyMigrations } from '../../test-util'
import { dismissDemand, listDemands, readCursor, upsertDemand, writeCursor } from './store'

const dsn = process.env.DATABASE_URL
const ORG = 'demand-store-test'

describe.skipIf(dsn === undefined)('demand store（真库）', () => {
  const pool = new pg.Pool({ connectionString: dsn })

  beforeAll(async () => { await applyMigrations(pool) })

  afterAll(async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.demand_mining_state where org = $1', [ORG]).catch(() => {})
    await pool.end()
  })

  it('同一 (org,kind,target) 累加而不是新建；evidence 只留 5 条且新在前', async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG])
    for (let i = 1; i <= 7; i += 1) {
      await upsertDemand(pool, ORG, { kind: 'new_metric', target: 'm:a:b', detail: {}, evidence: [{ i }] })
    }
    const rows = await listDemands(pool, ORG, { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.occurrences).toBe(7)
    expect((rows[0]?.evidence as { i: number }[]).map((e) => e.i)).toEqual([7, 6, 5, 4, 3])
  })

  it('否决幂等：第一次 dismissed，第二次 already，且默认列表不再返回', async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG])
    await upsertDemand(pool, ORG, { kind: 'drill_gap', target: 'm:x', detail: { dimensions: ['branch_num'] }, evidence: [] })
    const [row] = await listDemands(pool, ORG, { limit: 1 })
    expect(await dismissDemand(pool, ORG, row!.id, 'u1', '不需要')).toEqual({ status: 'dismissed' })
    expect((await dismissDemand(pool, ORG, row!.id, 'u2', 'x')).status).toBe('already')
    expect(await listDemands(pool, ORG, { limit: 10 })).toHaveLength(0)
    expect(await listDemands(pool, ORG, { limit: 10, includeDismissed: true })).toHaveLength(1)
  })

  it('水位读写', async () => {
    await pool.query('delete from data.demand_mining_state where org = $1', [ORG])
    expect(await readCursor(pool, ORG, 'query_audit')).toBe(0)
    await writeCursor(pool, ORG, 'query_audit', 42)
    await writeCursor(pool, ORG, 'query_audit', 99)
    expect(await readCursor(pool, ORG, 'query_audit')).toBe(99)
  })

  it('org 隔离：读不到别的 org', async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG])
    await upsertDemand(pool, ORG, { kind: 'new_metric', target: 'm:o:1', detail: {}, evidence: [] })
    expect(await listDemands(pool, `${ORG}-other`, { limit: 10 })).toHaveLength(0)
  })
})
