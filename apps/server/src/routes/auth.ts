// routes/auth.ts — 账密登录/登出/会话（登录链路五路归一的账密路；企微路在 Task 14）
//
// 所有登录路径产出同一 platform_session cookie，模块永远只见 ctx.identity（Task 9）。
// 路由挂在租户中间件（c.get('tenant')）与会话中间件（c.get('session')）之后：
//  - POST /login  body {username,password}（登录本身免 CSRF：尚未有会话，SameSite=Lax + POST 已足）
//  - POST /logout 要求 header x-csrf-token 与 csrfToken(session) 一致（防跨站强制登出）
//  - GET  /session 会话自画像（前端 csrf token 的取用口）
//
// sub 语义：CasdoorClient.getUser 不回 UUID，sub 用 org 内唯一的 name——与旧 gateway
// relay JWT（sub=String(userId)，userId 即用户名）同语义，UUID 化待客户端扩展时统一切换。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { csrfToken, effectiveScopes, signSession } from '@platform/auth-core'
import type { TenantEnv } from '../tenant'
import {
  clearSessionCookie,
  serializeSessionCookie,
  type CasdoorFactory,
  type SessionEnv,
} from '../session-middleware'

export interface AuthRoutesDeps {
  /** org 随租户变：multi 模式下各租户各自的 Casdoor org（c.get('tenant').casdoor_org） */
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
}

/**
 * 入参长度上限：超长一律按坏凭据 401 且【不调 Casdoor、audit 不落原样长串】——
 * 防用巨型凭据刷 Casdoor 带宽 / 灌 audit 表（audit 刷量面）。Casdoor 侧用户名/密码
 * 上限远低于此，真实用户不可能触达。
 */
const MAX_USERNAME_LEN = 256
const MAX_PASSWORD_LEN = 512

/** 登录审计一行（platform.audit；失败也 await——审计写不进去就不该继续发会话） */
async function writeAudit(
  pool: Pool,
  tenantId: number,
  actor: string,
  action: 'login.ok' | 'login.fail',
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [tenantId, actor, action, detail],
  )
}

export function authRoutes(deps: AuthRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()

  app.post('/login', async (c) => {
    const t = c.get('tenant')
    const body = (await c.req.json().catch(() => null)) as {
      username?: unknown
      password?: unknown
    } | null
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    // 形状不对也按坏凭据处理（401 不区分原因，不泄探查面）
    if (!username || !password) {
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }
    if (username.length > MAX_USERNAME_LEN || password.length > MAX_PASSWORD_LEN) {
      // 超长：不调 Casdoor；audit 记 login.fail 但 actor 截断到 256（有界写入，超长串
      // 绝不原样入库）+ detail 标 reason:'oversized'——与真实坏凭据失败可区分可过滤
      await writeAudit(
        deps.pool,
        t.id,
        username.slice(0, MAX_USERNAME_LEN),
        'login.fail',
        { via: 'password', reason: 'oversized' },
      )
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }

    const casdoor = deps.casdoor(t.casdoor_org)
    let name: string | null
    try {
      name = (await casdoor.verifyPassword(username, password))?.name ?? null
    } catch {
      // 传输层故障（网络/5xx）≠ 坏凭据：502 如实暴露，不记 login.fail（非用户过错）
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)
    }
    if (name === null) {
      await writeAudit(deps.pool, t.id, username, 'login.fail', { via: 'password' })
      return c.json({ error: 'BAD_CREDENTIALS' }, 401)
    }

    // 有效会话必须带可信 scopes：取不到就拒绝登录（fail loudly；已持有会话者的刷新降级
    // 在会话中间件做——可用性优先的边界划在那里，不在签发口）
    let scopes: string[]
    try {
      const [user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
      scopes = effectiveScopes(name, user?.roles ?? [], perms)
    } catch {
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 502)
    }

    const now = Math.floor(Date.now() / 1000)
    const token = await signSession(
      { sub: name, org: t.casdoor_org, name, scopes, authVia: 'password' },
      deps.sessionSecret,
      now,
    )
    // 审计先行（M-4）：插入抛错 → 500 且未发任何会话 cookie——审计与发证保持原子序，
    // 不留"登录已记账失败但浏览器已拿到新会话"的窗口
    await writeAudit(deps.pool, t.id, name, 'login.ok', { via: 'password' })
    c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
    return c.json({ ok: true })
  })

  app.post('/logout', (c) => {
    const s = c.get('session')
    if (!s) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    if (c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
      // fail-closed：会话中间件可能在本次请求重签过（新 iat→新 csrf），持有旧 csrf 的客户端
      // 会 403——安全侧正确，客户端经 GET /session 重取 csrf 即恢复
      return c.json({ error: 'CSRF' }, 403)
    }
    // 与签发同属性 + Max-Age=0；若中间件本次已重签（Set-Cookie 在前），浏览器按序应用，
    // 清除 cookie 排最后生效
    c.res.headers.append('Set-Cookie', clearSessionCookie())
    return c.json({ ok: true })
  })

  app.get('/session', (c) => {
    const s = c.get('session')
    if (!s) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    return c.json({
      // 载荷无 displayName 槽位（auth-core 形状已冻结），M0 以 name 兜位
      user: { id: s.sub, name: s.name, displayName: s.name },
      org: s.org,
      scopes: s.scopes,
      csrfToken: csrfToken(s, deps.sessionSecret),
    })
  })

  return app
}
