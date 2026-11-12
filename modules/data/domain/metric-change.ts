// metric-change.ts —— 指标变更单状态机（spec §5.2/§7，P0）。
// 本文件不生效任何指标：生效在 adoptChange（Task 4）分发到既有唯一编译点。
import type { Pool } from 'pg'
import { z } from 'zod'
import { exceedsNesting, L2ExprDeclarationSchema, L2RefineDeclarationSchema } from './semantic-compiler'
import type { L2Declaration } from './semantic-compiler'
import type { MetricWriteDeps, MetricWriteOutcome, MetricMetaPatch } from './metric-write'
import { writeL2Declaration, updateMetricMeta, deleteMetricDeclaration } from './metric-write'
import type { PreviewSnapshot } from './metric-change-preview'

export type ChangeKind = 'create' | 'update' | 'meta' | 'delete'
export type ChangeStatus = 'draft' | 'preview_ready' | 'preview_failed' | 'adopted' | 'rejected' | 'superseded' | 'withdrawn'
export const PENDING_STATUSES: readonly ChangeStatus[] = ['draft', 'preview_ready', 'preview_failed']

export interface MetricChangeRow {
  id: number; org: string; metricId: string; kind: ChangeKind
  payload: Record<string, unknown>; status: ChangeStatus
  preview: Record<string, unknown> | null
  submittedBy: string; submittedChannel: string; submittedAt: string
  decidedBy: string | null; decidedAt: string | null; rejectReason: string | null
}

export type SubmitOutcome =
  | { ok: true; change: MetricChangeRow }
  | { ok: false; http: 400 | 409; error: 'INVALID_DECLARATION' | 'INVALID_META' | 'CHANGE_ALREADY_PENDING' }

const MetaPayload = z.object({
  bizDescription: z.string().max(500).optional(),
  unit: z.string().max(32).optional(),
  caliberNote: z.string().max(500).optional(),
}).strict()

/**
 * 声明档 payload：refine/expr 判别式 union（复用编译器的 zod——第二份形状就是第二事实源）。
 * 写入闸在共享 schema 之上再收紧一档 `.strict()`（**返回派生实例，不改共享 schema**）：
 * `L2RefineDeclarationSchema` 本体按既有约定是非 strict（多余键被 strip，见 semantic-compiler.ts），
 * 但变更单是**写入面**——自由 SQL 字段（如 selectSql）必须在这里被拒（结构化声明纪律），不能静默剥掉。
 */
function parseDeclaration(payload: unknown): boolean {
  if (exceedsNesting(payload)) return false
  const refine = L2RefineDeclarationSchema.strict().safeParse(payload)
  if (refine.success) return true
  const expr = L2ExprDeclarationSchema.safeParse(payload)
  return expr.success
}

const COLS = 'id, org, metric_id, kind, payload, status, preview, submitted_by, submitted_channel, submitted_at, decided_by, decided_at, reject_reason'
type DbRow = Record<string, unknown>
function toRow(r: DbRow): MetricChangeRow {
  return {
    id: Number(r.id), org: String(r.org), metricId: String(r.metric_id), kind: String(r.kind) as ChangeKind,
    payload: (r.payload ?? {}) as Record<string, unknown>, status: String(r.status) as ChangeStatus,
    preview: (r.preview ?? null) as Record<string, unknown> | null,
    submittedBy: String(r.submitted_by), submittedChannel: String(r.submitted_channel),
    submittedAt: new Date(r.submitted_at as string).toISOString(),
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    decidedAt: r.decided_at === null ? null : new Date(r.decided_at as string).toISOString(),
    rejectReason: r.reject_reason === null ? null : String(r.reject_reason),
  }
}

export async function submitChange(
  pool: Pool, org: string, submitter: { userId: string; channel: string },
  metricId: string, kind: ChangeKind, payload: unknown,
): Promise<SubmitOutcome> {
  if (metricId.trim() === '' || metricId.length > 128) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  if ((kind === 'create' || kind === 'update') && !parseDeclaration(payload)) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  if (kind === 'meta' && !MetaPayload.safeParse(payload).success) return { ok: false, http: 400, error: 'INVALID_META' }
  if (kind === 'delete' && payload !== null && typeof payload === 'object' && Object.keys(payload as object).length > 0) {
    return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  }

  const client = await pool.connect()
  try {
    await client.query('begin')
    // 旧未决单自动 superseded（spec §7）；并发双提交靠唯一索引兜底
    await client.query(
      `update data.metric_change set status = 'superseded'
        where org = $1 and metric_id = $2 and status = any($3)`,
      [org, metricId, PENDING_STATUSES],
    )
    const ins = await client.query(
      `insert into data.metric_change (org, metric_id, kind, payload, submitted_by, submitted_channel)
       values ($1, $2, $3, $4::jsonb, $5, $6) returning ${COLS}`,
      [org, metricId, kind, JSON.stringify(payload ?? {}), submitter.userId, submitter.channel],
    )
    await client.query('commit')
    return { ok: true, change: toRow(ins.rows[0]!) }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    if ((e as { code?: string }).code === '23505') return { ok: false, http: 409, error: 'CHANGE_ALREADY_PENDING' }
    throw e
  } finally {
    client.release()
  }
}

export async function listChanges(pool: Pool, org: string, status?: ChangeStatus | 'pending'): Promise<MetricChangeRow[]> {
  const r = status === undefined
    ? await pool.query(`select ${COLS} from data.metric_change where org = $1 order by submitted_at desc limit 200`, [org])
    : status === 'pending'
      ? await pool.query(`select ${COLS} from data.metric_change where org = $1 and status = any($2) order by submitted_at desc limit 200`, [org, PENDING_STATUSES])
      : await pool.query(`select ${COLS} from data.metric_change where org = $1 and status = $2 order by submitted_at desc limit 200`, [org, status])
  return r.rows.map(toRow)
}

export async function getChange(pool: Pool, org: string, id: number): Promise<MetricChangeRow | null> {
  const r = await pool.query(`select ${COLS} from data.metric_change where org = $1 and id = $2`, [org, id])
  return r.rows[0] === undefined ? null : toRow(r.rows[0])
}

export async function withdrawChange(pool: Pool, org: string, id: number, userId: string): Promise<boolean> {
  const r = await pool.query(
    `update data.metric_change set status = 'withdrawn', decided_by = $3, decided_at = now()
      where org = $1 and id = $2 and submitted_by = $3 and status = any($4)`,
    [org, id, userId, PENDING_STATUSES],
  )
  return (r.rowCount ?? 0) > 0
}

export type DecideOutcome =
  | (MetricWriteOutcome & { snapshot?: PreviewSnapshot })
  | { ok: false; http: 409; error: 'PREVIEW_UNAVAILABLE' | 'CHANGE_STATE_CHANGED' | 'REASON_REQUIRED' }

/** 已决/已离场状态：单据已被处理或被顶掉，任何裁决动作都不再吃它（CAS 语义）。 */
const DECIDED_STATUSES: readonly ChangeStatus[] = ['adopted', 'rejected', 'superseded', 'withdrawn']

/**
 * 采纳：preview_ready 才可；按 kind 分发到既有唯一编译点（本函数不自造第二条写路径）。
 * 写成功后才翻状态（CAS）；被并发抢先 ⇒ 409 CHANGE_STATE_CHANGED。
 * 注意：生效写本身幂等（upsert/meta 幂等；delete 重试会 404 如实返回）——
 * 真正要防的是「同一单被吃两次」，由状态机单守。
 */
export async function adoptChange(deps: MetricWriteDeps, org: string, id: number): Promise<DecideOutcome> {
  const cur = await getChange(deps.pool, org, id)
  if (cur === null) return { ok: false, http: 404, error: 'NOT_FOUND' }
  // 两种 409 语义分开：已决/离场 = 状态被并发或先前裁决改变（CAS 输了）；
  // draft/preview_failed = 还没试算好，没有可采纳的快照凭据。
  if (DECIDED_STATUSES.includes(cur.status)) return { ok: false, http: 409, error: 'CHANGE_STATE_CHANGED' }
  if (cur.status !== 'preview_ready') return { ok: false, http: 409, error: 'PREVIEW_UNAVAILABLE' }

  let out: MetricWriteOutcome
  if (cur.kind === 'create' || cur.kind === 'update') {
    out = await writeL2Declaration(deps, org, cur.metricId, cur.payload as unknown as L2Declaration)
  } else if (cur.kind === 'meta') {
    // 逐字段透传（**不补默认值**）：updateMetricMeta 的契约是 `undefined`=不改该字段、
    // `''`=显式清空（routes/metrics.ts PUT /metrics/:id/meta 同款用法）。
    // 若把缺席键补成 ''，一张只改 unit 的单会把 bizDescription 静默清掉。
    const p = cur.payload as Partial<MetricMetaPatch>
    const patch: MetricMetaPatch = {}
    if (p.bizDescription !== undefined) patch.bizDescription = p.bizDescription
    if (p.unit !== undefined) patch.unit = p.unit
    if (p.caliberNote !== undefined) patch.caliberNote = p.caliberNote
    out = await updateMetricMeta(deps, org, cur.metricId, patch)
  } else {
    // kind = 'delete'。'override' 档 P1 才接（表值已备，P0 写侧只会产出前四值）。
    out = await deleteMetricDeclaration(deps, org, cur.metricId)
  }
  if (!out.ok) return out

  // CAS 收尾：写成功后才翻状态；被并发抢先 ⇒ 409（写本身幂等，见函数头注）
  const mark = await deps.pool.query(
    `update data.metric_change set status = 'adopted', decided_by = $3, decided_at = now(), adopted_snapshot = $4::jsonb
      where org = $1 and id = $2 and status = 'preview_ready'`,
    [org, id, deps.requester.userId, JSON.stringify(cur.preview ?? {})],
  )
  if ((mark.rowCount ?? 0) === 0) return { ok: false, http: 409, error: 'CHANGE_STATE_CHANGED' }
  return { ok: true, snapshot: (cur.preview ?? undefined) as PreviewSnapshot | undefined }
}

/**
 * 驳回：必填原因（trim 后非空、≤500 字），任何未决态（draft/preview_ready/preview_failed）都可驳——
 * 「没试算完就看出不对」是合法驳回路径。已决/离场单不吃第二次驳回（WHERE 钉 PENDING_STATUSES）。
 */
export async function rejectChange(pool: Pool, org: string, id: number, reviewerId: string, reason: string): Promise<boolean> {
  if (reason.trim() === '' || reason.length > 500) return false
  const r = await pool.query(
    `update data.metric_change set status = 'rejected', decided_by = $3, decided_at = now(), reject_reason = $4
      where org = $1 and id = $2 and status = any($5)`,
    [org, id, reviewerId, reason.trim(), PENDING_STATUSES],
  )
  return (r.rowCount ?? 0) > 0
}
