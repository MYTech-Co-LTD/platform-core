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
import { sessionMiddleware, type CasdoorFactory, type SessionEnv } from '../session-middleware'
import { MAX_LOGIN_BODY_BYTES, authRoutes } from './auth'
import { USER_FAIL_LIMIT, createLoginLimiter, type LoginLimiter } from '../rate-limit'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-session-secret-0123456789abcdef' // ≥32 字符，测试专用

// MockCasdoor 种子：alice 直挂 ticket:view + 经 ops 角色挂 ticket:admin
const mock = new MockCasdoor({
  users: [{ name: 'alice', password: 'pw', roles: ['ops'], displayName: 'Alice' }],
  perms: [
    // owner 必须与租户 org 一致（host acme.test → tenant.casdoor_org='acme'）：
    // 权限按 org 分桶后，不标 owner 的码落在 MOCK_ORG 桶，org='acme' 的 client 看不到
    { owner: 'acme', name: 'p-view', users: ['alice'], resources: ['ticket:view'] },
    { owner: 'acme', name: 'p-admin', roles: ['ops'], resources: ['ticket:admin'] },
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

function makeApp(
  pool: Pool,
  casdoor: CasdoorFactory = casdoorFor,
  limiter: LoginLimiter = createLoginLimiter(),
): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  app.use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
  app.use('*', sessionMiddleware({ casdoor, sessionSecret: SECRET }))
  app.route(
    '/api/platform/auth',
    authRoutes({ casdoor, sessionSecret: SECRET, pool, limiter }),
  )
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

  // ⑫ 超长 username：401 且不调 Casdoor，audit actor 截断 + detail 标 oversized
  it('超长 username（>256）：401 BAD_CREDENTIALS，Casdoor 零调用，audit actor 截断、detail.reason=oversized', async () => {
    let factoryCalls = 0
    const c2 = testClient(
      makeApp(pool, (org) => {
        factoryCalls++
        return casdoorFor(org)
      }),
    )
    const longName = 'u'.repeat(300)
    const res = await c2.api.platform.auth.login.$post(
      { json: { username: longName, password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'BAD_CREDENTIALS' })
    expect(factoryCalls).toBe(0) // CasdoorClient 未构造 = 必然零 HTTP
    const { rows } = await pool.query<{ actor: string; detail: { reason?: string } }>(
      "select actor, detail from platform.audit where action='login.fail' order by id desc limit 1",
    )
    expect(rows[0]!.actor.length).toBeLessThanOrEqual(256) // 有界写入
    expect(rows[0]!.actor).not.toBe(longName) // 超长串绝不原样入库
    expect(rows[0]!.detail.reason).toBe('oversized') // 与真实坏凭据可区分
  })

  // ⑬ 超长 password：401 且不触 Casdoor
  it('超长 password（>512）：401 BAD_CREDENTIALS，Casdoor 零调用', async () => {
    let factoryCalls = 0
    const c2 = testClient(
      makeApp(pool, (org) => {
        factoryCalls++
        return casdoorFor(org)
      }),
    )
    const res = await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'p'.repeat(513) } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'BAD_CREDENTIALS' })
    expect(factoryCalls).toBe(0)
  })

  // ⑭ 审计先行（M-4）：审计写失败 → 500 且不发会话 cookie
  it('审计写失败：500 且响应不带会话 cookie（writeAudit 先于 Set-Cookie）', async () => {
    const poisoned = {
      query: (...args: unknown[]) => {
        if (typeof args[0] === 'string' && args[0].includes('platform.audit')) {
          return Promise.reject(new Error('audit insert failed (simulated)'))
        }
        return (pool.query as unknown as (...a: unknown[]) => unknown)(...args)
      },
    } as unknown as Pool
    const c2 = testClient(makeApp(poisoned))
    const res = await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(500)
    expect(setCookies(res)).toEqual([]) // 未发会话——审计与发证原子序
  })

  // ⑮ 限速（M1 闭债 R2）：失败达阈值 → 429，且【此后再不产生 audit 行】
  //
  // 审计断言必须按【专用 actor】计数，不能用全局 count(*)：vitest 并发跑各测试文件，
  // 别的文件同时在写/清（migrate.test.ts 的 prune 用例）platform.audit —— 全局计数会抖。
  // 这个用户名全仓只有本用例用，计数因此稳定。
  it('★ 负例：连续失败达阈值 → 429 + Retry-After，且限速挡在 audit 之前（行数不再增长）', async () => {
    const RL_USER = 'rate-limit-probe-user'
    const c2 = testClient(makeApp(pool)) // 独立限速器，不受本文件其他用例影响
    const auditCount = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        'select count(*) as n from platform.audit where actor = $1',
        [RL_USER],
      )
      return Number(rows[0]!.n)
    }
    // 该 actor 在多次运行间可能留残留（前一轮断言失败会照常写 audit）⇒ 先清，
    // 保证"从未出现过"这个前置断言在重复运行下仍确定成立
    await pool.query('delete from platform.audit where actor = $1', [RL_USER])
    expect(await auditCount()).toBe(0) // 前置：该 actor 从未出现过

    for (let i = 0; i < USER_FAIL_LIMIT; i++) {
      const r = await c2.api.platform.auth.login.$post(
        { json: { username: RL_USER, password: 'wrong' } },
        { headers: { host: 'acme.test' } },
      )
      expect(r.status).toBe(401)
    }
    const afterFails = await auditCount()
    expect(afterFails).toBe(USER_FAIL_LIMIT) // 阈值内的失败照常记账

    const blocked = await c2.api.platform.auth.login.$post(
      { json: { username: RL_USER, password: 'wrong' } },
      { headers: { host: 'acme.test' } },
    )
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await auditCount()).toBe(afterFails) // ← 被拦的请求一行都不写
  })

  // ⑯ 限速不该误伤正常用户：只要没超阈值，正确凭据照常登录
  it('未达阈值的正常登录不受限速影响（200 + 会话 cookie）', async () => {
    const c2 = testClient(makeApp(pool))
    await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'wrong' } },
      { headers: { host: 'acme.test' } },
    )
    const ok = await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(ok.status).toBe(200)
    expect(setCookies(ok).join('\n')).toContain('platform_session=')
  })

  // ⑰ 别名登录（提交串 username ≠ Casdoor 规范名 name）：成功清零必须也按【提交串】。
  // 反证：把 auth.ts 成功分支改回 record(t.id, name, true)，本用例第 2 轮失败即 429（红）。
  it('★ 别名登录：成功按提交串清零 ⇒ name!==username 时成功仍解得开失败桶', async () => {
    const ALIAS = 'alice-alias@acme.test' // 提交串；Casdoor 返回的规范名仍是 alice
    const aliasCasdoor: CasdoorFactory = (org) => {
      const client = casdoorFor(org)
      const real = client.verifyPassword.bind(client)
      client.verifyPassword = async (u, p) =>
        u === ALIAS && p === 'pw' ? { name: 'alice' } : real(u, p)
      return client
    }
    const c2 = testClient(makeApp(pool, aliasCasdoor)) // 独立限速器：不受本文件其他用例影响
    const post = (password: string) =>
      c2.api.platform.auth.login.$post(
        { json: { username: ALIAS, password } },
        { headers: { host: 'acme.test' } },
      )
    for (let i = 0; i < USER_FAIL_LIMIT - 1; i++) expect((await post('wrong')).status).toBe(401)
    expect((await post('pw')).status).toBe(200) // 别名成功登录：须清【提交串】那个失败桶
    for (let i = 0; i < USER_FAIL_LIMIT - 1; i++) expect((await post('wrong')).status).toBe(401)
  })

  // ⑱ 超长 username 的失败也必须计入限速桶（评审 finding 3：原实现超长分支的 record 零覆盖）。
  // 反证：临时删掉 auth.ts 超长分支的 limiter.record 调用，本用例第 6 次仍是 401（红）。
  it('★ 超长 username 连续失败达阈值 → 第 6 次 429（超长路径确实记账）', async () => {
    const longName = 'z'.repeat(300) // > MAX_USERNAME_LEN(256)：走"不调 Casdoor"的超长分支
    const c2 = testClient(makeApp(pool)) // 独立限速器
    const post = () =>
      c2.api.platform.auth.login.$post(
        { json: { username: longName, password: 'pw' } },
        { headers: { host: 'acme.test' } },
      )
    for (let i = 0; i < USER_FAIL_LIMIT; i++) expect((await post()).status).toBe(401)
    const blocked = await post()
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })
  })

  // ⑲ 形状不对（缺 password）的 401 也必须计入限速桶（PR#5 评审 R1：该分支此前只 401 不 record
  // ——一条不产生出站调用的限速死角）。反证：删掉 auth.ts 该分支的 record，本用例第 6 次仍 401（红）。
  it('★ 缺 password 的 401 也记账 → 第 6 次 429（形状分支不再是死角）', async () => {
    const c2 = testClient(makeApp(pool)) // 独立限速器
    const post = () =>
      c2.api.platform.auth.login.$post(
        { json: { username: 'shape-probe', password: '' } },
        { headers: { host: 'acme.test' } },
      )
    for (let i = 0; i < USER_FAIL_LIMIT; i++) expect((await post()).status).toBe(401)
    const blocked = await post()
    expect(blocked.status).toBe(429)
    expect(await blocked.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })
  })

  // ⑳ 未认证请求不得靠单请求撑爆内存（PR#5 评审 R1 建议 4）：有界读取直接 413。
  // 反证：恢复 c.req.json()（无上限）时本用例拿到 401 而非 413。
  it('★ 超长请求体：有界读取即拒（413 PAYLOAD_TOO_LARGE），整只 body 不进内存', async () => {
    const c2 = testClient(makeApp(pool))
    const res = await c2.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'p'.repeat(MAX_LOGIN_BODY_BYTES) } },
      { headers: { host: 'acme.test' } },
    )
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE' })
  })
})
