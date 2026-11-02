// metric-governance.ts — 指标治理：L2 草稿→确认→生效 + 可信度分级（spec 2026-11-01 §10.4 P0）
//
// 两个动作，各自只有一份实现：
//   · `saveDraft`    —— creator 编辑暂存到 `draft_spec`（**不触发编译点**，数字不变）
//   · `confirmDraft` —— creator 确认后走唯一编译点编译进 `spec`（数字对全租户变更）
//                        + 发 `metric.definition.changed` 通知给 viewer + scope 持有者
//
// 为什么要分两步（spec §10.4 D6）：L2 指标被 scope 授权给一批人后，creator 改一处
// 所有看数人的数字就变了——没有草稿确认，就是静默改口径。业界（Looker/Cube）一律
// draft→publish，不提供"即时生效"选项。
//
// 可信度分级（D7）：L1 恒 certified（读侧从 source 推导）；L2 新建默认 draft，
// 管理员审核后升 certified——先手动标，审核工作流出现真实诉求再自动化。
import type { Pool } from 'pg'

export type MetricCertification = 'certified' | 'draft'

/** 草稿保存：只写 `draft_spec`，**不触发编译点**（数字不变）。 */
export async function saveMetricDraft(
  pool: Pool, org: string, metricId: string, creator: string, draftSpec: Record<string, unknown>,
): Promise<boolean> {
  // 只有 creator 且 source=l2 才能存草稿（L1 只读、非 creator 不可编辑）
  // ⚠️ 占位符各用各的：`set` 用 $4（草稿 JSON），`created_by` 用 $3（creator）——
  //    复用同一个编号曾让 creator 串被当草稿写库（往返测试 metric-governance.test.ts 抓的）。
  const r = await pool.query(
    `update data.metrics
        set draft_spec = $4::jsonb
      where org = $1 and id = $2 and source = 'l2' and created_by = $3`,
    [org, metricId, creator, JSON.stringify(draftSpec)],
  )
  return (r.rowCount ?? 0) > 0
}

/** 读取草稿（creator 确认前预览用）。 */
export async function loadMetricDraft(
  pool: Pool, org: string, metricId: string, creator: string,
): Promise<Record<string, unknown> | null> {
  const { rows } = await pool.query(
    `select draft_spec from data.metrics
      where org = $1 and id = $2 and source = 'l2' and created_by = $3 and draft_spec is not null`,
    [org, metricId, creator],
  )
  return (rows[0]?.draft_spec as Record<string, unknown> | undefined) ?? null
}

/** 清除草稿（确认生效后调用；丢弃草稿也用这个）。 */
export async function clearMetricDraft(pool: Pool, org: string, metricId: string, creator: string): Promise<void> {
  await pool.query(
    `update data.metrics set draft_spec = null
      where org = $1 and id = $2 and source = 'l2' and created_by = $3`,
    [org, metricId, creator],
  )
}

/** 「能不能管这条指标」的判定（L2 且 creator）。L1 只读、非 creator 只读。 */
export function canEditMetric(source: 'l1' | 'l2', createdBy: string | null, requesterId: string): boolean {
  return source === 'l2' && createdBy === requesterId
}
