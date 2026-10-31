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

/** 集成健康（spec 2026-10-31 §2.3）：判定由服务端纯函数算好，前端只渲染，不重写判据。 */
export interface AdminIntegration {
  id: string
  org: string
  kind: 'callback' | 'token' | 'channel'
  source: string
  slaSeconds: number
  enabled: boolean
  lastOkAt: string | null
  lastProbeAt: string | null
  lastError: string | null
  note: string | null
  health: {
    verdict: 'OK' | 'STALE' | 'PROBE_FAILED' | 'DISABLED'
    ageSeconds: number | null
    reason: string
  }
}

export const listAdminUsers = () => request<{ users: AdminUser[] }>('/api/platform/admin/users')
export const listAdminIntegrations = () =>
  request<{
    integrations: AdminIntegration[]
    summary: { total: number; stale: number; probeFailed: number }
  }>('/api/platform/admin/integrations')
export const listAdminPermissions = () =>
  request<{ permissions: AdminPermission[] }>('/api/platform/admin/permissions')
export const listAdminSubscriptions = () =>
  request<{ subscriptions: AdminSubscription[] }>('/api/platform/admin/subscriptions')

/**
 * 写操作统一通道（管理域 + 个人 Key 域共用）：**现取** /session 拿 csrfToken
 *（会话重签会轮换，禁止缓存旧值——与 logout 同一契约）→ 带 x-csrf-token 调用。
 * 无 body 的 DELETE 传 undefined。
 */
async function csrfWrite<T>(path: string, method: string, body?: unknown): Promise<T> {
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
  csrfWrite<{ name: string }>('/api/platform/admin/users', 'POST', v)
export const setAdminUserForbidden = (name: string, isForbidden: boolean) =>
  csrfWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}`, 'PATCH', { isForbidden })
export const resetAdminUserPassword = (name: string, password: string) =>
  csrfWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}/password`, 'PATCH', { password })
export const deleteAdminUser = (name: string) =>
  csrfWrite<{ name: string }>(`/api/platform/admin/users/${encodeURIComponent(name)}`, 'DELETE')
export const grantAdminPermission = (code: string, user: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/users`, 'POST', { user })
export const revokeAdminPermission = (code: string, user: string) =>
  csrfWrite<{ ok: true }>(
    `/api/platform/admin/permissions/${encodeURIComponent(code)}/users/${encodeURIComponent(user)}`,
    'DELETE',
  )

// ---- 组织架构与角色管理（账户和权限体系 Task 9/10；后端契约见 routes/admin.ts）----

/** 组织树节点（后端 buildGroupTree 产物；displayName 来自 Casdoor Group——真机无 title 字段） */
export interface AdminGroupNode {
  name: string
  displayName: string
  parentId: string
  orphan: boolean
  memberCount: number
  children: AdminGroupNode[]
}
export const getAdminOrgTree = () => request<{ tree: AdminGroupNode[] }>('/api/platform/admin/org-tree')

export interface AdminMember {
  name: string
  displayName: string
  isForbidden: boolean
  /** 角色短名清单（后端从 listRoles 倒排，已剥 org 前缀） */
  roles: string[]
}
export const listAdminMembers = (group?: string) =>
  request<{ users: AdminMember[] }>(
    `/api/platform/admin/org-tree/members${group ? `?group=${encodeURIComponent(group)}` : ''}`,
  )

export interface AdminRoleRow {
  name: string
  displayName: string
  members: number
  /** 挂在该角色上的权限码（后端按权限 roles[] 反查） */
  codes: string[]
  /** 角色成员短名清单（授角色时算整组替换用） */
  users: string[]
}
export const listAdminRoles = () => request<{ roles: AdminRoleRow[] }>('/api/platform/admin/roles')
export const createAdminRole = (v: { name: string; displayName?: string }) =>
  csrfWrite<{ ok: true }>('/api/platform/admin/roles', 'POST', v)
export const deleteAdminRole = (name: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/roles/${encodeURIComponent(name)}`, 'DELETE')
/**
 * 角色成员**整组替换**。注意语义：设置的是【角色的成员表】——给用户授/收角色 =
 * 对每个变更角色算「现成员 ± 该用户」后调用（见 OrgTree 页 onGrant）。
 */
export const setAdminRoleMembers = (name: string, users: string[]) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/roles/${encodeURIComponent(name)}/members`, 'PUT', { users })
export const grantAdminPermissionRole = (code: string, role: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/roles`, 'POST', { role })
export const revokeAdminPermissionRole = (code: string, role: string) =>
  csrfWrite<{ ok: true }>(`/api/platform/admin/permissions/${encodeURIComponent(code)}/roles`, 'DELETE', { role })

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
  csrfWrite<{ ok: true }>('/api/platform/admin/storage', 'PUT', v)
/** 显式「测试连接」：**不写库** */
export const testAdminStorage = (v: AdminStorageInput) =>
  csrfWrite<{ ok: true }>('/api/platform/admin/storage/test', 'POST', v)
/** 清除配置 ⇒ 活回落平台默认（五列置 null） */
export const clearAdminStorage = () =>
  csrfWrite<{ ok: true }>('/api/platform/admin/storage', 'DELETE')

// ---- 个人 Key（PAT，通道 B）域（issue #894，正典 §1.5）----
// 个人档**免 scope**（任何登录账号管自己的）；管理档 `tenant:admin`（看/吊销全租户）。

export interface ApiKeyRow {
  id: number
  name: string
  createdAt: string
  lastUsedAt: string | null
  revoked: boolean
}
/** 管理档多一列归属用户 */
export interface AdminApiKeyRow extends ApiKeyRow {
  casdoorUser: string
}

export const listMyKeys = () => request<{ keys: ApiKeyRow[] }>('/api/platform/keys')
export const listAllKeys = () => request<{ keys: AdminApiKeyRow[] }>('/api/platform/keys/all')

/** 建 key：**明文 token 只在本响应里出现一次**（页面只显示一次，刷新即失）。 */
export const createMyKey = (name: string) =>
  csrfWrite<{ id: number; token: string }>('/api/platform/keys', 'POST', { name })
export const revokeMyKey = (id: number) => csrfWrite<{ ok: true }>(`/api/platform/keys/${id}`, 'DELETE')
export const revokeAnyKey = (id: number) =>
  csrfWrite<{ ok: true }>(`/api/platform/keys/all/${id}`, 'DELETE')
