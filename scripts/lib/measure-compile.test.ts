// scripts/lib/measure-compile.test.ts — 两阶段编译纯函数（P3.0 聚合面组件化 / issue #1012）。
//
// 为什么必须两阶段：measure.expr 自带聚合（`sum(a) + max(b)`），把它直接塞进指标粒度的
// select 会在**错的粒度**上求值——退货/折扣这类按行计数的表达式若先按订单键求和，与按行
// 键求和的差额会被抹平（错数比报错更糟）。两阶段 = ①先在组件自述的 grain 键上求得
// `measure_value`；②再在指标粒度上 `sum(measure_value)`。
//
// 断言面刻意分成两层：
//   · `compilePerGroup` 钉**整句**（CTE 会被拼进 dbt 模型，形状漂移要在单测就红）；
//   · 失败分支钉**抛错**（grain 缺失 / keys 空 / non_additive）——这三条是「缺省不许猜」的判据，
//     只断言 `toThrow()` 会让「抛了但抛的是别的错」蒙混过关。
import { describe, expect, it } from 'vitest'

import { measureOf } from '../sync-data-semantics.mjs'
import { compileAggregate, compilePerGroup } from './measure-compile.mjs'

const ORDER_KEYS = ['system_book', 'bizday', 'branch_num', 'order_no']

describe('compilePerGroup —— 在组件 grain 键上逐组求值', () => {
  it('两阶段：per-order 表达式先逐单求值、再按指标粒度求和（不是先和后除）', () => {
    const m = measureOf({ expr: 'sum(a) + max(b)', grain: ['order'], additivity: 'flow' })
    const cte = compilePerGroup({ measure: m, keys: ORDER_KEYS, baseAlias: 'base' })
    expect(cte).toContain('group by system_book, bizday, branch_num, order_no')
    expect(cte).toContain('as measure_value')
    expect(cte).toBe(
      'select system_book, bizday, branch_num, order_no, (sum(a) + max(b)) as measure_value from base group by system_book, bizday, branch_num, order_no',
    )
    const agg = compileAggregate({ measure: m, column: 'sale_amount__gen', valueExpr: 'measure_value' })
    expect(agg).toBe('sum(measure_value)::numeric(20,2) as sale_amount__gen')
  })

  it('additivity 缺失/非法 ⇒ 拒绝聚合（不许静默求和）', () => {
  const m = { expr: 'sum(a)' } as unknown as import('../sync-data-semantics.mjs').Measure
  expect(() => compileAggregate({ measure: m, column: 'x__gen', valueExpr: 'measure_value' })).toThrow(/additivity/)
})

it('grain 缺失时拒绝编译两阶段（缺省不许猜）', () => {
    const m = measureOf({ expr: 'sum(a)', additivity: 'flow' })
    expect(() => compilePerGroup({ measure: m, keys: ['order_no'], baseAlias: 'base' })).toThrow(/grain/)
  })

  it('keys 为空时拒绝编译（空 group by 会把全表塌成一行）', () => {
    const m = measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow' })
    expect(() => compilePerGroup({ measure: m, keys: [], baseAlias: 'base' })).toThrow(/keys|不能为空/)
  })

  it('baseAlias 原样进 from 子句（不归一、不加引号）', () => {
    const m = measureOf({ expr: 'sum(a)', grain: ['line'], additivity: 'flow' })
    expect(compilePerGroup({ measure: m, keys: ['order_no'], baseAlias: 'stg_orders' })).toBe(
      'select order_no, (sum(a)) as measure_value from stg_orders group by order_no',
    )
  })
})

describe('compileAggregate —— 指标粒度的求和', () => {
  it('flow 与 stock 都允许求和（stock 的时间不可加性由调用方的时间键保证）', () => {
    const stock = measureOf({ expr: 'max(balance)', grain: ['line'], additivity: 'stock' })
    expect(compileAggregate({ measure: stock, column: 'balance__gen', valueExpr: 'measure_value' })).toBe(
      'sum(measure_value)::numeric(20,2) as balance__gen',
    )
  })

  it('valueExpr 原样进 sum()（生成器传的是 `<组件>__gen.measure_value`）', () => {
    const m = measureOf({ expr: 'sum(a)', grain: ['order'], additivity: 'flow' })
    expect(compileAggregate({ measure: m, column: 'sale_amount__gen', valueExpr: 'sale_amount__gen.measure_value' })).toBe(
      'sum(sale_amount__gen.measure_value)::numeric(20,2) as sale_amount__gen',
    )
  })

  it('non_additive 一律拒绝（任何上卷都不成立，求和必错数）', () => {
    const m = measureOf({ expr: 'sum(a) / nullif(sum(b), 0)', grain: ['order'], additivity: 'non_additive' })
    expect(() => compileAggregate({ measure: m, column: 'rate__gen', valueExpr: 'measure_value' })).toThrow(/non_additive/)
  })
})
