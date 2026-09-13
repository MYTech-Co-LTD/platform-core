// routes/admin.test.ts — /api/platform/admin/*（M3，spec D4/D9，issue #46）
//
// 组装方式：tenant/session/identity 三注入替身（真实链路 = 租户解析→会话中间件）+ adminRoutes。
// 断言四条结构锁：① org 只来自 tenant.casdoor_org（fake casdoor 记录收到的 org）；
// ② 无 tenant:admin 一律 403；③ 写操作必须 x-csrf-token；④ 锚用户 tenantsub 四不可。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { csrfToken, type CasdoorClient } from '@platform/auth-core'
import type { Identity } from '@platform/sdk'
import type { Pool } from 'pg'
import type { TenantRow } from '../tenant'
import type { SessionPayload } from '@platform/auth-core'
import { adminRoutes, ANCHOR_USER, type AdminRoutesDeps } from './admin'

// ---- 替身 ----

interface FakeCasdoorCalls {
  listUsersOrgs: string[]
  created: Array<{ org: string; input: { name: string; displayName?: string; password: string } }>
  forbidden: Array<{ org: string; name: string; forbidden: boolean }>
  reset: Array<{ org: string; name: string; password: string }>
  deleted: Array<{ org: string; name: string }>
}

function fakeCasdoor(
  users: Array<{ name: string; displayName: string; isForbidden: boolean }> = [],
  calls: FakeCasdoorCalls = { listUsersOrgs: [], created: [], forbidden: [], reset: [], deleted: [] },
): (org: string) => CasdoorClient {
  // 每次 casdoor(org) 直接捕获该 org——断言「org 只来自 tenant.casdoor_org」的唯一观测口
  return (org: string) =>
    ({
      async listUsers() {
        calls.listUsersOrgs.push(org)
        return users
      },
      async createManagedUser(input: { name: string; displayName?: string; password: string }) {
        calls.created.push({ org, input })
      },
      async setUserForbidden(name: string, forbidden: boolean) {
        calls.forbidden.push({ org, name, forbidden })
      },
      async resetUserPassword(name: string, password: string) {
        calls.reset.push({ org, name, password })
      },
      async deleteUser(name: string) {
        calls.deleted.push({ org, name })
      },
    }) as unknown as CasdoorClient
}

function fakePool(): { pool: Pool; audits: Array<{ sql: string; params: unknown[] }> } {
  const audits: Array<{ sql: string; params: unknown[] }> = []
  const pool = {
    async query(sql: string, params?: unknown[]) {
      audits.push({ sql, params: params ?? [] })
      return { rows: [] }
    },
  } as unknown as Pool
  return { pool, audits }
}

const baseTenant: TenantRow = {
  id: 1, slug: 'my', casdoor_org: 'myorg', product_name: 'P', logo: null,
  primary_color: '#1677ff', background: '', login_methods: ['password'],
  wecom_corp_id: null, wecom_agent_id: null, wecom_secret: null, wecom_provider: null,
  wecom_auto_signup: false, created_at: new Date(),
}

const SESSION_SECRET = 'x'.repeat(32)

type TestEnv = { Variables: { tenant: TenantRow; session: SessionPayload; identity: Identity } }

function mount(
  deps: AdminRoutesDeps,
  opts: { scopes: string[]; user?: string } = { scopes: [] },
): Hono<TestEnv> {
  const user = opts.user ?? 'admin1'
  const app = new Hono<TestEnv>()
  app.use('*', createMiddleware<TestEnv>(async (c, next) => {
    const s: SessionPayload = {
      sub: user, org: 'myorg', name: user, scopes: opts.scopes,
      authVia: 'password', iat: 1, exp: 9_999_999_999, sfa: 1,
    }
    c.set('tenant', baseTenant)
    c.set('session', s)
    c.set('identity', {
      userId: user, orgId: 'myorg', displayName: user, scopes: opts.scopes,
      hasScope: (code) => opts.scopes.includes(code),
    })
    await next()
  }))
  app.route('/api/platform/admin', adminRoutes(deps))
  return app
}

const CSRF = csrfToken(
  { sub: 'admin1', org: 'myorg', name: 'admin1', scopes: [], authVia: 'password', iat: 1, exp: 9_999_999_999, sfa: 1 },
  SESSION_SECRET,
)
const withCsrf = { 'x-csrf-token': CSRF, 'Content-Type': 'application/json' }

function deps(overrides: Partial<AdminRoutesDeps> = {}): AdminRoutesDeps & { audits: unknown[] } {
  const { pool, audits } = fakePool()
  return {
    casdoor: fakeCasdoor(),
    sessionSecret: SESSION_SECRET,
    pool,
    permissions: () => [
      { code: 'tenant:admin', name: '租户管理员' },
      { code: 'demo:view', name: '演示查看' },
    ],
    modules: () => [{ id: 'demo', name: '演示模块' }],
    ...overrides,
    audits,
  } as AdminRoutesDeps & { audits: unknown[] }
}

// ---- 门禁 ----

describe('admin 路由：门禁与结构锁', () => {
  it('无 tenant:admin → 403 FORBIDDEN need=tenant:admin（连 casdoor 都不该被调用）', async () => {
    const d = deps()
    const app = mount(d, { scopes: ['demo:view'] })
    const res = await app.request('/api/platform/admin/users')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'tenant:admin' })
  })

  it('GET /users 过滤锚用户 tenantsub，org 取自 tenant.casdoor_org', async () => {
    const calls = { listUsersOrgs: [] as string[], created: [], forbidden: [], reset: [], deleted: [] }
    const d = deps({ casdoor: fakeCasdoor([
      { name: ANCHOR_USER, displayName: 'Tenant Subscription Anchor', isForbidden: true },
      { name: 'alice', displayName: 'Alice', isForbidden: false },
    ], calls) })
    const app = mount(d, { scopes: ['tenant:admin'] })
    const res = await app.request('/api/platform/admin/users')
    expect(await res.json()).toEqual({ users: [{ name: 'alice', displayName: 'Alice', isForbidden: false }] })
    expect(calls.listUsersOrgs).toEqual(['myorg'])
  })
})

describe('admin 路由：用户 CRUD', () => {
  it('POST /users 校验：用户名仅字母数字、密码≥8、拒锚用户名', async () => {
    const app = mount(deps(), { scopes: ['tenant:admin'] })
    const bad = [
      { username: 'bad_name', password: 'LongEnough1' },
      { username: ANCHOR_USER, password: 'LongEnough1' },
      { username: 'okname', password: 'short' },
    ]
    for (const body of bad) {
      const res = await app.request('/api/platform/admin/users', { method: 'POST', headers: withCsrf, body: JSON.stringify(body) })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'INVALID' })
    }
  })

  it('写操作缺/错 x-csrf-token → 403 CSRF', async () => {
    const app = mount(deps(), { scopes: ['tenant:admin'] })
    const none = await app.request('/api/platform/admin/users', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'okname', password: 'LongEnough1' }),
    })
    expect(none.status).toBe(403)
    expect(await none.json()).toEqual({ error: 'CSRF' })
    const wrong = await app.request('/api/platform/admin/users', {
      method: 'POST', headers: { 'x-csrf-token': 'deadbeef', 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'okname', password: 'LongEnough1' }),
    })
    expect(wrong.status).toBe(403)
  })

  it('POST /users 成功：201 + audit（action=admin.user.create，detail 无密码）', async () => {
    const calls = { listUsersOrgs: [] as string[], created: [], forbidden: [] as unknown[], reset: [], deleted: [] }
    const d = deps({ casdoor: fakeCasdoor([], calls) })
    const app = mount(d, { scopes: ['tenant:admin'] })
    const res = await app.request('/api/platform/admin/users', {
      method: 'POST', headers: withCsrf, body: JSON.stringify({ username: 'carol', displayName: 'Carol', password: 'InitPass123' }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ name: 'carol' })
    expect(calls.created).toEqual([{ org: 'myorg', input: { name: 'carol', displayName: 'Carol', password: 'InitPass123' } }])
    const audit = (d.audits as Array<{ sql: string; params: unknown[] }>).find((a) => a.sql.includes('platform.audit'))
    expect(audit?.params[2]).toBe('admin.user.create')
    expect(JSON.stringify(audit?.params[3])).not.toContain('InitPass123')
  })

  it('PATCH /users/:name：锚用户 400 FORBIDDEN_TARGET；正常禁用写 audit', async () => {
    const calls = { listUsersOrgs: [] as string[], created: [], forbidden: [], reset: [], deleted: [] }
    const d = deps({ casdoor: fakeCasdoor([], calls) })
    const app = mount(d, { scopes: ['tenant:admin'] })
    const anchor = await app.request(`/api/platform/admin/users/${ANCHOR_USER}`, {
      method: 'PATCH', headers: withCsrf, body: JSON.stringify({ isForbidden: true }),
    })
    expect(anchor.status).toBe(400)
    expect(await anchor.json()).toEqual({ error: 'FORBIDDEN_TARGET' })
    const ok = await app.request('/api/platform/admin/users/alice', {
      method: 'PATCH', headers: withCsrf, body: JSON.stringify({ isForbidden: true }),
    })
    expect(await ok.json()).toEqual({ name: 'alice' })
    expect(calls.forbidden).toEqual([{ org: 'myorg', name: 'alice', forbidden: true }])
  })

  it('PATCH /users/:name/password：短密码 400；成功不把密码写进 audit', async () => {
    const calls = { listUsersOrgs: [] as string[], created: [], forbidden: [] as unknown[], reset: [], deleted: [] }
    const d = deps({ casdoor: fakeCasdoor([], calls) })
    const app = mount(d, { scopes: ['tenant:admin'] })
    const bad = await app.request('/api/platform/admin/users/alice/password', {
      method: 'PATCH', headers: withCsrf, body: JSON.stringify({ password: 'short' }),
    })
    expect(bad.status).toBe(400)
    await app.request('/api/platform/admin/users/alice/password', {
      method: 'PATCH', headers: withCsrf, body: JSON.stringify({ password: 'NewPass456' }),
    })
    expect(calls.reset).toEqual([{ org: 'myorg', name: 'alice', password: 'NewPass456' }])
    const audits = d.audits as Array<{ sql: string; params: unknown[] }>
    expect(JSON.stringify(audits.map((a) => a.params[3]))).not.toContain('NewPass456')
  })

  it('DELETE /users/:name：删自己与删锚用户 400；正常删除写 audit', async () => {
    const calls = { listUsersOrgs: [] as string[], created: [], forbidden: [] as unknown[], reset: [] as unknown[], deleted: [] }
    const d = deps({ casdoor: fakeCasdoor([], calls) })
    const app = mount(d, { scopes: ['tenant:admin'] })
    expect((await app.request('/api/platform/admin/users/admin1', { method: 'DELETE', headers: withCsrf })).status).toBe(400)
    expect((await app.request(`/api/platform/admin/users/${ANCHOR_USER}`, { method: 'DELETE', headers: withCsrf })).status).toBe(400)
    const ok = await app.request('/api/platform/admin/users/bob', { method: 'DELETE', headers: withCsrf })
    expect(await ok.json()).toEqual({ name: 'bob' })
    expect(calls.deleted).toEqual([{ org: 'myorg', name: 'bob' }])
  })
})
