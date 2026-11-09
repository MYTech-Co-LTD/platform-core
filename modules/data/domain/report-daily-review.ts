// report-daily-review.ts — `ai_text` 的日报经营体检（focus=`daily_review`，P1）。
//
// 定位：一次生成、文本输出。目标日 = 单日过滤选中的营业日；未选单日时取
// 「营业额/订单/毛利都齐全的最近营业日」。三个基线：
//   ① 昨天（环比日）
//   ② 本月至今日均（MTD 累计 ÷ 已过天数）
//   ③ 去年同月同日之前的日均（同月同日期段的累计 ÷ 同一天数）
//
// 口径：
//   · 毛利 = `lemeng:retail:gross_profit`（P0 的 fct_retail_profit，不含券）
//   · 净毛利 = 毛利 − 报损 − 费用；**不含房租/水电**（固定成本 P2 接智能表格后再减）
//   · 净毛利率目标默认 20%（P2 做成租户/门店参数）
//   · 所有取数只经 buildFacts 注入的 `readSeries`（→ runQuery），本文件不写 SQL、不做权限判定
//   · 所有输出数字先格式化进 `numbers`；narrative 的 LLM 只负责表述，不重新算术
import { createHash } from 'node:crypto'
import dayjs from 'dayjs'
import { formatDelta, formatValue } from './report-format'
import type { DateRange } from './report-period'
import type { KpiPanel, PeriodSpec, ReportSpec } from './report-spec'

/** 日报固定使用的 L1 指标（与报表 panel 是否展示无关；授权/掩码仍由 runQuery 负责）。 */
export const DAILY_REVIEW_METRICS = {
  revenue: 'lemeng:retail:net_sales',
  orders: 'lemeng:retail:order_count',
  gross: 'lemeng:retail:gross_profit',
  loss: 'lemeng:loss:branch_amount',
  expense: 'lemeng:expense:branch_net',
} as const

/** 净毛利率目标：P2 前固定 20%。 */
export const NET_MARGIN_TARGET = 0.2
/** 好/坏判定阈值：日环比 ±5%。 */
const DELTA_THRESHOLD = 5

export interface DailySeries {
  columns: readonly string[]
  rows: readonly unknown[][]
  dataAsOf?: string | null
}

export type ReadDailySeries = (
  metricId: string,
  args: Record<string, unknown>,
) => Promise<DailySeries | null>

export interface DailyReviewDeps {
  readSeries: ReadDailySeries
  spec: ReportSpec
  period: PeriodSpec
  range: DateRange
  branchNum?: string
}

export interface DailySnapshot {
  label: string
  /** 单日 = YYYY-MM-DD；日均 = 说明串。 */
  day: string
  revenue: string
  orders: string
  aov: string
  gross: string
  grossMargin: string
  loss: string
  expense: string
  netGross: string
  netMargin: string
}

export interface DailyComparison {
  baseline: DailySnapshot
  /** 今天相对基线的变化（金额为相对变化率，利率为 pp）。 */
  delta: {
    revenue: string
    orders: string
    aov: string
    gross: string
    netMargin: string
  }
}

export interface DailyDriver {
  side: 'sales' | 'cost'
  label: string
  /** 今天的值（格式化）。 */
  value: string
  /** 相对基线（昨天/MTD 日均）的金额差或说明。 */
  delta: string
}

export interface DailyReviewBundle {
  /** 目标营业日（YYYY-MM-DD）。 */
  targetDay: string
  /** 昨天；数据不全 ⇒ null。 */
  yesterday: string | null
  /** MTD 起始日 / 去年同月同日区间。 */
  monthStart: string
  lastYearFrom: string
  lastYearTo: string
  /** 目标日快照。 */
  today: DailySnapshot
  /** 三个基线对比；去年无数据 ⇒ null。 */
  comparisons: {
    yesterday: DailyComparison | null
    mtdAvg: DailyComparison
    lastYearAvg: DailyComparison | null
  }
  /** MTD 累计快照（累计值，不是日均）。 */
  mtd: DailySnapshot
  /** 销售侧/成本侧驱动，按绝对影响降序。 */
  drivers: DailyDriver[]
  /** 2–3 条可执行建议（已带金额/项目）。 */
  suggestions: string[]
  /** 目标净毛利率（格式化，P1 固定 20%）。 */
  targetNetMargin: string
  /** 数据边界与口径说明（未含固定成本、数据缺失等）。 */
  notes: string[]
  /** 额外数字白名单（并入 FactBundle.numbers）。 */
  numbers: string[]
  dataAsOf: string | null
  hash: string
}

interface RawDay {
  day: string
  revenue: number | null
  orders: number | null
  gross: number | null
  loss: number
  expense: number
  aov: number | null
  grossMargin: number | null
  netGross: number | null
  netMargin: number | null
}

interface RawPeriod {
  from: string
  to: string
  days: number
  revenue: number | null
  orders: number | null
  gross: number | null
  loss: number
  expense: number
  avgRevenue: number | null
  avgOrders: number | null
  avgGross: number | null
  aov: number | null
  grossMargin: number | null
  netGross: number | null
  netMargin: number | null
}

const EMPTY = '-'

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 日期列 → YYYY-MM-DD（与 report-facts.dayLabelOf 同口径，但独立实现避免运行时环）。 */
function dayKeyOf(v: unknown): string | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null
    const y = v.getFullYear()
    const m = String(v.getMonth() + 1).padStart(2, '0')
    const d = String(v.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
  }
  if (typeof v === 'string') {
    const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
    return m === null ? null : m[1]!
  }
  return null
}

function fmt(v: number | null, format: KpiPanel['format']): string {
  return v === null ? EMPTY : formatValue(v, format).replace(/^¥/, '')
}

function delta(cur: number | null, base: number | null, format: KpiPanel['format']): string {
  return cur === null || base === null ? EMPTY : formatDelta(cur, base, format)
}

/** 金额差（带 +/- 与千分位），用于驾驶员；不做百分比。 */
function signedAmount(v: number | null): string {
  if (v === null) return EMPTY
  const s = formatValue(Math.abs(v), 'currency').replace(/^¥/, '')
  return `${v >= 0 ? '+' : '-'}${s}`
}

function seriesOf(out: DailySeries): Map<string, number> {
  const m = new Map<string, number>()
  const dIdx = out.columns.indexOf('bizday')
  const vIdx = out.columns.indexOf('value')
  if (dIdx < 0 || vIdx < 0) return m
  for (const row of out.rows) {
    const day = dayKeyOf(row[dIdx])
    const value = num(row[vIdx])
    if (day !== null && value !== null) m.set(day, value)
  }
  return m
}

function sumRange(m: Map<string, number>, from: string, to: string): number | null {
  let sum = 0
  let seen = false
  for (const [day, value] of m) {
    if (day >= from && day <= to) {
      sum += value
      seen = true
    }
  }
  return seen ? sum : null
}

function rawDayOf(
  m: { revenue: Map<string, number>; orders: Map<string, number>; gross: Map<string, number>; loss: Map<string, number>; expense: Map<string, number> },
  day: string,
): RawDay {
  const revenue = m.revenue.get(day) ?? null
  const orders = m.orders.get(day) ?? null
  const gross = m.gross.get(day) ?? null
  const loss = m.loss.get(day) ?? 0
  const expense = m.expense.get(day) ?? 0
  const aov = revenue !== null && orders !== null && orders > 0 ? revenue / orders : null
  const grossMargin = revenue !== null && gross !== null && revenue > 0 ? gross / revenue : null
  const netGross = gross === null ? null : gross - loss - expense
  const netMargin = revenue !== null && netGross !== null && revenue > 0 ? netGross / revenue : null
  return { day, revenue, orders, gross, loss, expense, aov, grossMargin, netGross, netMargin }
}

function rawPeriodOf(
  m: { revenue: Map<string, number>; orders: Map<string, number>; gross: Map<string, number>; loss: Map<string, number>; expense: Map<string, number> },
  from: string,
  to: string,
  days: number,
): RawPeriod {
  const revenue = sumRange(m.revenue, from, to)
  const orders = sumRange(m.orders, from, to)
  const gross = sumRange(m.gross, from, to)
  const loss = sumRange(m.loss, from, to) ?? 0
  const expense = sumRange(m.expense, from, to) ?? 0
  const avgRevenue = revenue === null ? null : revenue / days
  const avgOrders = orders === null ? null : orders / days
  const avgGross = gross === null ? null : gross / days
  const aov = revenue !== null && orders !== null && orders > 0 ? revenue / orders : null
  const grossMargin = revenue !== null && gross !== null && revenue > 0 ? gross / revenue : null
  const netGross = avgGross === null ? null : avgGross - loss / days - expense / days
  const netMargin = avgRevenue !== null && netGross !== null && avgRevenue > 0 ? netGross / avgRevenue : null
  return { from, to, days, revenue, orders, gross, loss, expense, avgRevenue, avgOrders, avgGross, aov, grossMargin, netGross, netMargin }
}

function snapshotOfDay(raw: RawDay, label: string): DailySnapshot {
  return {
    label,
    day: raw.day,
    revenue: fmt(raw.revenue, 'currency'),
    orders: fmt(raw.orders, 'number'),
    aov: fmt(raw.aov, 'currency'),
    gross: fmt(raw.gross, 'currency'),
    grossMargin: fmt(raw.grossMargin, 'percent'),
    loss: fmt(raw.loss, 'currency'),
    expense: fmt(raw.expense, 'currency'),
    netGross: fmt(raw.netGross, 'currency'),
    netMargin: fmt(raw.netMargin, 'percent'),
  }
}

function snapshotOfAvg(raw: RawPeriod, label: string): DailySnapshot {
  return {
    label,
    day: `${raw.from} ~ ${raw.to}（${raw.days} 天日均）`,
    revenue: fmt(raw.avgRevenue, 'currency'),
    orders: fmt(raw.avgOrders, 'number'),
    aov: fmt(raw.aov, 'currency'),
    gross: fmt(raw.avgGross, 'currency'),
    grossMargin: fmt(raw.grossMargin, 'percent'),
    loss: fmt(raw.loss / raw.days, 'currency'),
    expense: fmt(raw.expense / raw.days, 'currency'),
    netGross: fmt(raw.netGross, 'currency'),
    netMargin: fmt(raw.netMargin, 'percent'),
  }
}

function compareOf(today: RawDay, base: RawDay | RawPeriod, label: string): DailyComparison {
  const isPeriod = 'avgGross' in base
  const baseRevenue = isPeriod ? base.avgRevenue : base.revenue
  const baseOrders = isPeriod ? base.avgOrders : base.orders
  const baseGross = isPeriod ? base.avgGross : base.gross
  const baseAov = base.aov
  const baseNetMargin = base.netMargin
  const baseline = isPeriod
    ? snapshotOfAvg(base, label)
    : snapshotOfDay(base, label)
  return {
    baseline,
    delta: {
      revenue: delta(today.revenue, baseRevenue, 'currency'),
      orders: delta(today.orders, baseOrders, 'number'),
      aov: delta(today.aov, baseAov, 'currency'),
      gross: delta(today.gross, baseGross, 'currency'),
      netMargin: delta(today.netMargin, baseNetMargin, 'percent'),
    },
  }
}

function baseArgsOf(spec: ReportSpec, branchNum?: string): Record<string, unknown> | null {
  const panels = spec.panels.filter((p) => p.chart !== 'text' && p.chart !== 'ai_text')
  if (panels.length === 0) return null
  const preferred = panels.find((p) => p.chart === 'kpi' && p.metricId === DAILY_REVIEW_METRICS.revenue)
    ?? panels.find((p) => p.chart === 'kpi')
    ?? panels[0]!
  const args = { ...(preferred.args ?? {}) } as Record<string, unknown>
  delete args.bizday
  delete args.total
  if (branchNum !== undefined) args.branch_num = branchNum
  return args
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

function gradeDelta(d: string, goodDirection: 'up' | 'down' = 'up'): 'good' | 'bad' | 'neutral' {
  const m = /^([+-]?)(\d+(?:\.\d+)?)(%|pp)$/.exec(d)
  if (m === null) return 'neutral'
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1)
  if (Math.abs(n) < DELTA_THRESHOLD) return 'neutral'
  return goodDirection === 'up' ? (n > 0 ? 'good' : 'bad') : (n < 0 ? 'good' : 'bad')
}

/**
 * 构建日报事实包。返回 null ⇒ 报表没有可用数据面板/指标查询全部失败；
 * 目标日无数据时仍返回 bundle（hasData 由调用方按 today 是否为空判断），让文本说「无有效数据」。
 */
export async function buildDailyReview(deps: DailyReviewDeps): Promise<DailyReviewBundle | null> {
  const baseArgs = baseArgsOf(deps.spec, deps.branchNum)
  if (baseArgs === null) return null

  const ceiling = deps.period.mode === 'day' && deps.period.day !== undefined
    ? deps.period.day
    : deps.range.to
  if (!dayjs(ceiling).isValid()) return null
  const monthStart = dayjs(ceiling).startOf('month').format('YYYY-MM-DD')
  const lastYearFrom = dayjs(ceiling).subtract(1, 'year').startOf('month').format('YYYY-MM-DD')
  const lastYearCeiling = dayjs(ceiling).subtract(1, 'year').format('YYYY-MM-DD')
  const wideFrom = [deps.range.from, monthStart, lastYearFrom]
    .reduce((a, b) => (a < b ? a : b))
  const wideTo = ceiling

  const read = async (metricId: string): Promise<{ map: Map<string, number>; ok: boolean }> => {
    const out = await deps.readSeries(metricId, { ...baseArgs, bizday: { from: wideFrom, to: wideTo } })
    return { map: out === null ? new Map() : seriesOf(out), ok: out !== null }
  }
  // 顺序读，不并发：pg_duckdb 每连接一个 DuckDB 实例（1.5GB limit），5 路并发在 7.6G 数据面机会 OOM。
  const revenueR = await read(DAILY_REVIEW_METRICS.revenue)
  const ordersR = await read(DAILY_REVIEW_METRICS.orders)
  const grossR = await read(DAILY_REVIEW_METRICS.gross)
  const lossR = await read(DAILY_REVIEW_METRICS.loss)
  const expenseR = await read(DAILY_REVIEW_METRICS.expense)
  const m = { revenue: revenueR.map, orders: ordersR.map, gross: grossR.map, loss: lossR.map, expense: expenseR.map }

  const common = [...revenueR.map.keys()].filter(
    (d) => d <= ceiling && ordersR.map.has(d) && grossR.map.has(d),
  ).sort()
  const targetDay = deps.period.mode === 'day' && deps.period.day !== undefined
    ? deps.period.day
    : common.at(-1)
  if (targetDay === undefined) return null

  const today = rawDayOf(m, targetDay)
  const yesterdayDay = dayjs(targetDay).subtract(1, 'day').format('YYYY-MM-DD')
  const yesterdayRaw = rawDayOf(m, yesterdayDay)
  const yesterday = yesterdayRaw.revenue === null && yesterdayRaw.gross === null ? null : yesterdayRaw

  const mtdDays = dayjs(targetDay).date()
  const mtd = rawPeriodOf(m, monthStart, targetDay, mtdDays)
  const lyDay = Math.min(dayjs(targetDay).date(), dayjs(lastYearCeiling).daysInMonth())
  const lastYear = rawPeriodOf(m, lastYearFrom, lastYearCeiling, lyDay)
  const hasLastYear = lastYear.revenue !== null || lastYear.gross !== null

  const comparisons = {
    yesterday: yesterday === null ? null : compareOf(today, yesterday, '昨天'),
    mtdAvg: compareOf(today, mtd, '本月至今日均'),
    lastYearAvg: hasLastYear ? compareOf(today, lastYear, '去年同月同日日均') : null,
  }

  // 驱动：优先用昨天；昨天缺失时退 MTD 日均。成本侧 = 毛利率变化 + 报损 + 费用。
  const base: RawDay | RawPeriod = yesterday ?? mtd
  const isPeriod = 'avgGross' in base
  const baseRevenue = isPeriod ? base.avgRevenue : base.revenue
  const baseOrders = isPeriod ? base.avgOrders : base.orders
  const baseGross = isPeriod ? base.avgGross : base.gross
  const baseLoss = isPeriod ? base.loss / base.days : base.loss
  const baseExpense = isPeriod ? base.expense / base.days : base.expense
  const drivers: Array<DailyDriver & { impact: number }> = []
  const pushDriver = (side: 'sales' | 'cost', label: string, value: number | null, baseValue: number | null, text: string, impact: number, format: KpiPanel['format'] = 'currency'): void => {
    if (value === null || baseValue === null) return
    drivers.push({ side, label, value: fmt(value, format), delta: text, impact })
  }
  if (today.orders !== null && baseOrders !== null) {
    const d = today.orders - baseOrders
    pushDriver('sales', '订单数', today.orders, baseOrders, `${d >= 0 ? '+' : ''}${fmt(d, 'number')} 单`, Math.abs(d * (base.aov ?? 0)), 'number')
  }
  if (today.aov !== null && base.aov !== null) {
    const d = today.aov - base.aov
    pushDriver('sales', '客单价', today.aov, base.aov, signedAmount(d), Math.abs(d * (today.orders ?? 0)))
  }
  if (today.gross !== null && baseGross !== null) {
    const d = today.gross - baseGross
    pushDriver('cost', '毛利', today.gross, baseGross, signedAmount(d), Math.abs(d))
  }
  if (today.revenue !== null && baseRevenue !== null && today.gross !== null && baseGross !== null) {
    const cogsDelta = (today.revenue - baseRevenue) - (today.gross - baseGross)
    if (Math.abs(cogsDelta) > 0) {
      drivers.push({
        side: 'cost', label: '销售成本', value: fmt(today.revenue - today.gross, 'currency'),
        delta: signedAmount(cogsDelta), impact: Math.abs(cogsDelta),
      })
    }
  }
  if (today.loss !== baseLoss) {
    const d = today.loss - baseLoss
    if (Math.abs(d) > 0) drivers.push({ side: 'cost', label: '报损', value: fmt(today.loss, 'currency'), delta: signedAmount(d), impact: Math.abs(d) })
  }
  if (today.expense !== baseExpense) {
    const d = today.expense - baseExpense
    if (Math.abs(d) > 0) drivers.push({ side: 'cost', label: '费用', value: fmt(today.expense, 'currency'), delta: signedAmount(d), impact: Math.abs(d) })
  }
  drivers.sort((a, b) => b.impact - a.impact)
  const topDrivers = drivers.slice(0, 4).map(({ impact: _impact, ...d }) => d)

  const notes: string[] = [
    '净毛利 = 毛利 − 报损 − 费用；当前**未含房租、水电等固定成本**（P2 接智能表格后扣除）。',
  ]
  if (!lossR.ok) notes.push('报损指标查询失败/无权限，净毛利按报损 0 计，结果不可信。')
  if (!expenseR.ok) notes.push('费用指标查询失败/无权限，净毛利按费用 0 计，结果不可信。')
  if (comparisons.lastYearAvg === null) notes.push('去年同月无数据，无法比较去年同月日均。')
  if (yesterday === null) notes.push('昨天数据不完整，环比基线改用本月至今日均。')
  if (today.revenue === null) notes.push('所选日期没有营业额数据。')

  const suggestions: string[] = []
  const targetGap = today.netGross === null || today.revenue === null
    ? null
    : today.netGross - today.revenue * NET_MARGIN_TARGET
  if (today.netMargin !== null && today.netMargin < NET_MARGIN_TARGET) {
    suggestions.push(
      `净毛利率 ${fmt(today.netMargin, 'percent')}，低于 ${fmt(NET_MARGIN_TARGET, 'percent')} 目标；当日净毛利缺口 ${signedAmount(targetGap)}，优先压降报损/费用并核对毛利。`,
    )
  }
  const revDelta = comparisons.yesterday?.delta.revenue ?? comparisons.mtdAvg.delta.revenue
  const orderDelta = comparisons.yesterday?.delta.orders ?? comparisons.mtdAvg.delta.orders
  const aovDelta = comparisons.yesterday?.delta.aov ?? comparisons.mtdAvg.delta.aov
  if (gradeDelta(revDelta) === 'bad' && gradeDelta(orderDelta) === 'bad') {
    suggestions.push(`营业额 ${revDelta} 且订单数 ${orderDelta}：优先查客流/排班/缺货，再核对是否有整段闭店或采集缺口。`)
  } else if (gradeDelta(revDelta) === 'bad' && gradeDelta(aovDelta) === 'bad') {
    suggestions.push(`营业额 ${revDelta} 且客单价 ${aovDelta}：优先复盘促销力度与商品结构，避免只靠低价拉动。`)
  }
  const topCost = topDrivers.find((d) => d.side === 'cost' && d.delta.startsWith('+'))
  if (topCost !== undefined) suggestions.push(`${topCost.label}较基线 ${topCost.delta}（当日 ${topCost.value}），先复盘该项的明细原因。`)
  if (today.loss > 0 && dayjs(targetDay).date() > 1) {
    suggestions.push(`报损当日 ${fmt(today.loss, 'currency')}，按原因取前 2 项核对是否存在集中报废/验收问题。`)
  }
  if (suggestions.length < 2) {
    suggestions.push('先核对当日数据完整性（营业额/毛利/报损/费用是否都已到齐），再做经营动作判断。')
  }
  suggestions.splice(3)

  const mtdSnapshot: DailySnapshot = {
    label: '本月累计',
    day: `${monthStart} ~ ${targetDay}（${mtdDays} 天）`,
    revenue: fmt(mtd.revenue, 'currency'),
    orders: fmt(mtd.orders, 'number'),
    aov: fmt(mtd.aov, 'currency'),
    gross: fmt(mtd.gross, 'currency'),
    grossMargin: fmt(mtd.grossMargin, 'percent'),
    loss: fmt(mtd.loss, 'currency'),
    expense: fmt(mtd.expense, 'currency'),
    netGross: fmt(mtd.netGross === null ? null : mtd.netGross * mtdDays, 'currency'),
    netMargin: fmt(mtd.netMargin, 'percent'),
  }
  const snapshots = [
    snapshotOfDay(today, '目标日'),
    comparisons.yesterday?.baseline,
    comparisons.mtdAvg.baseline,
    comparisons.lastYearAvg?.baseline,
    mtdSnapshot,
    snapshotOfAvg(mtd, '本月累计日均'),
  ].filter((x): x is DailySnapshot => x !== undefined)
  const numbers = new Set<string>([targetDay, yesterdayDay, monthStart, lastYearFrom, lastYearCeiling, String(mtdDays), String(lyDay)])
  const add = (s: string): void => {
    if (s !== '' && s !== EMPTY && s !== '-') numbers.add(s)
  }
  for (const s of snapshots) {
    for (const v of [s.revenue, s.orders, s.aov, s.gross, s.grossMargin, s.loss, s.expense, s.netGross, s.netMargin]) add(v)
  }
  for (const c of [comparisons.yesterday, comparisons.mtdAvg, comparisons.lastYearAvg]) {
    if (c === null) continue
    for (const v of Object.values(c.delta)) add(v)
  }
  for (const d of topDrivers) {
    add(d.value)
    add(d.delta)
    for (const m of d.delta.match(/[+-]?\d[\d,]*(?:\.\d+)?(?:%|pp)?/g) ?? []) add(m)
  }
  for (const s of suggestions) for (const m of s.match(/[+-]?\d[\d,]*(?:\.\d+)?(?:%|pp)?/g) ?? []) add(m)
  if (targetGap !== null) add(signedAmount(targetGap))

  const body = {
    targetDay,
    yesterday: yesterday === null ? null : yesterdayDay,
    monthStart,
    lastYearFrom,
    lastYearTo: lastYearCeiling,
    today: snapshotOfDay(today, '目标日'),
    comparisons,
    mtd: mtdSnapshot,

    drivers: topDrivers,
    suggestions,
    targetNetMargin: fmt(NET_MARGIN_TARGET, 'percent'),
    notes,
    numbers: [...numbers],
    dataAsOf: null as string | null,
  }
  const hash = createHash('sha256').update(canonicalJson(body)).digest('hex')
  return { ...body, hash }
}
