// candidate-generator.test.ts — W2 Task 5：画像 → 规则筛 → 候选池。
//
// 本文件钉的是**生成规则**（不是存储层，存储见 metric-candidates.test.ts）：
//   ① 排除 全空 / 基数=1 / 非数值且不可枚举 / 已被 L1「列×聚合」覆盖；
//   ② 每关系上限 20（可下调，不可上调）；
//   ③ 幂等：重复生成 = 刷新证据，不新增行、不复活人工决策；
//   ④ 两池分离：画像/列类型读**仓库池**，候选写**平台池**；
//   ⑤ 画像读不到 ⇒ PROFILE_UNAVAILABLE（不造假数据）。
//
// 仓库池在测试里一律注入 fake loader（不必真跑 duckle）；平台池用真库（DATABASE_URL）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricRow } from './metric-store'
import type { RelationColumn } from './private-measure'
import { applyMigrations } from '../test-util'
import { listCandidates, setCandidateStatus } from './metric-candidates'
import { generateCandidates, loadLatestProfiles } from './candidate-generator'
import type { CandidateGeneratorDeps, ProfileRow } from './candidate-generator'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-t5-candidate-gen'
const OTHER_ORG = 'org-t5-candidate-gen-OTHER'

let pool: Pool

/** L1 夹具（形状 = sync 物化的产物）。 */
function l1(over: Partial<MetricRow> = {}): MetricRow {
  return {
    id: 'lemeng:retail:net_sales',
    title: '净销售额',
    description: '',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday, branch_num from fct_retail_sale',
    groupBy: 'system_book, bizday, branch_num',
    params: {},
    source: 'l1',
    sourceSystem: 'lemeng',
    updatedBy: null,
    version: 1,
    totalable: false,
    slaDays: 1,
    freshnessRelations: [],
    masks: null,
    entity: null,
    synonyms: [],
    certified: 'certified',
    createdBy: null,
    bizDescription: null,
    unit: null,
    caliberNote: null,
    basis: 'l1_tree',
    archivedAt: null,
    ...over,
  }
}

/**
 * L1 词表：
 *   · 同关系的三条口径覆盖 `sum(net_amount)` / `count(distinct order_no)` / `count(distinct supplier_num)`；
 *   · 声明的 grain 是 system_book / bizday / branch_num（维度候选的唯一来源）。
 */
const CATALOG: MetricRow[] = [
  l1({ id: 'lemeng:retail:net_sales' }),
  l1({
    id: 'lemeng:retail:order_count',
    selectSql: 'select count(distinct fct_retail_sale.order_no) as value, system_book from fct_retail_sale',
    groupBy: 'system_book',
  }),
  l1({
    id: 'lemeng:purchase:supplier_count',
    selectSql: 'select count(distinct fct_retail_sale.supplier_num) as value from fct_retail_sale',
    groupBy: '',
  }),
  // 上限用例的独立关系（只覆盖 sum(c0)）
  l1({
    id: 'lemeng:big:total',
    selectSql: 'select sum(fct_big.c0) as value from fct_big',
    groupBy: '',
  }),
]

const SALE_COLUMNS: RelationColumn[] = [
  { name: 'net_amount', dataType: 'numeric' },
  { name: 'sale_amount', dataType: 'numeric' },
  { name: 'memo', dataType: 'text' },
  { name: 'status', dataType: 'text' },
  { name: 'empty_col', dataType: 'numeric' },
  { name: 'constant_col', dataType: 'text' },
  { name: 'system_book', dataType: 'text' },
  { name: 'bizday', dataType: 'date' },
  { name: 'branch_num', dataType: 'text' },
  { name: 'order_no', dataType: 'text' },
  { name: 'supplier_num', dataType: 'text' },
]

const BIG_COLUMNS: RelationColumn[] = Array.from({ length: 12 }, (_, i) => ({
  name: `c${i}`, dataType: 'numeric',
}))

const COLUMNS: Record<string, RelationColumn[]> = {
  'staging.fct_retail_sale': SALE_COLUMNS,
  'staging.fct_big': BIG_COLUMNS,
}

/** qa.profile 的逐列统计形状（只用到 count / null_percentage / approx_unique / column_type）。 */
function stats(over: Record<string, unknown> = {}) {
  return {
    column_type: 'VARCHAR', min: null, max: null, approx_unique: 0,
    avg: null, std: null, q25: null, q50: null, q75: null,
    count: 0, null_percentage: 0,
    ...over,
  }
}

function profile(relation: string, column: string, over: Record<string, unknown> = {}): ProfileRow {
  return { relation, column, stats: stats(over), profiledAt: '2026-11-04T16:00:00.000Z' }
}

const SALE_PROFILES: ProfileRow[] = [
  profile('staging.fct_retail_sale', 'net_amount', { column_type: 'DOUBLE', count: 1000, approx_unique: 900, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'sale_amount', { column_type: 'DOUBLE', count: 1000, approx_unique: 400, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'memo', { count: 1000, approx_unique: 950, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'status', { count: 1000, approx_unique: 3, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'empty_col', { column_type: 'DOUBLE', count: 1000, approx_unique: 0, null_percentage: 100 }),
  profile('staging.fct_retail_sale', 'constant_col', { count: 1000, approx_unique: 1, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'system_book', { count: 1000, approx_unique: 2, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'bizday', { column_type: 'DATE', count: 1000, approx_unique: 600, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'branch_num', { count: 1000, approx_unique: 40, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'order_no', { count: 1000, approx_unique: 1000, null_percentage: 0 }),
  profile('staging.fct_retail_sale', 'supplier_num', { count: 1000, approx_unique: 20, null_percentage: 0 }),
]

const BIG_PROFILES: ProfileRow[] = Array.from({ length: 12 }, (_, i) =>
  profile('staging.fct_big', `c${i}`, { column_type: 'DOUBLE', count: 1000, approx_unique: 500, null_percentage: 0 }),
)

const FAKE_WAREHOUSE = { kind: 'warehouse' } as unknown as Pool

/** 只依赖注入的 fake：仓库侧不碰真库（真实 SQL 见 loadLatestProfiles 的单测）。 */
function deps(over: Partial<CandidateGeneratorDeps> = {}): CandidateGeneratorDeps {
  return {
    pool,
    warehouse: FAKE_WAREHOUSE,
    loadCatalog: async () => CATALOG,
    loadProfiles: async () => SALE_PROFILES,
    loadColumns: async (_p, relation) => COLUMNS[relation] ?? [],
    ...over,
  }
}

describePg('candidate-generator（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
  })

  beforeEach(async () => {
    await pool.query('delete from data.metric_candidates where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metric_candidates where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ 规则筛：全空/基数=1/不可枚举被排除；L1 已覆盖的「列×聚合」跳过；其余按关系归一落库', async () => {
    const r = await generateCandidates(deps(), ORG)
    expect(r.ok).toBe(true)
    if (!r.ok) return

    expect(r.report).toMatchObject({
      org: ORG,
      profiles: 11,
      relations: 1,
      skippedRelations: 0,
      skipped: 7,
      added: 10,
      refreshed: 0,
      capped: 0,
      maxPerRelation: 20,
    })
    expect(r.report.skippedBy).toEqual({
      'no-stats': 0,
      'no-data': 0,
      'all-null': 1,          // empty_col
      'single-value': 1,      // constant_col
      'not-enumerable': 3,    // memo / bizday / order_no
      'column-type-unavailable': 0,
      'covered-by-l1': 2,     // sum(net_amount) / count(distinct supplier_num)
    })

    const rows = await listCandidates(pool, ORG)
    expect(rows).toHaveLength(10)
    expect(rows.every((c) => c.origin === 'profile' && c.status === 'pending')).toBe(true)
    // 关系归一：画像里的 `staging.fct_retail_sale` → 白名单里的 L1 关系（裸名），
    // 否则 adopt 会被闸①（relation ∉ L1 marts）拒掉。
    expect(rows.every((c) => c.relation === 'fct_retail_sale')).toBe(true)
    expect(rows.map((c) => `${c.expr.agg}(${c.expr.column})`).sort()).toEqual([
      'avg(net_amount)', 'avg(sale_amount)',
      'count(branch_num)', 'count(status)', 'count(supplier_num)', 'count(system_book)',
      'count_distinct(branch_num)', 'count_distinct(status)', 'count_distinct(system_book)',
      'sum(sale_amount)',
    ])

    const avgAmount = rows.find((c) => c.expr.agg === 'avg' && c.expr.column === 'net_amount')!
    // 维度候选 = 已声明 grain ∩ 低基数（bizday 600/1000 超出比例阈值 ⇒ 不进 dims）
    expect(avgAmount.expr.dims).toEqual(['system_book', 'branch_num'])
    expect(avgAmount.confidence).toBeCloseTo(0.83, 2)
    expect(avgAmount.rationale).toContain('avg(net_amount)')
    expect(avgAmount.evidence).toMatchObject({
      source: 'profile',
      profileRelation: 'staging.fct_retail_sale',
      dataType: 'numeric',
      count: 1000,
      nullPercentage: 0,
      approxUnique: 900,
      profiledAt: '2026-11-04T16:00:00.000Z',
    })
  })

  it('★ 幂等：重复生成只刷新证据（added=0 / refreshed=N），不复活人工决策', async () => {
    const first = await generateCandidates(deps(), ORG)
    expect(first.ok && first.report.added).toBe(10)

    const again = await generateCandidates(deps(), ORG)
    expect(again.ok).toBe(true)
    if (!again.ok) return
    expect(again.report).toMatchObject({ added: 0, refreshed: 10, skipped: 7 })
    expect(await listCandidates(pool, ORG)).toHaveLength(10)

    // 人工拒绝是终态：重新 profiling 不得复活（只刷证据）
    const one = (await listCandidates(pool, ORG))[0]!
    expect(await setCandidateStatus(pool, ORG, one.id, 'rejected')).toBe(true)
    const third = await generateCandidates(deps(), ORG)
    expect(third.ok && third.report.refreshed).toBe(10)
    const after = await listCandidates(pool, ORG)
    expect(after.find((c) => c.id === one.id)!.status).toBe('rejected')
  })

  it('★ 每关系上限 20：超出的按置信度截断并计入 capped', async () => {
    const r = await generateCandidates(deps({
      loadProfiles: async () => BIG_PROFILES,
      loadColumns: async () => BIG_COLUMNS,
    }), ORG, { relations: ['fct_big'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // 12 列 × 2 聚合 = 24；c0 的 sum 已被 L1 覆盖 ⇒ 23 条候选 → 截到 20
    expect(r.report).toMatchObject({ added: 20, capped: 3, relations: 1, maxPerRelation: 20 })
    expect(await listCandidates(pool, ORG, { relation: 'fct_big' })).toHaveLength(20)
  })

  it('maxPerRelation 可下调、不可上调（>20 按 20 收口）', async () => {
    const small = await generateCandidates(deps({
      loadProfiles: async () => BIG_PROFILES,
      loadColumns: async () => BIG_COLUMNS,
    }), ORG, { relations: ['fct_big'], maxPerRelation: 3 })
    expect(small.ok && small.report.maxPerRelation).toBe(3)
    expect(small.ok && small.report.added).toBe(3)

    const tooBig = await generateCandidates(deps({
      loadProfiles: async () => BIG_PROFILES,
      loadColumns: async () => BIG_COLUMNS,
    }), ORG, { relations: ['fct_big'], maxPerRelation: 999 })
    expect(tooBig.ok && tooBig.report.maxPerRelation).toBe(20)
  })

  it('★ 只处理 L1 白名单内的关系；不在白名单的画像关系被跳过（不写候选）', async () => {
    const r = await generateCandidates(deps({
      loadProfiles: async () => [
        ...SALE_PROFILES,
        profile('staging.not_a_mart', 'x', { column_type: 'DOUBLE', count: 100, approx_unique: 50 }),
      ],
      loadColumns: async (_p, relation) => relation === 'staging.not_a_mart'
        ? [{ name: 'x', dataType: 'numeric' }]
        : COLUMNS[relation] ?? [],
    }), ORG)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.report).toMatchObject({ relations: 1, skippedRelations: 1, added: 10 })
    expect((await listCandidates(pool, ORG)).every((c) => c.relation === 'fct_retail_sale')).toBe(true)
  })

  it('★ 两池分离：画像/列类型从 warehouse 读，候选写 platform pool（不跨池事务）', async () => {
    const seen: Pool[] = []
    const r = await generateCandidates(deps({
      loadProfiles: async (p) => { seen.push(p); return SALE_PROFILES },
      loadColumns: async (p, rel) => { seen.push(p); return COLUMNS[rel] ?? [] },
    }), ORG)
    expect(r.ok).toBe(true)
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((p) => p === FAKE_WAREHOUSE), '仓库读用了平台池（两池混用）').toBe(true)
    // 写入落在平台库（真库可读）
    expect((await listCandidates(pool, ORG)).length).toBe(10)
  })

  it('★ 画像读不到 ⇒ PROFILE_UNAVAILABLE（不造假数据、不写候选）', async () => {
    const missing = Object.assign(new Error('relation "data.metric_profiles" does not exist'), { code: '42P01' })
    const r = await generateCandidates(deps({
      loadProfiles: async () => { throw missing },
    }), ORG)
    expect(r).toMatchObject({ ok: false, code: 'PROFILE_UNAVAILABLE' })
    expect(await listCandidates(pool, ORG)).toHaveLength(0)
  })

  it('租户隔离：候选按 org 落桶，别家 org 的画像/候选不串', async () => {
    expect((await generateCandidates(deps(), ORG)).ok).toBe(true)
    expect((await generateCandidates(deps(), OTHER_ORG)).ok).toBe(true)
    const mine = await listCandidates(pool, ORG)
    const other = await listCandidates(pool, OTHER_ORG)
    expect(mine).toHaveLength(10)
    expect(other).toHaveLength(10)
    expect(mine.every((c) => c.org === ORG)).toBe(true)
    expect(other.every((c) => c.org === OTHER_ORG)).toBe(true)
  })
})

describePg('loadLatestProfiles（仓库侧默认加载器）', () => {
  it('SQL 带 org 过滤 + 每 (relation, column) 取最新；坏 stats 归一成 {}', async () => {
    const calls: Array<{ sql: string; params: unknown[] }> = []
    const fake = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params })
        return {
          rows: [
            {
              relation: 'staging.fct_x', column: 'a',
              stats: { count: 10, approx_unique: 2, null_percentage: 0 },
              profiled_at: new Date('2026-11-04T00:00:00.000Z'),
            },
            { relation: 'staging.fct_x', column: 'b', stats: null, profiled_at: '2026-11-04T00:00:00.000Z' },
          ],
        }
      },
    } as unknown as Pool

    const rows = await loadLatestProfiles(fake, ORG)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.params).toEqual([ORG])
    expect(calls[0]!.sql).toContain('data.metric_profiles')
    expect(calls[0]!.sql).toContain('distinct on (relation, "column")')
    expect(calls[0]!.sql).toContain('order by relation, "column", profiled_at desc')
    expect(rows[0]).toMatchObject({
      relation: 'staging.fct_x', column: 'a', profiledAt: '2026-11-04T00:00:00.000Z',
    })
    expect(rows[1]!.stats).toEqual({})
  })
})
