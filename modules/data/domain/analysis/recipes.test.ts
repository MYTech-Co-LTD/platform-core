import { describe, expect, it } from 'vitest'
import { applyRecipe, compileRecipe, recipeTargetOf, shiftDate } from './recipes'
import type { RecipeRequest } from './recipes'

const req = (over: Partial<RecipeRequest> = {}): RecipeRequest => ({
  recipe: 'variance',
  relation: 'fct_retail_sale',
  measure: { agg: 'sum', column: 'sale_amount' },
  dimension: 'branch_num',
  periodA: { from: '2026-11-01', to: '2026-11-07' },
  periodB: { from: '2026-10-25', to: '2026-10-31' },
  ...over,
})

describe('compileRecipe（W6 Task 3：业务问题 → explore spec）', () => {
  it('variance 编译成两个 spec（本期 / 基期），都带 bizday between', () => {
    const out = compileRecipe(req())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.specs).toHaveLength(2)
    expect(out.specs[0].filters?.[0]).toEqual({ column: 'bizday', op: 'between', value: ['2026-11-01', '2026-11-07'] })
    expect(out.specs[1].filters?.[0]).toMatchObject({ value: ['2026-10-25', '2026-10-31'] })
    expect(out.notes.length).toBeGreaterThan(0)
  })

  it('top_contributors 一个 spec，topN 越界即拒', () => {
    const ok = compileRecipe(req({ recipe: 'top_contributors', period: { from: '2026-11-01', to: '2026-11-07' }, topN: 5 }))
    expect(ok.ok).toBe(true)
    expect(compileRecipe(req({ recipe: 'top_contributors', period: { from: '2026-11-01', to: '2026-11-07' }, topN: 51 })))
      .toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  })

  it('baseline 的基线 spec 按 [维度, bizday] 两维取（否则 MAD 恒 0，配方自欺）', () => {
    const out = compileRecipe(req({ recipe: 'baseline', asOf: '2026-11-06', baselineWindowDays: 28 }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.specs).toHaveLength(2)
    expect(out.specs[0].dimensions).toEqual(['branch_num', 'bizday'])
    expect(out.specs[0].filters?.[0]).toMatchObject({ value: ['2026-10-09', '2026-11-05'] })
    expect(out.specs[1].filters?.[0]).toMatchObject({ value: ['2026-11-06', '2026-11-06'] })
  })

  it('日期格式非法 / 缺期 ⇒ BAD_REQUEST', () => {
    expect(compileRecipe(req({ periodA: { from: '2026/11/01', to: '2026-11-07' } })))
      .toMatchObject({ ok: false, code: 'BAD_REQUEST' })
    expect(compileRecipe(req({ recipe: 'baseline' }))).toMatchObject({ ok: false, code: 'BAD_REQUEST' })
  })
})

describe('applyRecipe（算术）', () => {
  it('variance：按 |delta| 降序，share 用 Σdelta 归一；Σ≈0 时 share 为 null', () => {
    const out = applyRecipe(req(), [
      { columns: ['branch_num', 'value'], rows: [['B1', 100], ['B2', 40]] },
      { columns: ['branch_num', 'value'], rows: [['B1', 60], ['B2', 50]] },
    ])
    expect(out.rows).toEqual([
      { dimension: 'B1', current: 100, baseline: 60, delta: 40, share: 1.333333 },
      { dimension: 'B2', current: 40, baseline: 50, delta: -10, share: -0.333333 },
    ])
    expect(out.total).toBe(30)

    const flat = applyRecipe(req(), [
      { columns: ['branch_num', 'value'], rows: [['B1', 10], ['B2', 20]] },
      { columns: ['branch_num', 'value'], rows: [['B1', 20], ['B2', 10]] },
    ])
    expect(flat.rows.every((r) => r.share === null)).toBe(true)
  })

  it('top_contributors：降序取 N，share 以全量合计为分母（不是 Top-N 合计）', () => {
    const out = applyRecipe(
      req({ recipe: 'top_contributors', period: { from: '2026-11-01', to: '2026-11-07' }, topN: 2 }),
      [{ columns: ['branch_num', 'value'], rows: [['B1', 50], ['B2', 30], ['B3', 20]] }],
    )
    expect(out.rows).toEqual([
      { dimension: 'B1', value: 50, share: 0.5 },
      { dimension: 'B2', value: 30, share: 0.3 },
    ])
    expect(out.total).toBe(100)
  })

  it('baseline：中位数 / MAD 判异常；MAD=0 标 degenerate 不给假分数', () => {
    const out = applyRecipe(
      req({ recipe: 'baseline', asOf: '2026-11-06' }),
      [
        { columns: ['branch_num', 'bizday', 'value'], rows: [
          ['B1', '2026-11-01', 10], ['B1', '2026-11-02', 12], ['B1', '2026-11-03', 11], ['B1', '2026-11-04', 9],
          ['B2', '2026-11-01', 5], ['B2', '2026-11-02', 5],
        ] },
        { columns: ['branch_num', 'value'], rows: [['B1', 30], ['B2', 9]] },
      ],
    )
    const b1 = out.rows.find((r) => r.dimension === 'B1')!
    const b2 = out.rows.find((r) => r.dimension === 'B2')!
    expect(b1.median).toBe(10.5)
    expect(b1.anomaly).toBe(true)
    expect(b2.degenerate).toBe(true)
    expect(b2.score).toBeNull()
    expect(out.skipped).toBe(1)
  })
})

describe('shiftDate', () => {
  it('跨月/闰年边界正确（UTC 字符串运算，不碰时区）', () => {
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28')
    expect(shiftDate('2024-03-01', -1)).toBe('2024-02-29')
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('recipeTargetOf（指标 select_sql → 单列聚合目标）', () => {
  const sel = (expr: string) => `select ${expr} as value from fct_retail_sale`

  it('sum/avg/min/max 与 count(distinct) 都能反解出列名与关系', () => {
    expect(recipeTargetOf(sel('sum(sale_amount)'))).toMatchObject({ ok: true, relation: 'fct_retail_sale', measure: { agg: 'sum', column: 'sale_amount' } })
    expect(recipeTargetOf(sel('count(distinct branch_num)'))).toMatchObject({ ok: true, measure: { agg: 'count_distinct', column: 'branch_num' } })
  })

  it('关系限定列（L1 声明的真实形态）也可反解：只取最后一段列名', () => {
    expect(recipeTargetOf(sel('sum(fct_retail_sale.sale_amount)')))
      .toMatchObject({ ok: true, relation: 'fct_retail_sale', measure: { agg: 'sum', column: 'sale_amount' } })
    expect(recipeTargetOf(sel('count(distinct fct_retail_sale.branch_num)')))
      .toMatchObject({ ok: true, measure: { agg: 'count_distinct', column: 'branch_num' } })
  })

  it('复合口径（差/比率/case）明确拒，并指向 explore_query', () => {
    const out = recipeTargetOf(sel('sum(a) - sum(b)'))
    expect(out).toMatchObject({ ok: false, code: 'COMPOSITE_EXPRESSION' })
    if (!out.ok) expect(out.detail).toContain('explore_query')
  })
})
