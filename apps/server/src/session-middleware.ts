// session-middleware.ts — platform_session cookie → Identity 注入 + 滑动续期/scopes 刷新重签
//
// 职责边界（跨任务契约）：
//  - Task 6：verifySession 仅验签不判过期——过期自检（p.exp <= now）在本中间件；
//  - Task 9：Identity.hasScope 必须实现为 scopes.includes（锁定语义，防漂移）；
//  - 时间类决策（续期/刷新）消费 auth-core 的 needsRenew/needsScopeRefresh 判定结果。
//
// 重签策略：needsScopeRefresh（now-sfa>=300）或 needsRenew（exp-now<6天）任一命中即重签一次
// （signSession 以注入的同一 now 签发，iat/exp/sfa 三值与本地构造的载荷严格一致，csrf 可复算）；
// scopes 值只在 scope 刷新命中时向 Casdoor 重算（getUser+getPermissions+effectiveScopes）。
//
// 可用性优先：Casdoor 拉取失败（网络/5xx → CasdoorClient 抛错）→ 降级用旧 scopes 继续本次
// 请求且【不重签】（重签会把 sfa 抹成 now，遮蔽故障 5 分钟）；仅 Casdoor 明确返回"用户不存在"
// （getUser resolve 为 null，区别于抛错）时清会话 cookie。
//
// 验签失败/过期/租户 org 不符 → 不注 identity/session，照常放行（公开路由可达），
// 鉴权交给 requireScope（@platform/sdk）。
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  effectiveScopes,
  needsRenew,
  needsScopeRefresh,
  signSession,
  verifySession,
  type CasdoorClient,
  type SessionPayload,
} from '@platform/auth-core'
import type { Identity } from '@platform/sdk'
import type { TenantEnv } from './tenant'

/** 本中间件向 Hono context 注入的变量（与 TenantEnv 交并由宿主/路由组合） */
export interface SessionEnv {
  Variables: {
    identity: Identity
    session: SessionPayload
  }
}

/**
 * CasdoorClient 工厂：org 随租户变（multi 模式各租户各自 org），中间件与 auth 路由共用
 * 同一形状。构造函数轻量（仅存配置），按 org 换实例零成本；admin 会话缓存在实例内——
 * 需要跨请求复用 admin 会话的宿主应返回按 org 缓存的实例（Task 16 装配时定）。
 */
export type CasdoorFactory = (org: string) => CasdoorClient

export interface SessionMiddlewareDeps {
  casdoor: CasdoorFactory
  sessionSecret: string
}

/** 手写 cookie 序列化（不引 cookie 库）：host-only（不设 Domain）+ 安全属性全开 */
export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`
}

/** 清除会话 cookie：与签发同属性、Max-Age=0（属性不一致会导致部分浏览器拒清） */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

/** 从 Cookie 头读命名值（手写：split ';'/trim，无解码语义——JWT 本身无需解码） */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** SessionPayload → Identity（Task 9 契约：hasScope ≡ scopes.includes） */
function toIdentity(p: SessionPayload): Identity {
  return {
    userId: p.sub,
    orgId: p.org,
    displayName: p.name,
    scopes: p.scopes,
    hasScope: (code: string) => p.scopes.includes(code),
  }
}

export const sessionMiddleware = (
  deps: SessionMiddlewareDeps,
): MiddlewareHandler<TenantEnv & SessionEnv> =>
  createMiddleware<TenantEnv & SessionEnv>(async (c, next) => {
    const now = nowSec()
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    const p = token ? await verifySession(token, deps.sessionSecret) : null
    const tenant = c.get('tenant')

    // 三道门：验签通过 && 未过期（Task 6 契约的自检位）&& 会话 org 与当前租户一致
    // （host-only cookie 天然防跨域；org 不符只可能在异常部署形态下出现，不认即可）
    if (p && p.exp > now && p.org === tenant.casdoor_org) {
      const wantRefresh = needsScopeRefresh(p, now)
      const wantRenew = needsRenew(p, now)
      let scopes = p.scopes
      let refreshOk = false
      let userGone = false
      if (wantRefresh) {
        try {
          const casdoor = deps.casdoor(p.org)
          const user = await casdoor.getUser(p.name)
          if (user === null) {
            userGone = true // Casdoor 明确说没这个人（2xx + status error）→ 唯一清会话分支
          } else {
            const perms = await casdoor.getPermissions()
            scopes = effectiveScopes(p.name, user.roles ?? [], perms)
            refreshOk = true
          }
        } catch {
          // 网络/5xx：降级旧 scopes 继续（可用性优先），本次不重签（防 sfa 被抹新遮蔽故障）
        }
      }
      if (userGone) {
        c.res.headers.append('Set-Cookie', clearSessionCookie())
      } else if (refreshOk || wantRenew) {
        // 任一命中重签一次：signSession 用同一 now → iat/exp/sfa 与本地载荷逐值一致
        const fresh: SessionPayload = {
          ...p,
          scopes,
          iat: now,
          exp: now + SESSION_TTL_SEC,
          sfa: now,
        }
        const reissued = await signSession(fresh, deps.sessionSecret, now)
        c.res.headers.append('Set-Cookie', serializeSessionCookie(reissued))
        c.set('session', fresh)
        c.set('identity', toIdentity(fresh))
      } else {
        // 刷新未命中 / 命中但 Casdoor 故障降级 → 沿用原会话原 cookie
        c.set('session', p)
        c.set('identity', toIdentity(p))
      }
    }
    await next()
  })
