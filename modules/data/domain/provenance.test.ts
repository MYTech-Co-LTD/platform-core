// provenance.test.ts — 共享来源类型/构造器：字段名与可选字段策略（不伪造 auditId）。
import { describe, expect, it } from 'vitest'
import { detailProvenance, exploreProvenance, isoNow, recipeProvenance } from './provenance'

const clock = () => new Date('2026-11-10T00:00:00Z')

describe('provenance（共享构造器）', () => {
  it('isoNow 用注入时钟（可复算）', () => {
    expect(isoNow(clock)).toBe('2026-11-10T00:00:00.000Z')
  })

  it('explore：auditId=null/undefined ⇒ 缺席；有值 ⇒ 带上', () => {
    const base = { relation: 'fct_retail_sale', executedAt: '2026-11-10T00:00:00.000Z' }
    expect(exploreProvenance({ ...base, auditId: null })).toEqual({
      source: 'explore', relation: 'fct_retail_sale', executedAt: '2026-11-10T00:00:00.000Z',
    })
    expect(exploreProvenance({ ...base })).toEqual({
      source: 'explore', relation: 'fct_retail_sale', executedAt: '2026-11-10T00:00:00.000Z',
    })
    expect(exploreProvenance({ ...base, auditId: 42 })).toMatchObject({ auditId: 42 })
  })

  it('detail：dataAsOf 缺席时不写字段（未知 ≠ 空串）', () => {
    const p = detailProvenance({
      relation: 'vw_t', keyColumns: ['a'], groupedBy: ['a'], rowCountTotal: 1,
      drillAsOf: '2026-11-10 00:00:00 +08:00', auditId: 7,
    })
    expect(p).toEqual({
      relation: 'vw_t', keyColumns: ['a'], groupedBy: ['a'], rowCountTotal: 1,
      drillAsOf: '2026-11-10 00:00:00 +08:00', auditId: 7,
    })
    expect('dataAsOf' in p).toBe(false)
  })

  it('recipe：指标 / 关系 / 度量 / 配方 / 时刻原样收敛', () => {
    expect(recipeProvenance({
      metricId: 'lemeng:retail:net_sales', relation: 'fct_retail_sale',
      measure: { agg: 'sum', column: 'net_amount' }, recipe: 'variance',
      executedAt: '2026-11-10T00:00:00.000Z',
    })).toEqual({
      source: 'recipe', metricId: 'lemeng:retail:net_sales', relation: 'fct_retail_sale',
      measure: { agg: 'sum', column: 'net_amount' }, recipe: 'variance',
      executedAt: '2026-11-10T00:00:00.000Z',
    })
  })
})
