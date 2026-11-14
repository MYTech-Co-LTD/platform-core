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
import { parseStoredSpec } from './report-spec'

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
  /**
   * 提单动作本身被拒的候选数（submitChange 返回 !ok）：不是异常，计完继续下一候选。
   * ⚠️ 并发双跑**主要不走这条路**：submitChange 提交期会自动 supersede 同 (org, metric_id)
   * 的旧未决单，两个 job 都返回 ok——后到顶掉先到，`failed` 只剩唯一索引
   * `metric_change_one_pending_uq` 在真并发窗口命中的 23505（映射 409）会进来。
   * 不变式不因计数漂移：同 (org, metric_id) 未决单至多一张由唯一索引保证（static）；
   * 双跑的现实症状是 proposed 少一张（先到的单被顶成 superseded），job 侧幂等重跑可自愈。
   */
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
 * 同 org 作用域。存储原文可能是 **IR v2 形态**（`{ir:2, datasets, blocks}`，指标在
 * `datasets[].metricId`，report-spec.ts「V5 起新写入保留 v2、读面必须 parseStoredSpec 归一」
 * ——v2 没有 panels 键，按「panels 不是数组就跳过」是 fail-open：在用指标被提删、reason 谎报
 * 「报表引用已排除」）⇒ 遍历前**一律过 parseStoredSpec**（v2 扁平化会把 datasets 的指标内联进
 * panels），归一后走 `metricIdsOf`（发布门/观看面同一把尺：kpi 分母计入，text/ai_text 与
 * 降级占位符天然空）。
 * 只有 spec 为 null（metabase 渲染，合法缺席，静默）或**非空但解析失败**（跳过该行并
 * console.warn 留痕——不猜形状，也不让一行坏 spec 拖垮整租户的引用面）才跳过。
 */
async function referencedMetricIdsOf(pool: Pool, org: string): Promise<Set<string>> {
  const { rows } = await pool.query(
    `select id, spec from data.reports where org = $1
      union all
     select id, spec from data.report_versions where org = $1`, [org])
  const referenced = new Set<string>()
  for (const row of rows) {
    const parsed = parseStoredSpec(row.spec)
    if (!parsed.ok) {
      if (row.spec !== null && row.spec !== undefined) {
        console.warn(`[metric-retire] org=${org} 报表 spec 非空但解析失败（${parsed.code}），引用排除跳过该行 id=${row.id}`)
      }
      continue
    }
    for (const panel of parsed.spec.panels) {
      for (const id of metricIdsOf(panel)) referenced.add(id)
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
 * ④ 已有未决单**或人已驳回** ⇒ 跳过——未决的 id 不叠第二张单；驳回是人的明确决定，
 *    job 不跟人拉锯（否则「驳回 → 下一轮 job 原样重提」死循环）。`metric_change_one_pending_uq`
 *    只兜未决并发，rejected 要自己排。回头路是真实变化：指标后来又有使用再归零时 updated_at
 *    会刷新、重新给满一个窗口，届时重提是「新证据」不是复读（superseded/withdrawn 不排——
 *    withdrawn 是提案方自己撤的，不构成人的否决）。
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
  // ④ 未决 ∪ 已驳回：同 org 这些 id 一律跳过（adopted 行已被删，本就不在候选池）。
  const blocked = await pool.query(
    'select distinct metric_id from data.metric_change where org = $1 and status = any($2)',
    [org, [...PENDING_STATUSES, 'rejected']])
  const blockedIds = new Set(blocked.rows.map((r) => String(r.metric_id)))
  // ③ 报表引用（草稿 ∪ 已发布快照，org 作用域）。
  const referenced = await referencedMetricIdsOf(pool, org)
  return candidates
    .filter((c) => agedIds.has(c.metricId))
    .filter((c) => !referenced.has(c.metricId))
    .filter((c) => !blockedIds.has(c.metricId))
    .map((c) => ({ ...c, referenced: false as const }))
}

/** 合格下线候选（候选池 + 全部安全过滤）。语义见 safetyFilterOf 头注。 */
export async function retireEligibleOf(pool: Pool, org: string, days: number): Promise<RetireEligible[]> {
  return safetyFilterOf(pool, org, days, await retireCandidatesOf(pool, org, days))
}

/**
 * 对本租户的合格候选逐个提 delete 档变更单（`{reason}` = retireReasonOf(days)）。
 * 返回 {proposed, skipped, failed, tickets}：skipped = 安全过滤挡下的候选池数
 * （含未决/已驳回），failed = submitChange 拒绝数（计数语义见 RetireProposalResult.failed
 * 头注——并发双跑主要走 supersede，不走拒绝）。域层不跑试算（delete 档试算 = 删前口径
 * 快照，由提交面自动跑/人在待核对页补跑）。
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
