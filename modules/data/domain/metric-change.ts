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
import { createOverrideDeclaration, createTenantDeclaration } from './tenant-declaration-write'
import type { TenantDeclarationOutcome } from './tenant-declaration-write'
import { loadPlatformCatalog } from './metric-store'
import type { MetricOwnership } from './metric-store'
import { assertConcept, assertTitleFree, OwnershipError } from './metric-ownership'
import type { PreviewSnapshot } from './metric-change-preview'

/** override 档 P1 Task 7 接入；declaration 档 P5 Task 1 恢复（048 迁移扩 CHECK）。 */
export type ChangeKind = 'create' | 'update' | 'meta' | 'delete' | 'override' | 'declaration'
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
      | 'NOT_FOUND'
      // P4 收口（2026-11-13）：id 级/档级判据在**提交期**收口（与写域同码）——
      //   · 撞 L1 保留 id / delete 平台口径 / declared 行不可结构化编辑 / column_agg 跨档；
      //   · delete 不存在的 id ⇒ 404 METRIC_NOT_FOUND（不再落 preview_failed 死单）。
      // 原先只有 MCP 两把旧工具内联这套预检，REST /metric-changes 与 submit_metric_change 可绕过。
      | 'ID_RESERVED_BY_L1' | 'READONLY_L1' | 'DECLARED_NOT_EDITABLE' | 'BASIS_CONFLICT'
      | 'METRIC_NOT_FOUND' }

const MetaPayload = z.object({
  bizDescription: z.string().max(500).optional(),
  unit: z.string().max(32).optional(),
  caliberNote: z.string().max(500).optional(),
}).strict()

/**
 * delete 档 payload（下线提案尾波，2026-11-14）：空对象，或只含可选 `reason`（1–500 字）。
 * reason 是**人面展示文案**——job 提单时写「连续 N 天 0 次使用（报表引用已排除）」，给待核对页
 * 的人看出处；执行器 `deleteMetricDeclaration` **不读** payload，reason 永不进执行路径。
 * strict 闭集：旧判据「任何键都拒」收窄成「只认 reason」——给提案留出处，不给自由载荷开口子。
 */
const DeletePayload = z.object({ reason: z.string().min(1).max(500).optional() }).strict()

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
  // 泄露策略（P6 Task 4）：声明 entry 里没有这个形状（编译器不认）；它是**行属性**，随
  // payload 顶层单独解出、采纳时落列。放这里只为让非法值在提交期就 400（passthrough 不会校验）。
  reveal: z.enum(['panel', 'report']).optional(),
}).passthrough()

/**
 * declaration 档 payload 的**宽预检**（P5 Task 1）：payload = W8 全量声明 entry（与
 * `POST /metrics/declarations` 的 `declaration` 同形同源，故 passthrough 放行其余字段）。
 * 只拦形状级必填（name/label/definition/expression/grain；name 必须等于 metricId——id 就是
 * 声明名）；深校验（YAML 尺/关系白名单/实体/tier/列存在性）全在试算与采纳期共用的
 * `compileNewDeclaration` / `createTenantDeclaration`——第二份深校验就是第二事实源，不复制。
 */
const DeclarationPayload = z.object({
  name: z.string().min(1),
  label: z.string().min(1),
  definition: z.string().min(1),
  expression: z.string().min(1),
  grain: z.array(z.string().min(1)).min(1),
  // 泄露策略（P6 Task 4）：同 OverridePayload——行属性，不是声明形状；这里只为提交期拒非法值。
  reveal: z.enum(['panel', 'report']).optional(),
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
  // 泄露策略（P6 Task 4）：行属性，与归属同栖 payload 顶层；闭集与列 CHECK 一致
  // （zod 是提交期第一道，DB CHECK 是采纳期兜底——历史单/手改行可能绕过这里）。
  reveal: z.enum(['panel', 'report']).optional(),
}).strict()

/** payload 顶层归属键（与 OwnershipPayload 逐字同集——多一个键都不算归属键）。 */
const OWNERSHIP_KEYS: ReadonlySet<string> = new Set(['entity', 'synonyms', 'ownerDept', 'variantNote', 'reveal'])

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

/** 该 id 是否属于平台词表（L1）。判据与 metric-write 的 isL1Id 同源：`loadPlatformCatalog`。 */
const isPlatformIdOf = async (pool: Pool, id: string): Promise<boolean> =>
  (await loadPlatformCatalog(pool)).some((m) => m.id === id)

/**
 * 提交期 fail-early 预检（P4 收口，2026-11-13）：**所有提交面共用这一份**。
 *
 * 为什么必须在提交期拒：试算只编译 payload，不看 id 也不看既有行档位——放过 L1 保留 id
 * 会得到 preview_ready 的**绿单**（采纳才 409），declared / column_agg 行的单同样绿单后
 * 死在采纳期。这些都是**立单前**就能判定的，不该让人在队列里白点一次。
 *
 * 与写域的码保持一致（ID_RESERVED_BY_L1 / READONLY_L1 / DECLARED_NOT_EDITABLE /
 * BASIS_CONFLICT）；HTTP 状态按「提交期校验」取 400（不是生效写的 409）——变更单**没落**，
 * 调用方改入参重提即可。delete 的「行不存在」是 404 METRIC_NOT_FOUND（fail-early 的廉价闸）。
 *
 * `override` 档的 NOT_FOUND 判据在下方自己的块里（它只收 L1 id），不在这里重复。
 *
 * ⚠️ **creator 判据不在这里**（P6 Task 2 修复轮）：提交人 ≠ 采纳人（agent 提案、人决策），
 * 且真正决定写入的是**采纳人**（会话里持 data:manage 的人）。提交期按提交人预判 creator
 * 必然错位（示例：agent 的 PAT 无 manage、人采纳有 manage）⇒ creator 判据只在**采纳期**
 * 由域层（`metric-write.ts` 的 creator ∪ data:manage 门）判。
 */
async function precheckOf(pool: Pool, org: string, metricId: string, kind: ChangeKind): Promise<SubmitOutcome | null> {
  if (kind === 'declaration') {
    // P5 Task 1：声明是**新建**（无基底、无 upsert 语义）——撞平台保留 id 与 create 同判据，
    // 本 org 已有同 id 行（含 declared / column_agg）在采纳期必然 ID_EXISTS，都是立单前就能
    // 判定的死单 ⇒ 提交期就拒（与 P4 收口同一条「别让人在队列里白点一次」）。
    // ⚠️ 本守卫只看 **DB 目录**（已物化的 L1）：YAML-only、尚未物化的 L1 id 会放过这里，
    // 在试算期才被 compileNewDeclaration 的 YAML 尺拒成 preview_failed（单可见可驳回）；
    // 一旦该 id 物化进 DB，下一次提交就由本目录拦下。
    if (await isPlatformIdOf(pool, metricId)) return { ok: false, http: 400, error: 'ID_RESERVED_BY_L1' }
    const exists = await pool.query('select 1 from data.metrics where org = $1 and id = $2', [org, metricId])
    if ((exists.rowCount ?? 0) > 0) return { ok: false, http: 400, error: 'METRIC_ID_EXISTS' }
    return null
  }
  if (kind === 'create' || kind === 'update') {
    if (await isPlatformIdOf(pool, metricId)) return { ok: false, http: 400, error: 'ID_RESERVED_BY_L1' }
    const cur = await pool.query(
      "select basis from data.metrics where org = $1 and id = $2 and source = 'l2'", [org, metricId])
    const basis = cur.rows[0]?.basis as string | undefined
    // 租户全额声明（W8）不走 L2 结构化编辑：编辑 = 删除后重建（与 metric-write 同判据）。
    if (basis === 'declared') return { ok: false, http: 400, error: 'DECLARED_NOT_EDITABLE' }
    // 私有测度（column_agg）同款：树形写会翻档 ⇒ 与写域 BASIS_CONFLICT 同码。
    if (basis === 'column_agg') return { ok: false, http: 400, error: 'BASIS_CONFLICT' }
    // create 撞已存在行的错因是 METRIC_ID_EXISTS（下方 create 分支），**有意偏离** brief 里
    // 「create 也判 creator」的字面：谁建的都不影响「这个 id 已存在」这个事实，而 ID_EXISTS
    // 比 NOT_METRIC_CREATOR 更准确、也可自助修（换 id）。
    return null
  }
  if (kind === 'delete') {
    // 顺序与 deleteMetricDeclaration 同款：**先看本租户 L2 行，删不到才判 L1**——
    // 「租户先建 L2、平台事后同 id 物化」是合法时序；先判 L1 会让可删的行恒 READONLY_L1。
    const tenant = await pool.query(
      "select 1 from data.metrics where org = $1 and id = $2 and source = 'l2'", [org, metricId])
    if ((tenant.rowCount ?? 0) > 0) return null
    if (await isPlatformIdOf(pool, metricId)) return { ok: false, http: 400, error: 'READONLY_L1' }
    // 不存在的 id：立单只会得到 preview_failed + METRIC_NOT_FOUND 的死单 ⇒ 提交期就直接 404。
    return { ok: false, http: 404, error: 'METRIC_NOT_FOUND' }
  }
  return null
}

export async function submitChange(
  pool: Pool, org: string, submitter: { userId: string; channel: string },
  metricId: string, kind: ChangeKind, payload: unknown,
): Promise<SubmitOutcome> {
  if (metricId.trim() === '' || metricId.length > 128) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  // id 级/档级预检先于形状校验：与 MCP 旧内联预检的「提交即拒」顺序一致（错因更准）。
  const pre = await precheckOf(pool, org, metricId, kind)
  if (pre !== null) return pre
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
  //    （compileTenantDeclaration：label 空 ⇒ 回落 name），桶恒 null（fix2 裁定，见下方注释）。
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
    // 同名判据桶**恒 null**（P1 Task 7 fix2 裁定）：覆盖行经 insertTenantDeclaration 落库时
    // owner_dept 恒为 null（列清单不含它）——判据桶必须与落库桶**同构**，否则 payload 带
    // ownerDept 时就是「判据查 A 桶、行落 null 桶」的假拒/假放。把 owner_dept 管道接进
    // insertTenantDeclaration 是 P2 可见性波的活；在那之前 payload.ownerDept 不作桶参数
    //（概念归属 assertConcept 照旧按 payload.entity 判）。
    try {
      await assertTitleFree(pool, org, null, title)
    } catch (e) {
      if (e instanceof OwnershipError) return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
      throw e
    }
  }
  // declaration 档（P5 Task 1）：宽预检（必填五键 + name==metricId）；深校验交给试算/采纳期
  // 与写路径共用的编译尺。metricId 就是声明名（entry.name）——不一致时 payload 会写到另一个
  // id 上，直接在提交期拒。
  if (kind === 'declaration') {
    const parsed = DeclarationPayload.safeParse(payload)
    if (!parsed.success || parsed.data.name !== metricId) {
      return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
    }
    // 部门内同名互斥在**提交期**收口（P5 修复轮）：与 override 档同一把尺。
    // 桶恒 null 与落库桶同构——insertTenantDeclaration 的列清单不含 owner_dept（override 档
    // 已证明同构），判据若吃别的桶就是「查 A 桶、落 null 桶」的假拒/假放。
    // 生效 title 的取法与编译点同式（compileTenantDeclaration：label 空 ⇒ 回落 name）；
    // 形状闸已保证 label 是非空串，trim 后为空（纯空白）才回落 name。
    const label = parsed.data.label.trim()
    const title = label !== '' ? label : metricId
    try {
      await assertTitleFree(pool, org, null, title)
    } catch (e) {
      if (e instanceof OwnershipError) return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
      throw e
    }
  }
  const meta = kind === 'meta' ? MetaPayload.safeParse(payload) : null
  if (kind === 'meta' && (meta === null || !meta.success || metaAllKeysAbsent(meta.data))) {
    return { ok: false, http: 400, error: 'INVALID_META' }
  }
  // delete 档 payload：空对象或 {reason?}（DeletePayload 头注）；null/缺席归一为空对象，
  // 其余形状（标量/数组/未知键）一律 400——下线提案的 payload 必须可解释。
  if (kind === 'delete') {
    const parsed = DeletePayload.safeParse(payload ?? {})
    if (!parsed.success) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
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
 * `payload.reveal` 形状非法（非字符串；null/number/bool/对象）。
 * 提交期由 zod 闭集挡；采纳期遇到手改单/历史单必须**响亮**（400），不得静默忽略——
 * 静默忽略会让「想设 report 的治理动作」变成一次无声的 panel 写。
 */
class InvalidRevealError extends Error {}

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
  // 泄露策略（P6 Task 4）：类型**必须**是字符串——非字符串不静默丢弃（那会把治理动作变成
  // 无声的 panel 写）；闭集之外的字符串留给列 CHECK 兜底（23514 ⇒ adopt 映射 400）。
  if (raw.reveal !== undefined) {
    if (typeof raw.reveal !== 'string') throw new InvalidRevealError('reveal 必须是字符串')
    own.reveal = raw.reveal as NonNullable<MetricOwnership['reveal']>
  }
  return Object.keys(own).length > 0 ? own : undefined
}

/**
 * declaration / override 档的 payload 就是 W8 声明 entry（宽形状）——`reveal` 与
 * create/update 档一样是**行属性**、同栖顶层，但这两档不经过 `MetricOwnership`（它们走
 * insertTenantDeclaration），故单独解出。类型收口与兜底语义同 `ownershipOfPayload`。
 */
function revealOfPayload(payload: unknown): NonNullable<MetricOwnership['reveal']> | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const v = (payload as Record<string, unknown>).reveal
  if (v === undefined) return undefined
  if (typeof v !== 'string') throw new InvalidRevealError('reveal 必须是字符串')
  return v as NonNullable<MetricOwnership['reveal']>
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
      // `reveal`（P6 Task 4）同理同栖归属包（它是行属性，不是声明形状）。
      try {
        out = await writeL2Declaration(deps, org, cur.metricId, cur.payload as unknown as L2Declaration,
          { ownership: ownershipOfPayload(cur.payload) })
      } catch (e) {
        // 非法 reveal 形状（P6 Task 4 修复轮）：提交期 zod 已挡，手改单/历史单在这里响亮拒。
        if (e instanceof InvalidRevealError) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
        // Task 3 评审转入（P1 Task 4 顺带）：submit→adopt 的窗口被并发占名 ⇒ upsert 撞
        // metrics_title_per_dept_uq 的 23505。映射 409 TITLE_EXISTS_IN_DEPT（与提交期同名判据
        // 同码同义），别裸 500。只捕 23505：(org,id) 主键已被 upsert 冲突分支吃掉，能到这里
        // 的 23505 只有 title 唯一索引；其余错误照抛。
        if ((e as { code?: string }).code === '23505') {
          return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
        }
        // 列 CHECK 兜底（P6 Task 4，reveal 闭集）：绕过提交期 zod 的历史单/手改单会在这里
        // 撞 23514。调用方能修的是入参 ⇒ 400（不是裸 500）；单据保持 preview_ready 可重提。
        if ((e as { code?: string }).code === '23514') {
          return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
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
      let o: TenantDeclarationOutcome
      try {
        o = await createOverrideDeclaration(
          { pool: deps.pool, ...(deps.warehouse === undefined ? {} : { warehouse: deps.warehouse }) },
          org, deps.requester, cur.metricId, cur.payload,
          { reveal: revealOfPayload(cur.payload) },
        )
      } catch (e) {
        // 非法 reveal 形状（P6 Task 4 修复轮）：同 create/update 支。
        if (e instanceof InvalidRevealError) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
        // 与 create/update 支同款映射（Task 4 引入，fix2 补齐 override 支）：submit→adopt 的
        // 窗口被并发占名 ⇒ insertTenantDeclaration 撞 metrics_title_per_dept_uq 的 23505
        //（on conflict (org, id) 只吸收 id 冲突，title 唯一索引会真抛出来）。映射 409
        // TITLE_EXISTS_IN_DEPT（与提交期同名判据同码同义），别裸 500。只捕 23505，其余照抛：
        // (org,id) 主键冲突已被 on conflict do nothing 吃掉（返回 false ⇒ 409 OVERRIDE_EXISTS），
        // 能到这里的 23505 实际只有 title 唯一索引一条路。
        if ((e as { code?: string }).code === '23505') {
          return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
        }
        // 列 CHECK 兜底（P6 Task 4，reveal 闭集）⇒ 400，见 create/update 支同款映射。
        if ((e as { code?: string }).code === '23514') {
          return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
        }
        throw e
      }
      out = o.ok ? { ok: true } : o
    } else if (cur.kind === 'declaration') {
      // declaration 档采纳（P5 Task 1）：复用 W8 唯一写路径 createTenantDeclaration（**不造第二条
      // 写路径**），成功即 `basis='declared'` 直接生效——与 create/update 档一致，不经草稿/确认
      // 两步（覆盖档才有 draft→confirm 语义）。warehouse 随 deps 透传（列检查 + EXPLAIN）。
      let o: TenantDeclarationOutcome
      try {
        o = await createTenantDeclaration(
          { pool: deps.pool, ...(deps.warehouse === undefined ? {} : { warehouse: deps.warehouse }) },
          org, deps.requester, cur.payload,
          { reveal: revealOfPayload(cur.payload) },
        )
      } catch (e) {
        // 非法 reveal 形状（P6 Task 4 修复轮）：同 create/update 支。
        if (e instanceof InvalidRevealError) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
        // submit→adopt 窗口被并发占名 ⇒ insertTenantDeclaration 撞 metrics_title_per_dept_uq
        // 的 23505（on conflict (org,id) 只吸收 id 冲突）。映射 409 TITLE_EXISTS_IN_DEPT
        //（与其它档同码同义），别裸 500；只捕 23505，其余照抛。
        if ((e as { code?: string }).code === '23505') {
          return { ok: false, http: 409, error: 'TITLE_EXISTS_IN_DEPT' }
        }
        // 列 CHECK 兜底（P6 Task 4，reveal 闭集）⇒ 400，见 create/update 支同款映射。
        if ((e as { code?: string }).code === '23514') {
          return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
        }
        throw e
      }
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
