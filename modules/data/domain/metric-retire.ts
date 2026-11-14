// metric-retire.ts — 下线提案域层（尾波 2026-11-14）：候选安全过滤 + 自动提单。
//
// 读面在 metric-usage.ts（retireCandidatesOf：L2 + 窗口 0 次，L1 永不）。本文件在其上叠
// **安全过滤**与**提单**——job（scripts/metric-retire-job.mjs）只调用本文件，不自带判定：
//
//   候选池（过滤①）→ ②行龄 ③报表引用排除 ④未决单排除 ⇒ 合格清单 → submitChange(delete, {reason})
//
// 铁律：**job 只提案不删行**。生效唯一路径仍是人采纳（待核对页 + data:manage）；
// 提交身份由调用方给（job 侧 = `{userId:'metric-retire-job', channel:'job'}`）。
// 提单走 submitChange（域层不跑试算——delete 档试算 = 删前口径快照，由提交面/人补跑）。
import type { Pool } from 'pg'
import { PENDING_STATUSES, submitChange } from './metric-change'
import { retireCandidatesOf } from './metric-usage'
import type { RetireCandidate } from './metric-usage'
import { metricIdsOf } from './report-scope'
import type { MetricIdPanel } from './report-scope'

/** 合格候选：候选池再过三道安全闸。referenced 恒 false——被引用的在过滤期已剔除（结构自证）。 */
export interface RetireEligible {
  metricId: string
  title: string
  /** 恒 'l2'（继承读面：L1 是平台口径，永不进候选）。 */
  source: 'l2'
  createdBy: string | null
  lastUsedAt: string | null
  referenced: false
}

/** 提单身份（job 侧约定：`{userId:'metric-retire-job', channel:'job'}`；测试可自给）。 */
export interface RetireSubmitter {
  userId: string
  channel: string
}

export interface RetireProposalResult {
  /** 提单成功数（= tickets.length）。 */
  proposed: number
  /** 安全过滤挡下的候选数（候选池 − 合格清单）：job 汇总行据此可见「挡了多少」。 */
  skipped: number
  /** 提交期被拒数（如并发窗口撞出未决单 409）：不是异常，job 计数后继续下一候选。 */
  failed: number
  tickets: Array<{ metricId: string; changeId: number }>
}

/** 提单 reason（人面展示文案；执行器不读——单据的出处说明）。 */
export function retireReasonOf(days: number): string {
  return `连续 ${days} 天 0 次使用（报表引用已排除）`
}

/** 有 L2 行的 org 全列（job 的枚举面：逐 org 过滤 + 提单）。 */
export async function retireOrgs(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query("select distinct org from data.metrics where source = 'l2'")
  return rows.map((r) => String(r.org))
}

/**
 * 报表引用面：**草稿**（data.reports.spec）与**已发布快照**（data.report_versions.spec）的并集，
 * 同 org 作用域。JS 侧走 `spec.panels[]` 的 `metricId` + kpi `denominatorMetricId`——
 * 复用 metricIdsOf（发布门/观看面同一把尺，text/ai_text 面板与降级占位符天然返回空）。
 * spec 为 null（metabase 渲染）或 panels 不是数组（手改行）⇒ 跳过，不猜形状。
 */
async function referencedMetricIdsOf(pool: Pool, org: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `select spec from data.reports where org = $1
      union all
     select spec from data.report_versions where org = $1`, [org])
  const referenced = new Set<string>()
  for (const row of rows) {
    const spec = row.spec as unknown
    if (spec === null || typeof spec !== 'object') continue
    const panels = (spec as { panels?: unknown }).panels
    if (!Array.isArray(panels)) continue
    for (const panel of panels) {
      if (panel === null || typeof panel !== 'object') continue
      for (const id of metricIdsOf(panel as MetricIdPanel)) referenced.add(id)
    }
  }
  return referenced
}

/**
 * 安全过滤（四条，缺一不提单；过滤①由候选池承担）：
 * ① 仅 L2 且窗口 0 次使用（retireCandidatesOf：审计聚合，回归重放身份已豁免，L1 永不）；
 * ② 行龄 ≥ 窗口（`updated_at < now() - make_interval(days)`）——新采纳/新改的口径给满一个
 *    观察窗口，别把刚上线的指标判死；
 * ③ 不被任何报表引用——草稿与已发布快照都查，面板 metricId 与 kpi 分母都算（见
 *    referencedMetricIdsOf）；在用指标提删是最贵的误报；
 * ④ 已有未决单 ⇒ 跳过——人还没裁决完的 id 不叠第二张单（`metric_change_one_pending_uq`
 *    兜底并发，这里先查避免无谓 409）。
 */
async function safetyFilterOf(
  pool: Pool, org: string, days: number, candidates: RetireCandidate[],
): Promise<RetireEligible[]> {
  if (candidates.length === 0) return []
  // ② 行龄：org 桶行（L1 在平台桶，天然不在本集合——但候选池已按 source=l2 筛过，双保险）。
  const aged = await pool.query(
    `select id from data.metrics
      where org = $1 and source = 'l2' and updated_at < now() - make_interval(days => $2::int)`,
    [org, days])
  const agedIds = new Set(aged.rows.map((r) => String(r.id)))
  // ④ 未决单：同 org 已有三态单的 id 一律跳过。
  const pending = await pool.query(
    'select distinct metric_id from data.metric_change where org = $1 and status = any($2)',
    [org, PENDING_STATUSES])
  const pendingIds = new Set(pending.rows.map((r) => String(r.metric_id)))
  // ③ 报表引用（草稿 ∪ 已发布快照，org 作用域）。
  const referenced = await referencedMetricIdsOf(pool, org)
  return candidates
    .filter((c) => agedIds.has(c.metricId))
    .filter((c) => !referenced.has(c.metricId))
    .filter((c) => !pendingIds.has(c.metricId))
    .map((c) => ({ ...c, referenced: false as const }))
}

/** 合格下线候选（候选池 + 全部安全过滤）。语义见 safetyFilterOf 头注。 */
export async function retireEligibleOf(pool: Pool, org: string, days: number): Promise<RetireEligible[]> {
  return safetyFilterOf(pool, org, days, await retireCandidatesOf(pool, org, days))
}

/**
 * 对本租户的合格候选逐个提 delete 档变更单（`{reason}` = retireReasonOf(days)）。
 * 返回 {proposed, skipped, failed, tickets}：skipped = 安全过滤挡下的候选池数，
 * failed = submitChange 拒绝数（提交期并发撞未决单等 4xx；不是异常，不中断批次）。
 * 域层不跑试算（delete 档试算 = 删前口径快照，由提交面自动跑/人在待核对页补跑）。
 */
export async function submitRetireProposals(
  pool: Pool, org: string, days: number, submitter: RetireSubmitter,
): Promise<RetireProposalResult> {
  const candidates = await retireCandidatesOf(pool, org, days)
  const eligible = await safetyFilterOf(pool, org, days, candidates)
  const tickets: Array<{ metricId: string; changeId: number }> = []
  let failed = 0
  for (const c of eligible) {
    const out = await submitChange(pool, org, submitter, c.metricId, 'delete', { reason: retireReasonOf(days) })
    if (out.ok) tickets.push({ metricId: c.metricId, changeId: out.change.id })
    else failed += 1
  }
  return { proposed: tickets.length, skipped: candidates.length - eligible.length, failed, tickets }
}
