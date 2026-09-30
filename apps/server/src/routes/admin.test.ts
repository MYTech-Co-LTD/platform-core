// routes/admin.test.ts — /api/platform/admin/*（M3，spec D4/D9，issue #46）
//
// 组装方式：tenant/session/identity 三注入替身（真实链路 = 租户解析→会话中间件）+ adminRoutes。
// 断言四条结构锁：① org 只来自 tenant.casdoor_org（fake casdoor 记录收到的 org）；
// ② 无 tenant:admin 一律 403；③ 写操作必须 x-csrf-token；④ 锚用户 tenantsub 四不可。
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { csrfToken, type CasdoorClient } from '@platform/auth-core'
import type { Identity } from '@platform/sdk'
import type { Pool } from 'pg'
import type { TenantRow } from '../tenant'
import type { SessionPayload } from '@platform/auth-core'
import { adminRoutes, ANCHOR_USER, type AdminRoutesDeps } from './admin'

// ---- 替身 ----

/** 替身**收到的调用台账**（断言「org 只来自 tenant.casdoor_org」的观测口）。
 *  用例里一律显式注这个类型（`const calls: FakeCasdoorCalls = {…}`），别写 `[] as unknown[]`
 *  ——那会把手误写成 `unknown[]`、让台账与这里的形状悄悄脱钩（issue #68 Step 3 清掉的
 *  3 条 TS2345 就是它）。注了之后五个数组的形状由本接口一次性钉死。 */
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
  wecom_auto_signup: false,
  // 租户级微信公众号 provider（spec §1.3 外部客户身份，005）。**后加的两列**：本字面量当时
  // 没跟上 ⇒ 测试替身比真机窄（issue #68 的显形实例）。这里取 null = 未配公众号，
  // 与上面 wecom_* 的缺省口径一致（admin 域不消费这两列）。
  wechat_oa_app_id: null, wechat_oa_secret: null,
  // 五列存储配置（M3c）：本组用例要改它们 ⇒ 字面量必须写全，缺一个就 TS2741
  storage_endpoint: null, storage_region: null, storage_bucket: null,
  storage_access_key: null, storage_secret: null,
  created_at: new Date(),
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
    const calls: FakeCasdoorCalls = { listUsersOrgs: [], created: [], forbidden: [], reset: [], deleted: [] }
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
    const calls: FakeCasdoorCalls = { listUsersOrgs: [], created: [], forbidden: [], reset: [], deleted: [] }
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
    const calls: FakeCasdoorCalls = { listUsersOrgs: [], created: [], forbidden: [], reset: [], deleted: [] }
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
    const calls: FakeCasdoorCalls = { listUsersOrgs: [], created: [], forbidden: [], reset: [], deleted: [] }
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
    const calls: FakeCasdoorCalls = { listUsersOrgs: [], created: [], forbidden: [], reset: [], deleted: [] }
    const d = deps({ casdoor: fakeCasdoor([], calls) })
    const app = mount(d, { scopes: ['tenant:admin'] })
    expect((await app.request('/api/platform/admin/users/admin1', { method: 'DELETE', headers: withCsrf })).status).toBe(400)
    expect((await app.request(`/api/platform/admin/users/${ANCHOR_USER}`, { method: 'DELETE', headers: withCsrf })).status).toBe(400)
    const ok = await app.request('/api/platform/admin/users/bob', { method: 'DELETE', headers: withCsrf })
    expect(await ok.json()).toEqual({ name: 'bob' })
    expect(calls.deleted).toEqual([{ org: 'myorg', name: 'bob' }])
  })
})

// ---- 授权与订阅（Task 7）----

describe('admin 路由：角色与授权', () => {
  it('GET /permissions 只出宇宙内的码、users 映射短名并滤锚用户', async () => {
    const casdoor = (org: string) =>
      ({
        async getPermissions() {
          expect(org).toBe('myorg')
          return [
            { users: ['myorg/alice'], roles: [], resources: ['tenant:admin'] },
            { users: ['myorg/alice', `myorg/${ANCHOR_USER}`], roles: [], resources: ['demo:view'] },
            { users: ['myorg/alice'], roles: [], resources: ['other:sys'] }, // 宇宙外
          ]
        },
      }) as unknown as CasdoorClient
    const app = mount(deps({ casdoor }), { scopes: ['tenant:admin'] })
    const res = await app.request('/api/platform/admin/permissions')
    expect(await res.json()).toEqual({
      permissions: [
        { code: 'tenant:admin', name: '租户管理员', users: ['alice'] },
        { code: 'demo:view', name: '演示查看', users: ['alice'] },
      ],
    })
  })

  it('POST /permissions/:code/users：未知码 404、锚用户/非法名 400、成功写 audit admin.grant', async () => {
    const casdoor = (org: string) =>
      ({
        async grantPermissionToUser(code: string, user: string) {
          expect(org).toBe('myorg')
          return { code, user }
        },
      }) as unknown as CasdoorClient
    const d = deps({ casdoor })
    const app = mount(d, { scopes: ['tenant:admin'] })
    expect((await app.request('/api/platform/admin/permissions/nope:code/users', { method: 'POST', headers: withCsrf, body: JSON.stringify({ user: 'alice' }) })).status).toBe(404)
    expect((await app.request('/api/platform/admin/permissions/demo:view/users', { method: 'POST', headers: withCsrf, body: JSON.stringify({ user: ANCHOR_USER }) })).status).toBe(400)
    expect((await app.request('/api/platform/admin/permissions/demo:view/users', { method: 'POST', headers: withCsrf, body: JSON.stringify({ user: 'bad_name' }) })).status).toBe(400)
    const ok = await app.request('/api/platform/admin/permissions/demo:view/users', { method: 'POST', headers: withCsrf, body: JSON.stringify({ user: 'alice' }) })
    expect(await ok.json()).toEqual({ ok: true })
    const audits = d.audits as Array<{ sql: string; params: unknown[] }>
    expect(audits.at(-1)?.params[2]).toBe('admin.grant')
  })

  it('DELETE /permissions/:code/users/:user 成功写 audit admin.revoke', async () => {
    const casdoor = (org: string) =>
      ({ async revokePermissionFromUser() { expect(org).toBe('myorg') } }) as unknown as CasdoorClient
    const d = deps({ casdoor })
    const app = mount(d, { scopes: ['tenant:admin'] })
    const res = await app.request('/api/platform/admin/permissions/demo:view/users/alice', { method: 'DELETE', headers: withCsrf })
    expect(await res.json()).toEqual({ ok: true })
    const audits = d.audits as Array<{ sql: string; params: unknown[] }>
    expect(audits.at(-1)?.params[2]).toBe('admin.revoke')
  })
})

describe('admin 路由：我的订阅（只读）', () => {
  it('GET /subscriptions 映射 mod- 前缀、忽略外来订阅', async () => {
    const casdoor = (org: string) =>
      ({
        async listSubscriptions(owner: string) {
          expect(owner).toBe('myorg')
          return [
            { plan: 'myorg/mod-demo', state: 'Active', startTime: '2026-09-13T00:00:00Z', endTime: '2027-09-13T00:00:00Z' },
            { plan: 'myorg/sub_6a6def', state: 'Active', startTime: '2026-08-29T00:00:00Z', endTime: null },
          ]
        },
      }) as unknown as CasdoorClient
    const app = mount(deps({ casdoor }), { scopes: ['tenant:admin'] })
    const res = await app.request('/api/platform/admin/subscriptions')
    expect(await res.json()).toEqual({
      subscriptions: [
        { moduleId: 'demo', moduleName: '演示模块', state: 'Active', startTime: '2026-09-13T00:00:00Z', endTime: '2027-09-13T00:00:00Z' },
      ],
    })
  })
})

// ---- 租户级存储配置（M3c，正典「租户级配置注入」）----

describe('admin 路由：租户级存储配置（M3c）', () => {
  // ⚠️ baseTenant 是模块级常量：本组用例改它的五列，afterEach 必须复位（否则污染后续用例）。
  afterEach(() => {
    for (const k of ['storage_endpoint', 'storage_region', 'storage_bucket', 'storage_access_key', 'storage_secret'] as const) {
      baseTenant[k] = null
    }
  })

  // ⚠️ endpoint **故意不带协议**：下面的断言期望落库的是 `https://zos.acme.test` ⇒ 这条常量
  // 与那条断言合起来钉住「写库前必规范化」（注入侧与 storageRefOf 的相等比较都以此为基）。
  const STORAGE = { endpoint: 'zos.acme.test', region: 'xinan1', bucket: 'b1', accessKeyId: 'AKIATEST', secretAccessKey: 'sk-test' }

  /** 台账里那条 UPDATE 的 params（写库的唯一观测口 —— fakePool 不真写）。
   *  入参收 `unknown[]`：`deps().audits` 的声明是 `unknown[]`（既有形状），cast 收在助手内一处。 */
  const updateParams = (audits: unknown[]) =>
    (audits as Array<{ sql: string; params: unknown[] }>)
      .find((q) => /update\s+platform[.]tenant/i.test(q.sql) && /storage_endpoint/i.test(q.sql))?.params

  it('GET /storage：未配 ⇒ configured=false、partial=false；**响应体里没有 secret 字段**', async () => {
    const res = await mount(deps(), { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage')
    const body = await res.json()
    expect(body).toMatchObject({ configured: false, partial: false, endpoint: '', region: '', bucket: '', accessKeyIdMasked: '' })
    expect(Object.keys(body)).not.toContain('secretAccessKey')   // 字段不存在，不是「有但空」
    expect(JSON.stringify(body)).not.toContain('sk-')            // 任何形态的密钥都不该出现
  })

  it('GET /storage：部分填写 ⇒ partial=true（读侧如实暴露「库里是半套」，否则用户只看到 503）', async () => {
    baseTenant.storage_endpoint = 'https://zos.acme.test'
    baseTenant.storage_bucket = 'b1'                              // 只填两列
    const body = await (await mount(deps(), { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage')).json()
    expect(body).toMatchObject({ configured: false, partial: true, endpoint: 'https://zos.acme.test', bucket: 'b1' })
  })

  it('GET /storage：已配 ⇒ AK 只回掩码（前 4 位 + ****）、secret 仍不出现', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.acme.test', storage_region: 'xinan1', storage_bucket: 'b1',
      storage_access_key: 'AKIATEST', storage_secret: 'sk-test',
    })
    const body = await (await mount(deps(), { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage')).json()
    expect(body).toMatchObject({ configured: true, partial: false, accessKeyIdMasked: 'AKIA****' })
    expect(JSON.stringify(body)).not.toContain('sk-test')
  })

  it('PUT /storage：探测失败 ⇒ 400 STORAGE_PROBE_FAILED 且**库里纹丝不动**（写入必须在探测之后）', async () => {
    const d = deps()
    d.probe = async () => ({ ok: false, reason: 'HTTP_403', detail: 'zos.acme.test: 403' })
    const res = await mount(d, { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage', { method: 'PUT', headers: withCsrf, body: JSON.stringify(STORAGE) })
    expect(res.status).toBe(400)
    expect((await res.json())).toMatchObject({ error: 'STORAGE_PROBE_FAILED', reason: 'HTTP_403' })
    expect(updateParams(d.audits)).toBeUndefined()   // 一条 UPDATE 都没发出
  })

  it('PUT /storage：成功 ⇒ 五列落库（AK/SK 都在 params 里）+ 一条不含密钥的 audit', async () => {
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage', { method: 'PUT', headers: withCsrf, body: JSON.stringify(STORAGE) })
    expect(res.status).toBe(200)
    expect(updateParams(d.audits)).toEqual([
      'https://zos.acme.test', 'xinan1', 'b1', 'AKIATEST', 'sk-test', /* tenantId */ 1,
    ])
    const audit = (d.audits as Array<{ sql: string; params: unknown[] }>)
      .find((q) => /insert into platform[.]audit/i.test(q.sql))
    expect(audit?.params.join(' ')).not.toContain('sk-test')     // 密钥绝不进 audit
  })

  it('PUT /storage：AK/SK 留空 ⇒ 保持原值（不是清空），且探测用的是**合并后**的值', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.old.test', storage_region: 'x', storage_bucket: 'old',
      storage_access_key: 'AKIAOLD', storage_secret: 'sk-old',
    })
    const d = deps()
    let probed: { secretAccessKey: string } | null = null
    d.probe = async (cfg) => { probed = cfg; return { ok: true } }
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ endpoint: 'https://zos.new.test', region: 'x', bucket: 'new' }),  // AK/SK 不传
    })
    expect(res.status).toBe(200)
    expect(probed!.secretAccessKey).toBe('sk-old')                // 用旧值探测
    expect(updateParams(d.audits)).toEqual(['https://zos.new.test', 'x', 'new', 'AKIAOLD', 'sk-old', 1])
  })

  it('PUT /storage：未配过且 AK/SK 留空 ⇒ 400 INCOMPLETE（绝不静默存半套）', async () => {
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ endpoint: 'https://zos.new.test', region: 'x', bucket: 'new' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INCOMPLETE')
    expect(updateParams(d.audits)).toBeUndefined()
  })

  it('POST /storage/test：不写库（台账里只有 GET 与 audit 之外没有 UPDATE）', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.old.test', storage_region: 'x', storage_bucket: 'old',
      storage_access_key: 'AKIAOLD', storage_secret: 'sk-old',
    })
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage/test', {
      method: 'POST', headers: withCsrf, body: JSON.stringify({ endpoint: 'https://zos.new.test', region: 'x', bucket: 'new' }),
    })
    expect(res.status).toBe(200)
    expect(updateParams(d.audits)).toBeUndefined()                // 探测不改库
  })

  it('DELETE /storage：五列置 null（步 5 回滚路径的机检）+ audit 动作是 admin.storage.clear', async () => {
    Object.assign(baseTenant, {
      storage_endpoint: 'https://zos.old.test', storage_region: 'x', storage_bucket: 'old',
      storage_access_key: 'AKIAOLD', storage_secret: 'sk-old',
    })
    const d = deps()
    const res = await mount(d, { scopes: ['tenant:admin'] })
      .request('/api/platform/admin/storage', { method: 'DELETE', headers: withCsrf })
    expect(res.status).toBe(200)
    expect(updateParams(d.audits)).toEqual([null, null, null, null, null, 1])
    const audit = (d.audits as Array<{ sql: string; params: unknown[] }>)
      .find((q) => /audit/i.test(q.sql))
    expect(JSON.stringify(audit?.params)).toContain('admin.storage.clear')
  })

  it('PUT /storage：endpoint 里塞凭据（userinfo）⇒ 400 且不落库（凭据只能走 AK/SK 两字段）', async () => {
    const d = deps()
    d.probe = async () => ({ ok: true })
    const res = await mount(d, { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ ...STORAGE, endpoint: 'https://AKIATEST:sk-test@zos.acme.test' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID')
    // 混进 URL 的凭据会被 storageRefOf 写进**每一行** storage_ref ⇒ 必须在入口就挡住
    expect(updateParams(d.audits)).toBeUndefined()
  })

  it('写操作的 CSRF 由本文件既有的整路由中间件统一施加（存储端点不例外）', async () => {
    const res = await mount(deps(), { scopes: ['tenant:admin'] }).request('/api/platform/admin/storage', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(STORAGE),
    })
    expect(res.status).toBe(403)
  })
})

// ---- 租户已接入源登记（计划 5，spec §3⑧ 的前提）----

describe('admin 路由：租户已接入源（platform.tenant_source）', () => {
  /** 有状态替身（**仅本组**用）：既有 `fakePool` 恒回 `rows: []`，撑不起「PUT 后 GET 回读」那两条
   *  断言。这里按本组实现**发出的语句形状**维护一张极小内存表 —— 只为让回读断言可测。
   *  实现真正发出的 SQL 形状另有 params 断言独立钉住（见下「整体替换不删行」那条），不靠本替身兜底。 */
  function sourcePool() {
    const enabled = new Map<string, boolean>()
    const audits: Array<{ sql: string; params: unknown[] }> = []
    const pool = {
      async query(sql: string, params?: unknown[]) {
        audits.push({ sql, params: params ?? [] })
        if (/insert into platform[.]tenant_source/i.test(sql)) {
          for (const s of (params?.[1] ?? []) as string[]) enabled.set(s, true)
          return { rows: [] }
        }
        if (/update platform[.]tenant_source\s+set enabled = false/i.test(sql)) {
          const listed = (params?.[1] ?? []) as string[]
          for (const s of [...enabled.keys()]) if (!listed.includes(s)) enabled.set(s, false)
          return { rows: [] }
        }
        if (/select source, enabled from platform[.]tenant_source/i.test(sql)) {
          return {
            rows: [...enabled.entries()]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([source, on]) => ({ source, enabled: on })),
          }
        }
        return { rows: [] }
      },
    } as unknown as Pool
    return { pool, audits }
  }

  const sourcesPath = '/api/platform/admin/sources'

  it('★ 已接入源：PUT 整体替换 + GET 回读；非 tenant:admin 403', async () => {
    const sp = sourcePool()
    const app = mount(deps({ pool: sp.pool }), { scopes: ['tenant:admin'] })
    const put = await app.request(sourcesPath, {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ sources: ['lemeng'] }),
    })
    expect(put.status).toBe(200)
    const got = await (await app.request(sourcesPath)).json()
    expect(got.sources).toEqual([{ source: 'lemeng', enabled: true }])

    // 整体替换语义：换成另一个源 ⇒ 前一个 enabled=false（不删行，保留痕迹）
    await app.request(sourcesPath, {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ sources: [] }),
    })
    expect((await (await app.request(sourcesPath)).json()).sources)
      .toEqual([{ source: 'lemeng', enabled: false }])

    // 多余键 ⇒ 400（.strict()）
    expect((await app.request(sourcesPath, {
      method: 'PUT', headers: withCsrf,
      body: JSON.stringify({ sources: [], extra: 1 }),
    })).status).toBe(400)

    // 结构锁②：无 tenant:admin 一律 403（连路由形状都探不到）
    expect((await mount(deps(), { scopes: [] }).request(sourcesPath)).status).toBe(403)
    expect((await mount(deps(), { scopes: [] }).request(sourcesPath, {
      method: 'PUT', headers: withCsrf, body: JSON.stringify({ sources: [] }),
    })).status).toBe(403)
  })

  it('PUT 整体替换的 SQL 形状：第二句把不在列表里的置 false（不删行）+ 审计 admin.sources.update', async () => {
    const sp = sourcePool()
    const app = mount(deps({ pool: sp.pool }), { scopes: ['tenant:admin'] })
    await app.request(sourcesPath, { method: 'PUT', headers: withCsrf, body: JSON.stringify({ sources: ['lemeng'] }) })
    await app.request(sourcesPath, { method: 'PUT', headers: withCsrf, body: JSON.stringify({ sources: ['other'] }) })

    const upsert = sp.audits.find((q) => /insert into platform[.]tenant_source/i.test(q.sql))
    expect(upsert?.sql).toMatch(/on conflict \(tenant_id, source\) do update set enabled = excluded[.]enabled/)
    expect(upsert?.params).toEqual([1, ['lemeng']])
    // 「整体替换」= 覆盖句在 insert 之后单独发一次；去掉它就成了「只加不删」（变异确认点）
    const clears = sp.audits.filter((q) => /update platform[.]tenant_source set enabled = false/i.test(q.sql))
    expect(clears.at(-1)?.params).toEqual([1, ['other']])

    const audit = sp.audits.find((q) => /insert into platform[.]audit/i.test(q.sql))
    expect(JSON.stringify(audit?.params)).toContain('admin.sources.update')
  })

  it('写操作的 CSRF 由整路由中间件统一施加（源端点不例外）', async () => {
    const res = await mount(deps(), { scopes: ['tenant:admin'] }).request(sourcesPath, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sources: [] }),
    })
    expect(res.status).toBe(403)
  })
})
