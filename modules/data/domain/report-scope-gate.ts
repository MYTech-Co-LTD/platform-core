// report-scope-gate.ts — 报表**发布门**：受众 ⊆ 面板指标的可见范围（P5 Task 2，
// spec 2026-11-12-metric-semantic-governance-design.md §9.1）。
//
// 一句话：报表一旦发布，**只有能看这份报表的人**才谈得上看到里面的口径；若受众比某个面板指标的
// 可见范围更宽，发布即 409——而不是让它上线后「报表看着正常、点进去某个口径 403/空面板」。
//
// 受众模型（计划 §Task 2 的规则式判定，**不做**观看者上下文的逆运算）：
//
//   ① **有界受众**（可用部门集合表达）：报表 `required_depts` 的具名部门 ∪ ACL 里
//      `relation='viewer'` 且 `subject_type='dept'` 的部门，**每个具名部门再展开
//      「自身∪严格后代」**（渲染期 `required_depts=[P]` / ACL dept=P 放行的是 P 的整棵子树——
//      dept-gate D-O3 + 观看者闭包含祖先；不展开会把 `required_depts=[父部门]` 的兄弟支
//      误判成干净）。展开用 `subtreeOf`，**不用** `deptChainOf`（含祖先，而 visible_depts
//      只认直属 ⇒ 祖先入受众会反向误杀）。
//
//   ② **受众无法界定**（unbindable）——**独立**由「受众入口」推出，**绝不用「已收集到的部门
//      集合是否为空」当代理**（历史 bug：只要有一个 dept viewer 在场，user/scope/tenant 类
//      受众就被静默丢掉不判，`visibility` 从未被读取）：
//        · `visibility === 'tenant'` 且 `required_depts` 为空 ⇒ 旧粗门「拿到本模块的人都可见」，
//          全租户无部门约束；
//        · ACL 里存在 `relation='viewer'` 且 `subject_type ∈ {'scope','user'}` 的主体 ⇒
//          「拿到某权限码的所有人」/「某个具名个人」，人可能在任意部门。
//      ACL 是**加性**的，不会收窄 `visibility='tenant'` ⇒ 两类入口同时存在时受众仍是全集。
//      ⇒ unbindable 时**每个部门归属面板**都判违规（reason `audience_unbounded`）。
//
//   ③ **owner 豁免**（显式裁定）：ACL 的 `owner` 主体**不计入受众**——「能改配置」≠「以受众
//      身份读数」。因此发布门不为 owner 判违规：管理员可以管理自己读不到数的报表；owner 的
//      观看视图由渲染闸（`asset-auth.ts` 的 `applyPanelRenderGate`）逐面板降级兜住。
//      本豁免有测试钉住（`owner 豁免`），勿静默改动。
//
// 指标侧判定：`owner_dept` 为空的平台口径恒通过；非空时要求受众**每个** dept ∈
// （归属部门链 ∪ `visible_depts`）。部门链 = 自身 ∪ 全部祖先 ∪ 全部后代（`deptChainOf`）；
// `visible_depts` 只认直属部门（与 `metricVisibleWithDept` 的共享语义同一口径）。
//
// 边界（诚实记录）：
//   · `reveal='report'` 的指标与 `panel` 档在这里**同判**：reveal 只在渲染期更严
//     （整表 404），发布期的可见范围约束不改。
//   · 词表里找不到的面板指标（已删/未同步）⇒ **`issues`（判不了）**，不是 `panels`（违规）：
//     这是**存在性/漂移**问题，本门不编可见性判定。发布不因它阻断（P5 语义），但巡检按
//     issue 判红（P6 Task 1：判不了 ≠ 干净）。
//   · Metabase 行没有平台面板（`spec` 恒 null ⇒ metricIds 空）⇒ 无法判定，跳过并记
//     `issues`（详见 spec §9.2：Metabase 做不到面板级）。
import type { Pool } from 'pg'
import type { AclRow } from './asset-auth'
import { deptChainOf, subtreeOf } from './metric-visibility'
import { loadMergedCatalog } from './metric-store'
import type { ReportSpec } from './report-spec'
import { metricIdsOf } from './report-scope'

export type ReportScopeViolationReason =
  /**
   * 受众**无法用部门集合界定**：`visibility='tenant'` 且无部门门（全租户），或 ACL 里有
   * `scope` / `user` 的 viewer（拿到某码的所有人 / 某个具名个人）。
   * 人的部门不确定 ⇒ 对**任何**部门归属指标都 fail-closed。
   */
  | 'audience_unbounded'
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

/**
 * 门 `issues` 的 reason：**判不了**（与 `panels` 的「判为违规」是两种形状）。
 *
 * - `metric_unknown`：面板指标不在词表（归档/删除/未同步）⇒ 可见范围无从判定。
 * - `no_panel_metrics`：渲染器没有面板指标可判（Metabase；spec §9.2 做不到面板级）。
 */
export type ReportScopeIssueReason = 'metric_unknown' | 'no_panel_metrics'

/** 无法判定项（P6 Task 1）。发布不阻断（P5 语义），巡检按它判红。 */
export interface ReportScopeIssue {
  reason: ReportScopeIssueReason
  /**
   * 出问题的 `spec.panels` 下标。没有单个面板可指时（`no_panel_metrics`）为 `-1`——
   * 用负数而不是 0，避免把「整表判不了」误读成「第 0 块面板有问题」。
   */
  panelIndex: number
  metricId?: string
}

/** 判定结果：`null` = 通过且无提示；`panels` 空但 `issues` 非空 = 通过但有无法判定项。 */
export interface ReportScopeGateResult {
  panels: ReportScopeViolation[]
  issues: ReportScopeIssue[]
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

/**
 * 受众是否**无法用部门集合界定**。看的是「受众入口」本身，不是收集到的 dept 集合
 * （后者为空可能只是「还没收集」，不能反推「没有无界入口」）。
 *
 * - `visibility='tenant'` 且无部门门 ⇒ 旧粗门：全租户；
 * - ACL 有 viewer 的 `scope` / `user` 主体 ⇒ 拿到权限码的所有人 / 某个具名个人。
 *
 * `owner` 主体**不在**此列（owner 豁免，见文件头 ③）。
 */
function isUnbindableAudience(report: ReportScopeRow, acl: readonly AclRow[]): boolean {
  const tenantOpen = report.visibility === 'tenant' && (report.requiredDepts ?? []).length === 0
  if (tenantOpen) return true
  return acl.some((a) => a.relation === 'viewer'
    && (a.subjectType === 'scope' || a.subjectType === 'user') && a.subjectId !== '')
}

/**
 * 发布门判定。返回 `null` = 通过且无提示；否则回 `{ panels, issues }`（`panels` 空 =
 * 仅有无法判定项，如 Metabase 无面板 / 面板指标不在词表）。
 *
 * 纯读：本函数**不写任何东西**——任一路径（HTTP 发布 / 每日巡检）都可以放心调用。
 * 词表只加载一次；部门链/子树按部门去重缓存（同一报表里同部门只查一次）。
 */
export async function reportScopeViolations(
  deps: ReportScopeGateDeps,
): Promise<ReportScopeGateResult | null> {
  const { report, acl } = deps
  const issues: ReportScopeIssue[] = []

  // 面板指标（含 kpi 分母；text/ai_text 没有）。没有可判的面板 ⇒ Metabase 行记一条 issue，
  // 平台行（空草稿 / 纯文本）静默通过。
  const panelMetrics: Array<{ index: number; metricId: string }> = []
  if (report.spec !== null) {
    report.spec.panels.forEach((panel, index) => {
      for (const metricId of metricIdsOf(panel)) panelMetrics.push({ index, metricId })
    })
  }
  if (panelMetrics.length === 0) {
    if (report.renderer === 'metabase') {
      issues.push({ reason: 'no_panel_metrics', panelIndex: -1 })
      return { panels: [], issues }
    }
    return issues.length === 0 ? null : { panels: [], issues }
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
  // 无法界定的受众：每块部门归属面板都违规。**先于**部门集判定——否则「有一个 dept viewer」
  // 会让 user/scope/tenant 入口被静默掩盖（历史 bug）。
  const unbindable = isUnbindableAudience(report, acl)
  const panels: ReportScopeViolation[] = []

  for (const { index, metricId } of panelMetrics) {
    const metric = catalog.find((m) => m.id === metricId)
    if (metric === undefined) {
      // 存在性/漂移不在可见性门里判（发布写侧另有 UNKNOWN_PANEL_METRIC）——但「判不了」
      // 必须可被巡检判红，故显式记 issue，而不是一句会被当干净的提示。
      issues.push({ reason: 'metric_unknown', panelIndex: index, metricId })
      continue
    }
    // 空串归属 = 平台桶（与 metricVisibleWithDept 同一归一）
    const ownerDept = metric.ownerDept === '' ? null : (metric.ownerDept ?? null)
    if (ownerDept === null) continue

    if (unbindable) {
      panels.push({ index, metricId, reason: 'audience_unbounded' })
      continue
    }
    // 走到这里受众是**有界**的；部门集为空 = 只有 owner 能被点名（owner 豁免，见文件头 ③）
    // ⇒ 没有「受众部门」需要证明落在指标可见范围内，通过。

    const chain = await chainFor(ownerDept)
    const visibleDepts = new Set(metric.visibleDepts ?? [])
    const missing = [...audienceDepts].filter((d) => !chain.has(d) && !visibleDepts.has(d))
    if (missing.length > 0) {
      panels.push({
        index, metricId, missingDepts: missing.sort(), reason: 'audience_dept_outside_metric_scope',
      })
    }
  }

  return panels.length === 0 && issues.length === 0 ? null : { panels, issues }
}
