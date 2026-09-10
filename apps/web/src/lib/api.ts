// lib/api.ts —— web（门户+console 同构建）唯一 API 通道：一切请求经 platformFetch（Task 10 契约）。
//
// 错误形状统一 ApiError(code)：非 2xx 解析 body {error}（Task 13/14 的错误码）；
// platformFetch 自身的 throw（401 拦截跳 /login 后的 UNAUTHENTICATED、网络异常）也归一到同形状。
import { platformFetch } from '@platform/sdk/web'

/** GET /api/platform/branding 的形状（Task 12；loginMethods 为已知两值，服务端按租户配置回传） */
export interface Branding {
  productName: string
  logo?: string
  primaryColor: string
  background?: string
  loginMethods: string[]
  wecomCorpId?: string
}

/** branding 取失败时的兜底品牌（登录页永远可渲染） */
export const DEFAULT_BRANDING: Branding = {
  productName: 'Platform',
  primaryColor: '#1890ff',
  loginMethods: ['password'],
}

/** 平台错误码 → 用户可读文案；未登记码回退通用文案（?error= 兜底路同样走这里） */
const ERROR_TEXTS: Record<string, string> = {
  BAD_CREDENTIALS: '用户名或密码错误',
  NO_ACCOUNT: '该企业微信账号未绑定平台账号，请联系管理员',
  BAD_STATE: '登录状态已过期，请重试',
  CASDOOR_UNAVAILABLE: '认证服务暂不可用，请稍后重试',
  WECOM_UNAVAILABLE: '企业微信服务暂不可用，请稍后重试',
}

export function errorText(code: string): string {
  return ERROR_TEXTS[code] ?? '登录失败，请稍后重试'
}

/** 平台 API 唯一错误形状：code 即后端 {error} 错误码（或 UNAUTHENTICATED/NETWORK 等通道错误） */
export class ApiError extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

/** 非 2xx：解析 body {error} 为 ApiError；body 异常时退 HTTP_<status> */
async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return new ApiError(typeof body?.error === 'string' ? body.error : `HTTP_${res.status}`)
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await platformFetch(path, init)
  } catch (e) {
    // platformFetch 的 401 拦截（跳 /login 后 throw UNAUTHENTICATED）与网络层异常 → 归一单错误形状
    throw e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : 'NETWORK')
  }
  if (!res.ok) throw await toApiError(res)
  return (await res.json()) as T
}

/** 登录页运行时品牌（Task 12） */
export function getBranding(): Promise<Branding> {
  return request<Branding>('/api/platform/branding')
}

/** 账密登录（Task 13）：失败 401 {error:'BAD_CREDENTIALS'} → ApiError */
export function login(username: string, password: string): Promise<void> {
  return request<void>('/api/platform/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
}

/** 企微扫码 iframe 地址（Task 14） */
export function getWecomQr(): Promise<string> {
  return request<{ url: string }>('/api/platform/auth/wecom/qr').then((b) => b.url)
}
