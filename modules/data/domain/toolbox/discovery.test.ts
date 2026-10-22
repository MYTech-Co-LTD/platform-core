// discovery.test.ts — 四个发现工具：词表裁剪复用 visibleMetrics、样本走 authorizeCore、行限 ≤50。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { describeDatasetImpl, describeMetricImpl, sampleDimensionValuesImpl, searchImpl } from './discovery'
import type { ToolboxDeps } from './registry'
import type { MetricRow } from '../metric-store'
import type { Requester } from '../authz'

const row = (over: Partial<MetricRow>): MetricRow => ({
  id: 'lemeng:retail:net_sales', title: '净销', description: '净销售额\n第二行',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select org, branch_name, bizday, sum(v) as value from fct group by org, branch_name, bizday',
  groupBy: 'org, branch_name, bizday', params: {}, source: 'l1', sourceSystem: 'lemeng',
  updatedBy: null, version: 1, totalable: true, scopeNote: '', slaDays: 2,
  freshnessRelations: ['stg_lemeng_retail_order_line'], masks: null, ...over,
}) as MetricRow

const requester: Requester = { userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1, scopes: ['data:query'], hasScope: (c) => c === 'data:query' }

function deps(catalog: MetricRow[], wh: ToolboxDeps['wh'] = async () => ({ columns: [], rows: [] })): ToolboxDeps {
  return {
    pool: {
      query: async () => ({ rows: catalog.map((m) => ({
        id: m.id, title: m.title, description: m.description, required_scope: m.requiredScope,
        subject_column: m.subjectColumn, select_sql: m.selectSql, group_by: m.groupBy,
        params: m.params, source: m.source, source_system: m.sourceSystem,
        updated_by: m.updatedBy, version: m.version, totalable: m.totalable, scope_note: m.scopeNote,
        sla_days: m.slaDays, freshness_relations: m.freshnessRelations, mask_spec: m.masks,
      })) }),
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
