import { describe, expect, it } from 'vitest'
import { compileExplore } from './explore'
import type { ExploreContext } from './explore'

const cols = [
  { name: 'org', dataType: 'text' },
  { name: 'branch_num', dataType: 'text' },
  { name: 'sale_amount', dataType: 'numeric' },
  { name: 'order_num', dataType: 'integer' },
  { name: 'bizday', dataType: 'date' },
  { name: 'customer_phone', dataType: 'text' },
]

const ctx = (over: Partial<ExploreContext> = {}): ExploreContext => ({
  allowedRelations: new Set(['fct_retail_sale']),
  columns: new Map([['fct_retail_sale', cols]]),
  maskedColumns: new Set(['customer_phone']),
  maskedRelations: new Set(),
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
    expect(out.sql).toContain('org = $1')
    expect(out.sql).toContain('sum(sale_amount) as sum_sale_amount')
    expect(out.sql).toContain('group by branch_num')
    expect(out.sql).toContain('order by sum_sale_amount desc')
    expect(out.sql).toContain('limit 200')
    expect(out.params).toEqual(["B'01"])
    // 预览把值内联，但 org 不内联（执行层才知道）
    expect(out.preview).toContain("branch_num = 'B''01'")
    expect(out.preview).toContain("'<org>'")
  })

  it('count_distinct 形态正确', () => {
    const out = compileExplore(spec({ measures: [{ agg: 'count_distinct', column: 'branch_num', as: 'branches' }] }), ctx())
    expect(out.ok && out.sql).toContain('count(distinct(branch_num)) as branches')
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
    expect(out.sql).toContain('bizday between $2 and $3')
    expect(out.sql).toContain('branch_num = any($4)')
    expect(out.params).toEqual([['2026-11-01', '2026-11-05'][0], '2026-11-05', ['B1', 'B2']])
  })
})
