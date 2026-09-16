// src/shims/http.ts —— 移动端的 HTTP 薄封装。
//
// ⚠️ **刻意不用 `@platform/sdk/web` 的 `platformFetch`**：它在 401 时跳 `/login`
// （console 的账号密码登录页），而移动端要的是宿主的**公众号访客登录路**——在微信里打开
// `/login` 只会渲染一个用不了的账密表单。两条是**不同的身份路**，客户端不共用。
export const API_BASE = '/api/modules/aftersales'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /** 服务端 `{error, message}` 里的 message（部分端点带，如「您没有修改任何信息」） */
    override readonly message: string = '',
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

/**
 * 访客 session 缺失 ⇒ 带 `next` 跳宿主静默授权（spec §3.2 未登录节）。
 * `next` 是本期在宿主侧补的能力：没有它，登录成功后恒落 `/`（console 首页），
 * 用户回不到移动端页。
 */
export function redirectToGuestLogin(): void {
  const next = location.pathname + location.search
  location.href = '/api/platform/auth/wechat-oa/silent?next=' + encodeURIComponent(next)
}

async function toApiError(res: Response): Promise<ApiError> {
  // 体可能不是 JSON（反代 502 之类）——解析失败不能把状态码也吞掉
  const body = (await res.json().catch(() => null)) as { error?: unknown; message?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
  const message = typeof body?.message === 'string' ? body.message : ''
  return new ApiError(res.status, code, message)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, { ...init, credentials: 'same-origin' })
  if (res.status === 401) {
    redirectToGuestLogin()
    // 跳转已经发起，本页不会再渲染出有意义的结果 —— 抛出让调用方收尾 loading
    throw new ApiError(401, 'UNAUTHENTICATED')
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path)
}

export function apiSend<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
}
