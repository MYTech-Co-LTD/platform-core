// routes/api-keys.ts — /api/platform/keys：个人 Key（通道 B，PAT）管理面。issue #894，正典 §1.5。
//
// **为什么在宿主**：token 是平台级身份能力（「每个账号生成 token」），原长在 modules/data 的
// schema 里（`data.query_keys` + 问数的 console 页），2026-10-18 上移。本文件是它的新管理面。
//
// 两档（正典 §1.5 定案②，**不新增权限码**）：
//   · **个人档**（`/`）：任何已认证账号管**自己的** key——**免 scope**（发 token 不提权：
//     它只承载该账号自己的 scopes，能做什么仍由 Casdoor 实时权限决定）。
//   · **管理档**（`/all`）：`tenant:admin` 看/吊销**全租户**的 key。
//
// 归属钉死：org 取 `c.get('tenant').casdoor_org`、用户取 `c.get('identity').userId`——
// 请求参数里**没有任何能改变归属的口子**（越界是结构上不可能，不是「校验拦截」）。
// 写操作带 `x-csrf-token`（照 admin 路由先例；**比它替代的旧模块路由更严**——旧路由没有 CSRF）。
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { csrfToken } from '@platform/auth-core'
import { requireScope } from '@platform/sdk'
import type { SessionEnv } from '../session-middleware'
import type { TenantEnv } from '../tenant'
import {
  MAX_KEY_NAME_LEN,
  createPatKey,
  listPatKeys,
  listPatKeysInOrg,
  revokePatKey,
  revokePatKeyInOrg,
} from '../api-key-store'

export interface ApiKeyRoutesDeps {
  pool: Pool
  sessionSecret: string
}

export function apiKeyRoutes(deps: ApiKeyRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()

  // CSRF：写操作必须带与当前会话一致的 x-csrf-token（会话重签会轮换——前端每次现取 /session）
  app.use('*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method)) {
      const s = c.get('session')
      if (!s || c.req.header('x-csrf-token') !== csrfToken(s, deps.sessionSecret)) {
        return c.json({ error: 'CSRF' }, 403)
      }
    }
    await next()
  })

  // ── 管理档：**必须注册在 `/:id` 之前**，否则 `:id` 会把 'all' 吃掉 ──
  app.get('/all', requireScope('tenant:admin'), async (c) => {
    const org = c.get('tenant').casdoor_org
    return c.json({ keys: await listPatKeysInOrg(deps.pool, org) })
  })

  app.delete('/all/:id', requireScope('tenant:admin'), async (c) => {
    const org = c.get('tenant').casdoor_org
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'BAD_ID' }, 400)
    const ok = await revokePatKeyInOrg(deps.pool, org, id)
    return ok ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  // ── 个人档：免 scope（登录即可）──

  app.get('/', async (c) => {
    const org = c.get('tenant').casdoor_org
    const user = c.get('identity').userId
    return c.json({ keys: await listPatKeys(deps.pool, org, user) })
  })

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown } | null
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (name.length === 0 || name.length > MAX_KEY_NAME_LEN) {
      return c.json({ error: 'BAD_NAME', limit: MAX_KEY_NAME_LEN }, 400)
    }
    const org = c.get('tenant').casdoor_org
    const user = c.get('identity').userId
    // 明文 token **只在本响应里出现这一次**，之后库里只有哈希（前端也只显示一次，刷新即失）
    const { id, token } = await createPatKey(deps.pool, org, user, name)
    return c.json({ id, token }, 201)
  })

  app.delete('/:id', async (c) => {
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id)) return c.json({ error: 'BAD_ID' }, 400)
    const org = c.get('tenant').casdoor_org
    const user = c.get('identity').userId
    // 带 casdoor_user：**不带就能吊销别人的 key**（旧实现注释同款约束，搬过来不放松）
    const ok = await revokePatKey(deps.pool, org, user, id)
    return ok ? c.json({ ok: true }) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  return app
}
