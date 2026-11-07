import { describe, expect, it } from 'vitest'
import { compileExplore } from './explore'
import type { ExploreContext } from './explore'
import type { RelationDecl } from './relations'

const cols = [
  { name: 'org', dataType: 'text' },
  { name: 'system_book', dataType: 'text' },
  { name: 'branch_num', dataType: 'text' },
  { name: 'sale_amount', dataType: 'numeric' },
  { name: 'order_num', dataType: 'integer' },
  { name: 'bizday', dataType: 'date' },
  { name: 'customer_phone', dataType: 'text' },
]

const branchCols = [
  { name: 'org', dataType: 'text' },
  { name: 'system_book', dataType: 'text' },
  { name: 'branch_num', dataType: 'text' },
  { name: 'snapshot', dataType: 'date' },
  { name: 'name', dataType: 'text' },
  { name: 'region_name', dataType: 'text' },
  { name: 'gross_margin', dataType: 'numeric' },
  { name: 'contact_phone', dataType: 'text' },
]

const branchRelation: RelationDecl = {
  name: 'retail_sale_branch',
  from: { relation: 'fct_retail_sale', column: 'branch_num' },
  to: { relation: 'dim_lemeng_branch', column: 'branch_num' },
  keys: [{ from: 'system_book', to: 'system_book' }],
  cardinality: 'N:1',
  dedupRule: 'latest_snapshot',
  status: 'verified',
  evidence: { matchRate: 1, sampledDay: '2026-10-01' },
}

const candidateRelation: RelationDecl = {
  name: 'retail_sale_client',
  from: { relation: 'fct_retail_sale', column: 'client_fid' },
  to: { relation: 'dim_lemeng_client', column: 'client_fid' },
  keys: [],
  cardinality: 'N:1',
  status: 'candidate',
  evidence: { matchRate: null, sampledDay: null },
}

const ctx = (over: Partial<ExploreContext> = {}): ExploreContext => ({
  allowedRelations: new Set(['fct_retail_sale']),
  columns: new Map([['fct_retail_sale', cols]]),
  maskedColumns: new Set(['customer_phone']),
  maskedRelations: new Set(),
  ...over,
})

const joinCtx = (over: Partial<ExploreContext> = {}): ExploreContext => ctx({
  columns: new Map([
    ['fct_retail_sale', cols],
    ['dim_lemeng_branch', branchCols],
  ]),
  maskedColumns: new Set(['customer_phone', 'contact_phone']),
  relations: [branchRelation, candidateRelation],
  ...over,
})

const spec = (over: Record<string, unknown> = {}) => ({
  relation: 'fct_retail_sale',
  measures: [{ agg: 'sum', column: 'sale_amount' }],
  ...over,
})

describe('compileExplore（W6 Task 2：受约束的只读聚合器）', () => {
  it('正常编译：恒拼 org = $1，值走占位符，limit 缺省 200', () => {
    const out = compileExplore(spec({
      dimensions: ['branch_num'],
      filters: [{ column: 'branch_num', op: 'eq', value: "B'01" }],
      orderBy: { key: 'sum_sale_amount' },
    }), ctx())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sql).toContain('from staging.fct_retail_sale')
    expect(out.sql).toContain('fct_retail_sale.org = $1')
    expect(out.sql).toContain('sum(fct_retail_sale.sale_amount) as sum_sale_amount')
    expect(out.sql).toContain('group by fct_retail_sale.branch_num')
    expect(out.sql).toContain('order by sum_sale_amount desc')
    expect(out.sql).toContain('limit 200')
    expect(out.params).toEqual(["B'01"])
    // 预览把值内联，但 org 不内联（执行层才知道）
    expect(out.preview).toContain("fct_retail_sale.branch_num = 'B''01'")
    expect(out.preview).toContain("'<org>'")
  })

  it('count_distinct 形态正确', () => {
    const out = compileExplore(spec({ measures: [{ agg: 'count_distinct', column: 'branch_num', as: 'branches' }] }), ctx())
    expect(out.ok && out.sql).toContain('count(distinct(fct_retail_sale.branch_num)) as branches')
  })

  it('注入防线：spec 里出现 SQL 文本字段 ⇒ BAD_SPEC', () => {
    const out = compileExplore({ ...spec(), sql: 'select * from secrets' }, ctx())
    expect(out).toMatchObject({ ok: false, code: 'BAD_SPEC' })
  })

  it('列名带引号/分号/大写 ⇒ COLUMN_NOT_FOUND（不做模糊匹配）', () => {
    for (const column of ['sale_amount; drop table x', 'Sale_Amount', 'sale_amount"']) {
      const out = compileExplore(spec({ measures: [{ agg: 'sum', column }] }), ctx())
      expect(out).toMatchObject({ ok: false, code: 'COLUMN_NOT_FOUND' })
    }
  })

  it('未声明的表 ⇒ RELATION_NOT_ALLOWED（staging 里的其它表也进不来）', () => {
    const out = compileExplore(spec({ relation: 'stg_lemeng_wholesale_out' }), ctx())
    expect(out).toMatchObject({ ok: false, code: 'RELATION_NOT_ALLOWED' })
  })

  it('没有 org 列的表 ⇒ NO_ORG_COLUMN（fail-closed，不做跨租户读）', () => {
    const c = ctx({
      allowedRelations: new Set(['dim_brand']),
      columns: new Map([['dim_brand', [{ name: 'brand_name', dataType: 'text' }]]]),
    })
    const out = compileExplore(spec({ relation: 'dim_brand', measures: [{ agg: 'count', column: 'brand_name' }] }), c)
    expect(out).toMatchObject({ ok: false, code: 'NO_ORG_COLUMN' })
  })

  it('整值掩码关系 ⇒ RELATION_MASKED', () => {
    const out = compileExplore(spec(), ctx({ maskedRelations: new Set(['fct_retail_sale']) }))
    expect(out).toMatchObject({ ok: false, code: 'RELATION_MASKED' })
  })

  it('被掩码的列（度量或维度）⇒ COLUMN_MASKED', () => {
    const asMeasure = compileExplore(spec({ measures: [{ agg: 'count', column: 'customer_phone' }] }), ctx())
    expect(asMeasure).toMatchObject({ ok: false, code: 'COLUMN_MASKED' })
    const asDim = compileExplore(spec({ dimensions: ['customer_phone'] }), ctx())
    expect(asDim).toMatchObject({ ok: false, code: 'COLUMN_MASKED' })
  })

  it('非数值列做 sum ⇒ COLUMN_NOT_NUMERIC；count 同列可以', () => {
    expect(compileExplore(spec({ measures: [{ agg: 'sum', column: 'branch_num' }] }), ctx()))
      .toMatchObject({ ok: false, code: 'COLUMN_NOT_NUMERIC' })
    expect(compileExplore(spec({ measures: [{ agg: 'count', column: 'branch_num' }] }), ctx()).ok).toBe(true)
  })

  it('limit 越界/非整数 ⇒ 拒（不夹紧，避免调用方误以为拿到全量）', () => {
    expect(compileExplore(spec({ limit: 1001 }), ctx())).toMatchObject({ ok: false, code: 'BAD_SPEC' })
    expect(compileExplore(spec({ limit: 0 }), ctx())).toMatchObject({ ok: false, code: 'BAD_SPEC' })
    expect(compileExplore(spec({ limit: 1.5 }), ctx())).toMatchObject({ ok: false, code: 'BAD_SPEC' })
    expect(compileExplore(spec({ limit: 1000 }), ctx()).ok).toBe(true)
  })

  it('未知聚合 / 未知 op / 坏过滤值 ⇒ 各自失败码', () => {
    expect(compileExplore(spec({ measures: [{ agg: 'median', column: 'sale_amount' }] }), ctx()))
      .toMatchObject({ ok: false, code: 'AGG_NOT_ALLOWED' })
    expect(compileExplore(spec({ filters: [{ column: 'branch_num', op: 'like', value: '%x%' }] }), ctx()))
      .toMatchObject({ ok: false, code: 'BAD_FILTER' })
    expect(compileExplore(spec({ filters: [{ column: 'branch_num', op: 'in', value: [] }] }), ctx()))
      .toMatchObject({ ok: false, code: 'BAD_FILTER' })
    expect(compileExplore(spec({ filters: [{ column: 'branch_num', op: 'between', value: [1] }] }), ctx()))
      .toMatchObject({ ok: false, code: 'BAD_FILTER' })
  })

  it('orderBy 只能引用维度或度量别名', () => {
    expect(compileExplore(spec({ orderBy: { key: 'sale_amount' } }), ctx()))
      .toMatchObject({ ok: false, code: 'BAD_SPEC' })
  })

  it('between 与 in 的参数按顺序落位（$2 起，$1 留给 org）', () => {
    const out = compileExplore(spec({
      filters: [
        { column: 'bizday', op: 'between', value: ['2026-11-01', '2026-11-05'] },
        { column: 'branch_num', op: 'in', value: ['B1', 'B2'] },
      ],
    }), ctx())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sql).toContain('fct_retail_sale.bizday between $2 and $3')
    expect(out.sql).toContain('fct_retail_sale.branch_num = any($4)')
    expect(out.params).toEqual([['2026-11-01', '2026-11-05'][0], '2026-11-05', ['B1', 'B2']])
  })
})

describe('compileExplore · join（W7 Task 2：显式 opt-in，只收过闸门的关系）', () => {
  it('显式请求才 join；去重子查询 + 复合键 + 同 org', () => {
    const out = compileExplore(spec({
      joins: ['retail_sale_branch'],
      dimensions: ['retail_sale_branch.region_name'],
    }), joinCtx())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sql).toContain(
      'join (select distinct on (org, branch_num, system_book) * from dim_lemeng_branch'
      + ' order by org, branch_num, system_book, snapshot desc) retail_sale_branch',
    )
    expect(out.sql).toContain('retail_sale_branch.branch_num = fct_retail_sale.branch_num')
    expect(out.sql).toContain('retail_sale_branch.system_book = fct_retail_sale.system_book')
    expect(out.sql).toContain('retail_sale_branch.org = fct_retail_sale.org')
    expect(out.sql).toContain('select retail_sale_branch.region_name, sum(fct_retail_sale.sale_amount) as sum_sale_amount')
    expect(out.sql).toContain('group by retail_sale_branch.region_name')
  })

  it('不请求 join ⇒ SQL 里没有 join（不偷偷改既有查询的行数）', () => {
    const out = compileExplore(spec(), joinCtx())
    expect(out.ok && out.sql).not.toContain(' join ')
  })

  it('join 后的列可作维度/过滤/排序/度量（含默认别名取末段）', () => {
    const out = compileExplore(spec({
      joins: ['retail_sale_branch'],
      measures: [{ agg: 'sum', column: 'retail_sale_branch.gross_margin' }],
      dimensions: ['retail_sale_branch.region_name'],
      filters: [{ column: 'retail_sale_branch.region_name', op: 'eq', value: '一区' }],
      orderBy: { key: 'retail_sale_branch.region_name' },
    }), joinCtx())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.sql).toContain('sum(retail_sale_branch.gross_margin) as sum_gross_margin')
    expect(out.sql).toContain('retail_sale_branch.region_name = $2')
    expect(out.sql).toContain('order by retail_sale_branch.region_name desc')
    expect(out.params).toEqual(['一区'])
  })

  it('未请求的别名不可引用（不能绕过 joins 直接写表名）', () => {
    const out = compileExplore(spec({ dimensions: ['retail_sale_branch.region_name'] }), joinCtx())
    expect(out).toMatchObject({ ok: false, code: 'COLUMN_NOT_FOUND' })
  })

  it('未知关系名 / candidate 关系 ⇒ JOIN_NOT_ALLOWED（不猜、不放宽）', () => {
    expect(compileExplore(spec({ joins: ['nope'] }), joinCtx()))
      .toMatchObject({ ok: false, code: 'JOIN_NOT_ALLOWED' })
    expect(compileExplore(spec({ joins: ['retail_sale_client'] }), joinCtx()))
      .toMatchObject({ ok: false, code: 'JOIN_NOT_ALLOWED' })
    // 没有关系声明的上下文 ⇒ 任何 join 都不可用
    expect(compileExplore(spec({ joins: ['retail_sale_branch'] }), ctx()))
      .toMatchObject({ ok: false, code: 'JOIN_NOT_ALLOWED' })
  })

  it('目标关系整值掩码 ⇒ RELATION_MASKED；目标列掩码 ⇒ COLUMN_MASKED', () => {
    expect(compileExplore(spec({ joins: ['retail_sale_branch'] }), joinCtx({
      maskedRelations: new Set(['dim_lemeng_branch']),
    }))).toMatchObject({ ok: false, code: 'RELATION_MASKED' })
    expect(compileExplore(spec({
      joins: ['retail_sale_branch'],
      dimensions: ['retail_sale_branch.contact_phone'],
    }), joinCtx())).toMatchObject({ ok: false, code: 'COLUMN_MASKED' })
  })

  it('目标表不可见 / 缺 snapshot 却声明 latest_snapshot ⇒ JOIN_NOT_ALLOWED', () => {
    const noTarget = joinCtx({ columns: new Map([['fct_retail_sale', cols]]) })
    expect(compileExplore(spec({ joins: ['retail_sale_branch'] }), noTarget))
      .toMatchObject({ ok: false, code: 'JOIN_NOT_ALLOWED' })

    const noSnapshot = joinCtx({
      columns: new Map([
        ['fct_retail_sale', cols],
        ['dim_lemeng_branch', branchCols.filter((c) => c.name !== 'snapshot')],
      ]),
    })
    expect(compileExplore(spec({ joins: ['retail_sale_branch'] }), noSnapshot))
      .toMatchObject({ ok: false, code: 'JOIN_NOT_ALLOWED' })
  })

  it('目标列类型照实校验：text 不能 sum，numeric 可以', () => {
    expect(compileExplore(spec({
      joins: ['retail_sale_branch'],
      measures: [{ agg: 'sum', column: 'retail_sale_branch.name' }],
    }), joinCtx())).toMatchObject({ ok: false, code: 'COLUMN_NOT_NUMERIC' })
    expect(compileExplore(spec({
      joins: ['retail_sale_branch'],
      measures: [{ agg: 'sum', column: 'retail_sale_branch.gross_margin' }],
    }), joinCtx()).ok).toBe(true)
  })

  it('joins 形状：非数组/重复/超过 5 个 ⇒ BAD_SPEC；带分号的列名 ⇒ COLUMN_NOT_FOUND', () => {
    expect(compileExplore(spec({ joins: 'retail_sale_branch' }), joinCtx()))
      .toMatchObject({ ok: false, code: 'BAD_SPEC' })
    expect(compileExplore(spec({ joins: ['retail_sale_branch', 'retail_sale_branch'] }), joinCtx()))
      .toMatchObject({ ok: false, code: 'BAD_SPEC' })
    expect(compileExplore(spec({ joins: ['a', 'b', 'c', 'd', 'e', 'f'] }), joinCtx()))
      .toMatchObject({ ok: false, code: 'BAD_SPEC' })
    expect(compileExplore(spec({
      joins: ['retail_sale_branch'],
      dimensions: ['retail_sale_branch.region_name; drop table x'],
    }), joinCtx())).toMatchObject({ ok: false, code: 'COLUMN_NOT_FOUND' })
  })
})
