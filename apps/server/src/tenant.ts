// tenant.ts — Host → 租户解析（§5.1：宿主请求链第一件事）
//
// multi：去端口的 Host 查 platform.tenant_domain join platform.tenant——未注册的 Host
//        一律 404 UNKNOWN_TENANT，不留任何"默认租户"后门。
// single：按 platformOrg 查唯一租户，60s 内存缓存（请求期基本不查库）；查不到属
//        启动级问题（PLATFORM_ORG 配错 / seed 未跑）→ 中间件直接抛错暴露，不静默 404。
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import type { Pool } from 'pg'
import type { TenantMode } from './config'

/** platform.tenant 行原样（pg 驱动形状：text[] → string[]、timestamptz → Date、可空列 → null） */
export interface TenantRow {
  id: number
  slug: string
  casdoor_org: string
  product_name: string
  logo: string | null
  primary_color: string
  background: string
  login_methods: string[]
  wecom_corp_id: string | null
  wecom_agent_id: string | null
  wecom_secret: string | null
  /** 该租户在共享 Casdoor 上**自己那个**企微 provider 的名字（issue #27）；NULL ⇒ 代码回落默认 */
  wecom_provider: string | null
  created_at: Date
}

/** 中间件与 /api/platform 路由共享的 Hono Env：c.get('tenant') 强类型 */
export interface TenantEnv {
  Variables: { tenant: TenantRow }
}

/**
 * Host → 租户行（或 null）。
 * - multi：`acme.test:8443` → 去端口 + 小写归一后按 tenant_domain 精确匹配；无 Host 头 → null。
 * - single：host 参数完全忽略，按 platformOrg 查（60s 缓存，只缓存命中——seed 追加后下一请求自愈）。
 */
export async function getTenantByHost(
  pool: Pool,
  host: string | undefined,
  mode: TenantMode,
  platformOrg: string,
): Promise<TenantRow | null> {
  if (mode === 'single') {
    const cached = orgCache.get(platformOrg)
    if (cached && Date.now() - cached.at < ORG_CACHE_TTL_MS) return cached.row
    const { rows } = await pool.query<TenantRow>(
      'select * from platform.tenant where casdoor_org = $1',
      [platformOrg],
    )
    const row = rows[0] ?? null
    if (row) orgCache.set(platformOrg, { row, at: Date.now() })
    return row
  }
  const domain = normalizeHost(host)
  if (!domain) return null
  const { rows } = await pool.query<TenantRow>(
    `select t.* from platform.tenant t
       join platform.tenant_domain d on d.tenant_id = t.id
      where d.domain = $1`,
    [domain],
  )
  return rows[0] ?? null
}

// —— single 模式 org 缓存（模块级、全进程共享；60s TTL） ——
const ORG_CACHE_TTL_MS = 60_000
const orgCache = new Map<string, { row: TenantRow; at: number }>()

/** 清空 single 模式 org 缓存——测试隔离用（生产无需调用） */
export function resetTenantOrgCache(): void {
  orgCache.clear()
}

/** 去端口 + 小写归一（域名大小写不敏感；IPv6 字面量保留方括号原样，天然查不中 → 404） */
function normalizeHost(host: string | undefined): string | null {
  if (!host) return null
  return host.toLowerCase().replace(/:\d+$/, '')
}

export interface TenantMiddlewareDeps {
  pool: Pool
  mode: TenantMode
  /** single 模式的唯一租户 org（loadConfig 已保证非空）；multi 模式忽略 */
  platformOrg: string
}

/**
 * 命中 → `c.set('tenant', row)` 放行；multi 未命中 → 404 `{"error":"UNKNOWN_TENANT"}`；
 * single 查不到 org → 抛错（Hono 默认 onError → 500：启动级问题暴露，不静默降级）。
 */
export const resolveTenantMiddleware = (
  deps: TenantMiddlewareDeps,
): MiddlewareHandler<TenantEnv> =>
  createMiddleware<TenantEnv>(async (c, next) => {
    const tenant = await getTenantByHost(deps.pool, c.req.header('host'), deps.mode, deps.platformOrg)
    if (tenant) {
      c.set('tenant', tenant)
      await next()
      return
    }
    if (deps.mode === 'single') {
      throw new Error(
        `TENANT_MODE=single 但租户不存在：casdoor_org=${JSON.stringify(deps.platformOrg)}`
          + '（检查 PLATFORM_ORG 配置或先跑 seed）',
      )
    }
    return c.json({ error: 'UNKNOWN_TENANT' }, 404)
  })
