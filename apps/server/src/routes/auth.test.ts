// auth.test.ts — 会话中间件 + 账密登录/登出/会话路由（TDD）
//
// 真 PG（本地 docker platform-pg，同 tenant.test.ts 约定）+ MockCasdoor（真实 HTTP）：
// 未提供 DATABASE_URL 时整体跳过。覆盖简报 ①-⑦ + 三条安全硬语义：
// 过期自检（Task 6 契约）/ 跨租户 cookie 不认 / Casdoor 故障降级与用户不存在清会话。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { testClient } from 'hono/testing'
import { fileURLToPath } from 'node:url'
import {
  SCOPES_TTL_SEC,
  SESSION_TTL_SEC,
  CasdoorClient,
  csrfToken,
  signSession,
  verifySession,
} from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { runMigrations } from '../migrate'
import { seedDemo } from '../seed'
import { resolveTenantMiddleware, type TenantEnv } from '../tenant'
import { sessionMiddleware, type SessionEnv } from '../session-middleware'
import { authRoutes } from './auth'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-session-secret-0123456789abcdef' // ≥32 字符，测试专用

// MockCasdoor 种子：alice 直挂 ticket:view + 经 ops 角色挂 ticket:admin
const mock = new MockCasdoor({
  users: [{ name: 'alice', password: 'pw', roles: ['ops'], displayName: 'Alice' }],
  perms: [
    { name: 'p-view', users: ['alice'], resources: ['ticket:view'] },
    { name: 'p-admin', roles: ['ops'], resources: ['ticket:admin'] },
  ],
})

// casdoor 工厂：按 org 现取 mock.origin（stop/start 换端口后自愈）；每请求新实例（构造零成本）
function casdoorFor(org: string): CasdoorClient {
  return new CasdoorClient({
    origin: mock.origin,
    clientId: 'test-client',
    clientSecret: '',
    org,
    adminUser: 'admin',
    adminPwd: 'pw',
  })
}

type AppClient = ReturnType<typeof testClient<ReturnType<typeof makeApp>>>

function makeApp(pool: Pool): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  app.use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
  app.use('*', sessionMiddleware({ casdoor: casdoorFor, sessionSecret: SECRET }))
  app.route('/api/platform/auth', authRoutes({ casdoor: casdoorFor, sessionSecret: SECRET, pool }))
  return app
}

function setCookies(res: Response): string[] {
  return typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie') ?? ''].filter(Boolean)
}

function sessionToken(res: Response): string {
  const m = /platform_session=([^;]+)/.exec(setCookies(res).join('\n'))
  if (!m) throw new Error('response has no platform_session Set-Cookie')
  return m[1]!
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

async function loginOk(client: AppClient): Promise<string> {
  const res = await client.api.platform.auth.login.$post(
    { json: { username: 'alice', password: 'pw' } },
    { headers: { host: 'acme.test' } },
  )
  expect(res.status).toBe(200)
  return sessionToken(res)
}

describe.skipIf(!dbUrl)('会话中间件 + 账密登录/登出/会话', () => {
  let pool: Pool
  let client: AppClient

  beforeAll(async () => {
    await mock.start()
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('../migrations', import.meta.url)))
    await seedDemo(pool)
    client = testClient(makeApp(pool))
  })

  afterAll(async () => {
    await mock.stop()
    await pool.end()
  })

  // ① 登录成功 → 会话 cookie 形状（host-only 无 Domain 是硬约束）
  it('登录成功：Set-Cookie 含 platform_session= 且无 Domain=；HttpOnly/Secure/SameSite=Lax/Path=/Max-Age', async () => {
    const res = await client.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const sc = setCookies(res).join('\n')
    expect(sc).toContain('platform_session=')
    expect(sc).not.toContain('Domain=') // host-only：不带 Domain 属性
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Secure')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).toContain('Path=/')
    expect(sc).toContain(`Max-Age=${SESSION_TTL_SEC}`)
  })

  // ② 错密码
  it('错密码：401 {"error":"BAD_CREDENTIALS"}', async () => {
    const res = await client.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'wrong' } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'BAD_CREDENTIALS' })
  })

  // ③ 带 cookie 调 /session
  it('带会话 cookie 调 /session：user/org/scopes/csrfToken（csrf 与载荷绑定可复算）', async () => {
    const token = await loginOk(client)
    const res = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${token}` },
    })
    expect(res.status).toBe(200)
    const p = await verifySession(token, SECRET)
    expect(p).not.toBeNull() // ① 下发的 cookie 本身可验签
    expect(await res.json()).toEqual({
      user: { id: 'alice', name: 'alice', displayName: 'alice' },
      org: 'acme',
      scopes: ['ticket:admin', 'ticket:view'], // 直挂 ∪ 角色，排序去重
      csrfToken: csrfToken(p!, SECRET),
    })
  })

  // ④ 登出（正确 csrf）
  it('登出（正确 csrf）：{ok:true} + 清 cookie（Max-Age=0 同属性）；随后 /session 401', async () => {
    const token = await loginOk(client)
    const sres = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${token}` },
    })
    const { csrfToken: csrf } = await sres.json()
    const out = await client.api.platform.auth.logout.$post(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${token}`, 'x-csrf-token': csrf },
    })
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ ok: true })
    const sc = setCookies(out).join('\n')
    expect(sc).toContain('platform_session=')
    expect(sc).toContain('Max-Age=0')
    // 浏览器执行清除后不再携带 cookie → 未登录
    const after = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(after.status).toBe(401)
    expect(await after.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  // ⑤ 错 csrf 登出
  it('登出错 csrf：403 {"error":"CSRF"}', async () => {
    const token = await loginOk(client)
    const out = await client.api.platform.auth.logout.$post(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${token}`, 'x-csrf-token': 'deadbeef' },
    })
    expect(out.status).toBe(403)
    expect(await out.json()).toEqual({ error: 'CSRF' })
  })

  // ⑥ scopes 刷新（简报做法：signSession 注入历史 now 造 sfa 过期 token——exp 仍在未来且剩 >6 天，
  //    只触发 scope 刷新不触发续期；旧 token 的 scopes 是 Casdoor 里不存在的 stale 值）
  it('scopes 刷新：sfa 过期(>=300s) → getUser+getPermissions+effectiveScopes 重算并重签', async () => {
    const now = nowSec()
    const stale = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: ['stale:scope'], authVia: 'password' },
      SECRET,
      now - SCOPES_TTL_SEC - 60,
    )
    const res = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${stale}` },
    })
    expect(res.status).toBe(200)
    const fresh = sessionToken(res) // 重签后的新 cookie
    const p = await verifySession(fresh, SECRET)
    expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view']) // stale 被替换为 Casdoor 真值
    expect(p!.sfa).toBeGreaterThanOrEqual(now) // sfa 已刷新（新签发时刻）
    expect((await res.json()).scopes).toEqual(['ticket:admin', 'ticket:view']) // 本请求即见新 scopes
  })

  // ⑦ audit 两行入库
  it('audit：login.fail 与 login.ok 各一行入库（tenant_id=acme、actor=alice）', async () => {
    await client.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'wrong' } },
      { headers: { host: 'acme.test' } },
    )
    await loginOk(client)
    const { rows } = await pool.query<{ action: string; actor: string; tenant_id: number }>(
      `select action, actor, tenant_id from platform.audit
        where action in ('login.ok','login.fail') order by id desc limit 2`,
    )
    expect(rows.map((r) => r.action)).toEqual(['login.ok', 'login.fail'])
    expect(rows.every((r) => r.actor === 'alice')).toBe(true)
    const acme = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug='acme'",
    )
    expect(rows.every((r) => r.tenant_id === acme.rows[0]!.id)).toBe(true)
  })

  // ⑧ Task 6 契约：verifySession 仅验签——过期拒绝必须来自中间件 exp 自检
  it('过期会话（验签通过但 exp<=now）：401 UNAUTHENTICATED，不注 identity', async () => {
    const token = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: ['ticket:view'], authVia: 'password' },
      SECRET,
      nowSec() - SESSION_TTL_SEC - 60,
    )
    expect(await verifySession(token, SECRET)).not.toBeNull() // 验签确实通过
    const res = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${token}` },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  // ⑨ 跨租户 cookie：host-only 防跨域，但同 host 部署形态下 org 不符的会话也不认
  it('跨租户 cookie（org=acme 会话打到 beta.test）：401 不认', async () => {
    const token = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: [], authVia: 'password' },
      SECRET,
    )
    const res = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'beta.test', cookie: `platform_session=${token}` },
    })
    expect(res.status).toBe(401)
  })

  // ⑩ Casdoor 故障降级：sfa 过期但 Casdoor 不可达 → 用旧 scopes 继续，不阻塞不崩不重签
  it('Casdoor 不可达：降级旧 scopes 继续（200、无重签 Set-Cookie）', async () => {
    const stale = await signSession(
      { sub: 'alice', org: 'acme', name: 'alice', scopes: ['old:scope'], authVia: 'password' },
      SECRET,
      nowSec() - SCOPES_TTL_SEC - 60,
    )
    await mock.stop()
    try {
      const res = await client.api.platform.auth.session.$get(undefined, {
        headers: { host: 'acme.test', cookie: `platform_session=${stale}` },
      })
      expect(res.status).toBe(200)
      expect(setCookies(res)).toEqual([]) // 未重签（重签会假装 sfa 已刷新，遮蔽故障）
      expect((await res.json()).scopes).toEqual(['old:scope'])
    } finally {
      await mock.start() // 换端口重启；工厂按 mock.origin 现取，自愈
    }
  })

  // ⑪ Casdoor 明确"用户不存在"（getUser=null 且非传输故障）→ 唯一的清会话分支
  it('Casdoor 明确用户不存在：清会话 cookie（Max-Age=0）+ 401', async () => {
    const stale = await signSession(
      { sub: 'ghost', org: 'acme', name: 'ghost', scopes: ['x:y'], authVia: 'password' },
      SECRET,
      nowSec() - SCOPES_TTL_SEC - 60,
    )
    const res = await client.api.platform.auth.session.$get(undefined, {
      headers: { host: 'acme.test', cookie: `platform_session=${stale}` },
    })
    expect(res.status).toBe(401)
    expect(setCookies(res).join('\n')).toContain('Max-Age=0')
  })
})
