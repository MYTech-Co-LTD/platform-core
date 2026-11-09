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
import { z } from 'zod'
import type { MetricBasis } from './metric-store'
import { COLUMN_AGG_FUNCS, L2DeclarationSchema } from './semantic-compiler'

export type MetricCertification = 'certified' | 'draft'

/**
 * 私有测度的草稿形状（W2 Task 3 评审 Important）：`{kind:'column_agg', agg, column, dims}`。
 *
 * **没有 relation** 是刻意的：修改只能在原 mart 内换列/换聚合/换维度；换源 = 新建一条。
 * `.strict()` 与 L2 写面同一纪律：混入 `selectSql`/`relation` 等未列键 ⇒ 400，不静默忽略。
 */
export const ColumnAggDraftSchema = z.object({
  kind: z.literal('column_agg'),
  agg: z.enum(COLUMN_AGG_FUNCS),
  column: z.string().min(1).max(128),
  dims: z.array(z.string().min(1).max(128)).max(64).optional(),
}).strict()

/** 草稿的两种档位：树形 L2 声明（既有）| 私有测度列级聚合（W2）。 */
export const MetricDraftSpecSchema = z.union([L2DeclarationSchema, ColumnAggDraftSchema])

export type ColumnAggDraft = z.infer<typeof ColumnAggDraftSchema>

/** 存草稿的判别式结果：区分「不可编辑」（403）与「草稿档位与行不符」（400）。 */
export type SaveDraftResult =
  | { ok: true }
  | { ok: false; error: 'NOT_EDITABLE' | 'DRAFT_BASIS_MISMATCH' }

/**
 * 该行是不是私有测度（草稿形状分档与确认分支都读它）。
 * 只读 L2；不存在 / L1 ⇒ null（调用方回 404/409，不猜）。
 */
export async function metricBasisOf(
  pool: Pool, org: string, metricId: string,
): Promise<MetricBasis | null> {
  const { rows } = await pool.query(
    `select basis from data.metrics where org = $1 and id = $2 and source = 'l2'`,
    [org, metricId],
  )
  if (rows.length === 0) return null
  const b = (rows[0] as { basis?: unknown }).basis
  return b === 'column_agg' ? 'column_agg' : b === 'declared' ? 'declared' : 'l1_tree'
}

/**
 * 草稿保存：只写 `draft_spec`，**不触发编译点**（数字不变）。
 *
 * ★ basis 感知（W2 Task 3 评审 Important）：`column_agg` 行只收列级聚合草稿，树形 L2 行
 *   拒收 `kind:'column_agg'` 草稿——存进去也确认不了（死草稿），不如在保存时就 400。
 */
export async function saveMetricDraft(
  pool: Pool, org: string, metricId: string, creator: string, draftSpec: Record<string, unknown>,
): Promise<SaveDraftResult> {
  // 只有 creator 且 source=l2 才能存草稿（L1 只读、非 creator 不可编辑）
  // ⚠️ 占位符各用各的：`set` 用 $4（草稿 JSON），`created_by` 用 $3（creator）——
  //    复用同一个编号曾让 creator 串被当草稿写库（往返测试 metric-governance.test.ts 抓的）。
  const cur = await pool.query(
    `select basis from data.metrics
      where org = $1 and id = $2 and source = 'l2' and created_by = $3`,
    [org, metricId, creator],
  )
  if ((cur.rowCount ?? 0) === 0) return { ok: false, error: 'NOT_EDITABLE' }
  const rawBasis = (cur.rows[0] as { basis?: unknown }).basis
  const basis: MetricBasis = rawBasis === 'column_agg' ? 'column_agg' : rawBasis === 'declared' ? 'declared' : 'l1_tree'
  // declared（W8）：租户全额声明的修改走专用覆盖/声明工具，**不走**旧的 draft_spec 树形草稿路径
  // （确认链会把声明当 L2 树编译，语义不同）。这里显式拒，别让它落成「确认不了的死草稿」。
  if (basis === 'declared') return { ok: false, error: 'NOT_EDITABLE' }
  const isColumnAggDraft = (draftSpec as { kind?: unknown }).kind === 'column_agg'
  if ((basis === 'column_agg') !== isColumnAggDraft) return { ok: false, error: 'DRAFT_BASIS_MISMATCH' }

  // `and basis = $5` 是 TOCTOU 守卫：读档位与写草稿之间行被换档 ⇒ 不写（宁可 false，不落错档草稿）
  const r = await pool.query(
    `update data.metrics
        set draft_spec = $4::jsonb
      where org = $1 and id = $2 and source = 'l2' and created_by = $3 and basis = $5`,
    [org, metricId, creator, JSON.stringify(draftSpec), basis],
  )
  return (r.rowCount ?? 0) > 0 ? { ok: true } : { ok: false, error: 'NOT_EDITABLE' }
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

/**
 * 清除草稿。带 `expected` 时是**内容条件清除**（确认生效路径）：只有「库里还是刚才读到的那份」
 * 才清——load 与 clear 之间被并发保存抢写时返回 false（调用方回 409，新草稿原地保留），
 * 绝不静默吞掉比刚才读到的更新的草稿。不带 `expected` = 无条件清（当前无调用方，留给显式弃稿）。
 */
export async function clearMetricDraft(
  pool: Pool, org: string, metricId: string, creator: string,
  expected?: Record<string, unknown>,
): Promise<boolean> {
  const cond = expected === undefined ? '' : ` and draft_spec = $4::jsonb`
  const r = await pool.query(
    `update data.metrics set draft_spec = null
      where org = $1 and id = $2 and source = 'l2' and created_by = $3${cond}`,
    expected === undefined ? [org, metricId, creator] : [org, metricId, creator, JSON.stringify(expected)],
  )
  return (r.rowCount ?? 0) > 0
}

/** 「能不能管这条指标」的判定（L2 且 creator）。L1 只读、非 creator 只读。 */
export function canEditMetric(source: 'l1' | 'l2', createdBy: string | null, requesterId: string): boolean {
  return source === 'l2' && createdBy === requesterId
}
