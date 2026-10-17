// report-scope.ts — 报表 `requiredScope` 的派生（spec §4.2）。
//
// 纯函数、无 IO：入参故意收窄到「派生动得到的两个字段」，这样单测不用造完整的 MetricDef，
// 也让「这个函数不碰库」变成类型上的事实而不是约定。
import type { ReportSpec } from './report-spec'

export type DeriveResult =
  | { ok: true; requiredScope: string | null }
  | { ok: false; reason: 'UNKNOWN_PANEL_METRIC'; metricId: string }
  | { ok: false; reason: 'CONFLICTING_PANEL_SCOPES'; scopes: string[] }

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
  catalog: readonly { id: string; requiredScope: string | null }[],
): DeriveResult {
  const scopes = new Set<string>()
  for (const panel of spec.panels) {
    const metric = catalog.find((m) => m.id === panel.metricId)
    if (metric === undefined) {
      return { ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: panel.metricId }
    }
    if (metric.requiredScope !== null) scopes.add(metric.requiredScope)
  }
  if (scopes.size > 1) return { ok: false, reason: 'CONFLICTING_PANEL_SCOPES', scopes: [...scopes] }
  return { ok: true, requiredScope: scopes.size === 0 ? null : [...scopes][0] }
}
