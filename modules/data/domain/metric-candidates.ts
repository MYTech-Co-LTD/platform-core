// metric-candidates.ts — W2 候选池的存储层（迁移 034 的 data.metric_candidates）。
//
// 候选 = 「可能值得变成指标的东西」：duckle profiler 从源数据剖面出来（origin='profile'），
// 或从需求轨迹挖出来（origin='demand'）。本文件只做存取与状态机；生成规则/上限/去重在 Task 5。
//
// 隔离键一律是 **org（text，值 = 该租户的 Casdoor org）**：每条 SQL 都带 `where org = $1`
// （正典 docs/module-protocol.md「租户数据隔离」，机器判据 scripts/check-tenant-isolation.mjs）。
import type { Pool } from 'pg'

/** 候选从哪来：profiler / 需求挖掘。与迁移 034 的 check 约束同域。 */
export type CandidateOrigin = 'profile' | 'demand'

/**
 * 候选状态机（与迁移 034 的 check 约束同域）：
 *   pending  → 待处置（新候选）
 *   created  → 已落成指标（L2 / 私有测度）
 *   promoted → 已提为 L1 候选（W3 出 PR）
 *   rejected → 人工拒绝（终态：重新 profiling 不得复活）
 *   expired  → 过期（同理，人工/流程可再置回）
 */
export type CandidateStatus = 'pending' | 'created' | 'promoted' | 'rejected' | 'expired'

/**
 * 候选的测度表达式——**单列聚合**（B11 口径单一定义）：`<agg>(<column>)`，可选维度。
 * 复合表达式 / join 属 L2 树，不进候选档。
 */
export interface CandidateExpr {
  agg: string
  column: string
  /** 维度列（可为空数组）；存储层**恒写**该键（省缺归一成 `[]`，见 `normalizeExpr`）。 */
  dims: string[]
}

/** 候选行（读侧形状）。 */
export interface Candidate {
  id: number
  org: string
  relation: string
  /** 表达式（库里的 jsonb 原形；`dims` 是它的投影，同一事实源）。 */
  expr: CandidateExpr
  /** `expr.dims` 的便捷投影——只关心维度列的调用方不必再剥一层。 */
  dims: string[]
  /** profiler / 挖掘的原始证据（形状由生成方定；坏形状归一成 {}）。 */
  evidence: Record<string, unknown>
  rationale: string
  /** 0–1 的置信度（numeric；pg 回字符串，读侧归一成 number）。 */
  confidence: number
  origin: CandidateOrigin
  status: CandidateStatus
  /** 首次出现时刻（ISO；upsert 不动它，它是唯一的时间锚）。 */
  createdAt: string
}

/** `upsertCandidate` 的入参。`status` 不在入参面：新候选恒 `pending`，决策走 `setCandidateStatus`。 */
export interface CandidateInput {
  relation: string
  expr: { agg: string; column: string; dims?: readonly string[] }
  evidence?: Record<string, unknown>
  rationale?: string
  confidence?: number
  origin: CandidateOrigin
}

export interface ListCandidatesOptions {
  status?: CandidateStatus
  origin?: CandidateOrigin
  relation?: string
  /** 上限（候选池可能很大；不给 = 全量，调用方负责收窄）。 */
  limit?: number
}

/** 读侧投影列：一处写法，避免两个查询各写一份列清单而漂移。 */
const CANDIDATE_COLUMNS = 'id, org, relation, expr, evidence, rationale, confidence, origin, status, created_at'

type Row = Record<string, unknown>

/**
 * 表达式归一（**存储层收口**）：`{agg, column, dims}` 恒三键、dims 恒数组。
 *
 * 为什么要归一：幂等键是 `md5(expr::text)`。若调用方一次省缺 dims、一次传 `[]`，
 * 同一语义候选会落成两行（key 不同）——归一后两者逐字相同（jsonb 再把键序归一定死）。
 */
function normalizeExpr(expr: CandidateInput['expr']): CandidateExpr {
  return {
    agg: String(expr.agg),
    column: String(expr.column),
    dims: Array.isArray(expr.dims) ? expr.dims.map(String) : [],
  }
}

/** 行 → Candidate：不信任存储形状（坏 jsonb 不许让整池读取抛错）。 */
function toCandidate(row: Row): Candidate {
  const raw = row.expr
  const expr = normalizeExpr(
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as CandidateInput['expr'])
      : { agg: '', column: '', dims: [] },
  )
  const evidence = typeof row.evidence === 'object' && row.evidence !== null && !Array.isArray(row.evidence)
    ? (row.evidence as Record<string, unknown>)
    : {}
  return {
    id: Number(row.id),
    org: String(row.org),
    relation: String(row.relation),
    expr,
    dims: expr.dims,
    evidence,
    rationale: typeof row.rationale === 'string' ? row.rationale : '',
    // numeric 列 pg 回字符串 ⇒ 归一成 number（非有限值按 0——它是统计量，NaN 对下游无意义）
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
    origin: row.origin as CandidateOrigin,
    status: row.status as CandidateStatus,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : new Date(String(row.created_at)).toISOString(),
  }
}

/**
 * 写入/刷新一条候选：同 `(org, relation, md5(expr::text))` 幂等（profiler 会反复出同一条）。
 *
 * 冲突分支**只刷证据面**（evidence / rationale / confidence / updated_at）：
 *   · `status` 不碰：`rejected` / `promoted` 是人工/流程决策，重新 profiling 不得复活/降级；
 *   · `origin` 不碰：首次来源是时间事实（先 profile 后 demand 仍是 profile）；
 *   · `created_at` 不碰：它是候选首次出现的锚。
 * 返回落库后的整行（调用方不必再点读一次）。
 */
export async function upsertCandidate(
  pool: Pool, org: string, input: CandidateInput,
): Promise<Candidate> {
  const expr = normalizeExpr(input.expr)
  const { rows } = await pool.query(
    `insert into data.metric_candidates
       (org, relation, expr, evidence, rationale, confidence, origin)
     values ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
     on conflict (org, relation, (md5(expr::text))) do update set
       evidence   = excluded.evidence,
       rationale  = excluded.rationale,
       confidence = excluded.confidence,
       updated_at = now()
     returning ${CANDIDATE_COLUMNS}`,
    [
      org, input.relation, JSON.stringify(expr),
      JSON.stringify(input.evidence ?? {}), input.rationale ?? '', input.confidence ?? 0, input.origin,
    ],
  )
  const row = (rows as Row[])[0]
  if (row === undefined) {
    throw new Error('upsertCandidate: insert … returning 未返回行（候选表可能缺列或迁移未应用）')
  }
  return toCandidate(row)
}

/**
 * 列本租户的候选（默认全状态；给了选项就收窄）。
 * 排序 `confidence desc, id asc`：候选池的消费面先看高置信的；同分按出现顺序稳定。
 */
export async function listCandidates(
  pool: Pool, org: string, opts: ListCandidatesOptions = {},
): Promise<Candidate[]> {
  const params: unknown[] = [org]
  let sql = `select ${CANDIDATE_COLUMNS} from data.metric_candidates where org = $1`
  if (opts.status !== undefined) {
    params.push(opts.status)
    sql += ` and status = $${params.length}`
  }
  if (opts.origin !== undefined) {
    params.push(opts.origin)
    sql += ` and origin = $${params.length}`
  }
  if (opts.relation !== undefined) {
    params.push(opts.relation)
    sql += ` and relation = $${params.length}`
  }
  sql += ' order by confidence desc, id asc'
  if (opts.limit !== undefined) {
    params.push(opts.limit)
    sql += ` limit $${params.length}`
  }
  const { rows } = await pool.query(sql, params)
  return (rows as Row[]).map(toCandidate)
}

/**
 * 按 id 读一条本租户候选（adopt 路径用；id 是 bigserial，跨租户一律读不到 ⇒ null）。
 *
 * `org` 必须进 WHERE（理由同 `setCandidateStatus`：先按 id 查再判 org 是静默越权）。
 */
export async function getCandidate(pool: Pool, org: string, id: number): Promise<Candidate | null> {
  const { rows } = await pool.query(
    `select ${CANDIDATE_COLUMNS} from data.metric_candidates where org = $1 and id = $2`,
    [org, id],
  )
  const row = (rows as Row[])[0]
  return row === undefined ? null : toCandidate(row)
}

/**
 * 批量把**自动来源**的 `expired` 候选重新置回 `pending`（池级上限的复活动作）。
 *
 * 为什么需要它：`upsertCandidate` 的冲突分支**不碰状态**（人工决策不得被自动信号复活），
 * 所以「上一轮被自动退役、这一轮画像又支持它」的候选必须显式复活——否则一次画像抖动
 * （列暂时消失/被上限挤出）会让候选**永久**退出池（expired 没有人工改回入口）。
 *
 * 只认 `origin='profile'`：demand 来源不参与自动池的退役/复活；`rejected` 等人工决策不动
 * （它们不是 `expired`，不会被本函数选中）。
 */
export async function reviveExpiredCandidates(
  pool: Pool, org: string, ids: readonly number[],
): Promise<number> {
  if (ids.length === 0) return 0
  const r = await pool.query(
    `update data.metric_candidates
        set status = 'pending', updated_at = now()
      where org = $1 and id = any($2::bigint[])
        and status = 'expired' and origin = 'profile'`,
    [org, ids],
  )
  return r.rowCount ?? 0
}

/**
 * 批量把**自动来源**的 pending 候选置 `expired`（池级上限的退役动作，W2 Task 5 评审）。
 *
 * 只动 `status='pending' and origin='profile'`：人工决策（rejected/promoted/created）不碰，
 * demand 来源（对话挖出来的）不碰——它们不占 profiler 的「每关系 ≤20」预算。
 * 返回实际退役行数（并发下可能小于 ids 长度：行已被别处改状态 ⇒ 本次没动它）。
 */
export async function expireCandidates(
  pool: Pool, org: string, ids: readonly number[],
): Promise<number> {
  if (ids.length === 0) return 0
  const r = await pool.query(
    `update data.metric_candidates
        set status = 'expired', updated_at = now()
      where org = $1 and id = any($2::bigint[])
        and status = 'pending' and origin = 'profile'`,
    [org, ids],
  )
  return r.rowCount ?? 0
}

/**
 * 采用前的**占位**（CAS：pending → created）。返回是否抢到。
 *
 * 为什么不是「建完测度再改状态」：那两个动作分属不同语句，两个并发 adopt 会都看到 pending
 * ⇒ 各建一条私有测度（id 不同，不会撞 METRIC_EXISTS）。CAS 让「同一候选只能被采用一次」
 * 成为数据库层的事实；采用失败（三闸不过）由调用方把状态**回滚**成 pending（见路由）。
 *
 * 只认 pending：created/promoted/rejected/expired 都是决策，抢不到 ⇒ 调用方回 409。
 */
export async function claimCandidate(pool: Pool, org: string, id: number): Promise<boolean> {
  const r = await pool.query(
    `update data.metric_candidates
        set status = 'created', updated_at = now()
      where org = $1 and id = $2 and status = 'pending'`,
    [org, id],
  )
  return (r.rowCount ?? 0) > 0
}

/**
 * 人工/流程改状态。返回是否命中本租户的行（false = id 不存在或属于别的 org ⇒ 路由层回 404）。
 *
 * ⚠️ `org` 必须进 WHERE（不是先查再改）：跨租户改状态是静默越权，且没有任何日志能看出改错。
 */
export async function setCandidateStatus(
  pool: Pool, org: string, id: number, status: CandidateStatus,
): Promise<boolean> {
  const r = await pool.query(
    `update data.metric_candidates
        set status = $3, updated_at = now()
      where org = $1 and id = $2`,
    [org, id, status],
  )
  return (r.rowCount ?? 0) > 0
}
