// report-receipt.test.ts — 凭证的纯核（R1）：组成可用判据 + CSV 形状。
import { describe, expect, it } from 'vitest'
import type { MetricRow } from './metric-store'
import type { KpiPanel } from './report-spec'
import {
  explainDelta, exportDetailCsv, receiptCsv, seriesSupported, type ReportReceipt,
} from './report-receipt'
import { runDetailQuery } from './drill'

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
  seriesSum: '1,234', consistent: true, notes: [], delta: null,
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

describe('explainDelta', () => {
  const series = [
    { day: '2026-10-01', value: 1000, formatted: '1,000' },
    { day: '2026-10-02', value: 200, formatted: '200' },
    { day: '2026-10-03', value: 34, formatted: '34' },
  ]

  it('用户数与系统一致 ⇒ 直接判一致', () => {
    const d = explainDelta(series, 1234, 1234, 'number')
    expect(d.explained).toBe(true)
    expect(d.difference).toBe('+0.00')
    expect(d.candidates[0]?.kind).toBe('full')
  })

  it('用户少算了首日 ⇒ 指出少了 10-01（连续子区间）', () => {
    const d = explainDelta(series, 1234, 234, 'number')
    expect(d.explained).toBe(true)
    expect(d.candidates[0]?.label).toBe('2026-10-02 ~ 2026-10-03（2 天）的合计')
    expect(d.candidates[0]?.amount).toBe('234')
    expect(d.candidates[0]?.detail).toBe('少了 2026-10-01')
  })

  it('解释不了 ⇒ 不编原因，明确提示核对口径', () => {
    const d = explainDelta(series, 1234, 999, 'number')
    expect(d.explained).toBe(false)
    expect(d.candidates).toEqual([])
    expect(d.note).toContain('无法由按日组成解释')
  })

  it('没有按日组成 ⇒ 说明不可解释', () => {
    const d = explainDelta(null, 1234, 999, 'number')
    expect(d.explained).toBe(false)
    expect(d.note).toContain('没有按日组成')
  })
})

describe('exportDetailCsv', () => {
  const okPage = (rows: unknown[][], total: number) => ({
    status: 'ok' as const, subject: 'o', metricId: 'm', dimensions: ['bizday', 'order_no'],
    columns: ['bizday', 'order_no', 'value'], rows, rowCountTotal: total,
    truncated: false, drill_as_of: '2026-11-13 00:00:00 +08:00',
    provenance: {} as never,
  })

  it('分页拼接：两页 ⇒ 一份 CSV，行数等于总数', async () => {
    const pages = [
      okPage([['2026-10-01', 'A1', 100], ['2026-10-01', 'A2', 200]], 3),
      okPage([['2026-10-02', 'A3', 300]], 3),
    ]
    let calls = 0
    const fake = (async () => pages[calls++]!) as unknown as typeof runDetailQuery
    const out = await exportDetailCsv({} as never, 'o', {} as never, 'm', {}, { runDetail: fake })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.out.rows).toBe(3)
    expect(out.out.truncated).toBe(false)
    expect(out.out.csv.split('\n')[0]).toBe('bizday,order_no,value')
    expect(out.out.csv).toContain('2026-10-02,A3,300')
  })

  it('CSV 转义：逗号/引号/换行必须被引号包住', async () => {
    const page = okPage([['2026-10-01', 'A,1', 'x"y']], 1)
    const fake = (async () => page) as unknown as typeof runDetailQuery
    const out = await exportDetailCsv({} as never, 'o', {} as never, 'm', {}, { runDetail: fake })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.out.csv).toContain('"A,1"')
    expect(out.out.csv).toContain('"x""y"')
  })

  it('超过上限 ⇒ 只导前 N 行并标 truncated', async () => {
    const page = okPage([['d1', 'A1', 1], ['d2', 'A2', 2], ['d3', 'A3', 3]], 3)
    const fake = (async () => page) as unknown as typeof runDetailQuery
    const out = await exportDetailCsv({} as never, 'o', {} as never, 'm', {}, { runDetail: fake, maxRows: 2 })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.out.rows).toBe(2)
    expect(out.out.truncated).toBe(true)
  })

  it('指标未声明下钻 ⇒ not_supported（不是「空结果」）', async () => {
    const fake = (async () => ({ status: 'denied', metricId: 'm', reason: 'no_detail_binding' })) as unknown as typeof runDetailQuery
    const out = await exportDetailCsv({} as never, 'o', {} as never, 'm', {}, { runDetail: fake })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('not_supported')
  })
})
