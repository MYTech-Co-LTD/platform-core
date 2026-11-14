// report-scope.ts — 报表写入侧校验（spec §4.2）。
//
// 纯函数、无 IO：入参故意收窄到「校验动得到的字段」，这样单测不用造完整的 MetricDef，
// 也让「这个函数不碰库」变成类型上的事实而不是约定。
import type { ReportSpec } from './report-spec'

/**
 * 校验只看词表行的这四个字段（`MetricRow` 结构性满足它）：
 * - `requiredScope`：页门派生（§4.2）
 * - `totalable`：可加性（line/bar/kpi 不过合计就是假数）
 * - `sourceSystem`：源裁剪（未接入的源的指标不得进报表；`null` = 本租户自己的 L2 行，恒可用）
 */
export interface ScopeRow {
  id: string
  requiredScope: string | null
  totalable: boolean
  sourceSystem: string | null
}

export type DeriveResult =
  | { ok: true; requiredScope: string | null }
  | { ok: false; reason: 'UNKNOWN_PANEL_METRIC'; metricId: string }
  | { ok: false; reason: 'CONFLICTING_PANEL_SCOPES'; scopes: string[] }

export type ValidateResult =
  | { ok: true }
  | {
    ok: false
    reason: 'UNKNOWN_PANEL_METRIC' | 'METRIC_SOURCE_NOT_ADOPTED' | 'CHART_REQUIRES_ADDITIVE' | 'KPI_NOT_TOTALABLE'
    metricId: string
  }
  // ai_text 的结构闸没有 metricId 可点名（问题出在「整份规格缺什么」，不在某个面板）。
  | { ok: false; reason: 'AI_TEXT_REQUIRES_DATA_PANEL' | 'AI_TEXT_REQUIRES_PERIOD' }

/** 真有数据面的图型（ai_text 不是数据面板：它读的是**别人**算出来的事实包）。 */
const DATA_CHARTS = new Set<ReportSpec['panels'][number]['chart']>(['line', 'bar', 'table', 'cross_table', 'waterfall', 'bullet', 'kpi'])

/**
 * `metricIdsOf` 的最小输入形状：**故意全可选**——除了真实面板，观看面还会出现降级占位符
 * `{ index, denied: true }`（`ViewableSpec`）。占位符没有任何指标字段，必须**返回空数组**，
 * 而不是 `[undefined]`（后者会让调用方把 undefined 当指标 id 查词表、拼 `Set`、写日志）。
 */
export interface MetricIdPanel {
  chart?: string
  metricId?: string
  denominatorMetricId?: string
}

/**
 * 面板引用的指标 id（**全部**，不是只取主指标）。
 *
 * ⚠️ text / ai_text 面板没有 metricId ⇒ 必须跳过：按 `panel.metricId` 硬取会把它当成
 *    「指向不存在的指标」拒掉，文字块就没法进报表。
 * ⚠️ **降级占位符** `{ index, denied: true }` 也没有 chart/metricId ⇒ 同样跳过（守卫见下）；
 *    否则会返回 `[undefined]`，污染调用方的 id 集合。
 * ⚠️ kpi 的分母是**第二个指标**：它的 scope 与源接入情况同样约束报表可见性，
 *    漏掉分母 = 「主指标可见、分母 403」的报表在运行时才炸。
 *
 * 发布门（`report-scope-gate.ts`）也 import 这一份：分母的**可见性**与它的 scope/源同样要判。
 */
export function metricIdsOf(panel: MetricIdPanel): string[] {
  if (panel.chart === undefined || panel.chart === 'text' || panel.chart === 'ai_text') return []
  const metricId = panel.metricId
  // 无 metricId（降级占位符 / 陈旧形状）⇒ 没有指标可判，跳过而不是产出 undefined。
  if (metricId === undefined || metricId === '') return []
  const denominator = panel.denominatorMetricId
  const ids = panel.chart === 'kpi' && denominator !== undefined && denominator !== ''
    ? [metricId, denominator]
    : [metricId]
  // 分母与主指标同 id 时只留一份：发布门会逐项回报违规，重复会让同一面板报两条。
  return [...new Set(ids)]
}

/**
 * 从面板指标派生报表的 `requiredScope`——它是「**报表可见 ⇒ 每个面板的指标都可见**」
 * 这条不变量的**唯一**实现（spec §4.2）。
 *
 * ⚠️ 为什么不是「取 max(面板 scope)」：**`max` 无定义**——scope 是不透明字符串，这套模型里
 *    **没有 scope 层级**（`hasScope` 就是集合成员判断），故 `hasScope(A) ⇒ hasScope(B)`
 *    当且仅当 `A === B`。⇒ 只能按**集合**判：多元素时单值列**表达不了**「这些码都要有」，
 *    唯一诚实的动作是**拒绝发布并点名**。
 *
 * ⚠️ 为什么多元素是拒绝而不是挑一个：挑任一个都会放行「只有 C1 没有 C2」的人，而他的 C2 面板
 *    `/query` 会 403 ⇒ **报表看起来正常、点进去炸**。宁可发布时响亮地失败。
 *
 * ⚠️ `renderer === 'metabase'` 的报表**不走这里**（`spec` 为 null，没有面板可推）——
 *    那条分支的 `requiredScope` 仍由调用方给。调用点负责这个分支，本函数不做判断。
 */
export function deriveRequiredScope(
  spec: ReportSpec,
  catalog: readonly ScopeRow[],
): DeriveResult {
  const scopes = new Set<string>()
  for (const panel of spec.panels) {
    for (const id of metricIdsOf(panel)) {
      const metric = catalog.find((m) => m.id === id)
      if (metric === undefined) return { ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: id }
      if (metric.requiredScope !== null) scopes.add(metric.requiredScope)
    }
  }
  if (scopes.size > 1) return { ok: false, reason: 'CONFLICTING_PANEL_SCOPES', scopes: [...scopes] }
  return { ok: true, requiredScope: scopes.size === 0 ? null : [...scopes][0] }
}

/**
 * 面板指标在**写入侧**的可发布性校验（spec §4.2 补强）：
 *
 * - `UNKNOWN_PANEL_METRIC`：面板指向词表里没有的指标（含 kpi 分母）。
 * - `METRIC_SOURCE_NOT_ADOPTED`：指标所属源系统本租户未接入——它的 `/query` 会 403。
 *   L2 行（`sourceSystem === null`）恒可用。
 * - `CHART_REQUIRES_ADDITIVE`：line/bar 会沿维度求和，不可加指标（比率/去重计数）
 *   求和出来是没有意义的数 ⇒ 写入即拒（table 展示明细不受此限）。
 * - `KPI_NOT_TOTALABLE`：kpi 大数字本就是合计值，不可加指标放上去同样出假数。
 * - `AI_TEXT_REQUIRES_DATA_PANEL`：ai_text 的文本**只能引用报表自身面板的事实**；
 *   纯 ai_text 报表没有事实可依据 ⇒ 生成出来的是脱离数据的空话（写侧即拒）。
 * - `AI_TEXT_REQUIRES_PERIOD`：ai_text 说的是「当前期间」的结论；没有报表期间就无从确定
 *   时间窗，生成内容的语义不成立。
 *
 * ⚠️ 校验顺序即**错误归因优先级**：结构闸（ai_text 缺数据面/缺期间）先于逐面板指标——
 *    它说的是「整份规格不成立」，先修它再谈指标。逐面板内部仍是未知指标 → 源裁剪 → 可加性。
 */
export function validatePanelMetrics(
  spec: ReportSpec,
  catalog: readonly ScopeRow[],
  adoptedSources: ReadonlySet<string>,
): ValidateResult {
  const hasAi = spec.panels.some((p) => p.chart === 'ai_text')
  if (hasAi && !spec.panels.some((p) => DATA_CHARTS.has(p.chart))) {
    return { ok: false, reason: 'AI_TEXT_REQUIRES_DATA_PANEL' }
  }
  if (hasAi && spec.period === undefined) return { ok: false, reason: 'AI_TEXT_REQUIRES_PERIOD' }

  for (const panel of spec.panels) {
    if (panel.chart === 'text' || panel.chart === 'ai_text') continue
    for (const id of metricIdsOf(panel)) {
      const metric = catalog.find((m) => m.id === id)
      if (metric === undefined) return { ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: id }
      if (metric.sourceSystem !== null && !adoptedSources.has(metric.sourceSystem)) {
        return { ok: false, reason: 'METRIC_SOURCE_NOT_ADOPTED', metricId: id }
      }
      if ((panel.chart === 'line' || panel.chart === 'bar' || panel.chart === 'cross_table' || panel.chart === 'waterfall'
        || panel.chart === 'bullet') && !metric.totalable) {
        return { ok: false, reason: 'CHART_REQUIRES_ADDITIVE', metricId: id }
      }
      if ((panel.chart === 'kpi' || panel.chart === 'bullet') && !metric.totalable) {
        return { ok: false, reason: 'KPI_NOT_TOTALABLE', metricId: id }
      }
    }
  }
  return { ok: true }
}
