import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { expectedTicketSums, reconcileCounts, reconcileTicketSums } from './reconcile'
import { cleanTicket } from './clean'
import { importRegion, importTicket } from './import'
import { FIXTURE_TICKET } from './fixtures'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'test-m2b-reconcile'

describePg('对账（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query(`delete from aftersales.ticket where org = $1`, [ORG])
    await pool.query(`delete from aftersales.region where org = $1`, [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('计数：相等 ok=true；少一行 ok=false（差额留人工核对，不吞）', async () => {
    await importRegion(pool, ORG, [{ sourceId: 'R001', name: '华东' }])
    const checks = await reconcileCounts(pool, ORG, [{ table: 'region', source: 1 }])
    expect(checks[0].ok).toBe(true)
    const bad = await reconcileCounts(pool, ORG, [{ table: 'region', source: 2 }])
    expect(bad[0]).toMatchObject({ source: 2, target: 1, ok: false })
  })

  it('金额和：同一份 clean 产物的期望 vs 库内实sum，bigint 全程字符串比较', async () => {
    const cleaned = [cleanTicket(FIXTURE_TICKET), cleanTicket({ ...FIXTURE_TICKET, _id: 'wo-002', after_sales_amount: 100 })]
    await importTicket(pool, ORG, cleaned)
    const sums = await reconcileTicketSums(pool, ORG, expectedTicketSums(cleaned))
    expect(sums).toHaveLength(2)
    for (const s of sums) expect(s.ok, `${s.label}: expected=${s.expected} actual=${s.actual}`).toBe(true)
  })
})
