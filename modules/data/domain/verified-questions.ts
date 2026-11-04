// verified-questions.ts — W1 可信度地基：已验证问答（回归集）的存储层。
//
// 这一层只做「表 ↔ 类型」的读写，不含 Hono 依赖、不含回归比较（那是 Task 3 的纯函数）。
// 隔离键一律 `org`（= DataTenant.casdoor_org），**四处读写全部带 `where org = $1`**——
// 与 metric-store.ts 同纪律（正典 docs/module-protocol.md「租户数据隔离」）。
//
// 三档信号与落库状态（计划 2026-11-04-amd-w1-verified-questions Task 1）：
//   强（strong）→ 写入即 `status='verified'`、`verified_by='auto:strong'`、`verified_at=now()`
//   弱（weak）  → `status='candidate'`，等人工确认
//   人工（human）→ upsert 只落 `candidate`；确认/拒绝由调用方随后 `setStatus`
//
// 唯一索引是 `(org, metric_id, md5(question), md5(params::text))`：同一问题 + 同一参数
// 重复投递只落一行（幂等，摄入重放/水位回退都靠它）。**冲突时不覆盖已 verified 的行**——
// 自动化信号不能把人工/先前确认过的基线降级。
import type { Pool } from 'pg'

export type VerifiedQuestionSource = 'human' | 'auto'
export type VerifiedQuestionStrength = 'human' | 'strong' | 'weak'
export type VerifiedQuestionStatus = 'candidate' | 'verified' | 'rejected' | 'stale'
/** 回归执行结果（`stale` 的判定归后续任务，本层只如实记录最近一次结果）。 */
export type CheckResult = 'pass' | 'fail' | 'error'

/**
 * 回归基线 = **结构 + 数值摘要**（不是整份结果集）：
 * 结果集可能很大，而口径改动会体现在列集/行数/数值聚合上。比较规则归 Task 3。
 */
export interface Baseline {
  columns: string[]
  rowCount: number
  summary: Record<string, { sum: number; min: number; max: number; nulls: number }>
}

/** 写入候选的载荷（自动信号来自 Task 4/5 的摄入，人工确认走路由）。 */
export interface CandidateInput {
  question: string
  metricId: string
  params?: Record<string, unknown>
  slicing?: Record<string, unknown>
  baseline: Baseline
  /** 相对容差；缺省取表默认 0.001。 */
  tolerance?: number
  source: VerifiedQuestionSource
  strength: VerifiedQuestionStrength
  sessionId?: string | null
}

/** 库行（snake_case → camelCase 后的形状）。 */
export interface VerifiedQuestion {
  id: number
  org: string
  question: string
  metricId: string
  params: Record<string, unknown>
  slicing: Record<string, unknown>
  baseline: Baseline
  tolerance: number
  source: VerifiedQuestionSource
  strength: VerifiedQuestionStrength
  status: VerifiedQuestionStatus
  /** 人工确认人，或 `auto:strong`；未确认 = null。 */
  verifiedBy: string | null
  verifiedAt: string | null
  lastCheckedAt: string | null
  lastCheckResult: CheckResult | null
  sessionId: string | null
  createdAt: string
  updatedAt: string
}

export interface ListVerifiedOptions {
  /** 缺省 `'verified'`——函数名即语义：默认只列「已验证」的回归集。 */
  status?: VerifiedQuestionStatus
  metricId?: string
}

type Row = Record<string, unknown>

function iso(v: unknown): string | null {
  return v === null || v === undefined ? null : new Date(v as string | Date).toISOString()
}

function toVerifiedQuestion(row: Row): VerifiedQuestion {
  return {
    id: Number(row.id),
    org: String(row.org),
    question: String(row.question),
    metricId: String(row.metric_id),
    params: (row.params ?? {}) as Record<string, unknown>,
    slicing: (row.slicing ?? {}) as Record<string, unknown>,
    baseline: row.baseline as Baseline,
    // numeric 在 node-pg 里是 string（避免精度丢失的默认行为）；这一列是容差，转 number 是安全的。
    tolerance: Number(row.tolerance),
    source: row.source as VerifiedQuestionSource,
    strength: row.strength as VerifiedQuestionStrength,
    status: row.status as VerifiedQuestionStatus,
    verifiedBy: row.verified_by === null || row.verified_by === undefined ? null : String(row.verified_by),
    verifiedAt: iso(row.verified_at),
    lastCheckedAt: iso(row.last_checked_at),
    lastCheckResult: (row.last_check_result ?? null) as CheckResult | null,
    sessionId: row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  }
}

/**
 * 写一条候选/已验问答（幂等 upsert）。
 *
 * 冲突语义：
 *   · 已有行 `status='verified'` ⇒ **保留**它的 status / verified_by / verified_at（自动化不降级）；
 *   · 其余状态 ⇒ 采纳本次信号的状态（弱→candidate；强→verified 并记 `auto:strong`）；
 *   · 两种路径都刷新 baseline / tolerance / slicing / session_id / updated_at。
 *
 * ⚠️ 唯一索引不含 slicing（计划原样）：同一 question+params 配不同 slicing 会判为同一行。
 * 这是当前口径的已知边界，改索引前先回计划/issue。
 */
export async function upsertCandidate(pool: Pool, org: string, input: CandidateInput): Promise<void> {
  // 只有**自动强信号**才自带确认身份；人工行恒落 candidate，随后由 setStatus 记下确认人
  // （否则 human+strong 会被错标成 `auto:strong`——来源与确认人必须能对上）。
  const autoStrong = input.source === 'auto' && input.strength === 'strong'
  const status: VerifiedQuestionStatus = autoStrong ? 'verified' : 'candidate'
  const verifiedBy = autoStrong ? 'auto:strong' : null
  await pool.query(
    `insert into data.verified_questions as vq
       (org, question, metric_id, params, slicing, baseline, tolerance,
        source, strength, status, verified_by, verified_at, session_id)
     values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, coalesce($7::numeric, 0.001),
             $8, $9, $10, $11,
             case when $10 = 'verified' then now() else null end,
             $12)
     on conflict (org, metric_id, (md5(question)), (md5(params::text)))
     do update set
       slicing     = excluded.slicing,
       baseline    = excluded.baseline,
       tolerance   = excluded.tolerance,
       session_id  = coalesce(excluded.session_id, vq.session_id),
       status      = case when vq.status = 'verified' then vq.status else excluded.status end,
       verified_by = case when vq.status = 'verified' then vq.verified_by else excluded.verified_by end,
       verified_at = case when vq.status = 'verified' then vq.verified_at else excluded.verified_at end,
       updated_at  = now()`,
    [
      org,
      input.question,
      input.metricId,
      JSON.stringify(input.params ?? {}),
      JSON.stringify(input.slicing ?? {}),
      JSON.stringify(input.baseline),
      input.tolerance ?? null,
      input.source,
      input.strength,
      status,
      verifiedBy,
      input.sessionId ?? null,
    ],
  )
}

/** 列回归集（默认只列 `verified`；显式给 status 才列候选/拒绝）。 */
export async function listVerified(
  pool: Pool, org: string, opts: ListVerifiedOptions = {},
): Promise<VerifiedQuestion[]> {
  const status = opts.status ?? 'verified'
  const params: unknown[] = [org, status]
  let sql = `select * from data.verified_questions where org = $1 and status = $2`
  if (opts.metricId !== undefined) {
    params.push(opts.metricId)
    sql += ` and metric_id = $3`
  }
  sql += ` order by created_at desc, id desc`
  const { rows } = await pool.query(sql, params)
  return (rows as Row[]).map(toVerifiedQuestion)
}

/**
 * 人工改状态（确认 / 拒绝）。
 *
 * `verified_by` / `verified_at` 只在置为 `verified` 时写入；置为其他状态时**保留**原来的
 * 确认痕迹（拒绝一行不会抹掉「谁确认过它」——审计要能回答两个问题）。
 */
export async function setStatus(
  pool: Pool, org: string, id: number | string,
  status: VerifiedQuestionStatus, by: string | null = null,
): Promise<void> {
  await pool.query(
    `update data.verified_questions
        set status      = $3,
            verified_by = case when $3 = 'verified' then $4 else verified_by end,
            verified_at = case when $3 = 'verified' then now() else verified_at end,
            updated_at  = now()
      where org = $1 and id = $2`,
    [org, id, status, by],
  )
}

/** 记录一次回归执行结果（pass/fail/error）。status 不变——`stale` 的判定不在本层发明。 */
export async function recordCheck(
  pool: Pool, org: string, id: number | string, result: CheckResult,
): Promise<void> {
  await pool.query(
    `update data.verified_questions
        set last_checked_at = now(),
            last_check_result = $3,
            updated_at = now()
      where org = $1 and id = $2`,
    [org, id, result],
  )
}
