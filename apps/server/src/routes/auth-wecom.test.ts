// auth-wecom.test.ts — 企微登录两路路由（qr 扫码 + 企微内静默）（TDD）
//
// 真 PG（本地 docker platform-pg，同 auth.test.ts 约定）+ MockCasdoor（真实 HTTP，含
// /api/login/oauth/access_token 兑换 issueOidcCode 预种 code + 故障旋钮）+ 注入 fetchFn 的
// 假企微 qyapi。未提供 DATABASE_URL 时整体跳过。覆盖简报 ①-⑦ + fix round（评审 I1/I2）：
//  ① /qr 返回 authorize url（state 与 cookie 绑定）② qr code/state → platform_session + 302 /
//  ③ 错 state → 302 /login?error=BAD_STATE ④ iframe 头 → 200 HTML postMessage
//  ④a iframe+坏 code → sso-fail ④b NO_ACCOUNT → 302 /login?error= ④c token 端点 5xx/HTML
//     → 传输故障分类（CASDOOR_UNAVAILABLE，非 BAD_CODE）⑤ 非 wxwork UA 访问 /silent → 302 /login
//  ⑥ via=silent 全链路（假企微 code → userid → Casdoor 用户）→ authVia='wecom-silent'
//  ⑦ 未配 corp 租户 404。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { testClient } from 'hono/testing'
import { fileURLToPath } from 'node:url'
import { CasdoorClient, verifySession } from '@platform/auth-core'
import { MockCasdoor } from '@platform/auth-core/src/test-util/mock-casdoor'
import { runMigrations } from '../migrate'
import { seedDemo } from '../seed'
import { resolveTenantMiddleware, type TenantEnv } from '../tenant'
import { sessionMiddleware, type CasdoorFactory, type SessionEnv } from '../session-middleware'
import { wecomRoutes } from './auth-wecom'
import { TENANT_FAIL_LIMIT, createLoginLimiter, type LoginLimiter } from '../rate-limit'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-session-secret-0123456789abcdef' // ≥32 字符，测试专用
const PUBLIC_ORIGIN = 'https://portal.test'
const CALLBACK = `${PUBLIC_ORIGIN}/api/platform/auth/wecom/callback`

// MockCasdoor 种子：alice = qr 路（Casdoor OIDC code）；wo_alice = 静默路（企微 userid 即
// Casdoor name，woke 语义 wo 开头）；两人同挂 ops 角色 + ticket:view 直挂
const mock = new MockCasdoor({
  users: [
    { name: 'alice', password: 'pw', roles: ['ops'] },
    { name: 'wo_alice', password: 'pw', roles: ['ops'] },
  ],
  perms: [
    // owner 必须与租户 org 一致（同 auth.test.ts）：权限按 org 分桶后，不标 owner 的码
    // 落在 MOCK_ORG 桶，租户 org='acme' 的 client 看不到 ⇒ scopes 恒空
    { owner: 'acme', name: 'p-view', users: ['alice', 'wo_alice'], resources: ['ticket:view'] },
    { owner: 'acme', name: 'p-admin', roles: ['ops'], resources: ['ticket:admin'] },
  ],
})

function casdoorFor(org: string): CasdoorClient {
  return new CasdoorClient({
    origin: mock.origin,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    org,
    adminUser: 'admin',
    adminPwd: 'pw',
  })
}

const WXWORK_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 wxwork/4.1.29 MicroMessenger'
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/605.1.15'

// 假企微 qyapi：gettoken → access_token；auth/getuserinfo(code) → wo_alice
//（wecomUserIdForCode 有模块级 token 缓存——gettoken 只会被打一次，两分支都要能独立应答）
function fakeWecomFetch(input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
  const u = String(input)
  if (u.startsWith('https://qyapi.weixin.qq.com/cgi-bin/gettoken')) {
    return Promise.resolve(Response.json({ errcode: 0, access_token: 'mock-corp-token', expires_in: 7200 }))
  }
  if (u.startsWith('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo')) {
    return Promise.resolve(Response.json({ errcode: 0, userid: 'wo_alice' }))
  }
  return Promise.resolve(new Response('not found', { status: 404 }))
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
    '/api/platform/auth/wecom',
    wecomRoutes({
      casdoor,
      sessionSecret: SECRET,
      pool,
      limiter, // ← 新增
      casdoorUrl: mock.origin,
      casdoorClientId: 'test-client',
      casdoorClientSecret: 'test-secret',
      publicOrigin: PUBLIC_ORIGIN,
      wecomFetch: fakeWecomFetch,
    }),
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

function stateToken(res: Response): string {
  const m = /wecom_state=([^;]+)/.exec(setCookies(res).join('\n'))
  if (!m) throw new Error('response has no wecom_state Set-Cookie')
  return m[1]!
}

describe.skipIf(!dbUrl)('企微登录路由（qr + 静默）', () => {
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

  // ① /qr：authorize url（qr 模式 + provider 预选 + redirect_uri）+ state cookie 绑定
  it('/qr：url 含 state（与 wecom_state cookie 一致）、provider/mode/redirect_uri 正确；cookie HttpOnly/Max-Age=300/SameSite=Lax', async () => {
    const res = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    expect(url).toContain(`${mock.origin}/login/oauth/authorize?`)
    expect(url).toContain('provider=provider_wecom')
    expect(url).toContain('mode=qr')
    expect(url).toContain('client_id=test-client')
    expect(url).toContain(`redirect_uri=${encodeURIComponent(CALLBACK)}`)
    const state = stateToken(res)
    expect(url).toContain(`state=${state}`) // url 里的 state 与 cookie 里的是同一枚
    const sc = setCookies(res).join('\n')
    expect(sc).toContain('wecom_state=')
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Max-Age=300')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).not.toContain('Domain=') // host-only，与 platform_session 同纪律
  })

  // ② qr 全链：Casdoor code + 正确 state → platform_session + 302 /，authVia=wecom-qr
  it('callback（qr）：正确 code/state → 302 / + platform_session（authVia=wecom-qr、scopes 直挂∪角色）+ audit login.ok', async () => {
    const qr = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const code = mock.issueOidcCode('alice')
    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.authVia).toBe('wecom-qr')
    expect(p?.name).toBe('alice')
    expect(p?.org).toBe('acme')
    expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view'])
    const { rows } = await pool.query<{
      action: string
      actor: string
      detail: { via?: string }
    }>(
      "select action, actor, detail from platform.audit where action='login.ok' order by id desc limit 1",
    )
    expect(rows[0]).toMatchObject({ action: 'login.ok', actor: 'alice', detail: { via: 'wecom-qr' } })
  })

  // ③ 错 state（cookie 与 query 不一致）→ 浏览器上下文兜底：302 /login?error=BAD_STATE（评审 I1）
  it('callback：state 与 cookie 不一致 → 302 /login?error=BAD_STATE，无 platform_session', async () => {
    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code: 'any-code', state: 'aaa' } },
      { headers: { host: 'acme.test', cookie: 'wecom_state=bbb' } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=BAD_STATE')
    expect(setCookies(res)).toEqual([])
  })

  // ④ iframe 头：200 + 小 HTML postMessage（父页壳 SPA 监听 sso-done），会话 cookie 照发
  it('callback（iframe）：Sec-Fetch-Dest=iframe → 200 HTML 含 parent.postMessage({type:\'sso-done\'})，platform_session 照发', async () => {
    const qr = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const code = mock.issueOidcCode('alice')
    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}`, 'sec-fetch-dest': 'iframe' } },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain(`parent.postMessage({type:'sso-done'},'*')`)
    sessionToken(res) // 200 分支同样拿到会话 cookie（iframe 同站可种）
  })

  // ④a iframe 失败路（评审 I1）：坏 code → 200 HTML sso-fail（与 sso-done 对称），不发会话
  it('callback（iframe）：坏 code → 200 HTML 含 sso-fail(error:\'BAD_CODE\')，无 platform_session', async () => {
    const qr = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code: 'no-such-code', state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}`, 'sec-fetch-dest': 'iframe' } },
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain(`parent.postMessage({type:'sso-fail', error:'BAD_CODE'},'*')`)
    expect(setCookies(res)).toEqual([])
  })

  // ④b 非 iframe 失败路（评审 I1）：已认证但 org 内无账户（NO_ACCOUNT）→ 302 /login?error=NO_ACCOUNT
  it('callback：NO_ACCOUNT（code 换到 org 外用户）→ 302 /login?error=NO_ACCOUNT + audit login.fail', async () => {
    const qr = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const code = mock.issueOidcCode('stranger') // 企微/Casdoor 已认证，但 acme org 无此用户
    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=NO_ACCOUNT')
    expect(setCookies(res)).toEqual([])
    const { rows } = await pool.query<{
      action: string
      actor: string
      detail: { via?: string; reason?: string }
    }>(
      "select action, actor, detail from platform.audit where action='login.fail' order by id desc limit 1",
    )
    expect(rows[0]).toMatchObject({
      action: 'login.fail',
      actor: 'stranger',
      detail: { via: 'wecom-qr', reason: 'no-account' },
    })
  })

  // ④c I2 修复：token 端点 5xx+HTML / 2xx+HTML 都是传输故障（CASDOOR_UNAVAILABLE），
  //     绝不吞成 BAD_CODE——用【有效】code 验证：分类只看端点故障，与 code 有效性无关
  it('callback：Casdoor token 端点 502+HTML 或 200+HTML → 传输故障（非 iframe 302 error=CASDOOR_UNAVAILABLE；iframe sso-fail 同码），非 BAD_CODE', async () => {
    for (const mode of ['http502', 'html200'] as const) {
      mock.setTokenEndpointFault(mode)
      try {
        // 非 iframe：302 兜底到登录页，错误码标 CASDOOR_UNAVAILABLE（不是 BAD_CODE/401 语义）
        const qr1 = await client.api.platform.auth.wecom.qr.$get(undefined, {
          headers: { host: 'acme.test' },
        })
        const s1 = stateToken(qr1)
        const c1 = mock.issueOidcCode('alice')
        const r1 = await client.api.platform.auth.wecom.callback.$get(
          { query: { code: c1, state: s1 } },
          { headers: { host: 'acme.test', cookie: `wecom_state=${s1}` } },
        )
        expect(r1.status).toBe(302)
        expect(r1.headers.get('location')).toBe('/login?error=CASDOOR_UNAVAILABLE')
        expect(r1.headers.get('location')).not.toContain('BAD_CODE')
        expect(setCookies(r1)).toEqual([])
        // iframe：200 sso-fail 同码
        const qr2 = await client.api.platform.auth.wecom.qr.$get(undefined, {
          headers: { host: 'acme.test' },
        })
        const s2 = stateToken(qr2)
        const c2 = mock.issueOidcCode('alice')
        const r2 = await client.api.platform.auth.wecom.callback.$get(
          { query: { code: c2, state: s2 } },
          { headers: { host: 'acme.test', cookie: `wecom_state=${s2}`, 'sec-fetch-dest': 'iframe' } },
        )
        expect(r2.status).toBe(200)
        expect(await r2.text()).toContain(
          `parent.postMessage({type:'sso-fail', error:'CASDOOR_UNAVAILABLE'},'*')`,
        )
        expect(setCookies(r2)).toEqual([])
      } finally {
        mock.setTokenEndpointFault('off')
      }
    }
  })

  // ⑤ 桌面浏览器（非 wxwork UA）打到 /silent → 302 /login，不种 state 不跳企微
  it('/silent：非 wxwork UA → 302 /login 且不种 wecom_state', async () => {
    const res = await client.api.platform.auth.wecom.silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': DESKTOP_UA },
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login')
    expect(setCookies(res)).toEqual([])
  })

  // ⑥ 静默全链：wxwork UA → 企微静默 URL（redirect_uri 带 via=silent）→ 企微 code 回调
  //    → 假企微 fetch 换 userid wo_alice → Casdoor 用户 → authVia=wecom-silent
  it('via=silent 全链：/silent → open.weixin.qq.com；企微 code 回调 → platform_session authVia=wecom-silent', async () => {
    const s1 = await client.api.platform.auth.wecom.silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': WXWORK_UA },
    })
    expect(s1.status).toBe(302)
    const loc = s1.headers.get('location') ?? ''
    expect(loc).toContain('https://open.weixin.qq.com/connect/oauth2/authorize?')
    expect(loc).toContain('appid=ww_demo_corp')
    expect(loc).toContain('agentid=1000002')
    expect(loc).toContain(`redirect_uri=${encodeURIComponent(`${CALLBACK}?via=silent`)}`)
    expect(loc.endsWith('#wechat_redirect')).toBe(true)
    const state = stateToken(s1)

    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code: 'wecom-silent-code', state, via: 'silent' } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.authVia).toBe('wecom-silent')
    expect(p?.name).toBe('wo_alice')
    expect(p?.org).toBe('acme')
    expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view'])
    const { rows } = await pool.query<{ detail: { via?: string } }>(
      "select detail from platform.audit where action='login.ok' order by id desc limit 1",
    )
    expect(rows[0]?.detail.via).toBe('wecom-silent')
  })

  // ⑦ 未配企微的租户（beta）：/qr 与 /silent（wxwork UA）都 404 WECOM_NOT_CONFIGURED
  it('未配 corp 租户：/qr 与 /silent 均 404 {"error":"WECOM_NOT_CONFIGURED"}', async () => {
    const qr = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'beta.test' },
    })
    expect(qr.status).toBe(404)
    expect(await qr.json()).toEqual({ error: 'WECOM_NOT_CONFIGURED' })
    const silent = await client.api.platform.auth.wecom.silent.$get(undefined, {
      headers: { host: 'beta.test', 'user-agent': WXWORK_UA },
    })
    expect(silent.status).toBe(404)
    expect(await silent.json()).toEqual({ error: 'WECOM_NOT_CONFIGURED' })
  })

  // 企微路：租户层限速（code 换票前拿不到用户名 ⇒ 只判租户维度，见 spec §3.2）
  it('★ 负例：租户失败达阈值 → 回调整体 429 TOO_MANY_REQUESTS（不落任何 audit）', async () => {
    const PROBE_ACTOR = 'rate-limit-wecom-probe' // 专用 actor：全仓仅本用例用，audit 计数才稳
    const { rows } = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug = 'acme'",
    )
    const acmeId = rows[0]!.id
    // 计数按【专用 tenant+actor】维度取：vitest 并发跑各测试文件、别的文件也在写 platform.audit，
    // 全局 count(*) 会抖——这里 tenant_id+actor 双条件把它钉死在只有本用例碰得着的行上。
    await pool.query('delete from platform.audit where tenant_id = $1 and actor = $2', [
      acmeId,
      PROBE_ACTOR,
    ])
    const auditCount = async (): Promise<number> => {
      const { rows: r } = await pool.query<{ n: string }>(
        'select count(*) as n from platform.audit where tenant_id = $1 and actor = $2',
        [acmeId, PROBE_ACTOR],
      )
      return Number(r[0]!.n)
    }
    expect(await auditCount()).toBe(0) // 前置：该 tenant+actor 从未出现过

    const limiter = createLoginLimiter()
    const c2 = testClient(makeApp(pool, casdoorFor, limiter))

    // 构造一个"若不限速就会写一行 audit"的回调：有效 state + 已认证但 org 内无账户的 code
    // ⇒ 正常路径会落到 NO_ACCOUNT 分支、写 login.fail(actor=PROBE_ACTOR)。这样下面的
    // "行数不增"才不是空断言。反证：临时删掉 callback 的限速早返回，本用例 audit 断言变红。
    const qr = await c2.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const code = mock.issueOidcCode(PROBE_ACTOR)

    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) limiter.record(acmeId, null, false)

    const res = await c2.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await auditCount()).toBe(0) // ← 限速挡在 audit 之前：被拦的回调一行都不写
  })
})
