// report-format.test.ts — KPI 值与差值的格式化/颜色语义（计划 2026-10-26 Task 2 从 KpiCard 原样抽出）。
//
// 纪律（spec 全局约束）：
//  · 无数据 / 零分母 ⇒ `-`（不显示 0、∞、空白）；
//  · 比率型对比给**百分点**（pp），避免「率的增长率」这种二级歧义；其余给相对变化率；
//  · 对比基数为 0 ⇒ `-`（增长率无定义）；
//  · 颜色只由 `goodDirection` 决定；持平 / 无方向 ⇒ 中性（别把「持平」染成失败）。
import { describe, expect, it } from 'vitest'
import { formatDelta, formatValue, toneOf } from './report-format'
import type { KpiPanel } from './report-spec'

describe('formatValue', () => {
  it('currency / number / percent；null ⇒ -', () => {
    expect(formatValue(51273.89, 'currency')).toBe('¥51,273.89')
    expect(formatValue(1234, 'number')).toBe('1,234')
    expect(formatValue(0.4736, 'percent')).toBe('47.36%')
    expect(formatValue(null, 'currency')).toBe('-')
  })
})

describe('formatDelta', () => {
  it('比率给百分点（pp）；其余给相对变化率；零基数 ⇒ -', () => {
    expect(formatDelta(0.5, 0.47, 'percent')).toBe('+3.00pp')
    expect(formatDelta(0.4, 0.5, 'percent')).toBe('-10.00pp')
    expect(formatDelta(150, 100, 'number')).toBe('+50.0%')
    expect(formatDelta(50, 0, 'currency')).toBe('-')
  })
})

describe('toneOf', () => {
  const kpi = (goodDirection: KpiPanel['goodDirection']): KpiPanel => ({
    chart: 'kpi', title: 't', metricId: 'm', format: 'number', span: 12,
    timeScoped: true, compare: 'auto', goodDirection, args: {},
  })

  it('方向决定颜色；持平 / 无方向 ⇒ 中性', () => {
    expect(toneOf(kpi('up'), 2, 1)).toBe('success')
    expect(toneOf(kpi('up'), 1, 2)).toBe('danger')
    expect(toneOf(kpi('down'), 1, 2)).toBe('success')
    expect(toneOf(kpi('down'), 2, 1)).toBe('danger')
    expect(toneOf(kpi('up'), 1, 1)).toBe('secondary')
    expect(toneOf(kpi('none'), 2, 1)).toBe('secondary')
  })
})
