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
/** 带值级掩码的 L1 基底：L2 不得建立在它之上（spec 2026-10-17 §5.3.1，fail-closed）。 */
const MASKED_L1 = 'ma_l1_masked_base'

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
      slaDays: 1, freshnessRelations: [], masks: null,
    })
    // 掩码列必须逐字出现在 selectSql 里（声明面的规则；夹具照真机形状）
    await upsertL1Metric(pool, {
      id: MASKED_L1, title: '带掩码的基底', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday', params: {}, sourceSystem: null,
      slaDays: 1, freshnessRelations: [],
      masks: [{ column: 'mart_sales_daily.revenue', kind: 'round', step: 1000, grantedBy: 'data:cost' }],
    })
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = any($1)`, [[L1, MASKED_L1]]).catch(() => {})
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

  // ── T4：L2 不得基于被掩码的 L1 构建（spec 2026-10-17 §5.3.1）──────────────────
  // 编译后表达式里已经没有那个列引用 ⇒ 运行期定点替换命中不了它。放行即旁路。
  it('★ 建：base 带 mask ⇒ 400 点名（L1 + 掩码），且不落行 / 不落审计', async () => {
    const r = await writeL2Declaration(deps(pool), ORG, 'ma_masked_l2', { ...decl, baseMetric: MASKED_L1 })
    expect(r).toMatchObject({ ok: false, http: 400, error: 'L2_BASE_MASKED' })
    expect((r as { extra?: Record<string, unknown> }).extra).toMatchObject({ base: MASKED_L1 })
    const gone = await pool.query(`select 1 from data.metrics where org = $1 and id = 'ma_masked_l2'`, [ORG])
    expect(gone.rowCount).toBe(0)                                  // ★ 不是「静默放行 + 记日志」
    expect((await listMetricAudit(pool, ORG, 'ma_masked_l2')).length).toBe(0)
  })

  it('★ 改：既有 L2 改指向带 mask 的 base ⇒ 同样 400，旧行原样不动', async () => {
    expect((await writeL2Declaration(deps(pool), ORG, 'ma_masked_update', decl)).ok).toBe(true)
    // ★ 判「旧行原样不动」的判据必须是**这次写会改掉的**字段（T4-①，issue #824）：
    //   两条基底（L1 / MASKED_L1）的 select_sql **逐字相同** ⇒ 比 select_sql 是恒真的空断言。
    //   `version` 是 upsert 的 `version = version + 1`（metric-store.ts），失败的事务连它一起
    //   回滚 ⇒ 未变 = 确实一个字节都没写进去。
    const before = await pool.query(
      `select version, title from data.metrics where org = $1 and id = 'ma_masked_update'`, [ORG])
    const r = await writeL2Declaration(deps(pool), ORG, 'ma_masked_update', { ...decl, baseMetric: MASKED_L1 })
    expect(r).toMatchObject({ ok: false, http: 400, error: 'L2_BASE_MASKED' })
    const after = await pool.query(
      `select version, title, select_sql from data.metrics where org = $1 and id = 'ma_masked_update'`, [ORG])
    expect(after.rows[0].version).toBe(before.rows[0].version)     // ★ 旧行没被改写
    expect(after.rows[0].title).toBe(before.rows[0].title)
    expect(after.rows[0].select_sql).toContain('mart_sales_daily')  // 仍编译自未掩码的 L1
    expect((await listMetricAudit(pool, ORG, 'ma_masked_update')).length).toBe(1)  // 只有最初的 create
    await deleteMetricDeclaration(deps(pool), ORG, 'ma_masked_update')
  })
})
