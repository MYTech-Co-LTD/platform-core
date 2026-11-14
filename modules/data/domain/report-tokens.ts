// report-tokens.ts — 文本面板 L2 语义内嵌的**服务端解析器**（R3）。
//
// 为什么在服务端：token 取的是**活数**（当前期间/门店/共享筛选下、走同一条授权与掩码链）。
// 前端只拿到「已替换好的文本」——它不取数、不拼数、不改数，也无法把 token 指向报表外的指标。
//
// fail-closed：任何一个引用解析不了（指标不在报表里 / 无权 / 取数失败 / 无值），
// **整块返回失败原因**，不静默降级成空或原样输出 `{{…}}`——那会让人把占位符当数字。
import type { QueryDeps } from './query-service'
import { runQuery } from './query-service'
import type { Requester } from './authz'
import { panelArgsOf, type DataPanel } from './report-query'
import { previousRangeOf, yearAgoRangeOf, type DateRange } from './report-period'
import { formatDelta, formatValue } from './report-format'
import { totalOf } from './report-receipt'
import { metricIdsOf } from './report-scope'
import type { ReportFilter, ReportSpec } from './report-spec'
import type { DeniedPanel } from './report-plan'
import { parseTokens, type MetricToken } from './report-token-parse'

type ViewPanel = ReportSpec['panels'][number] | DeniedPanel
type MetricViewPanel = Exclude<ViewPanel, DeniedPanel | { chart: 'text' } | { chart: 'ai_text' }>

export interface TokenResolveInput {
  content: string
  /** 观看面规格（已过渲染闸：被拒面板已替换为占位符，不得再引用其指标）。 */
  panels: readonly ViewPanel[]
  filters?: readonly ReportFilter[]
  /** 报表当前期间（token 的 range 窗口）。 */
  range: DateRange
  /** 筛选栏当前门店（与面板 args 同源）。 */
  branchNum?: string
  /** 报表共享筛选的运行期取值。 */
  filterValues: Record<string, unknown>
}

export type TokenResolveResult =
  | { ok: true; text: string }
  | { ok: false; detail: string }

interface TokenValue { value: number; asOf?: unknown }

const WINDOW_LABEL: Record<string, string> = {
  range: '当前期间',
  prev_period: '上期',
  prev_month: '上月',
  prev_year: '去年同期',
}

function windowRangeOf(range: DateRange, window: string): DateRange {
  if (window === 'prev_year') return yearAgoRangeOf(range)
  if (window === 'prev_month') return previousRangeOf(range, 'prev_month')
  return previousRangeOf(range, 'prev_period')
}

/** 解析文本里的全部 token（已替换成格式化值）。 */
export async function resolveTextTokens(
  deps: QueryDeps,
  org: string,
  requester: Requester | null,
  input: TokenResolveInput,
): Promise<TokenResolveResult> {
  const parsed = parseTokens(input.content)
  if (!parsed.ok) return { ok: false, detail: `文本引用语法不合法：${parsed.detail}` }
  if (parsed.tokens.length === 0) return { ok: true, text: input.content }

  const filterDefs = input.filters === undefined || input.filters.length === 0
    ? undefined
    : { defs: input.filters, values: input.filterValues }

  /** token 只能引用 plan 里出现过的指标；被渲染闸拒绝的面板不留指标 ⇒ 自然找不到。 */
  const panelOf = (metricId: string): MetricViewPanel | undefined =>
    input.panels.find((p): p is MetricViewPanel =>
      !('denied' in p) && p.chart !== 'text' && p.chart !== 'ai_text' && metricIdsOf(p).includes(metricId))

  const queryCache = new Map<string, Promise<{ ok: true; v: TokenValue } | { ok: false; detail: string }>>()

  const queryOf = (
    token: MetricToken, metricId: string, window: string,
  ): Promise<{ ok: true; v: TokenValue } | { ok: false; detail: string }> => {
    const key = `${metricId}|${window}`
    const hit = queryCache.get(key)
    if (hit !== undefined) return hit
    const p = panelOf(metricId)
    if (p === undefined) {
      return Promise.resolve({ ok: false, detail: `文本引用的指标不在本报表里：${metricId}` })
    }
    // 非时间面板没有窗口语义：切窗口等于静默换一个口径，拒。
    if (window !== 'range' && p.timeScoped === false) {
      return Promise.resolve({
        ok: false, detail: `指标 ${metricId} 不按时间切片，不能用 window:${window}`,
      })
    }
    const range = window === 'range' ? input.range : windowRangeOf(input.range, window)
    const args = {
      ...panelArgsOf(p as DataPanel, range, input.branchNum, filterDefs),
      total: true,
    }
    const run = (async () => {
      const out = await runQuery(deps, org, requester, metricId, args)
      if (out.status === 'denied') {
        if (out.reason === 'bad_param') {
          return {
            ok: false as const,
            detail: `指标 ${metricId} 不接受当前的筛选或窗口（${out.detail ?? 'bad_param'}）`,
          }
        }
        return { ok: false as const, detail: `无权查看指标 ${metricId} 的数据（${out.reason}）` }
      }
      if (out.status !== 'ok') {
        return { ok: false as const, detail: `指标 ${metricId} 取数失败（${out.reason}）` }
      }
      const raw = totalOf(out)
      if (raw === null) {
        return { ok: false as const, detail: `指标 ${metricId} 在${WINDOW_LABEL[window] ?? window}没有数值` }
      }
      // KPI 比率 = 分子 ÷ 分母：token 引用主指标时与卡片逐字一致（KpiCard.valueOf 同一条语义）。
      let value = raw
      if (p.chart === 'kpi' && metricId === p.metricId && p.denominatorMetricId !== undefined) {
        const den = await runQuery(deps, org, requester, p.denominatorMetricId, args)
        if (den.status !== 'ok') {
          return { ok: false as const, detail: `指标 ${p.denominatorMetricId} 取数失败（比率分母）` }
        }
        const denominator = totalOf(den)
        if (denominator === null || denominator === 0) {
          return { ok: false as const, detail: `指标 ${metricId} 的比率在${WINDOW_LABEL[window] ?? window}无定义（分母为 0 或缺数）` }
        }
        value = raw / denominator
      }
      return { ok: true as const, v: { value, ...(out.data_as_of === undefined ? {} : { asOf: out.data_as_of }) } }
    })()
    queryCache.set(key, run)
    return run
  }

  let text = input.content
  for (const token of parsed.tokens) {
    const fmt = token.fmt ?? 'number'
    if (token.kind === 'as_of') {
      const cur = await queryOf(token, token.metricId, 'range')
      if (!cur.ok) return cur
      if (cur.v.asOf === undefined || cur.v.asOf === null) {
        return { ok: false, detail: `指标 ${token.metricId} 没有数据截止时间` }
      }
      text = text.replaceAll(token.raw, String(cur.v.asOf))
      continue
    }
    const cur = await queryOf(token, token.metricId, token.window ?? 'range')
    if (!cur.ok) return cur
    if (token.kind === 'metric') {
      text = text.replaceAll(token.raw, formatValue(cur.v.value, fmt))
      continue
    }
    // delta：当前窗口 − 对比窗口；比率指标由 formatDelta 给百分点（pp），与 KPI 卡同一条口径。
    const vs = token.vs ?? 'prev_period'
    const prev = await queryOf(token, token.metricId, vs)
    if (!prev.ok) return prev
    text = text.replaceAll(token.raw, formatDelta(cur.v.value, prev.v.value, fmt))
  }
  return { ok: true, text }
}
