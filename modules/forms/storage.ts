// storage.ts — forms 内核的 SQL 封装（issue #710）。
// 薄封装纪律：DB 函数的错误**原样上抛**（触发器拒绝信息带版本号与 kind，PoC RESULTS §5
// 排障口径）；应用层只补两处——契约校验（domain/contract）与 FormsError 机检错误码。
// 主体（org）一律来自调用方传入的 identity.orgId，本层绝不读请求。
import type { Pool } from 'pg'
import type { OrganizationPort } from '@platform/sdk'
import { dictRefs, schemaOf, validateSubmission } from './domain/contract'
import { validateApprovalBody } from './domain/approval'
import type { ApprovalBody } from './domain/approval'
import { compilePlan } from './domain/approval-compile'
import type { EngineResolver } from './domain/engine-client'
import { FormsError } from './domain/errors'

/** 机检错误码载体：routes 按 code 映射 HTTP 状态与文案，不解析 message。
 *  （定义在 domain/errors.ts——storage 与审批编译/引擎 client 都要抛它，放在这里会成环。
 *   这里 re-export 保持既有 `import { FormsError } from './storage'` 调用点不变。） */
export { FormsError }

/** 受管资产 kind（forms.kind 的已注册值）。默认 form_def ⇒ 既有调用方零改动。 */
export type FormsKind = 'form_def' | 'approval_def'

const DEFAULT_KIND: FormsKind = 'form_def'
/** 收集类（指派/催办/出湖）只看 form_def —— 审批模板不是收集表单，别把它们拖进收集链路。 */
const COLLECTION_KIND: FormsKind = 'form_def'

// ── 审计（事项平台：谁在什么时候动了什么；表单/审批共用一张表） ──

/**
 * 写一条 `forms.audit`（只记**已发生的事实**：动作 + 目标 + 细节）。
 * 走 pool 直发 ⇒ **不参与调用方事务**：调用方在业务写成功之后调，审计失败不掩盖业务结果。
 * 若某条通路要求审计与业务写入同生共死，由调用方在自己的 client/事务里写，别从这里借。
 */
export async function audit(
  pool: Pool, org: string, actor: string, action: string, target: string | null, detail: unknown,
): Promise<void> {
  await pool.query(
    `insert into forms.audit (org, actor, action, target, detail) values ($1,$2,$3,$4,$5::jsonb)`,
    [org, actor, action, target, JSON.stringify(detail ?? {})],
  )
}

// ── 生命周期（org 维度全部显式入参；kind 为可选尾参，缺省 form_def） ──

export async function newDraft(
  pool: Pool, org: string, assetId: string, body: unknown, actor: string, kind: FormsKind = DEFAULT_KIND,
): Promise<number> {
  const { rows } = await pool.query('select forms.new_draft($1,$2,$3,$4,$5) v', [
    org, kind, assetId, JSON.stringify(body ?? null), actor,
  ])
  return rows[0].v
}

export async function updateDraft(
  pool: Pool, org: string, assetId: string, version: number, body: unknown, kind: FormsKind = DEFAULT_KIND,
): Promise<void> {
  await pool.query('select forms.update_draft($1,$2,$3,$4,$5)', [
    org, kind, assetId, version, JSON.stringify(body ?? null),
  ])
}

export async function dropDraft(
  pool: Pool, org: string, assetId: string, version: number, kind: FormsKind = DEFAULT_KIND,
): Promise<void> {
  await pool.query('select forms.drop_draft($1,$2,$3,$4)', [org, kind, assetId, version])
}

/** 发布：API 层已按 scope 把住人 gate（forms:publish）；actorRole 固定 'human'——
 *  会话身份即人；AI 工具面将来走 manage 不走 publish，DB 策略分支保持双保险。 */
export async function publish(
  pool: Pool, org: string, assetId: string, version: number, actor: string, kind: FormsKind = DEFAULT_KIND,
): Promise<void> {
  await pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [org, kind, assetId, version, actor, 'human'])
}

export async function rollbackTo(
  pool: Pool, org: string, assetId: string, version: number, kind: FormsKind = DEFAULT_KIND,
): Promise<void> {
  await pool.query('select forms.rollback_to($1,$2,$3,$4)', [org, kind, assetId, version])
}

export async function retire(
  pool: Pool, org: string, assetId: string, version: number, kind: FormsKind = DEFAULT_KIND,
): Promise<void> {
  await pool.query('select forms.retire($1,$2,$3,$4)', [org, kind, assetId, version])
}

export async function headVersion(
  pool: Pool, org: string, assetId: string, kind: FormsKind = DEFAULT_KIND,
): Promise<number | null> {
  const { rows } = await pool.query(
    'select active_version from forms.asset_head where org=$1 and kind=$2 and asset_id=$3',
    [org, kind, assetId],
  )
  return rows[0]?.active_version ?? null
}

export async function bodyAt(
  pool: Pool, org: string, assetId: string, version: number, kind: FormsKind = DEFAULT_KIND,
): Promise<object | null> {
  const { rows } = await pool.query('select forms.body_at($1,$2,$3,$4) body', [org, kind, assetId, version])
  return rows[0]?.body ?? null
}

/**
 * §2.4「指派与催办」：跨租户列出**当前活跃版本**、且**契约含 assignees 声明**的已发布表单
 * （供 `scripts/notify-reconcile` 对账）。活跃版本 = `asset_head.active_version`（回滚即改此行）——
 * 与正典「以当前 published 版本为准」口径一致。`body ? 'assignees'`（jsonb 键存在）在 SQL 侧先筛，
 * 避免把全量已发布表单拖进脚本；脚本内 `parseAssignment` 是第二道守卫。
 * ⚠️ 这是**唯一**一个不带 org 入参的读函数：调用方是 scripts/（不在 B1 扫描根内），它按租户逐条处理，
 * 每次 emit 仍显式带该行的 org（不读请求参数）。
 */
export async function listAssignmentTargets(pool: Pool): Promise<Array<{
  org: string; assetId: string; version: number; publishedAt: string; body: unknown
}>> {
  const { rows } = await pool.query(
    `select v.org, v.asset_id, v.version, v.published_at, v.body
       from forms.asset_version v
       join forms.asset_head h
         on h.org = v.org and h.kind = v.kind and h.asset_id = v.asset_id and h.active_version = v.version
      where v.kind = $1 and v.status = 'published' and v.body ? 'assignees'`,
    [COLLECTION_KIND],
  )
  return rows.map((r) => ({
    org: r.org, assetId: r.asset_id, version: r.version, publishedAt: r.published_at, body: r.body,
  }))
}

/** 该资产在本租户下是否已有任何版本（AI 起草重名时据此拒，**不覆盖**）。 */
export async function assetExists(
  pool: Pool, org: string, assetId: string, kind: FormsKind = DEFAULT_KIND,
): Promise<boolean> {
  const { rows } = await pool.query(
    'select 1 from forms.asset_version where org=$1 and kind=$2 and asset_id=$3 limit 1',
    [org, kind, assetId],
  )
  return rows.length > 0
}

// ── MCP 审计（2026-11-16 能力网关 spec §6.5） ──

export type McpAuditOutcome = 'ok' | 'denied' | 'error'

/**
 * 每次 MCP tools/call 落一行（org/userId 由调用方从 identity 传入）。
 * `params` = 本次调用的完整入参（spec §6.5「args 摘要」，与 data.query_audit 同口径——
 * 含 generate_form_draft 的 description，供事后复核 agent 到底让平台生成了什么）。
 * ⚠️ 调用方负责「审计失败不改变业务结果」：本函数**原样上抛**，由 callTool 的
 * try/catch 吞掉并告警（与 storage 的「错误原样上抛」纪律一致，不在本层静默）。
 */
export async function writeMcpAudit(
  pool: Pool,
  org: string,
  userId: string,
  tool: string,
  outcome: McpAuditOutcome,
  reason: string | null,
  params: Record<string, unknown>,
  assetId?: string | null,
  version?: number | null,
): Promise<void> {
  await pool.query(
    `insert into forms.mcp_audit (org, user_id, tool, outcome, reason, params, asset_id, version)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
    [org, userId, tool, outcome, reason, JSON.stringify(params), assetId ?? null, version ?? null],
  )
}

export interface VersionRow {
  version: number
  status: string
  createdBy: string
  publishedBy: string | null
  createdAt: Date
  publishedAt: Date | null
  retiredAt: Date | null
  body: unknown
}

export async function listVersions(
  pool: Pool, org: string, assetId: string, kind: FormsKind = DEFAULT_KIND,
): Promise<VersionRow[]> {
  const { rows } = await pool.query(
    `select version, status, created_by, published_by, created_at, published_at, retired_at, body
       from forms.asset_version
      where org=$1 and kind=$2 and asset_id=$3
      order by version desc`,
    [org, kind, assetId],
  )
  return rows.map((r) => ({
    version: r.version, status: r.status, createdBy: r.created_by, publishedBy: r.published_by,
    createdAt: r.created_at, publishedAt: r.published_at, retiredAt: r.retired_at, body: r.body,
  }))
}

export interface DefSummaryRow {
  assetId: string
  headVersion: number | null
  draftCount: number
  publishedCount: number
  retiredCount: number
  updatedAt: Date
}

export async function listDefs(
  pool: Pool, org: string, kind: FormsKind = DEFAULT_KIND,
): Promise<DefSummaryRow[]> {
  const { rows } = await pool.query(
    `select v.asset_id,
            h.active_version as head_version,
            count(*) filter (where v.status='draft')::int     as draft_count,
            count(*) filter (where v.status='published')::int as published_count,
            count(*) filter (where v.status='retired')::int   as retired_count,
            max(v.created_at)                                 as updated_at
       from forms.asset_version v
       left join forms.asset_head h
         on h.org=v.org and h.kind=v.kind and h.asset_id=v.asset_id
      where v.org=$1 and v.kind=$2
      group by v.asset_id, h.active_version
      order by max(v.created_at) desc`,
    [org, kind],
  )
  return rows.map((r) => ({
    assetId: r.asset_id, headVersion: r.head_version, draftCount: r.draft_count,
    publishedCount: r.published_count, retiredCount: r.retired_count, updatedAt: r.updated_at,
  }))
}

// ── 提交（先按 head 契约校验，再钉版本入库） ──

/** 契约五道闸的共用实现（收集提交与审批事项提共用同一把尺子）。
 *  预载契约引用的生效 key 集——validateSubmission 的 dictLookup 是同步接口，先 await 预载。 */
async function validateAgainstContract(
  pool: Pool, org: string, body: unknown, payload: unknown,
): Promise<void> {
  const schema = schemaOf(body)
  if (schema === null) throw new FormsError('CONTRACT_MALFORMED', '发布版本的契约缺 schema')
  const cache = await activeKeysByRef(pool, org, schema)
  const result = validateSubmission({ schema, payload, dictLookup: (ref) => cache.get(ref) ?? new Set() })
  if (!result.ok) throw new FormsError(result.code, result.detail)
}

export interface SubmissionRow {
  id: string
  assetId: string
  version: number
  payload: unknown
  submittedBy: string
  submittedAt: Date
}

/** 提交 = 按「提交将钉住的版本」（head）预载字典生效集 → 契约五道闸 → forms.submit
 *  （触发器复核 head：校验与写入之间 head 被切走时**保守拒绝**，绝不出现
 *  「按旧契约校验、新契约入库」的窗口）。
 *
 *  `kind` 只影响「读哪个资产的 head/body」。**契约五道闸只对 form_def 生效**：approval_def 的
 *  body 是审批 DSL（没有 `schema`），它的校验与入库走 `submitApproval`（编译计划 + 建 case，
 *  自带 `validateApprovalBody`），不从这里过。 */
export async function submit(
  pool: Pool, org: string, assetId: string, payload: unknown, userId: string, kind: FormsKind = DEFAULT_KIND,
): Promise<{ id: string; version: number }> {
  const version = await headVersion(pool, org, assetId, kind)
  if (version === null) throw new FormsError('NO_PUBLISHED_HEAD', '表单尚无发布版本，不能提交')
  const body = await bodyAt(pool, org, assetId, version, kind)
  if (body === null) throw new FormsError('NO_PUBLISHED_HEAD', '表单尚无发布版本，不能提交')
  if (kind === COLLECTION_KIND) {
    // 契约 body = {schema, uiSchema?}（#724 定案）；校验只吃 schema 那一半
    await validateAgainstContract(pool, org, body, payload)
  }

  try {
    const { rows } = await pool.query('select forms.submit($1,$2,$3,$4,$5) id', [
      org, kind, assetId, JSON.stringify(payload ?? null), userId,
    ])
    return { id: String(rows[0].id), version }
  } catch (e) {
    if (/submissions follow head only/.test((e as Error).message)) {
      throw new FormsError('HEAD_MOVED', '提交期间表单版本已切换，请重试')
    }
    throw e
  }
}

export async function getSubmission(pool: Pool, org: string, id: string): Promise<SubmissionRow | null> {
  const { rows } = await pool.query(
    `select id, asset_id, version, payload, submitted_by, submitted_at
       from forms.submission where org=$1 and id=$2::bigint`,
    [org, id],
  )
  if (rows.length === 0) return null
  const r = rows[0]
  return { id: String(r.id), assetId: r.asset_id, version: r.version, payload: r.payload, submittedBy: r.submitted_by, submittedAt: r.submitted_at }
}

export async function listSubmissions(
  pool: Pool, org: string, assetId: string, limit = 100, kind: FormsKind = DEFAULT_KIND,
): Promise<SubmissionRow[]> {
  const { rows } = await pool.query(
    `select id, asset_id, version, payload, submitted_by, submitted_at
       from forms.submission
      where org=$1 and kind=$2 and asset_id=$3
      order by submitted_at desc limit $4`,
    [org, kind, assetId, limit],
  )
  return rows.map((r) => ({ id: String(r.id), assetId: r.asset_id, version: r.version, payload: r.payload, submittedBy: r.submitted_by, submittedAt: r.submitted_at }))
}

// ── 导出面（出湖管线的「源」，M1.4 / #729） ──

export interface ExportRow {
  submission_id: string
  org: string
  form_def_id: string
  submitted_at: Date
  payload: unknown
}

/**
 * 按键集游标导出提交（`submission_id > afterId`，按 id 升序，最多 limit 行）。
 * - **水位用 id 不用 submitted_at**：id 单调无歧义，同秒并发提交不会撞出漏窗（人已裁定 #729）
 * - **org 由调用方从身份取**（PAT 跨租户已被宿主拒）⇒ 本函数只服务单租户
 * - 用 id 游标而非 offset：offset 在持续写入下会漂（漏行/重复行）
 */
export async function exportSubmissions(
  pool: Pool, org: string, afterId: number, limit: number,
): Promise<ExportRow[]> {
  const { rows } = await pool.query(
    `select id, org, asset_id, submitted_at, payload
       from forms.submission
      where org = $1 and id > $2
      order by id asc
      limit $3`,
    [org, afterId, limit],
  )
  return rows.map((r) => ({
    submission_id: String(r.id),
    org: r.org,
    form_def_id: r.asset_id,
    submitted_at: r.submitted_at,
    payload: r.payload,
  }))
}

// ── 字典（同名不同表：tenant → dict_item / global → dict_global_item，P4 分档） ──

export type DictScope = 'tenant' | 'global'

function dictTable(scope: DictScope): string {
  // 表名只来自本枚举，不进参数化位（pg 不参数化标识符）；值全部走 $n 占位
  return scope === 'tenant' ? 'forms.dict_item' : 'forms.dict_global_item'
}

export interface DictKeyRow {
  dictId: string
  key: string
  label: string
  sortNo: number
  enabled: boolean
  retiredAt: Date | null
}

export async function addDictKey(
  pool: Pool, scope: DictScope, org: string | null, dictId: string, key: string, label: string, actor: string, sortNo = 0,
): Promise<void> {
  if (scope === 'tenant') {
    await pool.query(
      `insert into forms.dict_item (org, dict_id, key, label, sort_no, created_by)
       values ($1, $2, $3, $4, $5::int, $6)
       on conflict (org, dict_id, key) do update
         set label = excluded.label, sort_no = excluded.sort_no, updated_at = now()`,
      [org, dictId, key, label, sortNo, actor],
    )
  } else {
    await pool.query(
      `insert into forms.dict_global_item (dict_id, key, label, sort_no, created_by)
       values ($1, $2, $3, $4::int, $5)
       on conflict (dict_id, key) do update
         set label = excluded.label, sort_no = excluded.sort_no, updated_at = now()`,
      [dictId, key, label, sortNo, actor],
    )
  }
}

export async function updateDictKey(
  pool: Pool, scope: DictScope, org: string | null, dictId: string, key: string,
  patch: { label?: string; sortNo?: number; enabled?: boolean },
): Promise<void> {
  // key 不可变由触发器兜底；本函数根本不接受 key 变更（patch 无 key 字段）。
  // 软删 = enabled=false + retired_at；恢复 = enabled=true + retired_at 清空（#710 实施期定）。
  const sets: string[] = ['updated_at = now()']
  const params: unknown[] = []
  if (patch.label !== undefined) { params.push(patch.label); sets.push(`label = $${params.length}`) }
  if (patch.sortNo !== undefined) { params.push(patch.sortNo); sets.push(`sort_no = $${params.length}::int`) }
  if (patch.enabled !== undefined) {
    params.push(patch.enabled); sets.push(`enabled = $${params.length}::boolean`)
    sets.push(patch.enabled ? 'retired_at = null' : 'retired_at = now()')
  }
  const whereParts: string[] = [`dict_id = $${params.length + 1}`, `key = $${params.length + 2}`]
  params.push(dictId, key)
  if (scope === 'tenant') { params.push(org); whereParts.push(`org = $${params.length}`) }
  const { rowCount } = await pool.query(
    `update ${dictTable(scope)} set ${sets.join(', ')} where ${whereParts.join(' and ')}`,
    params,
  )
  if (rowCount === 0) throw new FormsError('DICT_KEY_NOT_FOUND', `字典 ${dictId} 的 key "${key}" 不存在`)
}

/** 生效 options（enabled=true，按 sort_no, key 排序）——渲染与提交校验同一数据源。 */
export async function dictOptions(
  pool: Pool, scope: DictScope, org: string | null, dictId: string,
): Promise<Array<{ key: string; label: string; sortNo: number }>> {
  const params: unknown[] = [dictId]
  const orgCond = scope === 'tenant' ? 'and org = $2' : ''
  if (scope === 'tenant') params.push(org)
  const { rows } = await pool.query(
    `select key, label, sort_no from ${dictTable(scope)} where dict_id=$1 ${orgCond} and enabled = true order by sort_no, key`,
    params,
  )
  return rows.map((r) => ({ key: r.key, label: r.label, sortNo: r.sort_no }))
}

/** 渲染历史用：任意 key（含已退役）→ label + enabled 标记（正典：取已退役值渲染历史）。 */
export async function dictResolve(
  pool: Pool, scope: DictScope, org: string | null, dictId: string, keys: string[],
): Promise<Map<string, { label: string; enabled: boolean }>> {
  if (keys.length === 0) return new Map()
  const params: unknown[] = [dictId, keys]
  const orgCond = scope === 'tenant' ? 'and org = $3' : ''
  if (scope === 'tenant') params.push(org)
  const { rows } = await pool.query(
    `select key, label, enabled from ${dictTable(scope)} where dict_id=$1 and key = any($2) ${orgCond}`,
    params,
  )
  return new Map(rows.map((r) => [r.key, { label: r.label, enabled: r.enabled }]))
}

export async function listDicts(
  pool: Pool, scope: DictScope, org: string | null,
): Promise<Array<{ dictId: string; total: number; active: number }>> {
  const params: unknown[] = []
  const orgCond = scope === 'tenant' ? 'where org = $1' : ''
  if (scope === 'tenant') params.push(org)
  const { rows } = await pool.query(
    `select dict_id, count(*)::int total, count(*) filter (where enabled)::int active
       from ${dictTable(scope)} ${orgCond} group by dict_id order by dict_id`,
    params,
  )
  return rows.map((r) => ({ dictId: r.dict_id, total: r.total, active: r.active }))
}

/** 契约引用的生效 key 集（submit 预载通路用）：前缀决定查租户表还是全局表。 */
export async function activeKeysByRef(pool: Pool, org: string, schema: unknown): Promise<Map<string, Set<string>>> {
  const cache = new Map<string, Set<string>>()
  for (const ref of dictRefs(schema)) {
    const scope: DictScope = ref.startsWith('gdict:') ? 'global' : 'tenant'
    const dictId = ref.replace(/^(dict|gdict):/, '')
    const options = await dictOptions(pool, scope, scope === 'tenant' ? org : null, dictId)
    cache.set(ref, new Set(options.map((o) => o.key)))
  }
  return cache
}

// ════════════════════════════════════════════════════════════════════════════
// 审批（OA P1 / issue #2363）：提交 → 编译 → 建 case；回调/撤回的状态回写
// ════════════════════════════════════════════════════════════════════════════

const APPROVAL_ASSET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

export type ItemMode = 'approval' | 'collection' | 'collaboration'

/** 事项模板的 mode（缺省 collection——存量表单一律按收集类读，spec §6.1）。 */
export function itemModeOf(body: unknown): ItemMode {
  const m = (body as { mode?: unknown } | null)?.mode
  return m === 'approval' || m === 'collaboration' ? m : 'collection'
}

export interface ItemApprovalRef {
  id: string
  version: number
  provider: 'inapp'
}

/** 事项模板上的审批引用（mode=approval 才读；形状不对 ⇒ 明确报错，不猜版本）。 */
export function itemApprovalRefOf(body: unknown): ItemApprovalRef {
  const b = body as { approvalRef?: unknown; provider?: unknown } | null
  const ref = b?.approvalRef as { id?: unknown; version?: unknown } | undefined
  if (!ref || typeof ref.id !== 'string' || !APPROVAL_ASSET_ID_RE.test(ref.id)) {
    throw new FormsError('APPROVAL_REF_INVALID', 'mode=approval 需要 approvalRef.id（形如 leave）')
  }
  if (typeof ref.version !== 'number' || !Number.isInteger(ref.version) || ref.version < 1) {
    throw new FormsError('APPROVAL_REF_INVALID', 'approvalRef.version 必须是 >=1 的整数')
  }
  const provider = b?.provider ?? 'inapp'
  if (provider !== 'inapp') {
    // P1 只执行 inapp；wecom_native 走「绑定 + 深链 + 镜像」，不在本计划范围（P2）
    throw new FormsError('PROVIDER_UNSUPPORTED', `P1 只支持 inapp（当前 provider=${String(provider)}）`)
  }
  return { id: ref.id, version: ref.version, provider }
}

export async function assetVersionStatus(
  pool: Pool, org: string, kind: FormsKind, assetId: string, version: number,
): Promise<string | null> {
  const { rows } = await pool.query(
    'select status from forms.asset_version where org=$1 and kind=$2 and asset_id=$3 and version=$4',
    [org, kind, assetId, version],
  )
  return rows[0]?.status ?? null
}

export interface SubmitApprovalDeps {
  /** 组织查询面（未注入 ⇒ ORG_UNAVAILABLE；**不得**当成「没人」） */
  orgPort: OrganizationPort | null
  /** 租户 → 引擎 client（无映射 ⇒ 409 OA_NOT_ENABLED） */
  engineFor: EngineResolver
  /** 引擎侧标题（如「请假 - 张三」） */
  title: string
}

export interface ApprovalSubmitResult {
  id: string
  version: number
  caseId: string
  status: 'pending_approval'
}

/**
 * 审批事项提交：读事项模板 head → 读**钉住版本**的审批模板 → 校验 DSL → 编译计划
 * → 写 submission(pending_approval) → 建引擎 case → 回填 case_ref。
 *
 * 失败补偿：建 case 失败 ⇒ 该 submission 立即标 withdrawn 并写审计（**不留 pending 孤儿**：
 * 没有 case_ref 的 pending 行会让「待我审批」列表出现永远推不动的单）。
 * 顺序上先解析引擎配置再写库：无引擎映射时根本不该落行（OA_NOT_ENABLED 是 409，不是故障）。
 */
export async function submitApproval(
  pool: Pool, org: string, assetId: string, payload: unknown, userId: string, deps: SubmitApprovalDeps,
): Promise<ApprovalSubmitResult> {
  const version = await headVersion(pool, org, assetId, COLLECTION_KIND)
  if (version === null) throw new FormsError('NO_PUBLISHED_HEAD', '事项模板尚无发布版本，不能提交')
  const itemBody = await bodyAt(pool, org, assetId, version, COLLECTION_KIND)
  if (itemBody === null) throw new FormsError('NO_PUBLISHED_HEAD', '事项模板尚无发布版本，不能提交')
  if (itemModeOf(itemBody) !== 'approval') {
    throw new FormsError('NOT_APPROVAL_MODE', '当前事项模板不是 approval 模式')
  }
  const ref = itemApprovalRefOf(itemBody)
  const templateStatus = await assetVersionStatus(pool, org, 'approval_def', ref.id, ref.version)
  if (templateStatus === null) {
    throw new FormsError('APPROVAL_TEMPLATE_NOT_FOUND', `审批模板 ${ref.id} v${ref.version} 不存在`)
  }
  if (templateStatus !== 'published') {
    throw new FormsError('APPROVAL_TEMPLATE_NOT_PUBLISHED', `审批模板 ${ref.id} v${ref.version} 不是已发布（${templateStatus}）`)
  }
  const approvalBodyRaw = await bodyAt(pool, org, ref.id, ref.version, 'approval_def')
  if (approvalBodyRaw === null) {
    throw new FormsError('APPROVAL_TEMPLATE_NOT_FOUND', `审批模板 ${ref.id} v${ref.version} 不存在`)
  }
  const parsed = validateApprovalBody(approvalBodyRaw)
  if (!parsed.ok) throw new FormsError(parsed.code, parsed.detail)
  if (parsed.body.provider !== ref.provider) {
    throw new FormsError('PROVIDER_MISMATCH', `事项模板 provider=${ref.provider} 与审批模板 provider=${parsed.body.provider} 不一致`)
  }
  if (deps.orgPort === null) {
    throw new FormsError('ORG_UNAVAILABLE', '组织查询面未注入，无法解析审批人')
  }
  const plan = await compilePlan({
    org,
    templateRef: { id: ref.id, version: ref.version },
    requester: userId,
    payload: (payload ?? {}) as Record<string, unknown>,
    body: parsed.body as ApprovalBody,
  }, deps.orgPort)

  // 事项字段本身仍要过契约五道闸（审批不等于不校验表单）
  await validateAgainstContract(pool, org, itemBody, payload)

  // 先取引擎：没开通就不落行（否则建 submission 后才发现无引擎，只能补偿）
  const engine = await deps.engineFor(org)
  if (engine === null) throw new FormsError('OA_NOT_ENABLED', `租户 ${org} 未开通应用内审批（无引擎映射）`)

  let id: string
  try {
    const { rows } = await pool.query(
      `insert into forms.submission
         (org, kind, asset_id, version, payload, submitted_by, status, provider, approval_plan)
       values ($1,'form_def',$2,$3,$4::jsonb,$5,'pending_approval','inapp',$6::jsonb)
       returning id`,
      [org, assetId, version, JSON.stringify(payload ?? null), userId, JSON.stringify(plan)],
    )
    id = String(rows[0].id)
  } catch (e) {
    if (/submissions follow head only/.test((e as Error).message)) {
      throw new FormsError('HEAD_MOVED', '提交期间表单版本已切换，请重试')
    }
    throw e
  }

  const externalRef = `forms:submission:${id}`
  let caseId: string
  try {
    const created = await engine.createCase({
      org,
      externalRef,
      planVersion: plan.contractVersion,
      provider: 'inapp',
      type: 'approval',
      title: deps.title,
      requesterId: userId,
      payload: payload ?? {},
      plan,
    })
    caseId = created.caseId
    if (typeof caseId !== 'string' || caseId.length === 0) {
      throw new FormsError('ENGINE_BAD_RESPONSE', '引擎未返回 caseId')
    }
  } catch (e) {
    await abandonApprovalSubmission(pool, org, id)
    await audit(pool, org, userId, 'approval.submit.failed', id, {
      assetId, version, templateRef: plan.templateRef, error: (e as Error).message,
    })
    // client 已把网络失败包成 ENGINE_UNAVAILABLE；这里再兜一层：任何非 FormsError 的
    // 抛错都不能变成 500（那是平台故障的语义，实际是上游不可用 ⇒ 502）
    throw e instanceof FormsError ? e : new FormsError('ENGINE_UNAVAILABLE', (e as Error).message)
  }

  await pool.query(
    'update forms.submission set case_ref=$3 where org=$1 and id=$2::bigint and status=\'pending_approval\'',
    [org, id, caseId],
  )
  await audit(pool, org, userId, 'approval.submit', id, {
    assetId, version, caseId, templateRef: plan.templateRef, nodes: plan.nodes.map((n) => n.key),
  })
  return { id, version, caseId, status: 'pending_approval' }
}

/** 建 case 失败的补偿：标 withdrawn（只动 still-pending 的行，幂等）。 */
export async function abandonApprovalSubmission(pool: Pool, org: string, id: string): Promise<void> {
  await pool.query(
    `update forms.submission set status='withdrawn', withdrawn_at=now(), decision_action='withdrawn'
      where org=$1 and id=$2::bigint and status='pending_approval'`,
    [org, id],
  )
}

export interface ApprovalSubmissionRow {
  id: string
  assetId: string
  version: number
  payload: unknown
  submittedBy: string
  submittedAt: Date
  status: string
  provider: string | null
  caseRef: string | null
  plan: unknown
  decidedAt: Date | null
  decisionAction: string | null
  decisionComment: string | null
}

function mapApprovalRow(r: any): ApprovalSubmissionRow {
  return {
    id: String(r.id),
    assetId: r.asset_id,
    version: r.version,
    payload: r.payload,
    submittedBy: r.submitted_by,
    submittedAt: r.submitted_at,
    status: r.status,
    provider: r.provider,
    caseRef: r.case_ref,
    plan: r.approval_plan,
    decidedAt: r.decided_at,
    decisionAction: r.decision_action,
    decisionComment: r.decision_comment,
  }
}

const APPROVAL_COLS = `id, asset_id, version, payload, submitted_by, submitted_at,
  status, provider, case_ref, approval_plan, decided_at, decision_action, decision_comment`

/** 按 case 引用找审批提交（回调/详情/决策代理的入口；org 钉死）。 */
export async function getSubmissionByCaseRef(
  pool: Pool, org: string, caseRef: string,
): Promise<ApprovalSubmissionRow | null> {
  const { rows } = await pool.query(
    `select ${APPROVAL_COLS} from forms.submission where org=$1 and case_ref=$2 limit 1`,
    [org, caseRef],
  )
  return rows.length === 0 ? null : mapApprovalRow(rows[0])
}

/** 本租户「待我审批」：计划快照任一节点包含我（引擎的真实当前节点由详情接口回答）。 */
export async function listPendingApprovalsFor(
  pool: Pool, org: string, user: string, limit = 200,
): Promise<ApprovalSubmissionRow[]> {
  const { rows } = await pool.query(
    `select ${APPROVAL_COLS}
       from forms.submission
      where org=$1 and status='pending_approval'
        and exists (
          select 1 from jsonb_array_elements(coalesce(approval_plan->'nodes', '[]'::jsonb)) n
           where n->'approvers' ? $2
        )
      order by submitted_at desc
      limit $3`,
    [org, user, limit],
  )
  return rows.map(mapApprovalRow)
}

/** 提交人自己的在途单（撤回入口；跨人/跨状态 ⇒ null，不泄露存在性）。 */
export async function getOwnPendingSubmission(
  pool: Pool, org: string, id: string, userId: string,
): Promise<ApprovalSubmissionRow | null> {
  const { rows } = await pool.query(
    `select ${APPROVAL_COLS} from forms.submission
      where org=$1 and id=$2::bigint and submitted_by=$3 and status='pending_approval'`,
    [org, id, userId],
  )
  return rows.length === 0 ? null : mapApprovalRow(rows[0])
}

/**
 * 回调/对账共用的最终结论回写：**只改 still-pending 的行** ⇒ 天然幂等（重复回调 0 行）。
 * `submissionId` 给了就同时校验 externalRef 与行 id 一致（防引擎串单）。
 */
export async function applyFinalDecision(pool: Pool, input: {
  org: string
  caseId: string
  submissionId?: string | null
  action: 'approved' | 'rejected' | 'withdrawn'
  decidedAt: Date
  comment?: string | null
}): Promise<{ id: string } | null> {
  const { rows } = await pool.query(
    `update forms.submission
        set status=$3, decided_at=$4, decision_action=$3, decision_comment=$5,
            withdrawn_at = case when $3 = 'withdrawn' then $4 else withdrawn_at end
      where org=$1 and case_ref=$2 and status='pending_approval'
        and ($6::bigint is null or id=$6::bigint)
      returning id`,
    [input.org, input.caseId, input.action, input.decidedAt, input.comment ?? null, input.submissionId ?? null],
  )
  return rows.length === 0 ? null : { id: String(rows[0].id) }
}

/** 撤回成功后的本地回写（条件 = 提交人 + still-pending，与引擎调用前读到的是同一行）。 */
export async function markWithdrawn(
  pool: Pool, org: string, id: string, userId: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update forms.submission
        set status='withdrawn', withdrawn_at=now(), decision_action='withdrawn'
      where org=$1 and id=$2::bigint and submitted_by=$3 and status='pending_approval'`,
    [org, id, userId],
  )
  return (rowCount ?? 0) > 0
}

// ── 标准审批只读镜像（OA P2，issue #2385）：企微是事实源，本层只读写镜像表 ──

/** 镜像状态白名单（与 DB 约束 `forms_external_approval_status_check` 同源同值）。 */
export const EXTERNAL_APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'canceled'] as const
export type ExternalApprovalStatus = (typeof EXTERNAL_APPROVAL_STATUSES)[number]

export interface ExternalApprovalInput {
  org: string
  /** 审批源；缺省 'wecom'（表默认值，为将来第二家留位） */
  provider?: string
  processCode: string
  /** 审批源侧单号（企微 SpNo）——(org, provider, provider_ref) 是幂等键 */
  providerRef: string
  title?: string | null
  requester?: string | null
  /** 机检白名单值；类型放宽成 string 是为了让**运行时**守卫真的能拦（回调/对账的数据不可信） */
  status: string
  startedAt?: Date | null
  finishedAt?: Date | null
  /** 审批源可得的摘要；拿不到就 null（不假装有） */
  detail?: unknown
}

export interface ExternalApprovalRow {
  id: string
  org: string
  provider: string
  processCode: string
  providerRef: string
  title: string | null
  requester: string | null
  status: ExternalApprovalStatus
  startedAt: Date | null
  finishedAt: Date | null
  detail: unknown
  syncedAt: Date
}

/**
 * 幂等写入一行镜像（回调与对账共用**同一个** upsert —— 重复回调只更新原行）。
 *
 * 两处刻意语义：
 * - `status` 永远后写胜（状态推进才是镜像存在的理由）；
 * - 其余可空列用 `coalesce(excluded.x, 原值)`：企微的状态变更回调常常**只带状态**，
 *   不能让一次「只带状态」的回调把先到的标题/申请人/开始时间/摘要擦成 null。
 *   代价是「上游真的把某字段清空」无法镜像——审批字段在企微侧本就不允许清空，取这一边。
 *
 * 状态先过应用层白名单（`FormsError` 机检码），DB 的 check 约束是第二道兜底。
 */
export async function upsertExternalApproval(
  pool: Pool, row: ExternalApprovalInput,
): Promise<void> {
  if (!(EXTERNAL_APPROVAL_STATUSES as readonly string[]).includes(row.status)) {
    throw new FormsError(
      'EXTERNAL_APPROVAL_STATUS_INVALID',
      `非法状态 ${JSON.stringify(row.status)}：只接受 ${EXTERNAL_APPROVAL_STATUSES.join('/')}`,
    )
  }
  await pool.query(
    `insert into forms.external_approval
       (org, provider, process_code, provider_ref, title, requester, status,
        started_at, finished_at, detail, synced_at)
     values ($1, coalesce($2, 'wecom'), $3, $4, $5, $6, $7, $8, $9, $10::jsonb, now())
     on conflict (org, provider, provider_ref) do update
       set process_code = excluded.process_code,
           title        = coalesce(excluded.title, forms.external_approval.title),
           requester    = coalesce(excluded.requester, forms.external_approval.requester),
           status       = excluded.status,
           started_at   = coalesce(excluded.started_at, forms.external_approval.started_at),
           finished_at  = coalesce(excluded.finished_at, forms.external_approval.finished_at),
           detail       = coalesce(excluded.detail, forms.external_approval.detail),
           synced_at    = now()`,
    [
      row.org, row.provider ?? null, row.processCode, row.providerRef,
      row.title ?? null, row.requester ?? null, row.status,
      row.startedAt ?? null, row.finishedAt ?? null,
      row.detail === undefined || row.detail === null ? null : JSON.stringify(row.detail),
    ],
  )
}

/**
 * 本租户的镜像列表（只读）。排序 = 开始时间倒序，**没有开始时间的排最后**
 * （缺 ApplyTime 的新单不该压在有时间的历史单之上），同时间用 id 兜底成确定序。
 */
export async function listExternalApprovals(
  pool: Pool, org: string, limit = 100,
): Promise<ExternalApprovalRow[]> {
  const { rows } = await pool.query(
    `select id, org, provider, process_code, provider_ref, title, requester, status,
            started_at, finished_at, detail, synced_at
       from forms.external_approval
      where org = $1
      order by started_at desc nulls last, id desc
      limit $2`,
    [org, limit],
  )
  return rows.map((r) => ({
    id: String(r.id),
    org: r.org,
    provider: r.provider,
    processCode: r.process_code,
    providerRef: r.provider_ref,
    title: r.title,
    requester: r.requester,
    status: r.status as ExternalApprovalStatus,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    detail: r.detail,
    syncedAt: r.synced_at,
  }))
}

/** 对账脚本用：跨租户列在途超阈值的单（**不带 org**——脚本按行上的 org 逐条处理）。 */
export async function listStalePendingSubmissions(
  pool: Pool, olderThanMinutes: number, limit = 500,
): Promise<Array<{ org: string; id: string; caseRef: string | null; submittedAt: Date }>> {
  const { rows } = await pool.query(
    `select org, id, case_ref, submitted_at
       from forms.submission
      where status='pending_approval'
        and submitted_at < now() - ($1::int * interval '1 minute')
      order by submitted_at asc
      limit $2`,
    [olderThanMinutes, limit],
  )
  return rows.map((r) => ({ org: r.org, id: String(r.id), caseRef: r.case_ref, submittedAt: r.submitted_at }))
}
