// routes/admin.ts — /api/platform/admin/*：租户管理员代理（spec D4/D9，M3，issue #46）
//
// 三条结构锁死，不靠约定：
//  ① org 永远取自 c.get('tenant').casdoor_org——请求参数里没有任何能改变 org 的口子
//    （越界即结构上不可能，不是"校验拦截"）；
//  ② 整路由 requireScope('tenant:admin')——未挂码者连路由形状都探不到；
//  ③ 写操作（POST/PATCH/DELETE）校验 x-csrf-token 与当前会话一致（与 /logout 同款，防跨站强制管理）。
// 锚用户 tenantsub 不可见/不可改/不可删/不可授权（spec §6.2）。密码类敏感值不进 audit、不进日志。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { csrfToken } from '@platform/auth-core'
import { requireScope } from '@platform/sdk'
import type { TenantEnv } from '../tenant'
import type { CasdoorFactory, SessionEnv } from '../session-middleware'

/** 订阅锚用户名（casdoor-client ensureAnchorUser 同款；单处定义防漂移） */
export const ANCHOR_USER = 'tenantsub'

export interface AdminRoutesDeps {
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
  /** 权限码全集（平台内置 + 已装载模块）——授权页的可见宇宙 */
  permissions: () => ReadonlyArray<{ code: string; name: string }>
  /** 已装载模块（订阅页把 mod-<id> 映射回模块名） */
  modules: () => Array<{ id: string; name: string }>
}

/** 管理动作审计（platform.audit；与 auth.ts writeAudit 同款——await、失败即断） */
async function writeAudit(
  pool: Pool,
  tenantId: number,
  actor: string,
  action: 'admin.user.create' | 'admin.user.update' | 'admin.user.delete' | 'admin.grant' | 'admin.revoke',
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [tenantId, actor, action, detail],
  )
}

export function adminRoutes(deps: AdminRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  // ② scope 门禁：整路由（未挂码 403 {error:'FORBIDDEN',need:'tenant:admin'}）
  app.use('*', requireScope('tenant:admin'))
  // ③ CSRF：写操作必须带与当前会话一致的 x-csrf-token（会话重签会轮换——前端每次现取 /session）
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const s = c.get('session')
      if (!s || c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
        return c.json({ error: 'CSRF' }, 403)
      }
    }
    await next()
  })

  // ---- 用户管理 ----

  app.get('/users', async (c) => {
    const org = c.get('tenant').casdoor_org
    const users = (await deps.casdoor(org).listUsers()).filter((u) => u.name !== ANCHOR_USER)
    return c.json({ users })
  })

  app.post('/users', async (c) => {
    const body = await c.req.json<{ username?: unknown; displayName?: unknown; password?: unknown }>().catch(() => null)
    const username = typeof body?.username === 'string' ? body.username : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    const displayName = typeof body?.displayName === 'string' && body.displayName ? body.displayName : undefined
    // 用户名仅字母数字（Casdoor 用户名字符集实测拒绝 `_`，spec §1.2）；密码下限 8
    if (!/^[A-Za-z0-9]+$/.test(username) || username === ANCHOR_USER || password.length < 8) {
      return c.json({ error: 'INVALID' }, 400)
    }
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).createManagedUser({ name: username, displayName, password })
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.create', { user: username })
    return c.json({ name: username }, 201)
  })

  app.patch('/users/:name', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const body = await c.req.json<{ isForbidden?: unknown }>().catch(() => null)
    if (!body || typeof body.isForbidden !== 'boolean') return c.json({ error: 'INVALID' }, 400)
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).setUserForbidden(name, body.isForbidden)
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.update', { user: name, isForbidden: body.isForbidden })
    return c.json({ name })
  })

  app.patch('/users/:name/password', async (c) => {
    const name = c.req.param('name')
    if (name === ANCHOR_USER) return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    const body = await c.req.json<{ password?: unknown }>().catch(() => null)
    const password = typeof body?.password === 'string' ? body.password : ''
    if (password.length < 8) return c.json({ error: 'INVALID' }, 400)
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).resetUserPassword(name, password)
    // 密码绝不进 detail（敏感值规矩）
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.update', { user: name, reset: true })
    return c.json({ name })
  })

  app.delete('/users/:name', async (c) => {
    const name = c.req.param('name')
    // 锚用户不可删；自己不可删自己（防管理员误自杀——交接先授权他人）
    if (name === ANCHOR_USER || name === c.get('identity').userId) {
      return c.json({ error: 'FORBIDDEN_TARGET' }, 400)
    }
    const t = c.get('tenant')
    await deps.casdoor(t.casdoor_org).deleteUser(name)
    await writeAudit(deps.pool, t.id, c.get('identity').userId, 'admin.user.delete', { user: name })
    return c.json({ name })
  })

  return app
}
