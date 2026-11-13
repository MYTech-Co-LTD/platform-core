// discovery.test.ts — 四个发现工具：词表裁剪复用 visibleMetrics、样本走 authorizeCore、行限 ≤50。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { describeDatasetImpl, describeMetricImpl, sampleDimensionValuesImpl, searchImpl } from './discovery'
import type { ToolboxDeps } from './registry'
import { upsertMetric, type MetricRow } from '../metric-store'
import type { Requester } from '../authz'
import { applyMigrations, applyPlatformMigrations } from '../../test-util'

const row = (over: Partial<MetricRow>): MetricRow => ({
  id: 'lemeng:retail:net_sales', title: '净销', description: '净销售额\n第二行',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select org, branch_name, bizday, sum(v) as value from fct group by org, branch_name, bizday',
  groupBy: 'org, branch_name, bizday', params: {}, source: 'l1', sourceSystem: 'lemeng',
  updatedBy: null, version: 1, totalable: true, scopeNote: '', slaDays: 2,
  freshnessRelations: ['stg_lemeng_retail_order_line'], masks: null,
  // W0（031）：MetricRow 上两字段**恒有值**（未声明 = null / []）——夹具必须同形，
  // 否则读侧 `.some(...)` 会撞上 undefined（假红/假绿都不可信）。
  entity: null, synonyms: [],
  // W2（034）：档与归档态恒有值——夹具同形（L1 恒树形 / 恒未归档）
  basis: 'l1_tree', archivedAt: null,
  ...over,
}) as MetricRow

const requester: Requester = { userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1, scopes: ['data:query'], hasScope: (c) => c === 'data:query' }

function deps(
  catalog: MetricRow[],
  wh: ToolboxDeps['wh'] = async () => ({ columns: [], rows: [] }),
  // 观看者的直属部门（P3 Task 1 投影测试用）：夹具行带 owner_dept 时，部门可见守卫
  // （deptContextIfOwned → loadDeptContext）会对 pool 发 v_org_membership 查询——
  // 假执行器按 SQL 形状分流：部门查询回直属集，其余照旧回词表行。
  deptDirect: string[] = [],
): ToolboxDeps {
  return {
    pool: {
      query: async (sql: string) => sql.includes('v_org_membership')
        ? { rows: deptDirect.map((extId) => ({ direct_id: extId, direct_path: extId, desc_id: null })) }
        : { rows: catalog.map((m) => ({
          id: m.id, title: m.title, description: m.description, required_scope: m.requiredScope,
          subject_column: m.subjectColumn, select_sql: m.selectSql, group_by: m.groupBy,
          params: m.params, source: m.source, source_system: m.sourceSystem,
          updated_by: m.updatedBy, version: m.version, totalable: m.totalable, scope_note: m.scopeNote,
          sla_days: m.slaDays, freshness_relations: m.freshnessRelations, mask_spec: m.masks,
          entity: m.entity, synonyms: m.synonyms,
          // 下钻三列（capabilities.detail 的判据）：夹具带 drill 时同形映射，缺省 NULL
          drill_expr: m.drill?.expr ?? null, drill_dims: m.drill?.dims ?? null,
          drill_detail: m.drill === undefined ? null
            : { relation: m.drill.relation, filter: m.drill.filter, ...(m.drill.columns === undefined ? {} : { columns: m.drill.columns }) },
          // 归属三列（P1/P2）：投影测试要带值走通可见守卫，缺省 NULL（= 平台通用桶）
          owner_dept: m.ownerDept ?? null, variant_note: m.variantNote ?? null, visible_depts: m.visibleDepts ?? null,
        })) },
    } as never,
    org: 'acme', requester, adoptedSources: new Set(['lemeng']), wh,
  }
}

describe('searchImpl', () => {
  it('只列可见指标（源裁剪）；tier/owner/oneLiner 派生正确；≤20 条', async () => {
    const foreign = row({ id: 'other:x', sourceSystem: 'other', title: '别家' })
    const out = await searchImpl(deps([row({}), foreign]), { kind: 'metric' })
    const results = (out.payload as { results: { id: string; tier: string; owner: string; oneLiner: string }[] }).results
    expect(results.map((r) => r.id)).toEqual(['lemeng:retail:net_sales'])
    expect(results[0].tier).toBe('certified')
    expect(results[0].owner).toBe('data-platform')
    expect(results[0].oneLiner).toBe('净销售额')
  })
  it('q 与 tier 过滤生效', async () => {
    const custom = row({ id: 'acme:custom:1', source: 'l2' as const, sourceSystem: null, title: '自定义' })
    const d = deps([row({}), custom])
    const byQ = await searchImpl(d, { q: '自定义' })
    expect((byQ.payload as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(['acme:custom:1'])
    const byTier = await searchImpl(d, { tier: 'custom' })
    expect((byTier.payload as { results: { id: string }[] }).results.map((r) => r.id)).toEqual(['acme:custom:1'])
  })
  it('搜索按匹配强度排序：标题/同义词命中优先于「说明里顺带提过」', async () => {
    const noisy = row({ id: 'lemeng:branch:transfer_money', title: '门店配送金额', description: '与外部批发互为镜像的口径' })
    const exact = row({ id: 'lemeng:outbound:external_wholesale', title: '外部批发金额', description: '外部客户批发' })
    const out = await searchImpl(deps([noisy, exact]), { kind: 'metric', q: '外部批发金额' })
    const ids = (out.payload as { results: { id: string }[] }).results.map((r) => r.id)
    expect(ids[0], '说明命中压过了标题命中 ⇒ 模型会选错指标').toBe('lemeng:outbound:external_wholesale')
  })

  it('search_catalog 命中同义词', async () => {
    // W0（031）：q 的命中面除 id/title/description 外还含声明的同义词——问数入口说
    // 「营业额」时，指标 `net_sales`（标题「净销」）必须在结果里。
    const out = await searchImpl(deps([row({ synonyms: ['营业额'] })]), { kind: 'metric', q: '营业额' })
    const results = (out.payload as { results: { id: string }[] }).results
    expect(results.map((r) => r.id)).toContain('lemeng:retail:net_sales')
  })
  // ── P3 Task 1：同名 tie 检测 + 投影带口径 ─────────────────────────────────────
  it('同名 tie：顶分集合里 ≥2 条不同 id 的 title 相同 ⇒ ambiguous:true 且两条都在 results', async () => {
    const a = row({ id: 'acme:custom:yingye_a', source: 'l2' as const, sourceSystem: null, title: '营业额' })
    const b = row({ id: 'lemeng:retail:yingye_b', title: '营业额' })
    const out = await searchImpl(deps([a, b]), { kind: 'metric', q: '营业额' })
    const payload = out.payload as { results: { id: string }[]; ambiguous?: true }
    // 歧义必须显式回给调用方——同分组静默取先 = 模型拿到哪条算哪条（错答温床）
    expect(payload.ambiguous).toBe(true)
    expect(payload.results.map((r) => r.id).sort()).toEqual(['acme:custom:yingye_a', 'lemeng:retail:yingye_b'])
  })
  it('同名但分数不同（一精确命中一说明顺带）⇒ 无 ambiguous 键', async () => {
    const exact = row({ id: 'acme:custom:yingye_exact', source: 'l2' as const, sourceSystem: null, title: '营业额' })
    const noisy = row({ id: 'lemeng:retail:other', title: '别的指标', description: '说明里顺带提到营业额' })
    const out = await searchImpl(deps([exact, noisy]), { kind: 'metric', q: '营业额' })
    const payload = out.payload as { results: { id: string }[]; ambiguous?: true }
    expect(payload.results[0]!.id).toBe('acme:custom:yingye_exact')
    // ambiguous 只在为真时出现（缺省 = 不歧义，旧消费者零破坏）
    expect('ambiguous' in payload).toBe(false)
  })
  it('单条命中 ⇒ 无 ambiguous 键', async () => {
    const out = await searchImpl(deps([row({})]), { kind: 'metric', q: '净销' })
    expect('ambiguous' in out.payload).toBe(false)
    expect((out.payload as { results: unknown[] }).results).toHaveLength(1)
  })
  it('同义词 tie：title 不同但 synonyms 都精确含 q ⇒ ambiguous 且两条都在 results（#813 毛/净形态）', async () => {
    // 生产 L1 词表实况（dbt/semantics/l1_metrics.yml）：sales 与 net_sales 的 synonyms 都含
    // 「营业额」而 title 不同——旧判据只按 lower(title) 分组 ⇒ 不歧义 ⇒ 静默按 id 序取
    // net_sales，正是 #813 毛/净口径混淆的形态。tie 键必须扩到「共享精确命中面」。
    const gross = row({
      id: 'lemeng:retail:sales', title: '销售额（不冲退货）',
      synonyms: ['销售金额', '营业额', '营业额（不冲退货）'],
    })
    const net = row({
      id: 'lemeng:retail:net_sales', title: '净销售额',
      synonyms: ['净销售金额', '营业额', '营业额（冲退货）'],
    })
    const out = await searchImpl(deps([gross, net]), { kind: 'metric', q: '营业额' })
    const payload = out.payload as { results: { id: string }[]; ambiguous?: true }
    expect(payload.ambiguous).toBe(true)
    expect(payload.results.map((r) => r.id).sort())
      .toEqual(['lemeng:retail:net_sales', 'lemeng:retail:sales'])
  })
  it('顶分并列但无共享命中面（title/同义词皆不同）⇒ 无 ambiguous 键（顶分+共享面双条件）', async () => {
    const a = row({ id: 'acme:custom:jia', source: 'l2' as const, sourceSystem: null, title: '甲指标' })
    const b = row({ id: 'lemeng:retail:yi', title: '乙指标' })
    const out = await searchImpl(deps([a, b]), { kind: 'metric', q: '指标' })
    expect('ambiguous' in out.payload).toBe(false)
  })
  it('浏览态（q 缺席）⇒ 永不 ambiguous（哪怕有同名对）', async () => {
    const a = row({ id: 'acme:custom:yingye_a', source: 'l2' as const, sourceSystem: null, title: '营业额' })
    const b = row({ id: 'lemeng:retail:yingye_b', title: '营业额' })
    const out = await searchImpl(deps([a, b]), { kind: 'metric' })
    expect('ambiguous' in out.payload).toBe(false)
    expect((out.payload as { results: unknown[] }).results).toHaveLength(2)
  })
  it('投影带 dept/variantNote：声明了带值，未声明为 null', async () => {
    const owned = row({
      id: 'acme:custom:owned', source: 'l2' as const, sourceSystem: null,
      title: '部门营业额', description: '部门口径的营业额', ownerDept: 'd1', variantNote: '含税口径',
    })
    // 带 owner_dept 的行走真实可见守卫：viewer 直属 d1 ⇒ 链上可见（fail-closed 的反面即本例）
    const d = { ...deps([owned, row({})], undefined, ['d1']), requester: { ...requester, tenantId: 1, accountName: 'u' } }
    const out = await searchImpl(d, { kind: 'metric', q: '部门营业额' })
    const results = out.payload as { results: { id: string; dept: string | null; variantNote: string | null }[] }
    expect(results.results).toHaveLength(1)
    expect(results.results[0]).toMatchObject({ id: 'acme:custom:owned', dept: 'd1', variantNote: '含税口径' })
    const plain = await searchImpl(d, { kind: 'metric', q: '净销' })
    const pr = plain.payload as { results: { id: string; dept: string | null; variantNote: string | null }[] }
    expect(pr.results[0]).toMatchObject({ id: 'lemeng:retail:net_sales', dept: null, variantNote: null })
  })
  it('kind=dataset：DENYLIST schema 不出现', async () => {
    const d = deps([], async () => ({ columns: ['table_schema', 'table_name'], rows: [['pg_catalog', 'pg_class'], ['marts', 'fct_retail_sale']] }))
    const out = await searchImpl(d, { kind: 'dataset' })
    const results = (out.payload as { results: { id: string }[] }).results
    expect(results.map((r) => r.id)).toEqual(['marts.fct_retail_sale'])
  })
})

describe('describeMetricImpl', () => {
  it('可见指标回 grain/params/version；未接入源/未声明 ⇒ not_found（404 语义）', async () => {
    const out = await describeMetricImpl(deps([row({})]), { id: 'lemeng:retail:net_sales' })
    const p = out.payload as { status: string; grain: string[]; params: Record<string, unknown> }
    expect(p.status).toBe('ok')
    expect(p.grain).toEqual(['org', 'branch_name', 'bizday'])
    const nf = await describeMetricImpl(deps([row({})]), { id: 'nope' })
    expect(nf.isError).toBe(true)
    expect(nf.payload).toMatchObject({ status: 'not_found', metricId: 'nope' })
  })
  it('asOf：声明了链路且水位可查 ⇒ 在场；查不到 ⇒ 缺席（未知≠编造）', async () => {
    const withWater = deps([row({})], async (sql) => sql.includes('load_log')
      ? { columns: ['watermark', 'materialized_at'], rows: [['2026-10-20', new Date('2026-10-21T02:10:00+08:00')]] }
      : { columns: [], rows: [] })
    const ok = await describeMetricImpl(withWater, { id: 'lemeng:retail:net_sales' })
    expect((ok.payload as { asOf?: { dataThrough: string } }).asOf?.dataThrough).toBe('2026-10-20')
    const none = await describeMetricImpl(deps([row({})]), { id: 'lemeng:retail:net_sales' })
    expect('asOf' in none.payload).toBe(false)
  })
  it('coverage：grain 含 bizday 且 min/max 可查 ⇒ 在场；查询失败/无 bizday ⇒ 缺席', async () => {
    const wh = async (sql: string) => sql.includes('min(bizday)')
      ? { columns: ['min', 'max'], rows: [['2024-11-01', '2026-11-08']] }
      : { columns: [], rows: [] }
    const shaped = row({ selectSql: 'select sum(v) as value, org, branch_name, bizday from fct' })
    const out = await describeMetricImpl(deps([shaped], wh), { id: 'lemeng:retail:net_sales', coverage: true })
    expect((out.payload as { coverage?: { minBizday: string; maxBizday: string } }).coverage)
      .toEqual({ minBizday: '2024-11-01', maxBizday: '2026-11-08' })
    const noDay = await describeMetricImpl(deps([row({ groupBy: 'org, branch_name', selectSql: 'select sum(v) as value, org, branch_name from fct' })], wh), { id: 'lemeng:retail:net_sales', coverage: true })
    expect('coverage' in noDay.payload).toBe(false)
  })

  it('capabilities：detail 看 drill 绑定，topN 看可加且有非日期维度', async () => {
    const withDrill = row({
      totalable: true,
      drill: { expr: 'sum(v)', dims: ['branch_num'], relation: 'vw_t', filter: 'true' } as never,
    })
    const a = await describeMetricImpl(deps([withDrill]), { id: 'lemeng:retail:net_sales' })
    expect((a.payload as { capabilities: unknown }).capabilities).toEqual({ detail: true, topN: true })
    const plain = row({ totalable: true, groupBy: 'bizday', selectSql: 'select sum(v) as value, bizday from fct' })
    const b = await describeMetricImpl(deps([plain]), { id: 'lemeng:retail:net_sales' })
    expect((b.payload as { capabilities: unknown }).capabilities).toEqual({ detail: false, topN: false })
  })

  it('describe_metric 返回 entity/synonyms', async () => {
    const out = await describeMetricImpl(deps([row({ entity: 'branch', synonyms: ['营业额'] })]), { id: 'lemeng:retail:net_sales' })
    expect((out.payload as { entity: string }).entity).toBe('branch')
    expect((out.payload as { synonyms: string[] }).synonyms).toEqual(['营业额'])
    // 「未声明 = 字段缺席」：没声明实体/同义词 ⇒ payload 里不出现这两个键
    const bare = await describeMetricImpl(deps([row({})]), { id: 'lemeng:retail:net_sales' })
    expect('entity' in bare.payload).toBe(false)
    expect('synonyms' in bare.payload).toBe(false)
  })
})

describe('sampleDimensionValuesImpl', () => {
  const whOf = (rows: unknown[][]) => async () => ({ columns: ['value', 'n'], rows })
  it('行数 = min(limit, 50)；审计带 metricId 与 rowCount', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => [`店${i}`, 10 - i])
    const out = await sampleDimensionValuesImpl(deps([row({})], whOf(rows)), { metricId: 'lemeng:retail:net_sales', dimension: 'branch_name' })
    expect((out.payload as { values: unknown[] }).values).toHaveLength(50)
    expect(out.auditMetricId).toBe('lemeng:retail:net_sales')
    expect(out.auditRowCount).toBe(50)
    expect((out.payload as { truncated: boolean }).truncated).toBe(true)
  })
  it('未知维度 ⇒ denied（bad_param/unknown_dimension）；q 经 LIKE 转义', async () => {
    const bad = await sampleDimensionValuesImpl(deps([row({})]), { metricId: 'lemeng:retail:net_sales', dimension: 'nope' })
    expect(bad.isError).toBe(true)
    expect(bad.payload).toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'unknown_dimension:nope' })
    const seen: string[] = []
    const d = deps([row({})], async (sql) => { seen.push(sql); return { columns: ['value', 'n'], rows: [] } })
    await sampleDimensionValuesImpl(d, { metricId: 'lemeng:retail:net_sales', dimension: 'branch_name', q: '100%店' })
    expect(seen[0]).toContain("like '%100\\%店%'")
  })
  it('指标不存在 ⇒ denied 透传 authorizeCore 拒因（不自建判定）', async () => {
    const out = await sampleDimensionValuesImpl(deps([row({})]), { metricId: 'nope', dimension: 'org' })
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
  })
})

// ── 真库执行段（#991）─────────────────────────────────────────────────────────
// 教训：sample 的 SQL 语义**只有真库能证伪**——假执行器（上面几段）收什么回什么，
// SQL 写错照绿。事故形态：外层别名 `value` 与内层度量列 `value` 同名，PG 解析 `group by value`
// 时优先**输入列** ⇒ 维度列未分组 ⇒ 生产必炸 `column "t.<dim>" must appear in the GROUP BY clause`。
// 故本段把同一条组装链（authorizeCore → 外层聚合）放到真 PG 上跑一遍。
const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

describePg('sampleDimensionValuesImpl 真库执行（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => { await pool.end() })

  // 指标内层 select 的形状 = 编译器产物（buildSelectSql：`select <expr> as value, <grain> from <rel>`，
  // 不含 GROUP BY —— GROUP BY 由授权核心追加，主体列 org 必在 grain 里）。
  // 数据用 VALUES 现造，不依赖任何业务表。
  const probe = row({
    id: 'probe:sample:1',
    subjectColumn: 'org',
    selectSql: 'select v.org, v.bizday, v.store_name, sum(v.amount) as value from (values'
      + " ('acme', '2026-10-01'::date, '北部店', 10.0), ('acme', '2026-10-02'::date, '北部店', 5.0),"
      + " ('acme', '2026-10-01'::date, '南部店', 7.0), ('acme', '2026-10-01'::date, '东部店', 1.0)"
      + ') v(org, bizday, store_name, amount)',
    groupBy: 'org, bizday, store_name',
    sourceSystem: 'probe',
    masks: null,
  })
  const realDeps = (): ToolboxDeps => ({
    ...deps([probe]),
    adoptedSources: new Set(['probe']),
    wh: async (sql) => {
      const r = await pool.query(sql)
      return { columns: r.fields.map((f) => f.name), rows: r.rows.map((x) => Object.values(x) as unknown[]) }
    },
  })

  it('生成的外层聚合 SQL 在真库可执行，计数与维度值正确', async () => {
    const out = await sampleDimensionValuesImpl(realDeps(), { metricId: 'probe:sample:1', dimension: 'store_name' })
    expect(out.isError).toBe(false)
    const values = (out.payload as { values: { value: string; n: number }[] }).values
    expect(values).toHaveLength(3)
    expect(values[0]).toEqual({ value: '北部店', n: 2 })
    expect(values.reduce((s, v) => s + v.n, 0)).toBe(4)
  })

  it('q 过滤的是**维度值**（不是度量值）；limit 生效', async () => {
    const filtered = await sampleDimensionValuesImpl(realDeps(), { metricId: 'probe:sample:1', dimension: 'store_name', q: '北部' })
    expect((filtered.payload as { values: { value: string; n: number }[] }).values).toEqual([{ value: '北部店', n: 2 }])
    const capped = await sampleDimensionValuesImpl(realDeps(), { metricId: 'probe:sample:1', dimension: 'store_name', limit: 2 })
    expect((capped.payload as { values: unknown[]; truncated: boolean })).toMatchObject({ truncated: true })
    expect((capped.payload as { values: unknown[] }).values).toHaveLength(2)
  })

  it('防回归锚：旧写法（维度别名也叫 value）在真库必炸', async () => {
    // 钉死根因本身——若哪天有人把别名改回 `value`，这条会先于生产红。
    await expect(pool.query(
      'select store_name as value, count(*) as n from (select v.org, v.store_name, v.value'
      + " from (values ('acme','北部店',1.0)) v(org, store_name, value)) t group by value",
    )).rejects.toThrow(/must appear in the GROUP BY clause/)
  })
})

describe('describeDatasetImpl', () => {
  it('形状非法/DENYLIST ⇒ not_found；命中回列与类型', async () => {
    expect((await describeDatasetImpl(deps([]), { dataset: 'drop table' })).payload).toMatchObject({ status: 'not_found' })
    expect((await describeDatasetImpl(deps([]), { dataset: 'data.metrics' })).payload).toMatchObject({ status: 'not_found' })
    const d = deps([], async () => ({ columns: ['column_name', 'data_type'], rows: [['org', 'text'], ['bizday', 'date']] }))
    const out = await describeDatasetImpl(d, { dataset: 'marts.fct_retail_sale' })
    expect(out.payload).toMatchObject({ status: 'ok', dataset: 'marts.fct_retail_sale', org: 'acme' })
    expect((out.payload as { columns: unknown[] }).columns).toEqual([{ name: 'org', dataType: 'text' }, { name: 'bizday', dataType: 'date' }])
  })
})

// ── P2 Task 4：六面接线（部门可见性）——discovery/search 列表面代表用例 ────────────────
// 真库夹具（platform.org_* 底层真表 + data.metrics 行），org 与合成租户独立隔离。
describePg('searchImpl × 部门可见性（P2 Task 4）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const ORG_D = 'org-p2-vis-search'
  const TENANT_D = 9308 // query-service.test.ts 用 9307、metric-visibility 用 9207——错开
  const ROOT = 'org-p2-vis-s-root'
  const CHILD = 'org-p2-vis-s-child'
  const SIB = 'org-p2-vis-s-sib'
  const U_CHILD = 'org-p2-vis-s-u-child'
  const U_SIB = 'org-p2-vis-s-u-sib'

  const ownedRow = {
    id: 'p2_vis_search_owned', title: '部门归属的搜索面指标', description: '',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.p2_vis_search_owned', groupBy: '', params: {},
  }
  const plainRow = {
    id: 'p2_vis_search_plain', title: '平台通用的搜索面指标', description: '',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.p2_vis_search_plain', groupBy: '', params: {},
  }

  const realDeps = (requester: Requester): ToolboxDeps => ({
    pool, org: ORG_D, requester, adoptedSources: new Set<string>(), // 夹具全 L2 ⇒ 源维度不裁
    wh: async () => ({ columns: [], rows: [] }),
  })
  const reqOf = (userName: string, over: Partial<Requester> = {}): Requester => {
    const scopes = ['data:query']
    return {
      userId: userName, accountName: userName, orgId: ORG_D, channel: 'session', keyId: null,
      scopes, hasScope: (c) => scopes.includes(c), tenantId: TENANT_D, ...over,
    }
  }

  beforeAll(async () => {
    await applyMigrations(pool)
    await applyPlatformMigrations(pool)
    await pool.query(
      'insert into platform.tenant(id, slug, casdoor_org) values ($1, $2, $3) on conflict (id) do nothing',
      [TENANT_D, 'org-p2-vis-s-fixture', ORG_D],
    )
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT_D])
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT_D])
    const insDept = async (extId: string, parent: string | null, path: string) => {
      await pool.query(
        `insert into platform.org_node(tenant_id, ext_id, name, parent_ext_id, path, status)
         values ($1, $2, $3, $4, $5, 1)
         on conflict (tenant_id, ext_id) do update set parent_ext_id = excluded.parent_ext_id, path = excluded.path, status = 1`,
        [TENANT_D, extId, extId, parent, path],
      )
    }
    await insDept(ROOT, null, ROOT)
    await insDept(CHILD, ROOT, `${ROOT}.${CHILD}`)
    await insDept(SIB, null, SIB)
    const insMember = async (userName: string, extId: string) => {
      await pool.query(
        'insert into platform.org_membership(tenant_id, user_name, ext_id, is_primary) values ($1, $2, $3, true) on conflict do nothing',
        [TENANT_D, userName, extId],
      )
    }
    await insMember(U_CHILD, CHILD)
    await insMember(U_SIB, SIB)

    await pool.query('delete from data.metrics where org = $1', [ORG_D])
    await upsertMetric(pool, ORG_D, ownedRow, 'fixture')
    await upsertMetric(pool, ORG_D, plainRow, 'fixture')
    // 写侧暂无归属 API 面（P1 只建列）：夹具直改库设归属
    await pool.query('update data.metrics set owner_dept = $1 where org = $2 and id = $3', [CHILD, ORG_D, ownedRow.id])
  })

  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1', [ORG_D]).catch(() => {})
    await pool.query('delete from platform.org_membership where tenant_id = $1', [TENANT_D]).catch(() => {})
    await pool.query('delete from platform.org_node where tenant_id = $1', [TENANT_D]).catch(() => {})
    await pool.query('delete from platform.tenant where id = $1', [TENANT_D]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('链外观看者（直属 sib）：owned 行被过滤，平台桶行照列', async () => {
    const out = await searchImpl(realDeps(reqOf(U_SIB)), { kind: 'metric' })
    const ids = (out.payload as { results: { id: string }[] }).results.map((r) => r.id)
    expect(ids).not.toContain(ownedRow.id)
    expect(ids).toContain(plainRow.id)
  })

  it('链上观看者（直属 child，含祖先链）：owned 行照列（回归锁）', async () => {
    const out = await searchImpl(realDeps(reqOf(U_CHILD)), { kind: 'metric' })
    const ids = (out.payload as { results: { id: string }[] }).results.map((r) => r.id)
    expect(ids).toEqual([ownedRow.id, plainRow.id].sort())
  })
})
