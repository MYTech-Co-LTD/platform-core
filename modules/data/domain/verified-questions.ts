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
// 唯一索引是 `(org, metric_id, md5(question), md5(params::text), md5(slicing::text))`：
// 同一问题 + 同一参数 + 同一**切面**重复投递只落一行（幂等，摄入重放/水位回退都靠它）。
// slicing 必须进键——同题同参不同切面是**不同的结果基线**，合行会把两条回归用例静默并成一条。
//
// 冲突语义（2026-11-04 评审后定案，计划 Task 1 的表格是正典）：
//   · 已 verified 行：status/verified_by/verified_at **恒冻结**（确认身份只由人工 `setStatus` 改写），
//     baseline/slicing/tolerance 只有 `source='human'` 或 `strength='strong'` 的新信号能覆盖；
//     覆盖时清空 `last_check_result`（旧结果是对旧基线的，不能当新基线的成绩）。
//   · 已 rejected 行：自动信号不得复活（status 保持 rejected），只有人工 `setStatus` 能重开。
//   · source/strength 取「最强」：`human > strong > weak`——先弱后强必须升级，不能出现
//     status=verified 而 strength=weak 的自相矛盾行。
import type { Pool } from 'pg'

export type VerifiedQuestionSource = 'human' | 'auto'
export type VerifiedQuestionStrength = 'human' | 'strong' | 'weak'
export type VerifiedQuestionStatus = 'candidate' | 'verified' | 'rejected' | 'stale'
/** 回归执行结果（`stale` 的判定归后续任务，本层只如实记录最近一次结果）。 */
export type CheckResult = 'pass' | 'fail' | 'error'

/** 单列的摘要面（Task 3 的 `summarize` 产出）。 */
export interface ColumnSummary {
  /** 数值列的求和/最小/最大。**非数值列恒 0**（三值不参与比较，只有 nulls 有比较意义）。 */
  sum: number
  min: number
  max: number
  /** null/undefined 的格数——非数值列唯一被比较的字段。 */
  nulls: number
  /**
   * `false` = 该列不是数值列（Task 3 的 `summarize` 对全 null / 混合类型 / 文字列写入）。
   * **缺席按数值列处理**——兼容 Task 1 时代写入的基线与手写夹具（它们的 summary 只有四键）。
   */
  numeric?: boolean
}

/**
 * 回归基线 = **结构 + 数值摘要**（不是整份结果集）：
 * 结果集可能很大，而口径改动会体现在列集/行数/数值聚合上。比较规则归 Task 3。
 */
export interface Baseline {
  columns: string[]
  rowCount: number
  summary: Record<string, ColumnSummary>
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
  /** 最近一次人工决策（确认**或**拒绝）的操作人；自动信号 = null。
   *  与 `verifiedBy` 分开是刻意的：拒绝不抹掉「谁确认过」，确认也不抹掉「谁拒绝过」的审计面。 */
  decidedBy: string | null
  decidedAt: string | null
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
    decidedBy: row.decided_by === null || row.decided_by === undefined ? null : String(row.decided_by),
    decidedAt: iso(row.decided_at),
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
 * 冲突语义见文件头注释（2026-11-04 评审定案）。要点：
 *   · verified 行的确认身份恒冻结；内容（baseline/slicing/tolerance）只接受 human/strong 覆盖；
 *   · rejected 行不被自动信号复活；
 *   · source/strength 取最强（先弱后强会升级）；内容被覆盖时清空 last_check_result；
 *   · tolerance 缺省时**整列不写**，让表默认（0.001）生效——默认值只有表定义一处事实源。
 */
export async function upsertCandidate(pool: Pool, org: string, input: CandidateInput): Promise<void> {
  // 只有**自动强信号**才自带确认身份；人工行恒落 candidate，随后由 setStatus 记下确认人
  // （否则 human+strong 会被错标成 `auto:strong`——来源与确认人必须能对上）。
  const autoStrong = input.source === 'auto' && input.strength === 'strong'
  const status: VerifiedQuestionStatus = autoStrong ? 'verified' : 'candidate'
  const verifiedBy = autoStrong ? 'auto:strong' : null

  // 列清单动态拼：tolerance 未给 ⇒ 不出现该列（走表默认），不能用 coalesce 把默认值抄第二遍。
  const cols: string[] = []
  const exprs: string[] = []
  const params: unknown[] = []
  const add = (col: string, val: unknown, cast = ''): void => {
    params.push(val)
    cols.push(col)
    exprs.push(`$${params.length}${cast}`)
  }

  add('org', org)
  add('question', input.question)
  add('metric_id', input.metricId)
  add('params', JSON.stringify(input.params ?? {}), '::jsonb')
  add('slicing', JSON.stringify(input.slicing ?? {}), '::jsonb')
  add('baseline', JSON.stringify(input.baseline), '::jsonb')
  if (input.tolerance !== undefined) add('tolerance', input.tolerance)
  add('source', input.source)
  add('strength', input.strength)
  add('status', status)
  const statusParam = params.length
  add('verified_by', verifiedBy)
  // verified_at 依赖本次 status 参数，不是独立值。
  cols.push('verified_at')
  exprs.push(`case when $${statusParam} = 'verified' then now() else null end`)
  add('session_id', input.sessionId ?? null)

  await pool.query(
    `insert into data.verified_questions as vq
       (${cols.join(', ')})
     values (${exprs.join(', ')})
     on conflict (org, metric_id, (md5(question)), (md5(params::text)), (md5(slicing::text)))
     do update set
       -- source/strength 取最强：human > strong > weak（先弱后强必须升级）
       source = case
                  when vq.source = 'human' or excluded.source = 'human' then 'human'
                  else 'auto'
                end,
       strength = case
                    when vq.strength = 'human' or excluded.strength = 'human' then 'human'
                    when vq.strength = 'strong' or excluded.strength = 'strong' then 'strong'
                    else 'weak'
                  end,
       -- 确认身份恒冻结：verified 行不因自动信号改归属，rejected 行不因自动信号被复活
       status = case when vq.status in ('verified', 'rejected') then vq.status else excluded.status end,
       verified_by = case when vq.status in ('verified', 'rejected') then vq.verified_by else excluded.verified_by end,
       verified_at = case when vq.status in ('verified', 'rejected') then vq.verified_at else excluded.verified_at end,
       -- verified 行的参考基线只有 human/strong 能覆盖；弱信号不得悄悄替换
       baseline = case
                    when vq.status = 'verified' and excluded.source <> 'human' and excluded.strength <> 'strong'
                      then vq.baseline else excluded.baseline
                  end,
       slicing = case
                   when vq.status = 'verified' and excluded.source <> 'human' and excluded.strength <> 'strong'
                     then vq.slicing else excluded.slicing
                 end,
       tolerance = case
                     when vq.status = 'verified' and excluded.source <> 'human' and excluded.strength <> 'strong'
                       then vq.tolerance else excluded.tolerance
                   end,
       -- 基线/切面/容差**真的被覆盖** ⇒ 旧的 pass/fail/error 不再对应当前基线，清空。
       -- （verified 行被弱信号命中时内容没被覆盖，旧结果仍然对应当前基线，保留。）
       last_check_result = case
                             when (vq.baseline is distinct from excluded.baseline
                               or vq.slicing is distinct from excluded.slicing
                               or vq.tolerance is distinct from excluded.tolerance)
                              and (vq.status <> 'verified'
                                or excluded.source = 'human'
                                or excluded.strength = 'strong')
                               then null
                             else vq.last_check_result
                           end,
       session_id = coalesce(excluded.session_id, vq.session_id),
       updated_at = now()`,
    params,
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
 * 「谁拒绝的」由 `decided_by` / `decided_at` 承载（033）：**确认与拒绝都写**这两列，
 * 故任何一次人工决策都能回答归属，而不必依赖 `verified_by`（它对未确认过的候选行恒 NULL）。
 *
 * 人工状态变更**必须带操作人**（verified 与 rejected 都是）：没有归属的确认/拒绝是坏审计，
 * 宁可在入口抛错。自动信号不经过本函数（它走 `upsertCandidate`）。
 *
 * 置 `verified` 时同时把 `source`/`strength` 升为 `human`——「人工确认」本身就是最强档信号；
 * 不升会留下 `status='verified'` 而 `strength='weak'` 的自相矛盾行（计划 Task 2 定案）。
 *
 * 返回是否命中本租户的行：`false` = id 不存在或属于别的 org ⇒ 路由层回 404
 * （跨租户不暴露「这个 id 是否存在」，与模块内「非法 id 一律 404」同口径）。
 */
export async function setStatus(
  pool: Pool, org: string, id: number | string,
  status: VerifiedQuestionStatus, by: string | null = null,
): Promise<boolean> {
  const operator = by?.trim() ?? ''
  if ((status === 'verified' || status === 'rejected') && operator === '') {
    throw new Error(
      status === 'verified'
        ? 'setStatus: 置 verified 必须带确认人（审计要能回答谁确认的）'
        : 'setStatus: 置 rejected 必须带操作人（审计要能回答谁拒绝的）',
    )
  }
  const { rowCount } = await pool.query(
    `update data.verified_questions
        set status      = $3,
            verified_by = case when $3 = 'verified' then $4 else verified_by end,
            verified_at = case when $3 = 'verified' then now() else verified_at end,
            -- 决策痕迹：确认与拒绝都写（verified_by 只表示「谁确认过」，拒绝不挤占它）
            decided_by  = case when $3 in ('verified', 'rejected') then $4 else decided_by end,
            decided_at  = case when $3 in ('verified', 'rejected') then now() else decided_at end,
            -- 人工确认 = 最强档（human > strong > weak），见文件头与计划「冲突语义」表
            source      = case when $3 = 'verified' then 'human' else source end,
            strength    = case when $3 = 'verified' then 'human' else strength end,
            updated_at  = now()
      where org = $1 and id = $2`,
    [org, id, status, operator],
  )
  return (rowCount ?? 0) > 0
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
