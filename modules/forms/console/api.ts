// console/api.ts — console 页与模块 API 之间的薄层（issue #718）。
// HTTP 一律 platformFetch（会话 cookie / 401 统一跳登录由壳管）；错误按机检错误码透出。
// 铁律边界：**存储契约永不含值**（§2.4）；本文件的 injectDictEnums 造的是**渲染视图模型副本**
// ——值同源取自 /options（与服务端提交校验同一数据源），不回写、不落契约。
import { platformFetch } from '@platform/sdk/web'
import { DICT_REF_RE, fieldDeclsOf, statsEnabledOf } from '../domain/contract'
import { statsViewsOf } from '../domain/stats'
import type { FieldDecl, StatsFilter, StatsMeasure, StatsViewDecl } from '../domain/contract'

export type { FieldDecl, StatsFilter, StatsMeasure, StatsViewDecl } from '../domain/contract'

export interface DefSummary {
  assetId: string
  headVersion: number | null
  draftCount: number
  publishedCount: number
  retiredCount: number
  updatedAt: string
}

export interface VersionInfo {
  version: number
  status: string
  createdBy: string
  publishedBy: string | null
  body: unknown
}

export interface OptionItem {
  key: string
  label: string
  sortNo: number
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

async function readBody(res: Response): Promise<never> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; detail?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
  const detail = typeof body?.detail === 'string' ? body.detail : undefined
  throw new ApiError(res.status, code, detail)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await platformFetch(path)
  if (!res.ok) await readBody(res)
  return (await res.json()) as T
}

export async function apiSend<T>(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const res = await platformFetch(path, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
      : {}),
  })
  if (!res.ok) await readBody(res)
  return (await res.json()) as T
}

// ── 应用内审批（OA P1 / issue #2363） ──
// 授权在服务端按「计划快照的当前节点」判定；前端只做展示与动作入口，不缓存授权结论。

export interface MyApproval {
  submissionId: string
  caseId: string | null
  title: string
  requester: string
  nodeTitle: string
  submittedAt: string
}

export interface ApprovalSubmissionView {
  id: string
  assetId: string
  version: number
  payload: unknown
  submittedBy: string
  submittedAt: string
  status: string
  caseId: string | null
  plan: unknown
  decidedAt: string | null
  decisionAction: string | null
  decisionComment: string | null
}

export interface ApprovalDetailView {
  submission: ApprovalSubmissionView
  /** 提交钉住版本的事项模板契约（`{schema, uiSchema?}`；null = 契约缺失，按 JSON 降级渲染） */
  contract: unknown
  /** 引擎 case 详情（含 currentNode / nodeDecisions）；引擎不可用时为 null */
  case: {
    currentNode?: unknown
    nodeDecisions?: Array<{ nodeKey?: string; approver?: string; action?: string; comment?: string | null; at?: string }>
    [k: string]: unknown
  } | null
  engineError: string | null
}

export async function listMyApprovals(): Promise<MyApproval[]> {
  const body = await apiGet<{ approvals: MyApproval[] }>('/api/modules/forms/approvals/mine')
  return body.approvals
}

export async function getApprovalDetail(caseId: string): Promise<ApprovalDetailView> {
  return apiGet<ApprovalDetailView>(`/api/modules/forms/approvals/${encodeURIComponent(caseId)}`)
}

export type DecisionAction = 'approve' | 'reject'

export async function submitDecision(
  caseId: string,
  input: { nodeKey?: string; action: DecisionAction; comment?: string },
): Promise<{ ok: boolean; nodeKey: string }> {
  return apiSend<{ ok: boolean; nodeKey: string }>(
    'POST', `/api/modules/forms/approvals/${encodeURIComponent(caseId)}/decision`, input,
  )
}

/** 当前节点标题（引擎 `currentNode` 可能是 key 字符串或 {key,title}；缺失时按计划快照找「含我」的节点）。 */
export function currentNodeTitleOf(detail: ApprovalDetailView, me: string): string | null {
  const raw = detail.case?.currentNode
  if (raw && typeof raw === 'object') {
    const t = (raw as { title?: unknown; key?: unknown }).title
    const k = (raw as { key?: unknown }).key
    if (typeof t === 'string' && t.length > 0) return t
    if (typeof k === 'string') return planNodeTitle(detail.submission.plan, k)
  }
  if (typeof raw === 'string') return planNodeTitle(detail.submission.plan, raw)
  const nodes = (detail.submission.plan as { nodes?: Array<{ approvers?: unknown; title?: unknown }> } | null)?.nodes
  const hit = Array.isArray(nodes)
    ? nodes.find((n) => Array.isArray(n?.approvers) && n.approvers.includes(me))
    : undefined
  return typeof hit?.title === 'string' ? hit.title : null
}

function planNodeTitle(plan: unknown, key: string): string | null {
  const nodes = (plan as { nodes?: Array<{ key?: unknown; title?: unknown }> } | null)?.nodes
  if (!Array.isArray(nodes)) return null
  const hit = nodes.find((n) => n?.key === key)
  return typeof hit?.title === 'string' ? hit.title : null
}

// ── 标准审批镜像（OA P2 Task 7 / issue #2385）──
// 只读：镜像由企微回调/小时级对账写入。`detail` 可得才有（拿不到 = null，不假装有）。

export interface StandardApprovalRow {
  id: string
  org: string
  provider: string
  processCode: string
  providerRef: string
  title: string | null
  requester: string | null
  status: 'pending' | 'approved' | 'rejected' | 'canceled'
  startedAt: string | null
  finishedAt: string | null
  detail: unknown
  syncedAt: string
}

export async function listStandardApprovals(limit = 100): Promise<StandardApprovalRow[]> {
  const body = await apiGet<{ approvals: StandardApprovalRow[] }>(
    `/api/modules/forms/standard-approvals?limit=${limit}`,
  )
  return body.approvals
}

// ── 收集轮次（件③ / issue #2707）──
// 名单轮（targets：按人收）/ 值集轮（value_grid：按格子收）；进度来自期望集合行状态。

export type RoundKind = 'targets' | 'value_grid'
export type RoundStatus = 'draft' | 'open' | 'closed'

export interface RoundRow {
  id: string
  org: string
  assetId: string
  version: number
  roundKey: string
  kind: RoundKind
  name: string
  startsAt: string | null
  endsAt: string | null
  status: RoundStatus
  createdBy: string
  createdAt: string
  total: number
  submitted: number
  pending: number
}

export interface RoundProgressItem {
  key: string
  status: string
  submissionId: string | null
  updatedAt: string
}

export interface RoundProgressView {
  total: number
  submitted: number
  pending: number
  waived: number
  items: RoundProgressItem[]
}

export interface RoundDetailView {
  round: Omit<RoundRow, 'total' | 'submitted' | 'pending'>
  progress: RoundProgressView | null
}

export async function listRounds(): Promise<RoundRow[]> {
  const body = await apiGet<{ rounds: RoundRow[] }>('/api/modules/forms/rounds')
  return body.rounds
}

export async function getRound(id: string): Promise<RoundDetailView> {
  return apiGet<RoundDetailView>(`/api/modules/forms/rounds/${encodeURIComponent(id)}`)
}

export interface CreateRoundInput {
  assetId: string
  roundKey: string
  kind: RoundKind
  name: string
  startsAt?: string
  endsAt?: string
  targets?: string[]
  anchors?: string[]
}

export async function createRound(input: CreateRoundInput): Promise<{ id: string }> {
  return apiSend<{ id: string }>('POST', '/api/modules/forms/rounds', input)
}

export async function openRound(id: string): Promise<void> {
  await apiSend('POST', `/api/modules/forms/rounds/${encodeURIComponent(id)}/open`)
}

export async function closeRound(id: string): Promise<void> {
  await apiSend('POST', `/api/modules/forms/rounds/${encodeURIComponent(id)}/close`)
}

export function parseDictRef(ref: string): { scope: 'tenant' | 'global'; dictId: string } | null {
  const m = DICT_REF_RE.exec(ref)
  if (!m) return null
  return { scope: m[1] === 'gdict' ? 'global' : 'tenant', dictId: m[2] }
}

/** 拉取一组字典引用的生效 options（渲染与提交校验同源——服务端 /options）。 */
export async function loadOptions(refs: string[]): Promise<Map<string, OptionItem[]>> {
  const out = new Map<string, OptionItem[]>()
  for (const ref of refs) {
    const parsed = parseDictRef(ref)
    if (!parsed) continue
    const base = parsed.scope === 'global' ? '/api/modules/forms/global-dicts' : '/api/modules/forms/dicts'
    const body = await apiGet<{ options: OptionItem[] }>(`${base}/${parsed.dictId}/options`)
    out.set(ref, body.options)
  }
  return out
}

/** 契约里出现过的字典引用（顶层属性；与服务端 dictRefs 同一判定语义的渲染侧版）。
 *  入参是**契约 body**（`{schema, uiSchema?}`，与 renderModelOf 同口径）。 */
export function schemaDictRefs(body: unknown): string[] {
  const props = ((body as { schema?: { properties?: unknown } } | null)?.schema)?.properties
  if (props === null || typeof props !== 'object') return []
  const refs: string[] = []
  for (const prop of Object.values(props as Record<string, unknown>)) {
    const rec = prop !== null && typeof prop === 'object' ? (prop as Record<string, unknown>) : undefined
    if (rec && typeof rec['x-dict'] === 'string') refs.push(rec['x-dict'])
  }
  return [...new Set(refs)]
}

/**
 * 渲染视图模型：把契约 body（`{schema, uiSchema?}`，#724 定案）变成 RJSF 直接可吃的一对，
 * 并**注入字典候选**——顶层 `required` 绑定的字段：值进 schema.enum、标签进 uiSchema
 * 的 `ui:options.enumNames`（副本，不改原契约）。open 绑定不注入（自由文本）。
 * 候选顺序 = options 的 (sort_no, key)（服务端已排序）。
 * ⚠️ RJSF v6 的标签来源是 **uiSchema 的 ui:options.enumNames**（@rjsf/utils optionsList
 * 走 getUiOptions，schema.enumNames 已不再消费——#718 真机截图实测）。
 */
export function renderModelOf(
  body: unknown,
  options: Map<string, OptionItem[]>,
): { schema: object; uiSchema: Record<string, unknown> } {
  const raw = (body ?? {}) as { schema?: unknown; uiSchema?: unknown }
  const copy = structuredClone(raw.schema ?? {}) as {
    properties?: Record<string, Record<string, unknown>>
  }
  // 契约自带的 uiSchema 是底，字典候选覆盖其上（同键合并，不丢契约里的其他 ui:* 设置）
  const uiSchema: Record<string, unknown> = structuredClone(
    (raw.uiSchema ?? {}) as Record<string, unknown>,
  )
  const props = copy.properties
  if (props !== undefined) {
    for (const [field, prop] of Object.entries(props)) {
      const ref = prop['x-dict']
      if (typeof ref !== 'string' || prop['x-binding'] !== 'required') continue
      const items = options.get(ref)
      if (items === undefined) continue
      prop['enum'] = items.map((o) => o.key)
      const prev = uiSchema[field]
      const base = prev !== null && typeof prev === 'object' && !Array.isArray(prev)
        ? (prev as Record<string, unknown>)
        : {}
      uiSchema[field] = { ...base, 'ui:options': { ...((base['ui:options'] as object) ?? {}), enumNames: items.map((o) => o.label) } }
    }
  }
  return { schema: copy, uiSchema }
}

// ── 运营实时统计（件④ / #2755；console 面 D3 / #2756）──
// 只打声明式聚合端点 `POST /stats`：字段 / 聚合 / 视图全部来自契约（`GET /defs/:assetId` 回带
// head 版本 body），前端**不构造任意字段输入**。合计行用同过滤条件的无分组查询取得
// （avg 不能由各组合计反推，故不前端累加）。

export interface StatsQuery {
  assetId: string
  viewId?: string
  groupBy?: string[]
  measures?: StatsMeasure[]
  filter?: StatsFilter
  limit?: number
}

export interface StatsResult {
  /** 行对象键：分组字段用字段名，度量用 `<agg>_<field>`（`field='*'` 为 `count`）。 */
  rows: Array<Record<string, unknown>>
  /** 数据快照时刻（ISO）。 */
  asOf: string
  truncated: boolean
  cached?: boolean
  viewId?: string
}

export interface DefDetail {
  assetId: string
  head: number | null
  versions: Array<{ version: number; status: string; body: unknown }>
}

export async function runStats(input: StatsQuery): Promise<StatsResult> {
  return apiSend<StatsResult>('POST', '/api/modules/forms/stats', input)
}

export async function getDefDetail(assetId: string): Promise<DefDetail> {
  return apiGet<DefDetail>(`/api/modules/forms/defs/${encodeURIComponent(assetId)}`)
}

/** 契约里与统计有关的全部声明 + 字段标题（schema.properties[*].title，缺省用字段名）。 */
export interface StatsContract {
  enabled: boolean
  fields: FieldDecl[]
  views: StatsViewDecl[]
  titles: Record<string, string>
  /** 表单名（schema.title，缺省 assetId）。 */
  title: string
}

/**
 * `GET /defs/:assetId` → 已发布 head 的统计契约（无 head / 找不到 head 版本 ⇒ null）。
 * 统计开关只看 head：草稿上的 `stats.enabled` 不生效（与 `/stats` 只查 published head 同口径）。
 */
export function statsContractOf(detail: DefDetail): StatsContract | null {
  if (detail.head === null) return null
  const head = detail.versions.find((v) => v.version === detail.head)
  if (head === undefined) return null
  const body = head.body
  const schema = (body as { schema?: { title?: unknown; properties?: unknown } } | null)?.schema
  const titles: Record<string, string> = {}
  const props = schema?.properties
  if (props !== null && typeof props === 'object' && !Array.isArray(props)) {
    for (const [field, def] of Object.entries(props as Record<string, unknown>)) {
      const title = (def as { title?: unknown } | null)?.title
      titles[field] = typeof title === 'string' && title.trim().length > 0 ? title.trim() : field
    }
  }
  const schemaTitle = typeof schema?.title === 'string' ? schema.title.trim() : ''
  return {
    enabled: statsEnabledOf(body),
    fields: fieldDeclsOf(body),
    views: statsViewsOf(body),
    titles,
    title: schemaTitle.length > 0 ? schemaTitle : detail.assetId,
  }
}
