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
  // 登录限速被触发（PR#5 评审 R2）：企微回调的限速同样走 /login?error=TOO_MANY_REQUESTS，
  // 故这里必须有文案——未登记码会回退到通用"登录失败，请稍后重试"，把"等一下再来"这条
  // 唯一有用的信息抹掉
  TOO_MANY_REQUESTS: '尝试过于频繁，请稍后重试',
}

export function errorText(code: string): string {
  return ERROR_TEXTS[code] ?? '登录失败，请稍后重试'
}

/** 平台 API 唯一错误形状：code 即后端 {error} 错误码（或 UNAUTHENTICATED/NETWORK 等通道错误）。
 *  `reason` / `detail` 是可选的**结构化补充**（目前只有存储探测用：服务端回
 *  `{error:'STORAGE_PROBE_FAILED', reason, detail}`）——带上它们，页面才能把「为什么连不上」
 *  显示出来；只回一个 code 的话用户拿到的就是「操作失败」四个字，没有任何下一步可做。 */
export class ApiError extends Error {
  constructor(readonly code: string, readonly reason?: string, readonly detail?: string) {
    super(code)
  }
}

/** 非 2xx：解析 body {error} 为 ApiError；body 异常时退 HTTP_<status> */
async function toApiError(res: Response): Promise<ApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown; reason?: unknown; detail?: unknown } | null
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  return new ApiError(
    str(body?.error) ?? `HTTP_${res.status}`,
    str(body?.reason),
    str(body?.detail),
  )
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

/** GET /api/platform/auth/session 会话自画像（Task 13）；401 时 platformFetch 已先跳 /login */
export interface PlatformSession {
  user: { id: string; name: string; displayName: string }
  org: string
  scopes: string[]
  csrfToken: string
}

/** GET /api/platform/config 控制台菜单数据（服务端已按租户启用过滤——停用模块不出现） */
export interface PlatformConfig {
  tenant: { slug: string; org: string }
  modules: Array<{
    id: string
    name: string
    console: Array<{ path: string; title: string; icon?: string; scope: string }>
  }>
}

/** 会话自画像（Task 13）：Console 壳挂载即取；退出前也会现取一次刷新 csrf */
export function getSession(): Promise<PlatformSession> {
  return request<PlatformSession>('/api/platform/auth/session')
}

/** 租户配置（含启用模块的 console 清单）——菜单的运行时事实源 */
export function getPlatformConfig(): Promise<PlatformConfig> {
  return request<PlatformConfig>('/api/platform/config')
}

/**
 * 登出（Task 13）：需 header x-csrf-token = /session 现取的 csrfToken。
 * 会话重签会轮换 csrf——禁止使用挂载时缓存的旧值。
 */
export function logout(csrfToken: string): Promise<void> {
  return request<void>('/api/platform/auth/logout', {
    method: 'POST',
    headers: { 'x-csrf-token': csrfToken },
  })
}

// ---- 租户管理域（M3，spec D4/D9，issue #46）----

export interface AdminUser {
  name: string
  displayName: string
  isForbidden: boolean
}
export interface AdminPermission {
  code: string
  name: string
  users: string[]
}
export interface AdminSubscription {
  moduleId: string
  moduleName: string | null
  state: string
  startTime: string | null
  endTime: string | null
}

export const listAdminUsers = () => request<{ users: AdminUser[] }>('/api/platform/admin/users')
export const listAdminPermissions = () =>
  request<{ permissions: AdminPermission[] }>('/api/platform/admin/permissions')
export const listAdminSubscriptions = () =>
  request<{ subscriptions: AdminSubscription[] }>('/api/platform/admin/subscriptions')

/**
 * 管理写操作统一通道：**现取** /session 拿 csrfToken（会话重签会轮换，禁止缓存旧值——
 * 与 logout 同一契约）→ 带 x-csrf-token 调用。无 body 的 DELETE 传 undefined。
 */
async function adminWrite<T>(path: string, method: string, body?: unknown): Promise<T> {
  const s = await getSession()
  return request<T>(path, {
    method,
    headers: {
      'x-csrf-token': s.csrfToken,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
}

export const createAdminUser = (v: { username: string; displayName?: string; password: string }) =>
  adminWrite<{ name: string }>('/api/platform/admin/users', 'POST', v)
export const setAdminUserForbidden = (name: string, isForbidden: boolean) =>
  adminWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}`, 'PATCH', { isForbidden })
export const resetAdminUserPassword = (name: string, password: string) =>
  adminWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}/password`, 'PATCH', { password })
export const deleteAdminUser = (name: string) =>
  adminWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}`, 'DELETE')
export const grantAdminPermission = (code: string, user: string) =>
  adminWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/users`, 'POST', { user })
export const revokeAdminPermission = (code: string, user: string) =>
  adminWrite<{ ok: true }>(
    `/api/platform/admin/permissions/${encodeURIComponent(code)}/users/${encodeURIComponent(user)}`,
    'DELETE',
  )

// ---- 租户级存储配置（M3c）----

/**
 * GET /api/platform/admin/storage 的形状。
 * ⚠️ **没有 secretAccessKey 字段，也永远不会有**——服务端连字段都不回（「有但空」会被当成
 * 「配过」）。AK 只回掩码（前 4 位 + `****`）。这不是本类型的选择，是服务端的契约。
 */
export interface AdminStorage {
  /** 五列全填 ⇒ true（已配，附件走本租户的桶） */
  configured: boolean
  /** 部分填写 ⇒ true（库里是半套 ⇒ 宿主不予使用，附件不可用） */
  partial: boolean
  endpoint: string
  region: string
  bucket: string
  accessKeyIdMasked: string
  /** 进程 env 五键是否齐全（= 有没有「平台默认」可回落） */
  platformFallback: boolean
}

/** 存储配置写入形状；AK/SK **留空 = 保持原值**（凭据轮换不必重贴） */
export interface AdminStorageInput {
  endpoint: string
  region: string
  bucket: string
  accessKeyId?: string
  secretAccessKey?: string
}

export const getAdminStorage = () => request<AdminStorage>('/api/platform/admin/storage')
/** 保存（服务端**保存前探测**，不通过不写库）⇒ 400 STORAGE_PROBE_FAILED / INCOMPLETE */
export const saveAdminStorage = (v: AdminStorageInput) =>
  adminWrite<{ ok: true }>('/api/platform/admin/storage', 'PUT', v)
/** 显式「测试连接」：**不写库** */
export const testAdminStorage = (v: AdminStorageInput) =>
  adminWrite<{ ok: true }>('/api/platform/admin/storage/test', 'POST', v)
/** 清除配置 ⇒ 活回落平台默认（五列置 null） */
export const clearAdminStorage = () =>
  adminWrite<{ ok: true }>('/api/platform/admin/storage', 'DELETE')
