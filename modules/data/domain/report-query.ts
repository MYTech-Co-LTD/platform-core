// report-query.ts — 报表面板 → /query 的 args / body 装配纯函数（计划 2026-10-26 Task 2）。
//
// 抽出来的原因：渲染器（console/reports/ReportView.tsx）与事实包构建（AI 文本的 narrative
// 事实面）必须**用同一套装配规则**——两处各写一份，args 的形状迟早漂移，且漂移是静默的
// （服务端 authorize 只会拒绝未知参数，配错值的查询照样回数）。
//
// 语义（逐条对应 ReportView 的既有行为，抽函数不改行为）：
//  · args 只有两个源头：规格 `panel.args` + 调用方覆盖；**期间窗口最后写入**——它是规格级
//    当前期间，优先于面板自带的 bizday 默认值。
//  · `branchNum` 只覆盖**声明过** `branch_num` 的面板：筛选栏的控件只因某个面板声明了这个键
//    才出现，没有声明的面板不该被静默加上一个它从未要过的过滤参数。
//  · 无 slice ⇒ body **只有** `{metricId, args}`：90% 的存量报表逐字节一致；也不把「没声明
//    分组」静默变成 `dimensions: []`（那是**显式合计**形态，语义完全不同）。
//  · `dimensions` 回退顺序 = `slice.dimensions` → 面板 `dims`；两者都空时**不发**。
//
// ⚠️ args 的开放键名（租户自定义过滤参数）安全性全押在服务端 `authorize` 那条链上
//    （unknown_param 拒绝 + 保留键闸 + literal/rangeLiteral 转义）——本文件只负责**原样转发**，
//    不做第三种加工，也不在前端「顺手」过滤未知键（那会让服务端的拒绝面变得不可观测）。
import type { SlicingSpec } from './authz'
import type { DateRange } from './report-period'
import { previousRangeOf } from './report-period'
import type { KpiPanel, PeriodSpec, ReportSpec } from './report-spec'

/** 有数据面的面板（text / ai_text 不查 /query）。 */
export type DataPanel = Exclude<ReportSpec['panels'][number], { chart: 'text' } | { chart: 'ai_text' }>

/**
 * 面板 args 的唯一装配点。
 *
 * 期间窗口**最后**写入：`period` 是规格级的当前期间，优先于面板自带的 `bizday` 默认值。
 * `timeScoped === false` 的面板（字典 / 排行快照）不注入期间。
 */
export function panelArgsOf(
  p: DataPanel,
  range: DateRange | null,
  branchNum?: string,
): Record<string, unknown> {
  const args: Record<string, unknown> = { ...(p.args ?? {}) }
  if (branchNum !== undefined && Object.hasOwn(p.args ?? {}, 'branch_num')) args.branch_num = branchNum
  if (range !== null && p.timeScoped !== false) args.bizday = range
  return args
}

/**
 * /query 的请求 body。
 *
 * · kpi ⇒ **显式合计**（`args.total = true`）：比率 = 分子/分母各自合计后再除，
 *   前端绝不对明细行求和（明细可能被 LIMIT 截断，求和就是错数）。
 * · 有 slice ⇒ 追加服务端分组/排序/截断/合计（`dimensions` 回落到面板 dims）。
 * · 无 slice ⇒ 一个键都不多（旧规格的 body 逐字节一致）。
 */
export function panelQueryBodyOf(
  p: DataPanel,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (p.chart === 'kpi') return { metricId: p.metricId, args: { ...args, total: true } }
  const body: Record<string, unknown> = { metricId: p.metricId, args }
  const slice = p.slice
  if (slice === undefined) return body
  const dims = slice.dimensions ?? p.dims
  // 空数组 = 显式合计 ≠「没声明维度」——后者不发这个键
  if (slice.dimensions !== undefined || dims.length > 0) body.dimensions = dims
  if (slice.orderBy !== undefined) body.orderBy = slice.orderBy
  if (slice.limit !== undefined) body.limit = slice.limit
  if (slice.total !== undefined) body.total = slice.total
  return body
}

/**
 * KPI 的对比段：`auto` 依当前期间模式解析——月 → 上月同日期段（`prev_month`，按月末夹取）；
 * 其余 → 等长前移（`prev_period`）。显式指定的口径原样生效；`none` / 无期间 ⇒ null。
 */
export function compareRangeOf(
  p: KpiPanel,
  periodMode: PeriodSpec['mode'] | undefined,
  range: DateRange | null,
): DateRange | null {
  if (range === null || p.compare === 'none') return null
  const mode = p.compare === 'auto' ? (periodMode === 'month' ? 'prev_month' : 'prev_period') : p.compare
  return previousRangeOf(range, mode)
}

// ── 对比的数据覆盖度（issue #1078）──────────────────────────────────────────────
//
// 判据不是「对比期查询得数」：对比期只被数据覆盖了一部分时**也会得数**，于是算出假环比
// （现场：10-01..19 的对比期 9-12..30，零售数据从 9-23 起 ⇒ 只有 8/19 天）。
// 正确判据 = 对比期**整段**落在指标已有数据范围内：
//   prev.from >= 最早有数日   且   prev.to <= 水位（数据完整到哪天）
// 覆盖探测复用 `/query`（同一授权/掩码/审计通道，不新写 SQL 通道）：
//   明细形态（**不发 dimensions**）+ `orderBy bizday asc` + `limit 1` ⇒ 第一行即最早一天。
//   ⚠️ 子集聚合形态（发 dimensions）的 `orderBy` 会被组装器丢掉，LIMIT 1 变成任意一天，
//      所以这里刻意不发 `dimensions`；指标无 bizday 粒度时查询失败 ⇒ 覆盖未知（不出对比）。

/** 指标在某组过滤条件下的数据覆盖：最早有数日 + 水位（未知 ⇒ null）。 */
export interface CoverageInfo {
  /** 最早有数的一天（YYYY-MM-DD）。 */
  from: string
  /** 数据完整到哪一天（`/query` 的 watermark）；未声明新鲜度关系时缺席。 */
  to: string | null
}

const DAY_PREFIX = /^(\d{4}-\d{2}-\d{2})/

/**
 * 覆盖探测的 args：去掉期间窗口与 `total`——探测要的是**全历史**最早一天，
 * 带上期间窗口就只会看到窗口内的最早值（正是要避开的偏差）。
 */
export function coverageArgsOf(args: Record<string, unknown>): Record<string, unknown> {
  const { bizday: _bizday, total: _total, ...rest } = args
  return rest
}

/** 覆盖探测的切片：明细形态 + bizday 升序 + 1 行（第一行 = 最早一天）。 */
export function coverageSlicing(): SlicingSpec {
  return { orderBy: [{ column: 'bizday', dir: 'asc' }], limit: 1 }
}

/** `/query` 的覆盖探测 body（console 侧直接 POST）。 */
export function coverageQueryBodyOf(metricId: string, args: Record<string, unknown>): Record<string, unknown> {
  const slicing = coverageSlicing()
  return { metricId, args: coverageArgsOf(args), orderBy: slicing.orderBy, limit: slicing.limit }
}

/**
 * 从 `/query` 回包解析覆盖度。任何「读不出可信形状」的情形一律 null（调用方据此不出对比）：
 * 失败状态、空集、没有 bizday 列、日期不是 `YYYY-MM-DD` 开头——都不猜。
 */
export function coverageOfQueryResult(body: unknown): CoverageInfo | null {
  if (typeof body !== 'object' || body === null) return null
  const b = body as { status?: unknown; columns?: unknown; rows?: unknown; watermark?: unknown }
  if (b.status !== 'ok') return null
  if (!Array.isArray(b.columns) || !Array.isArray(b.rows) || b.rows.length === 0) return null
  const idx = b.columns.indexOf('bizday')
  if (idx < 0) return null
  const row = b.rows[0]
  if (!Array.isArray(row)) return null
  const raw = row[idx]
  if (typeof raw !== 'string') return null
  const m = DAY_PREFIX.exec(raw)
  if (m === null) return null
  const from = m[1]!
  const to = typeof b.watermark === 'string' && DAY_PREFIX.test(b.watermark)
    ? b.watermark.slice(0, 10)
    : null
  return { from, to }
}

/** 对比期是否**整段**可覆盖。覆盖未知（null）⇒ false：宁可不出对比，不出假数。 */
export function comparisonCovered(prev: DateRange, coverage: CoverageInfo | null): boolean {
  if (coverage === null) return false
  if (prev.from < coverage.from) return false
  if (coverage.to !== null && prev.to > coverage.to) return false
  return true
}
