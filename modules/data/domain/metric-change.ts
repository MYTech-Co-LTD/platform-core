// metric-change.ts —— 指标变更单状态机（spec §5.2/§7，P0；归属/同名/撞id 判据 P1 Task 3）。
// 本文件不生效任何指标：生效在 adoptChange（Task 4）分发到既有唯一编译点。
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  collectRefIds, derivedExprTitle, exceedsNesting, L2ExprDeclarationSchema, L2RefineDeclarationSchema,
  resolveL1Base, SemanticCompileError,
} from './semantic-compiler'
import type { L2Declaration } from './semantic-compiler'
import type { MetricWriteDeps, MetricWriteOutcome, MetricMetaPatch } from './metric-write'
import { writeL2Declaration, updateMetricMeta, deleteMetricDeclaration } from './metric-write'
import { createOverrideDeclaration } from './tenant-declaration-write'
import { loadPlatformCatalog } from './metric-store'
import type { MetricOwnership } from './metric-store'
import { assertConcept, assertTitleFree, OwnershipError } from './metric-ownership'
import type { PreviewSnapshot } from './metric-change-preview'

/** override 档 P1 Task 7 接入（046 建表时 kind 已按 spec 五值备全）。 */
export type ChangeKind = 'create' | 'update' | 'meta' | 'delete' | 'override'
export type ChangeStatus = 'draft' | 'preview_ready' | 'preview_failed' | 'adopted' | 'rejected' | 'superseded' | 'withdrawn'
export const PENDING_STATUSES: readonly ChangeStatus[] = ['draft', 'preview_ready', 'preview_failed']

export interface MetricChangeRow {
  id: number; org: string; metricId: string; kind: ChangeKind
  payload: Record<string, unknown>; status: ChangeStatus
  preview: Record<string, unknown> | null
  /** 被顶掉的旧试算快照（P1 Task 5，最新在前，FIFO 封顶 5；DB null 归一为 []）。 */
  previewHistory: Record<string, unknown>[]
  submittedBy: string; submittedChannel: string; submittedAt: string
  decidedBy: string | null; decidedAt: string | null; rejectReason: string | null
}

export type SubmitOutcome =
  | { ok: true; change: MetricChangeRow }
  | { ok: false; http: 400 | 404 | 409; error:
      | 'INVALID_DECLARATION' | 'INVALID_META' | 'CHANGE_ALREADY_PENDING'
      // P1 Task 3（spec §13）：概念归属未知（400）/ 部门内同名互斥（409）/ create 撞已有 id（400）
      | 'UNKNOWN_CONCEPT' | 'TITLE_EXISTS_IN_DEPT' | 'METRIC_ID_EXISTS'
      // P1 Task 7（override 档）：metricId 不是现行 L1 id ⇒ 提交即 404（fail-early 的廉价闸）
      | 'NOT_FOUND' }

const MetaPayload = z.object({
  bizDescription: z.string().max(500).optional(),
  unit: z.string().max(32).optional(),
  caliberNote: z.string().max(500).optional(),
}).strict()

/**
 * override 档 payload 的**宽预检**（P1 Task 7）：payload = W8 声明 entry（与
 * POST /metrics/:id/override 的 `declaration` 同形同源，故 passthrough 放行其余字段）。
 * 这里只拦形状级错误（name/label/expression/grain 在位且 name==metricId）；深校验
 * （YAML 尺/关系白名单/grain 同形/列存在性/掩码/scope 降档）全在采纳期的
 * `createOverrideDeclaration`——第二份深校验就是第二事实源，不复制。
 */
const OverridePayload = z.object({
  name: z.string().min(1),
  label: z.string(),
  expression: z.string(),
  grain: z.array(z.string()),
}).passthrough()

/**
 * meta 档判据（P1 Task 3 订正，销缓办④）：「**三键全缺**」才拒——`{}` 立了也采纳不了
 * （adoptChange 把 payload 透传给 updateMetricMeta，一个字段都不进 SET ⇒ 恒 400
 * EMPTY_META_PATCH，变成一张永远卡在队列里的死单，P0 终审 F3），所以在提交时就拒。
 *
 * ⚠️ P0 注释曾把判据写成「至少一键有实质内容（trim 非空）」——那是**错的**：
 * 带键但值空的提案（如 `{unit:''}`，乃至三键全空串）会被 updateMetricMeta 的 clean 收口成
 * null **进 SET**（显式清空契约），根本不是空补丁、不是死单。把显式清空拒在提交期，
 * 等于堵死了「下架单位标注」这条合法治理路径。P1 订正：只有三键全缺才拒。
 */
function metaAllKeysAbsent(p: { bizDescription?: string; unit?: string; caliberNote?: string }): boolean {
  return p.bizDescription === undefined && p.unit === undefined && p.caliberNote === undefined
}

/**
 * create/update 档 payload 顶层的**归属字段**（047，P1 Task 3，spec §5.1）。
 * 设计定案：归属**不进** `L2DeclarationBody`（声明形状契约不为它开口子）——它随**行**不随声明，
 * 与声明字段同栖一个 payload 顶层，采纳时拆出来经 opts.ownership 落库（见 adoptChange）。
 */
const OwnershipPayload = z.object({
  entity: z.string().min(1).max(128).optional(),
  synonyms: z.array(z.string().min(1).max(32)).max(16).optional(),
  ownerDept: z.string().min(1).max(128).optional(),
  variantNote: z.string().min(1).max(500).optional(),
}).strict()

/** payload 顶层四个归属键（与 OwnershipPayload 逐字同集——多一个键都不算归属键）。 */
const OWNERSHIP_KEYS: ReadonlySet<string> = new Set(['entity', 'synonyms', 'ownerDept', 'variantNote'])

/**
 * 把 payload 拆成「声明部分」与「归属部分」：声明部分进共享 schema 校验（strict 不得被
 * 归属键打脏），归属部分单独按 OwnershipPayload 校验。payload 不是平面对象（数组/标量）
 * 时原样留给声明校验去拒——不在这里猜形状。
 */
function splitOwnershipPayload(payload: unknown): { decl: unknown; own: Record<string, unknown> } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return { decl: payload, own: {} }
  const decl: Record<string, unknown> = {}
  const own: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (OWNERSHIP_KEYS.has(k)) own[k] = v
    else decl[k] = v
  }
  return { decl, own }
}

/**
 * 生效 title——同名互斥判据（assertTitleFree）的尺子，与编译点**同一条推导**：
 *   refine 档 = alias ?? 基底 L1 行的 title（compileRefine：`decl.alias ?? base.title`）；
 *   expr 档   = alias ?? derivedExprTitle(refIds)（compileExpr 同源，串只此一处）。
 * 解不出（基底不在 L1 词表 / expr 只有字面量）⇒ 返回 null：**跳过提交期同名判据**——
 * 这类单试算必失败（compileL2 响亮拒绝 ⇒ preview_failed 恒不可采纳），同名闸在采纳前天然闭环，
 * 不会放行任何能生效的同名行；唯一索引兜 adopt 期的并发窗口。
 */
async function effectiveTitleOf(pool: Pool, decl: unknown): Promise<string | null> {
  const d = decl as { alias?: unknown; op?: { kind?: unknown } }
  if (typeof d.alias === 'string' && d.alias !== '') return d.alias
  const kind = d.op === null || typeof d.op !== 'object' ? undefined : d.op.kind
  const refIds = collectRefIds(decl as L2Declaration)
  if (kind === 'expr') return refIds.length === 0 ? null : derivedExprTitle(refIds)
  if (kind === 'refine' && refIds.length === 1) {
    try {
      return resolveL1Base(await loadPlatformCatalog(pool), refIds[0]!).title
    } catch (e) {
      if (e instanceof SemanticCompileError) return null
      throw e
    }
  }
  return null
}

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

const COLS = 'id, org, metric_id, kind, payload, status, preview, preview_history, submitted_by, submitted_channel, submitted_at, decided_by, decided_at, reject_reason'
type DbRow = Record<string, unknown>
function toRow(r: DbRow): MetricChangeRow {
  return {
    id: Number(r.id), org: String(r.org), metricId: String(r.metric_id), kind: String(r.kind) as ChangeKind,
    payload: (r.payload ?? {}) as Record<string, unknown>, status: String(r.status) as ChangeStatus,
    preview: (r.preview ?? null) as Record<string, unknown> | null,
    previewHistory: Array.isArray(r.preview_history) ? (r.preview_history as Record<string, unknown>[]) : [],
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
  // create/update 档（P1 Task 3）：声明形状 + 归属字段形状 + 概念归属 + 同名互斥 + create 撞 id，
  // 全部在**提交期**收口——把可读错误给在立单前，而不是让人在采纳期撞裸 23505/编译错。
  let ownership: MetricOwnership | undefined
  if (kind === 'create' || kind === 'update') {
    const { decl, own } = splitOwnershipPayload(payload)
    if (!parseDeclaration(decl)) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
    const ownParsed = OwnershipPayload.safeParse(own)
    // 归属字段形状越界（超长/超量/错型）⇒ 与声明形状同罪：payload 整体不可立单
    if (!ownParsed.success) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
    ownership = Object.keys(ownParsed.data).length > 0 ? ownParsed.data : undefined
    // 缓办②销账：create 撞已有 (org, id) 行 ⇒ 拒收。update 档保留 upsert 语义（「改已生效
    // 口径」是 update 的本体）；archived 行同判——它仍是 (org, id) 的一行，静默复活是私有测度
    // 复活路径的职权（要过 creator/manage 闸），不是 create 的。
    if (kind === 'create') {
      const exists = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [org, metricId])
      if ((exists.rowCount ?? 0) > 0) return { ok: false, http: 400, error: 'METRIC_ID_EXISTS' }
    }
    // 概念归属（spec §5.3）：entity 必须在 平台 entities ∪ 租户概念 的并集里（null/缺省 = 未声明，放行）
    try {
      await assertConcept(pool, org, ownership?.entity ?? null)
    } catch (e) {
      if (e instanceof OwnershipError) return { ok: false, http: 400, error: 'UNKNOWN_CONCEPT' }
      throw e
    }
    // 部门内同名互斥（spec §5.1）：按**生效 title** 判（alias ?? 基底/派生 title，见 effectiveTitleOf）；
    // update 档排除自身——「保留旧 title 只改口径」是合法改法，不能被自己的旧行绊倒。
    const title = await effectiveTitleOf(pool, decl)
    if (title !== null) {
      let bucket = ownership?.ownerDept ?? null
      if (kind === 'update' && ownership?.ownerDept === undefined) {
        // update 不换桶时，生效桶 = 行上既有 owner_dept（缺席 = 保留，与 upsertMetric 冲突分支同语义）
        const cur = await pool.query('select owner_dept from data.metrics where org = $1 and id = $2', [org, metricId])
        bucket = (cur.rows[0]?.owner_dept as string | null | undefined) ?? null
      }
      try {
        await assertTitleFree(pool, org, bucket, title, kind === 'update' ? metricId : undefined)
      } catch (e) {
        if (e instanceof OwnershipError) return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
        throw e
      }
    }
  }
  // override 档（P1 Task 7）：提交期只收**形状级**闸（宽预检见 OverridePayload）+ 三道廉价闸——
  // ① metricId 必须是现行 L1 id（404 fail-early；编译尺/grain 同形/scope 降档全在采纳期
  //    createOverrideDeclaration，透传成 400）；② 概念归属（payload 带 entity 才判，同
  //    create/update 档一把尺）；③ 部门内同名互斥——覆盖行的 title 就是 entry.label
  //    （compileTenantDeclaration：label 空 ⇒ 回落 name），落在租户桶、owner_dept 缺省 null，
  //    故桶取 payload.ownerDept（缺席 = null 桶，与 assertTitleFree 的 coalesce 判据同构）。
  if (kind === 'override') {
    const parsed = OverridePayload.safeParse(payload)
    if (!parsed.success || parsed.data.name !== metricId) {
      return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
    }
    const p = parsed.data
    const catalog = await loadPlatformCatalog(pool)
    if (!catalog.some((m) => m.id === metricId)) return { ok: false, http: 404, error: 'NOT_FOUND' }
    const entity = typeof p.entity === 'string' && p.entity !== '' ? p.entity : null
    try {
      await assertConcept(pool, org, entity)
    } catch (e) {
      if (e instanceof OwnershipError) return { ok: false, http: 400, error: 'UNKNOWN_CONCEPT' }
      throw e
    }
    const label = p.label.trim()
    const title = label !== '' ? label : metricId
    const dept = typeof p.ownerDept === 'string' && p.ownerDept !== '' ? p.ownerDept : null
    try {
      await assertTitleFree(pool, org, dept, title)
    } catch (e) {
      if (e instanceof OwnershipError) return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
      throw e
    }
  }
  const meta = kind === 'meta' ? MetaPayload.safeParse(payload) : null
  if (kind === 'meta' && (meta === null || !meta.success || metaAllKeysAbsent(meta.data))) {
    return { ok: false, http: 400, error: 'INVALID_META' }
  }
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
  // 同决策锁（P1 Task 4 修复①，与 adopt/reject 同键）：withdraw 也是把未决单推离 PENDING 的
  // 裁决动作，裸 UPDATE 与 adopt 交错同样是「写已生效但单据 withdrawn」的毒丸形态。
  return withDecisionLock(pool, org, id, async () => {
    const r = await pool.query(
      `update data.metric_change set status = 'withdrawn', decided_by = $3, decided_at = now()
        where org = $1 and id = $2 and submitted_by = $3 and status = any($4)`,
      [org, id, userId, PENDING_STATUSES],
    )
    return (r.rowCount ?? 0) > 0
  })
}

export type DecideOutcome =
  | (MetricWriteOutcome & { snapshot?: PreviewSnapshot })
  | { ok: false; http: 409; error: 'PREVIEW_UNAVAILABLE' | 'CHANGE_STATE_CHANGED' | 'REASON_REQUIRED' }

/** 已决/已离场状态：单据已被处理或被顶掉，任何裁决动作都不再吃它（CAS 语义）。 */
const DECIDED_STATUSES: readonly ChangeStatus[] = ['adopted', 'rejected', 'superseded', 'withdrawn']

/**
 * 从单据 payload 顶层解出归属字段（P1 Task 3）：只认**真值形状**——P0 时代的历史单、
 * 形状漂移的手改行，都不会把垃圾写进 upsert 参数；全缺 ⇒ undefined（= upsert 冲突分支
 * 全 coalesce 保留，行为与 P0 逐字一致）。形状校验的权威在提交期（OwnershipPayload），
 * 这里只做防御性收口。
 */
function ownershipOfPayload(payload: unknown): MetricOwnership | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const raw = payload as Record<string, unknown>
  const own: MetricOwnership = {}
  if (typeof raw.entity === 'string' && raw.entity !== '') own.entity = raw.entity
  if (Array.isArray(raw.synonyms)) own.synonyms = raw.synonyms.filter((s): s is string => typeof s === 'string')
  if (typeof raw.ownerDept === 'string' && raw.ownerDept !== '') own.ownerDept = raw.ownerDept
  if (typeof raw.variantNote === 'string' && raw.variantNote !== '') own.variantNote = raw.variantNote
  return Object.keys(own).length > 0 ? own : undefined
}

/**
 * 决策串行闸（P1 Task 4，销缓办⑥）：同一张单的 adopt 与 reject 全程共用一把
 * **session 级** advisory lock（键 = `hashtext(org || ':mc:' || 变更单 id)`——两张裁决争的是
 * 同一张单，org 隔离即键隔离）。为什么不用 `pg_advisory_xact_lock`：adopt/reject **不在单一
 * 事务里**（adopt 是「域写各自 withTx 开自己的连接 → 再 CAS 翻状态」的两段式，reject 是裸
 * UPDATE）——xact 锁随调用方事务结束即放，罩不住「域写已提交、CAS 未翻状态」的竞态窗口。
 * 所以用独立连接持 session 锁排队，`pg_advisory_unlock` 放在 finally（fn 抛错也必放锁）。
 * 域写在锁内调用不冲突：它们开自己的连接，advisory lock 只是排队闸、不是数据锁。
 * 锁内顺序：getChange 校验 → 域写 → CAS 翻状态 → 解锁；并发后到者看到终态 ⇒
 * false / 409 CHANGE_STATE_CHANGED——消灭「写已生效但单据被驳回」的审计混淆形态。
 */
async function withDecisionLock<T>(pool: Pool, org: string, id: number, fn: () => Promise<T>): Promise<T> {
  const key = `${org}:mc:${id}`
  const client = await pool.connect()
  try {
    await client.query('select pg_advisory_lock(hashtext($1))', [key])
    try {
      return await fn()
    } finally {
      await client.query('select pg_advisory_unlock(hashtext($1))', [key])
    }
  } finally {
    client.release()
  }
}

/**
 * 采纳：preview_ready 才可；按 kind 分发到既有唯一编译点（本函数不自造第二条写路径）。
 * 写成功后才翻状态（CAS）；被并发抢先 ⇒ 409 CHANGE_STATE_CHANGED。
 * 注意：生效写本身幂等（upsert/meta 幂等；delete 重试会 404 如实返回）——
 * 真正要防的是「同一单被吃两次」：决策锁（withDecisionLock）把同一张单的 adopt/reject
 * 串行化（P1 Task 4），CAS 仍是锁内的最后一道自查。
 */
export async function adoptChange(deps: MetricWriteDeps, org: string, id: number): Promise<DecideOutcome> {
  return withDecisionLock(deps.pool, org, id, async (): Promise<DecideOutcome> => {
    const cur = await getChange(deps.pool, org, id)
    if (cur === null) return { ok: false, http: 404, error: 'NOT_FOUND' }
    // 两种 409 语义分开：已决/离场 = 状态被并发或先前裁决改变（CAS 输了）；
    // draft/preview_failed = 还没试算好，没有可采纳的快照凭据。
    if (DECIDED_STATUSES.includes(cur.status)) return { ok: false, http: 409, error: 'CHANGE_STATE_CHANGED' }
    if (cur.status !== 'preview_ready') return { ok: false, http: 409, error: 'PREVIEW_UNAVAILABLE' }

    let out: MetricWriteOutcome
    if (cur.kind === 'create' || cur.kind === 'update') {
      // 归属随单透传（P1 Task 3，spec §5.1）：payload 顶层的 entity/synonyms/ownerDept/variantNote
      // 不进声明（L2DeclarationBody 不动），经 opts.ownership 落到行上；缺席键 = 保留行上既有值。
      try {
        out = await writeL2Declaration(deps, org, cur.metricId, cur.payload as unknown as L2Declaration,
          { ownership: ownershipOfPayload(cur.payload) })
      } catch (e) {
        // Task 3 评审转入（P1 Task 4 顺带）：submit→adopt 的窗口被并发占名 ⇒ upsert 撞
        // metrics_title_per_dept_uq 的 23505。映射 409 TITLE_EXISTS_IN_DEPT（与提交期同名判据
        // 同码同义），别裸 500。只捕 23505：(org,id) 主键已被 upsert 冲突分支吃掉，能到这里
        // 的 23505 只有 title 唯一索引；其余错误照抛。
        if ((e as { code?: string }).code === '23505') {
          return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
        }
        throw e
      }
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
    } else if (cur.kind === 'override') {
      // override 档采纳（P1 Task 7）：复用 W8 写路径 createOverrideDeclaration（**不造第二条
      // 写路径**），outcome 形态与 MetricWriteOutcome 同构、错误原样透传（DECLARATION_INVALID /
      // GRAIN_MISMATCH / SCOPE_DOWNGRADE / OVERRIDE_EXISTS…）。warehouse 随 deps 透传（列检查 +
      // EXPLAIN；缺省跳过，与 routes/metrics.ts 的 override 端点同款布线）。
      // 采纳 = 在租户桶立**草稿**覆盖行（certified='draft'）；确认启用仍走既有 W8 confirm 流
      // （POST /metrics/:id/override/confirm）——生效时点不变，采纳只是把提案落成草稿。
      const o = await createOverrideDeclaration(
        { pool: deps.pool, ...(deps.warehouse === undefined ? {} : { warehouse: deps.warehouse }) },
        org, deps.requester, cur.metricId, cur.payload,
      )
      out = o.ok ? { ok: true } : o
    } else {
      // kind = 'delete'
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
  })
}

/**
 * 驳回：必填原因（trim 后非空、≤500 字），任何未决态（draft/preview_ready/preview_failed）都可驳——
 * 「没试算完就看出不对」是合法驳回路径。已决/离场单不吃第二次驳回（WHERE 钉 PENDING_STATUSES）。
 * 与 adoptChange 同锁（P1 Task 4，销缓办⑥）：并发 adopt/reject 串行，后到者看到终态 ⇒ false。
 */
export async function rejectChange(pool: Pool, org: string, id: number, reviewerId: string, reason: string): Promise<boolean> {
  if (reason.trim() === '' || reason.length > 500) return false
  return withDecisionLock(pool, org, id, async () => {
    const r = await pool.query(
      `update data.metric_change set status = 'rejected', decided_by = $3, decided_at = now(), reject_reason = $4
        where org = $1 and id = $2 and status = any($5)`,
      [org, id, reviewerId, reason.trim(), PENDING_STATUSES],
    )
    return (r.rowCount ?? 0) > 0
  })
}
