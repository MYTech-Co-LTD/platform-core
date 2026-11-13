// report-receipt.test.ts — 凭证的纯核（R1）：组成可用判据 + CSV 形状。
import { describe, expect, it } from 'vitest'
import type { MetricRow } from './metric-store'
import type { KpiPanel } from './report-spec'
import { receiptCsv, seriesSupported, type ReportReceipt } from './report-receipt'

const panel = (over: Partial<KpiPanel> = {}): KpiPanel => ({
  chart: 'kpi', title: '销售额', metricId: 'm:sales', args: {},
  format: 'number', compare: 'none', goodDirection: 'none', span: 12, timeScoped: true,
  ...over,
})

const metric = (over: Record<string, unknown> = {}): MetricRow => ({
  totalable: true, groupBy: 'bizday', ...over,
} as unknown as MetricRow)

const receipt = (over: Partial<ReportReceipt> = {}): ReportReceipt => ({
  metric: { id: 'm:sales', title: '销售额', definition: null, unit: null, scopeNote: null, caliber: 'certified' },
  window: { from: '2026-10-01', to: '2026-10-02', mode: 'range' },
  scope: { branchNum: null, args: {} },
  value: '1,234', rawValue: 1234, dataAsOf: null, watermark: null,
  freshness: { status: null, line: null },
  series: [
    { day: '2026-10-01', value: 1000, formatted: '1,000' },
    { day: '2026-10-02', value: 234, formatted: '234' },
  ],
  seriesSum: '1,234', consistent: true, notes: [],
  ...over,
})

describe('seriesSupported', () => {
  it('可加 + 声明 bizday ⇒ 给组成', () => {
    expect(seriesSupported(panel(), metric())).toBe(true)
  })
  it('比率（有分母指标）⇒ 不给组成：按日合计没有意义', () => {
    expect(seriesSupported(panel({ denominatorMetricId: 'm:orders' }), metric())).toBe(false)
  })
  it('不可加 ⇒ 不给组成', () => {
    expect(seriesSupported(panel(), metric({ totalable: false }))).toBe(false)
  })
  it('没有 bizday 粒度 ⇒ 不给组成', () => {
    expect(seriesSupported(panel(), metric({ groupBy: 'branch_num' }))).toBe(false)
  })
})

describe('receiptCsv', () => {
  it('表头 + 按日两行（原值，不做千分位）', () => {
    expect(receiptCsv(receipt())).toBe('bizday,value\n2026-10-01,1000\n2026-10-02,234\n')
  })
  it('没有组成 ⇒ 只有表头（调用方应先以 409 拦住，这里保证不抛）', () => {
    expect(receiptCsv(receipt({ series: null }))).toBe('bizday,value\n')
  })
})
