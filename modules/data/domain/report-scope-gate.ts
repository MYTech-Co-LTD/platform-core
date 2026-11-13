// report-scope-gate.ts — 报表**发布门**：受众 ⊆ 面板指标的可见范围（P5 Task 2，
// spec 2026-11-12-metric-semantic-governance-design.md §9.1）。
//
// 一句话：报表一旦发布，**只有能看这份报表的人**才谈得上看到里面的口径；若受众比某个面板指标的
// 可见范围更宽，发布即 409——而不是让它上线后「报表看着正常、点进去某个口径 403/空面板」。
//
// 受众模型（计划 §Task 2 的规则式判定，**不做**观看者上下文的逆运算）：
//   受众 dept 集 = 报表 `required_depts` 的具名部门 ∪ ACL 里 `relation='viewer'` 且
//                 `subject_type='dept'` 的部门。
//   `required_scope` 与 ACL 的 user/scope 主体被视作**全局**（不带来部门——它们是「谁」，
//   不是「哪个部门」）。因此受众**一个部门都没有**时，等价于「拿到 scope 的所有人」⇒ 对
//   部门归属指标而言必然更宽（reason `audience_wider_than_dept`）。
//
// 指标侧判定：`owner_dept` 为空的平台口径恒通过；非空时要求受众**每个** dept ∈
// （归属部门链 ∪ `visible_depts`）。部门链 = 自身 ∪ 全部祖先 ∪ 全部后代（`deptChainOf`）；
// `visible_depts` 只认直属部门（与 `metricVisibleWithDept` 的共享语义同一口径）。
//
// 边界（诚实记录）：
//   · 部门链的「后代」覆盖 `required_depts` 挂**祖先部门**时的一整棵子树——这正是
//     dept-gate D-O3 的语义（授权父部门 ⇒ 子部门可见），故归属部门自身/后代都放行。
//   · `reveal='report'` 的指标与 `panel` 档在这里**同判**：reveal 只在渲染期更严
//     （整表 404），发布期的可见范围约束不改。
//   · 词表里找不到的面板指标（已删/未同步）⇒ 非阻断 warning：这是**存在性/漂移**问题，
//     由发布路径既有的 `UNKNOWN_PANEL_METRIC` / 巡检脚本负责，不在可见性门上编判定。
//   · Metabase 行没有平台面板（`spec` 恒 null ⇒ metricIds 空）⇒ 无法判定，跳过并回 warning
//     （详见 spec §9.2：Metabase 做不到面板级）。
import type { Pool } from 'pg'
import type { AclRow } from './asset-auth'
import { deptChainOf } from './metric-visibility'
import { loadMergedCatalog } from './metric-store'
import type { ReportSpec } from './report-spec'
import { metricIdsOf } from './report-scope'

export type ReportScopeViolationReason =
  /** 受众没有任何部门约束（scope/具名用户）⇒ 「所有拿到 scope 的人」比部门链宽。 */
  | 'audience_wider_than_dept'
  /** 受众里这些部门不在指标可见范围内（既非归属部门链，也不在 visible_depts）。 */
  | 'audience_dept_outside_metric_scope'

export interface ReportScopeViolation {
  /** `spec.panels` 的下标（同一面板的分母指标也记在这个下标上）。 */
  index: number
  metricId: string
  /** 差集部门（仅 `audience_dept_outside_metric_scope` 有）。 */
  missingDepts?: string[]
  reason: ReportScopeViolationReason
}

/** 判定结果：`null` = 通过且无提示；`panels` 空但 `warnings` 非空 = 通过但有无法判定项。 */
export interface ReportScopeGateResult {
  panels: ReportScopeViolation[]
  warnings: string[]
}

/** 判定所需的最小报表形状（`ReportRow` 结构性满足——不绑存储类型，巡检脚本可复用）。 */
export interface ReportScopeRow {
  renderer: 'metabase' | 'platform'
  spec: ReportSpec | null
  requiredScope: string | null
  requiredDepts: string[] | null
  visibility: 'tenant' | 'restricted'
}

/** 判定所需的指标形状（`MetricRow` 结构性满足）。 */
export interface MetricScopeRow {
  id: string
  ownerDept?: string | null
  visibleDepts?: string[] | null
}

export interface ReportScopeGateDeps {
  pool: Pool
  /** 数值租户 id（org 表与部门链的隔离键；不是 casdoor org 文本）。 */
  tenantId: number
  /** casdoor org（报表/词表的隔离键）。 */
  org: string
  report: ReportScopeRow
  acl: readonly AclRow[]
  /** 可选：预加载的合并词表（每日巡检一次加载全量；缺省按本 org 加载）。 */
  catalog?: readonly MetricScopeRow[]
  /** 可选：部门链解析（测试注入；缺省走 `deptChainOf`）。 */
  chainOf?: (deptId: string) => Promise<ReadonlySet<string>>
}

/** 受众里的部门集：报表部门门 ∪ ACL 的 dept 受让方（user/scope 主体不带部门）。 */
function audienceDeptsOf(report: ReportScopeRow, acl: readonly AclRow[]): Set<string> {
  const depts = new Set<string>()
  for (const dept of report.requiredDepts ?? []) if (dept !== '') depts.add(dept)
  for (const a of acl) {
    if (a.relation === 'viewer' && a.subjectType === 'dept' && a.subjectId !== '') depts.add(a.subjectId)
  }
  return depts
}

/**
 * 发布门判定。返回 `null` = 通过且无提示；否则回 `{ panels, warnings }`（`panels` 空 =
 * 仅有无害提示，如 Metabase 无法判定）。
 *
 * 纯读：本函数**不写任何东西**——任一路径（HTTP 发布 / 每日巡检）都可以放心调用。
 * 词表只加载一次；部门链按归属部门去重缓存（同一报表里同部门指标只查一次）。
 */
export async function reportScopeViolations(
  deps: ReportScopeGateDeps,
): Promise<ReportScopeGateResult | null> {
  const { report, acl } = deps
  const warnings: string[] = []

  // 面板指标（含 kpi 分母；text/ai_text 没有）。没有可判的面板 ⇒ Metabase 行记一条 warning，
  // 平台行（空草稿 / 纯文本）静默通过。
  const panelMetrics: Array<{ index: number; metricId: string }> = []
  if (report.spec !== null) {
    report.spec.panels.forEach((panel, index) => {
      for (const metricId of metricIdsOf(panel)) panelMetrics.push({ index, metricId })
    })
  }
  if (panelMetrics.length === 0) {
    if (report.renderer === 'metabase') {
      warnings.push(
        '报表为 metabase 渲染器且没有面板指标（metricIds 为空）⇒ 无法判定受众与指标可见范围，发布门已跳过（不阻断）',
      )
      return { panels: [], warnings }
    }
    return warnings.length === 0 ? null : { panels: [], warnings }
  }

  const catalog = deps.catalog ?? await loadMergedCatalog(deps.pool, deps.org)
  const chainOf = deps.chainOf
    ?? ((deptId: string) => deptChainOf(deps.pool, deps.tenantId, deptId))
  const chainCache = new Map<string, Promise<ReadonlySet<string>>>()
  const chainFor = (deptId: string): Promise<ReadonlySet<string>> => {
    const hit = chainCache.get(deptId)
    if (hit !== undefined) return hit
    const p = chainOf(deptId)
    chainCache.set(deptId, p)
    return p
  }

  const audienceDepts = audienceDeptsOf(report, acl)
  const panels: ReportScopeViolation[] = []

  for (const { index, metricId } of panelMetrics) {
    const metric = catalog.find((m) => m.id === metricId)
    if (metric === undefined) {
      // 存在性/漂移不在可见性门里判（发布路径的 UNKNOWN_PANEL_METRIC 会响亮拒）——
      // 但巡检面要看得见，故记 warning。
      warnings.push(`面板 ${index} 的指标 ${metricId} 不在词表中 ⇒ 可见范围无法判定，已跳过`)
      continue
    }
    // 空串归属 = 平台桶（与 metricVisibleWithDept 同一归一）
    const ownerDept = metric.ownerDept === '' ? null : (metric.ownerDept ?? null)
    if (ownerDept === null) continue

    if (audienceDepts.size === 0) {
      // 「拿到 scope 的所有人」没有任何部门约束 ⇒ 对部门归属指标必然更宽
      panels.push({ index, metricId, reason: 'audience_wider_than_dept' })
      continue
    }

    const chain = await chainFor(ownerDept)
    const visibleDepts = new Set(metric.visibleDepts ?? [])
    const missing = [...audienceDepts].filter((d) => !chain.has(d) && !visibleDepts.has(d))
    if (missing.length > 0) {
      panels.push({
        index, metricId, missingDepts: missing.sort(), reason: 'audience_dept_outside_metric_scope',
      })
    }
  }

  return panels.length === 0 && warnings.length === 0 ? null : { panels, warnings }
}
