// api.ts — notify console 与模块 API 之间的薄层（统一 platformFetch）。
import { platformFetch } from '@platform/sdk/web'

const BASE = '/api/modules/notify'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code)
  }
}

async function read(res: Response): Promise<never> {
  const b = (await res.json().catch(() => null)) as { error?: unknown; issues?: unknown } | null
  const code = typeof b?.error === 'string' ? b.error : `HTTP_${res.status}`
  const detail = Array.isArray(b?.issues) ? b.issues.join('; ') : undefined
  throw new ApiError(res.status, code, detail)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await platformFetch(path)
  if (!res.ok) await read(res)
  return (await res.json()) as T
}

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await platformFetch(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) await read(res)
  return (await res.json()) as T
}

export const get = <T>(path: string) => apiGet<T>(`${BASE}${path}`)
export const post = <T>(path: string, body?: unknown) => apiSend<T>('POST', `${BASE}${path}`, body)
export const patch = <T>(path: string, body?: unknown) => apiSend<T>('PATCH', `${BASE}${path}`, body)
export const put = <T>(path: string, body?: unknown) => apiSend<T>('PUT', `${BASE}${path}`, body)
export const del = <T>(path: string) => apiSend<T>('DELETE', `${BASE}${path}`)

// ── 视图类型（页面共用）────────────────────────────────────────────────────────
export type EventField = { type: string; required?: boolean; label?: string }
export type EventRecipient = { kind: string; field?: string; scope?: string; label?: string }
export type EventView = {
  key: string
  title: string
  description?: string
  scope?: { key: string; label?: string }
  payload: Record<string, EventField>
  recipients: Record<string, EventRecipient>
  defaults?: { recipient: string; template: string; channels: string[] }
}

export type RuleView = {
  id: string
  enabled: boolean
  eventKey: string
  scope: string
  recipientKey: string
  recipientLiteral: string[] | null
  /** kind=dept 才有值：所选部门 ext_id（发送时展开含子树） */
  recipientDepts?: string[] | null
  templateKey: string
  channels: string[]
  cooldownMinutes: number | null
  origin: string
  createdAt: string
}

export type TemplateView = {
  key: string
  name: string
  eventKey: string
  status: string
  origin: string
  publishedRevision: number | null
  updatedAt: string
}

export type TemplateRevisionView = {
  revision: number
  contents: Record<string, Record<string, string>>
  bodyHash: string
  reviewStatus: string
  createdBy: string
  createdAt: string
}

export type TemplateDetailView = TemplateView & { revisions: TemplateRevisionView[] }

export type ChannelView = {
  id: string
  provider: string
  enabled: boolean
  configured: boolean
  config: Record<string, unknown>
  secretRefs: Record<string, string>
  health: string | null
  healthAt: string | null
}

export type DeliveryView = {
  eventId: string
  eventKey: string
  ruleId: string
  recipient: string
  channel: string
  address: string
  templateKey: string
  revision: number
  status: string
  attempts: number
  isTest: boolean
  lastError: string | null
  createdAt: string
}

export type InboxItem = {
  id: string
  eventId: string
  eventKey: string
  title: string
  body: string
  link: string | null
  readAt: string | null
  createdAt: string
}

/** `GET /org-depts`：部门选择器的数据源（宿主注入的 org 平表）。 */
export type OrgDeptOption = {
  extId: string
  name: string
  parentExtId: string | null
  memberCount: number
}

export type RuleDeliverability = {
  ruleId: string
  eventKey: string
  blocked: string | null
  recipientCount: number
  /** 启用了但没配（secret_refs 的 env 键缺失）的通道 id */
  unconfiguredChannels?: string[]
}

export const fetchDeliverability = (): Promise<RuleDeliverability[]> =>
  apiGet<{ rules: RuleDeliverability[] }>(`${BASE}/rules/deliverability`).then((r) => r.rules)
