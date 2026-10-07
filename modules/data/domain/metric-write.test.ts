// metric-write.test.ts — 写路径的判定链 + 审计（#489）。域层测试，不碰 Hono。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertL1Metric } from './metric-store'
import { deleteMetricDeclaration, writeL2Declaration } from './metric-write'
import { listMetricAudit } from './metric-audit-store'
import type { Requester } from './authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-ma-write'
const L1 = 'ma_l1_base'

/** 身份夹具：pat 通道、带 key_id（审计的身份三件套都非空，最严的形状）。 */
const req = (userId = 'ZhangDuo'): Requester => ({
  userId, orgId: ORG, channel: 'pat', keyId: 3, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
})
const deps = (pool: Pool, userId = 'ZhangDuo') =>
  ({ pool, adoptedSources: new Set<string>(), requester: req(userId) })

const decl = {
  baseMetric: L1,
  op: { kind: 'refine' } as const,
  alias: '别名',
  visibility: { dims: ['bizday'] },
}

describePg('写路径的审计（#489）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeAll(async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, {
      id: L1, title: '基底', description: '', requiredScope: null, subjectColumn: 'org',
      // 合 L1 的形状契约：`select <表达式> as value [, <维度>…] from <关系>`
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday', params: {}, sourceSystem: null,
    })
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = $1`, [L1]).catch(() => {})
    await pool.end()
  })

  it('★ 建 → 改 → 删：审计三行，前后态各就各位（含「从什么到什么」与删除留证）', async () => {
    expect((await writeL2Declaration(deps(pool), ORG, 'ma_l2', decl)).ok).toBe(true)
    expect((await writeL2Declaration(deps(pool), ORG, 'ma_l2', { ...decl, alias: '改过的' })).ok).toBe(true)
    expect((await deleteMetricDeclaration(deps(pool), ORG, 'ma_l2')).ok).toBe(true)

    const rows = await listMetricAudit(pool, ORG, 'ma_l2')
    expect(rows.map((r) => r.action)).toEqual(['delete', 'update', 'create'])
    expect(rows[2]!.before).toBeNull()                        // create：无前态
    expect(rows[2]!.after!.title).toContain('别名')            // 后态 = 落库的口径
    expect(rows[1]!.before!.title).toContain('别名')           // ★「从什么」
    expect(rows[1]!.after!.title).toContain('改过的')          // ★「到什么」
    expect(rows[0]!.before!.title).toContain('改过的')         // ★ 删除留证（被删时是什么）
    expect(rows[0]!.after).toBeNull()
    expect(rows[0]!.userId).toBe('ZhangDuo')                   // 记的是**人**
    expect(rows[0]!.channel).toBe('pat')
    expect(rows[0]!.keyId).toBe(3)
  })

  it('★ 审计与变更同生共死：审计写失败 ⇒ 行也必须回滚（不留半成品）', async () => {
    // userId=null 会让 metric_audit.user_id（not null）拒绝 ⇒ 整个事务回滚
    const broken = deps(pool, null as unknown as string)
    await expect(writeL2Declaration(broken, ORG, 'ma_tx', decl)).rejects.toThrow()
    const gone = await pool.query(`select 1 from data.metrics where org = $1 and id = 'ma_tx'`, [ORG])
    expect(gone.rowCount).toBe(0)                              // ★ 变更没留下
    expect((await listMetricAudit(pool, ORG, 'ma_tx')).length).toBe(0)
  })

  it('★ 一次写只落一行审计（防将来在路由层「再补一次」⇒ 双记）', async () => {
    expect((await writeL2Declaration(deps(pool), ORG, 'ma_once', decl)).ok).toBe(true)
    expect((await listMetricAudit(pool, ORG, 'ma_once')).length).toBe(1)
    expect((await deleteMetricDeclaration(deps(pool), ORG, 'ma_once')).ok).toBe(true)
    expect((await listMetricAudit(pool, ORG, 'ma_once')).length).toBe(2)   // 删也恰好一行
  })

  it('删除不存在的行：不落审计（NOT_FOUND 不是一次变更）', async () => {
    const r = await deleteMetricDeclaration(deps(pool), ORG, 'ma_nope')
    expect(r).toMatchObject({ ok: false, error: 'NOT_FOUND' })
    expect((await listMetricAudit(pool, ORG, 'ma_nope')).length).toBe(0)
  })
})
