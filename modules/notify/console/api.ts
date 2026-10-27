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
export const del = <T>(path: string) => apiSend<T>('DELETE', `${BASE}${path}`)
