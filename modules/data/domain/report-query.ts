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
