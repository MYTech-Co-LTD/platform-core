// console/lib/api.ts — 模块 console 页的 HTTP 薄封装。
//
// 只做两件事：拼模块 API 前缀、把非 2xx 的错误体（`{error}`，模块 API 约定）翻成可展示文案。
// 不做重试/缓存/全局状态——那些属于调用方或壳。
//
// 纪律：HTTP 只走 platformFetch（它管会话 cookie 与 401 跳登录），模块页不直接用 fetch。
import { platformFetch } from '@platform/sdk/web'

/** 模块 API 前缀（三同纪律：模块 id = DB schema = API 前缀） */
const BASE = '/api/modules/aftersales'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
    this.name = 'ApiError'
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  // 体可能不是 JSON（反代 502 之类）——解析失败不能把状态码也吞掉
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  const code = typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`
  return new ApiError(res.status, code)
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await platformFetch(BASE + path)
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

export async function apiSend<T>(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const res = await platformFetch(BASE + path, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

/** 错误码 → 中文文案。只列端点真会回的；其余回落成码本身（排障时比一句笼统话更有用） */
const MESSAGES: Record<string, string> = {
  NOT_FOUND: '记录不存在（可能已被他人删除）',
  ALREADY_PROCESSED: '该工单已被他人处理，请刷新列表',
  INVALID_BODY: '提交内容不合法',
  INVALID_AMOUNT: '金额或比例不合法',
  INVALID_ID: 'ID 不合法',
  FORBIDDEN: '没有权限执行该操作',
  UNAUTHENTICATED: '登录已失效，请重新登录',
}

export function messageOf(e: unknown): string {
  return e instanceof ApiError ? (MESSAGES[e.code] ?? e.code) : '网络异常，请重试'
}
