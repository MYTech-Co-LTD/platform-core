// report-scope-gate.ts — 报表**发布门**：受众 ⊆ 面板指标的可见范围（P5 Task 2，
// spec 2026-11-12-metric-semantic-governance-design.md §9.1）。
//
// 一句话：报表一旦发布，**只有能看这份报表的人**才谈得上看到里面的口径；若受众比某个面板指标的
// 可见范围更宽，发布即 409——而不是让它上线后「报表看着正常、点进去某个口径 403/空面板」。
//
// 受众模型（计划 §Task 2 的规则式判定，**不做**观看者上下文的逆运算）：
//   受众 dept 集 = 报表 `required_depts` 的具名部门 ∪ ACL 里 `relation='viewer'` 且
//                 `subject_type='dept'` 的部门，**每个具名部门再展开「自身∪严格后代」**
//                 （渲染期 `required_depts=[P]` / ACL dept=P 放行的是 P 的整棵子树——
//                 dept-gate D-O3 + 观看者闭包含祖先；不展开会把 `required_depts=[父部门]`
//                 的兄弟支误判成干净）。展开用 `subtreeOf`，**不用** `deptChainOf`（含祖先，
//                 而 visible_depts 只认直属 ⇒ 祖先入受众会反向误杀）。
//   `required_scope` 与 ACL 的 user/scope 主体被视作**全局**（不带来部门——它们是「谁」，
//   不是「哪个部门」）。因此受众**一个部门都没有**时，等价于「拿到 scope 的所有人」⇒ 对
//   部门归属指标而言必然更宽（reason `audience_wider_than_dept`）。
//   ⚠️ 只共享给**具名个人**（ACL user 主体，没有 dept 主体/部门门）时同样 fail-closed，
//   但 reason 单列为 `audience_user_only`：这类报表暂不能带部门归属指标发布；后续可按
//   `org_membership` 把收件人收窄成部门再放行（不在本轮）。
//
// 指标侧判定：`owner_dept` 为空的平台口径恒通过；非空时要求受众**每个** dept ∈
// （归属部门链 ∪ `visible_depts`）。部门链 = 自身 ∪ 全部祖先 ∪ 全部后代（`deptChainOf`）；
// `visible_depts` 只认直属部门（与 `metricVisibleWithDept` 的共享语义同一口径）。
//
// 边界（诚实记录）：
//   · `reveal='report'` 的指标与 `panel` 档在这里**同判**：reveal 只在渲染期更严
//     （整表 404），发布期的可见范围约束不改。
//   · 词表里找不到的面板指标（已删/未同步）⇒ 非阻断 warning：这是**存在性/漂移**问题，
//     由发布路径既有的 `UNKNOWN_PANEL_METRIC` / 巡检脚本负责，不在可见性门上编判定。
//   · Metabase 行没有平台面板（`spec` 恒 null ⇒ metricIds 空）⇒ 无法判定，跳过并回 warning
//     （详见 spec §9.2：Metabase 做不到面板级）。
import type { Pool } from 'pg'
import type { AclRow } from './asset-auth'
import { deptChainOf, subtreeOf } from './metric-visibility'
import { loadMergedCatalog } from './metric-store'
import type { ReportSpec } from './report-spec'
import { metricIdsOf } from './report-scope'

export type ReportScopeViolationReason =
  /** 受众没有任何部门约束（scope 主体 / 公开）⇒ 「所有拿到 scope 的人」比部门链宽。 */
  | 'audience_wider_than_dept'
  /** 受众只有具名个人（ACL user 主体）⇒ 人可能在任意部门，无法证明 ⊆ 部门链（fail-closed）。 */
  | 'audience_user_only'
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
  /** 可选：子树展开（测试注入；缺省走 `subtreeOf`）。 */
  subtreeOf?: (deptId: string) => Promise<ReadonlySet<string>>
}

/** 受众里的**具名**部门：报表部门门 ∪ ACL 的 dept 受让方（user/scope 主体不带部门）。 */
function namedAudienceDeptsOf(report: ReportScopeRow, acl: readonly AclRow[]): Set<string> {
  const depts = new Set<string>()
  for (const dept of report.requiredDepts ?? []) if (dept !== '') depts.add(dept)
  for (const a of acl) {
    if (a.relation === 'viewer' && a.subjectType === 'dept' && a.subjectId !== '') depts.add(a.subjectId)
  }
  return depts
}

/** 受众里是否有**具名个人**（只给个人共享的报表——无部门可判）。 */
function hasNamedUserAudience(acl: readonly AclRow[]): boolean {
  return acl.some((a) => a.relation === 'viewer' && a.subjectType === 'user' && a.subjectId !== '')
}

/** 受众里是否有**全局 scope**（报表页门或 ACL 的 scope 主体）——它与「具名个人」互斥解释。 */
function hasGlobalScopeAudience(report: ReportScopeRow, acl: readonly AclRow[]): boolean {
  if (report.requiredScope !== null) return true
  return acl.some((a) => a.relation === 'viewer' && a.subjectType === 'scope' && a.subjectId !== '')
}

/**
 * 发布门判定。返回 `null` = 通过且无提示；否则回 `{ panels, warnings }`（`panels` 空 =
 * 仅有无害提示，如 Metabase 无法判定）。
 *
 * 纯读：本函数**不写任何东西**——任一路径（HTTP 发布 / 每日巡检）都可以放心调用。
 * 词表只加载一次；部门链/子树按部门去重缓存（同一报表里同部门只查一次）。
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

  // 受众侧：每个具名部门展开「自身 ∪ 严格后代」（渲染期实际可命中的人）。
  // 具名部门本身先入集：部门不存在/已软删时子树为空，仍会作为差集被点名（fail-closed），
  // 而不是静默缩成「受众无部门」。
  const subtreeFor = deps.subtreeOf
    ?? ((deptId: string) => subtreeOf(deps.pool, deps.tenantId, deptId))
  const subtreeCache = new Map<string, Promise<ReadonlySet<string>>>()
  const audienceDepts = new Set<string>()
  for (const named of namedAudienceDeptsOf(report, acl)) {
    audienceDepts.add(named)
    let subtree = subtreeCache.get(named)
    if (subtree === undefined) {
      subtree = subtreeFor(named)
      subtreeCache.set(named, subtree)
    }
    for (const d of await subtree) audienceDepts.add(d)
  }
  const userOnly = audienceDepts.size === 0
    && hasNamedUserAudience(acl)
    && !hasGlobalScopeAudience(report, acl)
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
      // 没有部门约束：只共享给个人（人可能在任意部门）或「拿到 scope 的所有人」——
      // 两者都比部门归属指标更宽，都 fail-closed，只是 reason 区分（可观测、可解释）。
      panels.push({ index, metricId, reason: userOnly ? 'audience_user_only' : 'audience_wider_than_dept' })
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
