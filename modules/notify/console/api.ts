// console/api.ts — notify console 与模块 API 之间的薄层。
// HTTP 一律 platformFetch（会话 cookie / 401 统一跳登录由壳管）；错误按机检错误码透出（`{error}`）。
import { platformFetch } from '@platform/sdk/web'

const BASE = '/api/modules/notify'

export interface RuleView {
  id: string
  enabled: boolean
  eventType: string
  mount: string
  templateId: string
  recipient: string
  recipientArg: string | null
  channels: string[]
  cooldownMinutes: number | null
  origin: string
  createdAt: string
}

export interface DeliveryView {
  ruleId: string
  eventId: string
  eventType: string
  recipient: string
  template: string
  status: string
  error: string | null
  createdAt: string
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
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}),
  })
  if (!res.ok) await readBody(res)
  return (await res.json()) as T
}

export const fetchRules = (): Promise<RuleView[]> => apiGet<{ rules: RuleView[] }>(`${BASE}/rules`).then((r) => r.rules)

export const fetchDeliveries = (): Promise<DeliveryView[]> =>
  apiGet<{ deliveries: DeliveryView[] }>(`${BASE}/deliveries`).then((r) => r.deliveries)

export const setRuleEnabled = (id: string, enabled: boolean): Promise<{ ok: boolean }> =>
  apiSend('PUT', `${BASE}/rules/${encodeURIComponent(id)}/enabled`, { enabled })

export const removeRule = (id: string): Promise<{ ok: boolean }> =>
  apiSend('DELETE', `${BASE}/rules/${encodeURIComponent(id)}`)
