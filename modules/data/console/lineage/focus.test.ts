import { describe, expect, it } from 'vitest'
import { buildFocus, windowOf, type FocusInput } from './focus'

const col = (name: string, status: 'passthrough' | 'dropped' | 'added' | 'aggregate' = 'passthrough') =>
  ({ name, status }) as const

const INPUT: FocusInput = {
  source: {
    columns: [
      col('system_book'), col('bizday'), col('hour'), col('order_no'),
      col('order_transaction_type'), col('sale_money'), col('order_detail_share_discount'),
      col('order_total_money', 'dropped'),
    ],
  },
  staging: {
    columns: [
      col('system_book'), col('org', 'added'), col('bizday'), col('hour'), col('order_no'),
      col('order_transaction_type'), col('sale_money'), col('order_detail_share_discount'),
    ],
    partitions: ['system_book', 'bizday', 'hour'],
  },
  marts: {
    columns: [
      col('system_book'), col('org'), col('bizday'), col('branch_num'),
      { name: 'sale_amount', status: 'aggregate', inputs: ['sale_money', 'order_transaction_type'] },
      { name: 'return_amount', status: 'aggregate', inputs: ['sale_money'] },
      { name: 'net_amount', status: 'aggregate', inputs: ['sale_money', 'order_transaction_type'], dependsOn: ['sale_amount', 'return_amount'] },
      { name: 'order_count', status: 'aggregate', inputs: ['order_no'] },
    ],
  },
}

describe('buildFocus', () => {
  it('普通字段前向：源 + staging 同名，汇入的度量点亮，其余度量不动', () => {
    const f = buildFocus('sale_money', INPUT)!
    expect(f.reverse).toBe(false)
    expect([...f.source]).toEqual(['sale_money'])
    expect([...f.staging]).toEqual(['sale_money'])
    // 三个度量都吃 sale_money；order_count 不吃
    expect([...f.marts].sort()).toEqual(['net_amount', 'return_amount', 'sale_amount'])
    expect(f.links).toHaveLength(3)
  })

  it('度量反向：输入列从 staging 扇入，并带出度量依赖', () => {
    const f = buildFocus('net_amount', INPUT)!
    expect(f.reverse).toBe(true)
    expect([...f.staging].sort()).toEqual(['order_transaction_type', 'sale_money'])
    expect([...f.marts].sort()).toEqual(['net_amount', 'return_amount', 'sale_amount'])
    expect(f.links).toEqual([['sale_money', 'net_amount'], ['order_transaction_type', 'net_amount']])
    expect(f.deps).toEqual([['sale_amount', 'net_amount'], ['return_amount', 'net_amount']])
  })

  it('分区键：映射到湖里的落点', () => {
    const f = buildFocus('hour', INPUT)!
    expect(f.partitions).toEqual(new Set(['hour']))
    // hour 不到 marts
    expect(f.marts.size).toBe(0)
  })

  it('只在源层存在的列：staging 丢掉时反查得到空集合（页面据此画丢弃截线）', () => {
    const f = buildFocus('order_total_money', INPUT)!
    expect([...f.source]).toEqual(['order_total_money'])
    expect(f.staging.size).toBe(0)
    expect(f.marts.size).toBe(0)
  })

  it('找不到的字段返回 null（不编一个空聚焦）', () => {
    expect(buildFocus('no_such_col', INPUT)).toBeNull()
  })
})

describe('windowOf', () => {
  it('命中列上下各留 radius 行，其余折成「还有 N 列」', () => {
    const w = windowOf(10, new Set([5]), 2)
    expect([...w.visible].sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7])
    // 尾部那段的 before = total（插在最后一列之后）
    expect(w.gaps).toEqual([{ before: 3, count: 3 }, { before: 10, count: 2 }])
  })

  it('都命中就不折（不产生无意义的占位）', () => {
    const w = windowOf(4, new Set([0, 1, 2, 3]), 2)
    expect(w.gaps).toEqual([])
    expect(w.visible.size).toBe(4)
  })

  it('没有命中时返回空（调用方退回折叠总览）', () => {
    expect(windowOf(10, new Set()).visible.size).toBe(0)
  })
})
