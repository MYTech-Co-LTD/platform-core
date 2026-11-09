import { describe, expect, it } from 'vitest'
import { buildDailyReview, DAILY_REVIEW_METRICS, type DailySeries } from './report-daily-review'
import type { ReportSpec } from './report-spec'

const DAY = '2026-11-08'
const spec: ReportSpec = {
  panels: [{
    chart: 'kpi', title: '销售额', metricId: DAILY_REVIEW_METRICS.revenue,
    args: { system_book: '3120', branch_num: '92' },
    format: 'currency', compare: 'auto', goodDirection: 'up', span: 12, timeScoped: true,
  }],
}

function series(values: Record<string, number>): DailySeries {
  return {
    columns: ['bizday', 'value'],
    rows: Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([d, v]) => [d, v]),
  }
}

const mtdDays = Array.from({ length: 7 }, (_, i) => `2026-11-0${i + 1}`)
const lyDays = Array.from({ length: 8 }, (_, i) => `2025-11-0${i + 1}`)

function fake(values: Record<string, Record<string, number>>): (metricId: string) => Promise<DailySeries | null> {
  return async (metricId) => {
    if (metricId === DAILY_REVIEW_METRICS.revenue) return series(values.revenue ?? {})
    if (metricId === DAILY_REVIEW_METRICS.orders) return series(values.orders ?? {})
    if (metricId === DAILY_REVIEW_METRICS.gross) return series(values.gross ?? {})
    if (metricId === DAILY_REVIEW_METRICS.loss) return series(values.loss ?? {})
    if (metricId === DAILY_REVIEW_METRICS.expense) return series(values.expense ?? {})
    return null
  }
}

const base = {
  revenue: Object.fromEntries([...mtdDays.map((d) => [d, 500_000]), ['2026-11-08', 507_322.21], ...lyDays.map((d) => [d, 400_000])]),
  orders: Object.fromEntries([...mtdDays.map((d) => [d, 950]), ['2026-11-08', 1_000], ...lyDays.map((d) => [d, 900])]),
  gross: Object.fromEntries([...mtdDays.map((d) => [d, 170_000]), ['2026-11-08', 172_983.20], ...lyDays.map((d) => [d, 130_000])]),
  loss: Object.fromEntries([...mtdDays.map((d) => [d, 500]), ['2026-11-07', 800], ['2026-11-08', 1_000], ...lyDays.map((d) => [d, 700])]),
  expense: Object.fromEntries([...mtdDays.map((d) => [d, 3_000]), ['2026-11-07', 4_000], ['2026-11-08', 5_000], ...lyDays.map((d) => [d, 2_500])]),
}

describe('buildDailyReview', () => {
  it('单日目标日：今天/昨天/MTD 日均/去年同月日均 + 净毛利', async () => {
    const read = fake(base)
    const out = await buildDailyReview({
      spec,
      period: { mode: 'day', day: DAY },
      range: { from: DAY, to: DAY },
      readSeries: (metricId) => read(metricId),
    })
    expect(out).not.toBeNull()
    const dr = out!
    expect(dr.targetDay).toBe(DAY)
    expect(dr.yesterday).toBe('2026-11-07')
    expect(dr.today.revenue).toBe('507,322.21')
    expect(dr.today.orders).toBe('1,000')
    expect(dr.today.aov).toBe('507.32')
    expect(dr.today.gross).toBe('172,983.20')
    expect(dr.today.grossMargin).toBe('34.10%')
    // 172,983.20 - 1,000 - 5,000 = 166,983.20
    expect(dr.today.netGross).toBe('166,983.20')
    expect(dr.today.netMargin).toBe('32.91%')
    expect(dr.comparisons.yesterday?.delta.revenue).toBe('+1.5%')
    expect(dr.comparisons.mtdAvg.baseline.label).toBe('本月至今日均')
    expect(dr.comparisons.lastYearAvg?.baseline.label).toBe('去年同月同日日均')
    expect(dr.mtd.revenue).toBe('4,007,322.21')
    expect(dr.mtd.netGross).toBe('1,331,183.20')
    expect(dr.drivers.some((d) => d.label === '销售成本')).toBe(true)
    expect(dr.suggestions.length).toBeGreaterThanOrEqual(2)
    expect(dr.notes.join(' ')).toContain('未含房租')
    expect(dr.numbers).toContain('507,322.21')
    expect(dr.numbers).toContain('32.91%')
    expect(dr.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('目标日无数据 ⇒ 仍返回 bundle（today 为 -），不抛', async () => {
    const out = await buildDailyReview({
      spec,
      period: { mode: 'day', day: DAY },
      range: { from: DAY, to: DAY },
      readSeries: async () => null,
    })
    expect(out).not.toBeNull()
    expect(out!.today.revenue).toBe('-')
    expect(out!.today.netGross).toBe('-')
    expect(out!.notes.join(' ')).toContain('没有营业额数据')
  })

  it('固定成本表单 + 25% 目标：净毛利扣固定成本，目标按表单', async () => {
    const read = fake(base)
    const out = await buildDailyReview({
      spec,
      period: { mode: 'day', day: DAY },
      range: { from: DAY, to: DAY },
      readFixedCosts: async () => ({ yearMonth: '2026-11', rent: 3100, utilities: 1000, other: 0, targetNetMargin: 0.25 }),
      readSeries: (metricId) => read(metricId),
    })
    expect(out).not.toBeNull()
    const dr = out!
    expect(dr.fixedCostMaintained).toBe(true)
    expect(dr.fixedCostMonthly).toBe('4,100.00')
    expect(dr.fixedCostDaily).toBe('136.67')
    expect(dr.targetNetMargin).toBe('25.00%')
    // 172,983.20 - 1,000 - 5,000 - 4,100/30
    expect(dr.today.netGross).toBe('166,846.53')
    expect(dr.notes.join(' ')).toContain('固定成本 4,100.00/月')
  })

})
