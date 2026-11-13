import { describe, expect, it } from 'vitest'
import { buildDailyReview, DAILY_REVIEW_METRICS, type DailySeries } from './report-daily-review'
import { lastYearMonthToDate, previousRangeOf } from './report-period'
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
    expect(dr.assessment.verdict).toBe('neutral')
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
    // LLM 会引用 MTD 累计与驾驶员差值；这些也必须进白名单，否则整段被回退。
    expect(dr.numbers).toContain('4,007,322.21')
    expect(dr.numbers).toContain('1,331,183.20')
    expect(dr.numbers).toContain('+50')
    expect(dr.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('区间模式（本月）：按区间合计分析，末日取区间内最新有数日', async () => {
    const read = fake(base)
    const out = await buildDailyReview({
      spec,
      period: { mode: 'month', month: '2026-11' },
      range: { from: '2026-11-01', to: '2026-11-10' },
      readSeries: (metricId) => read(metricId),
    })
    expect(out).not.toBeNull()
    const dr = out!
    expect(dr.mode).toBe('range')
    expect(dr.targetDay).toBe('2026-11-08')
    expect(dr.rangeFrom).toBe('2026-11-01')
    expect(dr.rangeDays).toBe(8)
    expect(dr.rangeLabel).toBe('2026-11-01 ~ 2026-11-08（8 天）')
    // 合计而不是单日：7×500,000 + 507,322.21
    expect(dr.today.revenue).toBe('4,007,322.21')
    expect(dr.today.orders).toBe('7,650')
    // 区间日均 vs MTD 日均（同一区间）⇒ 0
    expect(dr.comparisons.mtdAvg.baseline.label).toBe('本月至今日均')
    expect(dr.comparisons.mtdAvg.delta.revenue).toBe('+0.0%')
    expect(dr.numbers).toContain('2026-11-01')
    expect(dr.numbers).toContain('2026-11-08')
  })

  it('R0：区间窗口来自 report-period 同一原语（上一区间 / 去年同月同日）', async () => {
    // 上一区间 10-24..10-31 必须有数，否则 bundle.yesterday 为 null（那不是窗口问题）
    const prevDays = Array.from({ length: 8 }, (_, i) => `2026-10-${24 + i}`)
    const withPrev = Object.fromEntries(
      prevDays.map((d) => [d, 400_000]),
    )
    const values = {
      revenue: { ...base.revenue, ...withPrev },
      orders: { ...base.orders, ...Object.fromEntries(prevDays.map((d) => [d, 900])) },
      gross: { ...base.gross, ...Object.fromEntries(prevDays.map((d) => [d, 130_000])) },
      loss: base.loss,
      expense: base.expense,
    }
    const read = fake(values)
    const out = await buildDailyReview({
      spec,
      period: { mode: 'month', month: '2026-11' },
      range: { from: '2026-11-01', to: '2026-11-10' },
      readSeries: (metricId) => read(metricId),
    })
    const dr = out!
    const prev = previousRangeOf({ from: '2026-11-01', to: dr.targetDay! }, 'prev_period')
    // 上一区间：末日 = 区间首日前一天；首日 = 等长前移（与 KPI/图表对比同一个函数）
    expect(dr.yesterday).toBe(prev.to)
    expect(dr.yesterday).toBe('2026-10-31')
    // 去年同期：去年同月 1 日 ~ 去年同日（不是等长平移）
    const ly = lastYearMonthToDate(dr.targetDay!)
    expect(dr.lastYearFrom).toBe(ly.from)
    expect(dr.lastYearTo).toBe(ly.to)
    expect(dr.lastYearFrom).toBe('2025-11-01')
    expect(dr.lastYearTo).toBe('2025-11-08')
  })

  it('R0：跨月区间且当月无数据 ⇒ MTD 跟随有数末日所在的自然月', async () => {
    const oct = Object.fromEntries(
      Array.from({ length: 31 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, 1_000]),
    )
    const out = await buildDailyReview({
      spec,
      period: { mode: 'custom', from: '2026-10-25', to: '2026-11-10' },
      range: { from: '2026-10-25', to: '2026-11-10' },
      readSeries: fake({ revenue: oct, orders: oct, gross: oct }),
    })
    const dr = out!
    expect(dr.targetDay).toBe('2026-10-31')
    expect(dr.mtd.day).toBe('2026-10-01 ~ 2026-10-31（31 天）')
    expect(dr.mtd.revenue).toBe('31,000.00')
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

  it('天气背景：目标日/昨天进入 bundle 与白名单', async () => {
    const read = fake(base)
    const out = await buildDailyReview({
      spec,
      period: { mode: 'day', day: DAY },
      range: { from: DAY, to: DAY },
      readWeather: async () => ({
        target: { day: DAY, tempMax: '13.5°C', tempMin: '7.0°C', precipitation: '18.7mm', condition: '阵雨' },
        yesterday: { day: '2026-11-07', tempMax: '19.8°C', tempMin: '13.0°C', precipitation: '11.4mm', condition: '阵雨' },
        source: 'Open-Meteo', note: '背景，不推断因果',
      }),
      readSeries: (metricId) => read(metricId),
    })
    expect(out?.weather?.target.condition).toBe('阵雨')
    expect(out?.numbers).toContain('18.7mm')
    expect(out?.numbers).toContain('13.5°C')
  })

})
