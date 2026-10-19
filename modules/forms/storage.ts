// storage.ts — forms 内核的 SQL 封装（issue #710）。
// 薄封装纪律：DB 函数的错误**原样上抛**（触发器拒绝信息带版本号与 kind，PoC RESULTS §5
// 排障口径）；应用层只补两处——契约校验（domain/contract）与 FormsError 机检错误码。
// 主体（org）一律来自调用方传入的 identity.orgId，本层绝不读请求。
import type { Pool } from 'pg'
import { dictRefs, schemaOf, validateSubmission } from './domain/contract'

/** 机检错误码载体：routes 按 code 映射 HTTP 状态与文案，不解析 message。 */
export class FormsError extends Error {
  constructor(
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

const KIND = 'form_def'

// ── 生命周期（org 维度全部显式入参） ──

export async function newDraft(pool: Pool, org: string, assetId: string, body: unknown, actor: string): Promise<number> {
  const { rows } = await pool.query('select forms.new_draft($1,$2,$3,$4,$5) v', [
    org, KIND, assetId, JSON.stringify(body ?? null), actor,
  ])
  return rows[0].v
}

export async function updateDraft(pool: Pool, org: string, assetId: string, version: number, body: unknown): Promise<void> {
  await pool.query('select forms.update_draft($1,$2,$3,$4,$5)', [
    org, KIND, assetId, version, JSON.stringify(body ?? null),
  ])
}

export async function dropDraft(pool: Pool, org: string, assetId: string, version: number): Promise<void> {
  await pool.query('select forms.drop_draft($1,$2,$3,$4)', [org, KIND, assetId, version])
}

/** 发布：API 层已按 scope 把住人 gate（forms:publish）；actorRole 固定 'human'——
 *  会话身份即人；AI 工具面将来走 manage 不走 publish，DB 策略分支保持双保险。 */
export async function publish(pool: Pool, org: string, assetId: string, version: number, actor: string): Promise<void> {
  await pool.query('select forms.publish($1,$2,$3,$4,$5,$6)', [org, KIND, assetId, version, actor, 'human'])
}

export async function rollbackTo(pool: Pool, org: string, assetId: string, version: number): Promise<void> {
  await pool.query('select forms.rollback_to($1,$2,$3,$4)', [org, KIND, assetId, version])
}

export async function retire(pool: Pool, org: string, assetId: string, version: number): Promise<void> {
  await pool.query('select forms.retire($1,$2,$3,$4)', [org, KIND, assetId, version])
}

export async function headVersion(pool: Pool, org: string, assetId: string): Promise<number | null> {
  const { rows } = await pool.query(
    'select active_version from forms.asset_head where org=$1 and kind=$2 and asset_id=$3',
    [org, KIND, assetId],
  )
  return rows[0]?.active_version ?? null
}

export async function bodyAt(pool: Pool, org: string, assetId: string, version: number): Promise<object | null> {
  const { rows } = await pool.query('select forms.body_at($1,$2,$3,$4) body', [org, KIND, assetId, version])
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
    [KIND],
  )
  return rows.map((r) => ({
    org: r.org, assetId: r.asset_id, version: r.version, publishedAt: r.published_at, body: r.body,
  }))
}

/** 该资产在本租户下是否已有任何版本（AI 起草重名时据此拒，**不覆盖**）。 */
export async function assetExists(pool: Pool, org: string, assetId: string): Promise<boolean> {
  const { rows } = await pool.query(
    'select 1 from forms.asset_version where org=$1 and kind=$2 and asset_id=$3 limit 1',
    [org, KIND, assetId],
  )
  return rows.length > 0
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

export async function listVersions(pool: Pool, org: string, assetId: string): Promise<VersionRow[]> {
  const { rows } = await pool.query(
    `select version, status, created_by, published_by, created_at, published_at, retired_at, body
       from forms.asset_version
      where org=$1 and kind=$2 and asset_id=$3
      order by version desc`,
    [org, KIND, assetId],
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

export async function listDefs(pool: Pool, org: string): Promise<DefSummaryRow[]> {
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
    [org, KIND],
  )
  return rows.map((r) => ({
    assetId: r.asset_id, headVersion: r.head_version, draftCount: r.draft_count,
    publishedCount: r.published_count, retiredCount: r.retired_count, updatedAt: r.updated_at,
  }))
}

// ── 提交（先按 head 契约校验，再钉版本入库） ──

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
 *  「按旧契约校验、新契约入库」的窗口）。 */
export async function submit(
  pool: Pool, org: string, assetId: string, payload: unknown, userId: string,
): Promise<{ id: string; version: number }> {
  const version = await headVersion(pool, org, assetId)
  if (version === null) throw new FormsError('NO_PUBLISHED_HEAD', '表单尚无发布版本，不能提交')
  const body = await bodyAt(pool, org, assetId, version)
  if (body === null) throw new FormsError('NO_PUBLISHED_HEAD', '表单尚无发布版本，不能提交')
  // 契约 body = {schema, uiSchema?}（#724 定案）；校验只吃 schema 那一半
  const schema = schemaOf(body)
  if (schema === null) throw new FormsError('CONTRACT_MALFORMED', '发布版本的契约缺 schema')

  // 预载契约引用的生效 key 集（validateSubmission 的 dictLookup 是同步接口 ⇒ 先 await 预载）
  const cache = await activeKeysByRef(pool, org, schema)
  const result = validateSubmission({ schema, payload, dictLookup: (ref) => cache.get(ref) ?? new Set() })
  if (!result.ok) throw new FormsError(result.code, result.detail)

  try {
    const { rows } = await pool.query('select forms.submit($1,$2,$3,$4,$5) id', [
      org, KIND, assetId, JSON.stringify(payload ?? null), userId,
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

export async function listSubmissions(pool: Pool, org: string, assetId: string, limit = 100): Promise<SubmissionRow[]> {
  const { rows } = await pool.query(
    `select id, asset_id, version, payload, submitted_by, submitted_at
       from forms.submission
      where org=$1 and kind=$2 and asset_id=$3
      order by submitted_at desc limit $4`,
    [org, KIND, assetId, limit],
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
