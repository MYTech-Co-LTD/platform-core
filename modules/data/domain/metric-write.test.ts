// metric-write.test.ts — 写路径的判定链 + 审计（#489）。域层测试，不碰 Hono。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertL1Metric } from './metric-store'
import { deleteMetricDeclaration, writeL2Declaration, writePrivateMeasure } from './metric-write'
import type { PrivateMeasureWriteDeps } from './metric-write'
import { listMetricAudit } from './metric-audit-store'
import type { Requester } from './authz'
import type { RelationColumn } from './private-measure'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-ma-write'
const L1 = 'ma_l1_base'
/** 带值级掩码的 L1 基底：L2 不得建立在它之上（spec 2026-10-17 §5.3.1，fail-closed）。 */
const MASKED_L1 = 'ma_l1_masked_base'
/** 私有测度白名单探针：L1 已用 mart 是 `pm_write_mart`（真实列由测试缝给）。 */
const PM_L1 = 'ma_l1_private'
const PM_RELATION = 'pm_write_mart'

/** 身份夹具：pat 通道、带 key_id（审计的身份三件套都非空，最严的形状）。 */
const req = (userId = 'ZhangDuo', scopes: string[] = ['data:manage']): Requester => ({
  userId, orgId: ORG, channel: 'pat', keyId: 3, scopes,
  hasScope: (c) => scopes.includes(c),
})
const deps = (pool: Pool, userId = 'ZhangDuo', scopes: string[] = ['data:manage']) =>
  ({ pool, adoptedSources: new Set<string>(), requester: req(userId, scopes) })

/** 私有测度路径的「实际列」（information_schema 的归一形状）。 */
const PM_COLUMNS: RelationColumn[] = [
  { name: 'org', dataType: 'text' },
  { name: 'day', dataType: 'date' },
  { name: 'amount', dataType: 'numeric' },
  { name: 'branch', dataType: 'text' },
]

const pmDeps = (pool: Pool, over: Partial<PrivateMeasureWriteDeps> = {}): PrivateMeasureWriteDeps => ({
  pool,
  requester: req(),
  loadColumns: async () => PM_COLUMNS,
  ...over,
})

const pmInput = (over: Record<string, unknown> = {}) => ({
  id: 'ma_pm_sales',
  // title 派生自 id（显式 title 照旧覆盖）：047 部门内同名互斥后，多行夹具共用一个
  // 默认标题会在同 org 里互相顶掉（同 owner_dept 桶 lower(title) 冲突）。
  title: `自定义销售额·${(over.id as string) ?? 'ma_pm_sales'}`,
  description: '按日汇总',
  agg: 'sum' as const,
  column: 'amount',
  dims: ['day'],
  relation: PM_RELATION,
  ...over,
})

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
    // 私有测度的白名单来源：L1 已用 mart = pm_write_mart（真实列由 loadColumns 测试缝给）
    await upsertL1Metric(pool, {
      id: PM_L1, title: '私有测度基底', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(pm_write_mart.amount) as value, day from pm_write_mart',
      groupBy: 'day', params: {}, sourceSystem: null,
      slaDays: 1, freshnessRelations: [], masks: null,
    })
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = any($1)`, [[L1, MASKED_L1, PM_L1]]).catch(() => {})
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

  it('★ reveal 入审计快照（P6 Task 4 修复）：panel→report 翻转的前后态可读', async () => {
    const id = 'ma_reveal_audit'
    expect((await writeL2Declaration(deps(pool), ORG, id, { ...decl, alias: '审计 reveal' })).ok).toBe(true)
    expect((await writeL2Declaration(deps(pool), ORG, id, { ...decl, alias: '审计 reveal' },
      { ownership: { reveal: 'report' } })).ok).toBe(true)

    const rows = await listMetricAudit(pool, ORG, id)
    expect(rows.map((r) => r.action)).toEqual(['update', 'create'])
    // 首建：列默认 panel（快照读的是落库真值，不是入参）
    expect(rows[1]!.before).toBeNull()
    expect(rows[1]!.after!.reveal).toBe('panel')
    // 翻转：安全相关字段的「从什么到什么」必须能从审计直接读出
    expect(rows[0]!.before!.reveal).toBe('panel')
    expect(rows[0]!.after!.reveal).toBe('report')
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

  // ── creator 闸（spec 2026-11-01 §10.2；评审 PR #1271 发现 #4）──────────────────
  // 「L2 非我创建 ⇒ 只读」是域层判定（HTTP PUT 与 MCP customize 共用本函数 = 共用这份闸）。
  // P6 Task 2 修复轮：域层门 = **creator ∪ data:manage**（与 updateMetricMeta :348-351 同形）——
  // 提交人 ≠ 采纳人（agent 提案、人决策），决策端点本身已要求 data:manage，域层不认 manage
  // 会让「agent 提单 + 管理员采纳」恒 403。
  it('★ creator 闸：非 creator 且无 data:manage 改/删别人的 L2 ⇒ 403，行原样不动', async () => {
    const id = 'ma_gate_l2'
    expect((await writeL2Declaration(deps(pool), ORG, id, decl)).ok).toBe(true)   // creator = ZhangDuo
    const before = await pool.query(
      `select version, title from data.metrics where org = $1 and id = $2`, [ORG, id])
    const r = await writeL2Declaration(deps(pool, 'WangDuo', ['data:query']), ORG, id, { ...decl, alias: '别人改的' })
    expect(r).toMatchObject({ ok: false, http: 403, error: 'NOT_METRIC_CREATOR' })
    const d = await deleteMetricDeclaration(deps(pool, 'WangDuo', ['data:query']), ORG, id)
    expect(d).toMatchObject({ ok: false, http: 403, error: 'NOT_METRIC_CREATOR' })
    const after = await pool.query(
      `select version, title from data.metrics where org = $1 and id = $2`, [ORG, id])
    expect(after.rows[0].version).toBe(before.rows[0].version)     // ★ 一个字节都没动
    expect((await listMetricAudit(pool, ORG, id)).length).toBe(1)  // 也别记成一次变更
    // creator 自己（**无** data:manage）：update 与 delete 都通（同一闸，同一份判定）
    expect((await writeL2Declaration(deps(pool, 'ZhangDuo', ['data:query']), ORG, id,
      { ...decl, alias: '本人改的' })).ok).toBe(true)
    // data:manage 豁免（P6 Task 2 修复轮）：持 manage 的第三人可改/删
    expect((await writeL2Declaration(deps(pool, 'WangDuo'), ORG, id,
      { ...decl, alias: '管理员改的' })).ok).toBe(true)
    expect((await deleteMetricDeclaration(deps(pool, 'WangDuo'), ORG, id)).ok).toBe(true)
  })

  it('★ creator 闸：created_by 为 NULL 的存量行 fail-closed；持 data:manage 则放行（P6 Task 2 修复轮）', async () => {
    const id = 'ma_gate_legacy'
    // 直接落一条 created_by=NULL 的 L2（模拟「027 前的存量且无 create 审计」——028 也回填不出）
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by,
          params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations, created_by, certified)
       values ($1, $2, '存量', '', null, 'org', 'select 1 as value', '', '{}'::jsonb, 'l2', null, 'legacy', 1, false, null, null, null, 'draft')`,
      [ORG, id])
    const r = await writeL2Declaration(deps(pool, 'ZhangDuo', ['data:query']), ORG, id, decl)
    expect(r).toMatchObject({ ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' })
    const d = await deleteMetricDeclaration(deps(pool, 'ZhangDuo', ['data:query']), ORG, id)
    expect(d).toMatchObject({ ok: false, http: 403, error: 'METRIC_CREATOR_UNKNOWN' })
    // data:manage 豁免：孤儿行由管理员接管（否则没有任何人能修）
    expect((await writeL2Declaration(deps(pool), ORG, id, decl)).ok).toBe(true)
    expect((await deleteMetricDeclaration(deps(pool), ORG, id)).ok).toBe(true)
  })
})

// ── 私有测度写入（W2 Task 3）──────────────────────────────────────────────────────
// 新建 = 写**生效列**（select_sql/group_by）+ `basis='column_agg'` + `certified='draft'`；
// **不写 draft_spec**（D6 只管修改）。审计与变更同事务。
describePg('私有测度写入：生效列 + basis + draft + create 审计', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeAll(async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, {
      id: PM_L1, title: '私有测度基底', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(pm_write_mart.amount) as value, day from pm_write_mart',
      groupBy: 'day', params: {}, sourceSystem: null,
      slaDays: 1, freshnessRelations: [], masks: null,
    })
    // 反向跨档用例需要一条合法 L1 基底来编译树形 L2（本组独立于上一组的 beforeAll/afterAll）
    await upsertL1Metric(pool, {
      id: L1, title: '基底', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday', params: {}, sourceSystem: null,
      slaDays: 1, freshnessRelations: [], masks: null,
    })
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = any($1)`, [[PM_L1, L1]]).catch(() => {})
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('★ 新建：生效列编译自声明、basis=column_agg、certified=draft、created_by=操作人、draft_spec 为空', async () => {
    const r = await writePrivateMeasure(pmDeps(pool), ORG, pmInput())
    expect(r).toEqual({ ok: true })

    const row = (await pool.query(
      `select source, basis, certified, created_by, subject_column, select_sql, group_by, draft_spec, archived_at
         from data.metrics where org = $1 and id = 'ma_pm_sales'`, [ORG])).rows[0]
    expect(row).toMatchObject({
      source: 'l2',
      basis: 'column_agg',
      certified: 'draft',
      created_by: 'ZhangDuo',
      subject_column: 'org',
      select_sql: 'select sum(amount) as value, day from pm_write_mart',
      group_by: 'day',
      draft_spec: null,          // ★ D6：新建即时生效，不走草稿
      archived_at: null,
    })

    const audit = await listMetricAudit(pool, ORG, 'ma_pm_sales')
    expect(audit.map((a) => a.action)).toEqual(['create'])
    expect(audit[0]!.before).toBeNull()
    expect(audit[0]!.after!.selectSql).toBe('select sum(amount) as value, day from pm_write_mart')
    expect(audit[0]!.userId).toBe('ZhangDuo')
  })

  it('三闸失败：不在白名单 ⇒ 400 RELATION_NOT_ALLOWED；实际列查不到 ⇒ 500 COLUMNS_UNAVAILABLE', async () => {
    const notAllowed = await writePrivateMeasure(
      pmDeps(pool), ORG, pmInput({ id: 'ma_pm_bad_relation', relation: 'not_a_mart' }))
    expect(notAllowed).toMatchObject({ ok: false, http: 400, error: 'RELATION_NOT_ALLOWED' })

    const unavailable = await writePrivateMeasure(
      pmDeps(pool, { loadColumns: async () => [] }), ORG, pmInput({ id: 'ma_pm_no_columns' }))
    expect(unavailable).toMatchObject({ ok: false, http: 500, error: 'COLUMNS_UNAVAILABLE' })

    // 两道都失败 ⇒ 一行都没落、也没审计（判定链是只读的，失败不留半成品）
    const rows = await pool.query(
      `select id from data.metrics where org = $1 and id = any($2)`, [ORG, ['ma_pm_bad_relation', 'ma_pm_no_columns']])
    expect(rows.rowCount).toBe(0)
    expect((await listMetricAudit(pool, ORG, 'ma_pm_bad_relation')).length).toBe(0)
    expect((await listMetricAudit(pool, ORG, 'ma_pm_no_columns')).length).toBe(0)
  })

  it('★ L2 不得占 L1 的 id（占下会被加载侧丢弃 ⇒ 静默无效）⇒ 409 ID_RESERVED_BY_L1', async () => {
    const r = await writePrivateMeasure(pmDeps(pool), ORG, pmInput({ id: PM_L1 }))
    expect(r).toMatchObject({ ok: false, http: 409, error: 'ID_RESERVED_BY_L1' })
  })

  it('★ 跨档 upsert 显式拒绝：同 id 是树形 L2 ⇒ 409 BASIS_CONFLICT，原行不动', async () => {
    const id = 'ma_pm_basis_conflict'
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by,
          params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations,
          created_by, certified, basis)
       values ($1, $2, '树形行', '', null, 'org', 'select 1 as value', '', '{}'::jsonb,
               'l2', null, 'ZhangDuo', 1, false, null, null, 'ZhangDuo', 'draft', 'l1_tree')`,
      [ORG, id])

    const r = await writePrivateMeasure(pmDeps(pool), ORG, pmInput({ id }))
    expect(r).toMatchObject({ ok: false, http: 409, error: 'BASIS_CONFLICT' })
    const row = (await pool.query(
      `select basis, select_sql from data.metrics where org = $1 and id = $2`, [ORG, id])).rows[0]
    expect(row).toMatchObject({ basis: 'l1_tree', select_sql: 'select 1 as value' })
    expect((await listMetricAudit(pool, ORG, id)).length).toBe(0)
  })

  it('★ 反向跨档：树形 L2 写（D6 确认路径共用）不得落到私有测度行 ⇒ 409 BASIS_CONFLICT，原行不动', async () => {
    const id = 'ma_pm_reverse_conflict'
    expect((await writePrivateMeasure(pmDeps(pool), ORG, pmInput({ id }))).ok).toBe(true)
    const r = await writeL2Declaration(deps(pool), ORG, id, decl)   // creator 本人也拒
    expect(r).toMatchObject({ ok: false, http: 409, error: 'BASIS_CONFLICT' })
    const row = (await pool.query(
      `select basis, select_sql from data.metrics where org = $1 and id = $2`, [ORG, id])).rows[0]
    expect(row).toMatchObject({
      basis: 'column_agg',
      select_sql: 'select sum(amount) as value, day from pm_write_mart',
    })
    expect((await listMetricAudit(pool, ORG, id)).map((a) => a.action)).toEqual(['create'])
  })

  it('★ 同档且在用 ⇒ 409 METRIC_EXISTS（本端点只建不改；修改走 D6）', async () => {
    expect((await writePrivateMeasure(pmDeps(pool), ORG, pmInput({ id: 'ma_pm_exists' }))).ok).toBe(true)
    const again = await writePrivateMeasure(pmDeps(pool), ORG, pmInput({ id: 'ma_pm_exists', title: '改个名' }))
    expect(again).toMatchObject({ ok: false, http: 409, error: 'METRIC_EXISTS' })
    const row = (await pool.query(
      `select title, version from data.metrics where org = $1 and id = 'ma_pm_exists'`, [ORG])).rows[0]
    expect(row).toMatchObject({ title: '自定义销售额·ma_pm_exists', version: 1 })
  })

  it('★ 归档行可复活：creator（或 data:manage）重建立即回到在用；别人 403 且仍归档', async () => {
    const id = 'ma_pm_revive'
    expect((await writePrivateMeasure(pmDeps(pool), ORG, pmInput({ id }))).ok).toBe(true)
    // 管理员先升了可信度，再被淘汰：复活必须保留 certified（upsert 冲突分支不改它）
    await pool.query(
      `update data.metrics set archived_at = now(), certified = 'certified' where org = $1 and id = $2`,
      [ORG, id])

    // 非 creator 且无 data:manage ⇒ 403（fail-closed：归档行不能被人静默复活）
    const denied = await writePrivateMeasure(
      pmDeps(pool, { requester: req('WangDuo', ['data:query']) }), ORG, pmInput({ id }))
    expect(denied).toMatchObject({ ok: false, http: 403, error: 'NOT_METRIC_CREATOR' })
    const stillArchived = (await pool.query(
      `select archived_at from data.metrics where org = $1 and id = $2`, [ORG, id])).rows[0]
    expect(stillArchived.archived_at).not.toBeNull()

    // creator 本人 ⇒ 复活（archived_at 清空、revived_at 落锚点，内容按新声明重写）
    const revived = await writePrivateMeasure(
      pmDeps(pool), ORG, pmInput({ id, title: '复活后', column: 'branch', agg: 'count' }))
    expect(revived).toEqual({ ok: true })
    const row = (await pool.query(
      `select archived_at, revived_at, certified, title, select_sql
         from data.metrics where org = $1 and id = $2`, [ORG, id])).rows[0]
    expect(row).toMatchObject({
      archived_at: null,
      certified: 'certified',          // ★ 复活不改既有可信度
      title: '复活后',
      select_sql: 'select count(branch) as value, day from pm_write_mart',
    })
    expect(row.revived_at).not.toBeNull()   // ★ 生命周期锚点：下次 job 从复活时刻重新起算
    // 复活记为一次 create（生命周期事件，不是内容修改）；后态 certified 读实际值
    const audit = await listMetricAudit(pool, ORG, id)
    expect(audit.map((a) => a.action)).toEqual(['create', 'create'])
    expect(audit[0]!.after!.certified).toBe('certified')
  })

  it('★ 审计与变更同生共死：审计写失败 ⇒ 私有测度行也必须回滚', async () => {
    const broken = pmDeps(pool, { requester: req(null as unknown as string) })
    await expect(writePrivateMeasure(broken, ORG, pmInput({ id: 'ma_pm_tx' }))).rejects.toThrow()
    const gone = await pool.query(`select 1 from data.metrics where org = $1 and id = 'ma_pm_tx'`, [ORG])
    expect(gone.rowCount).toBe(0)
    expect((await listMetricAudit(pool, ORG, 'ma_pm_tx')).length).toBe(0)
  })
})
