// api.ts — 移动端取数/写数的唯一 HTTP 面。
//
// ⚠️ 刻意不用 `@platform/sdk/web` 的 `platformFetch`（aftersales/mobile 同款决定）：
// 它在 401 时跳 `/login`——那是 console 的登录页，不是 IM 工作台 webview 的恢复路径。
// 这里 401 ⇒ 跳 **wecom 静默授权**（spec 2026-11-01 §5.1：工作台主页本来就是
// `/api/platform/auth/wecom/silent?next=…` 进来的，回跳同一条路）。
export class ApiError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) {
    super(`api ${status}`)
  }
}

/** 401 静默授权回跳（去哪来哪：pathname+search 原样带回去，silent 落完凭据弹回本页）。 */
function redirectToSilent(): void {
  location.href = '/api/platform/auth/wecom/silent?next=' + encodeURIComponent(location.pathname + location.search)
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await fetch(path, { credentials: 'same-origin' })
  if (r.status === 401) {
    redirectToSilent()
    throw new ApiError(401, {})
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok) throw new ApiError(r.status, body)
  return body as T
}

export async function apiSend<T>(method: 'PUT' | 'POST', path: string, payload: unknown): Promise<T> {
  const r = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (r.status === 401) {
    redirectToSilent()
    throw new ApiError(401, {})
  }
  const body = (await r.json().catch(() => ({}))) as Record<string, unknown>
  if (!r.ok) throw new ApiError(r.status, body)
  return body as T
}
