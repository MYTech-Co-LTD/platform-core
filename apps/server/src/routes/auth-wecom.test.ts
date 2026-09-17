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
import { authRoutes } from './auth'
import { TENANT_FAIL_LIMIT, createLoginLimiter, type LoginLimiter } from '../rate-limit'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-session-secret-0123456789abcdef' // ≥32 字符，测试专用
const PUBLIC_ORIGIN = 'https://portal.test'
const CALLBACK = `${PUBLIC_ORIGIN}/api/platform/auth/wecom/callback`

// MockCasdoor 种子：alice = qr 路（Casdoor OIDC code）；wo_alice = 静默路（企微 userid 即
// Casdoor name，woke 语义 wo 开头）；两人同挂 ops 角色 + ticket:view 直挂
const mock = new MockCasdoor({
  users: [
    // owner 与租户 org 一致：用户按 (org,name) 命中（评审 S3，同 auth.test.ts）
    { name: 'alice', password: 'pw', roles: ['ops'], owner: 'acme' },
    { name: 'wo_alice', password: 'pw', roles: ['ops'], owner: 'acme' },
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

/** 同款假企微 API，但 getuserinfo 回**指定** userid——JIT 用例（issue #32）要"陌生企微号" */
function wecomFetchFor(userid: string): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const u = String(input)
    if (u.startsWith('https://qyapi.weixin.qq.com/cgi-bin/gettoken')) {
      return Promise.resolve(Response.json({ errcode: 0, access_token: `tok-${userid}`, expires_in: 7200 }))
    }
    if (u.startsWith('https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo')) {
      return Promise.resolve(Response.json({ errcode: 0, userid }))
    }
    return Promise.resolve(new Response('not found', { status: 404 }))
  }) as typeof globalThis.fetch
}

type AppClient = ReturnType<typeof testClient<ReturnType<typeof makeApp>>>

function makeApp(
  pool: Pool,
  casdoor: CasdoorFactory = casdoorFor,
  limiter: LoginLimiter = createLoginLimiter(),
  wecomFetch: typeof globalThis.fetch = fakeWecomFetch,
) {
  return new Hono<TenantEnv & SessionEnv>()
    .use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
    .use('*', sessionMiddleware({ casdoor, sessionSecret: SECRET }))
    .route(
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
        wecomFetch,
      }),
    )
}

/**
 * 两扇门同挂一个 limiter 实例的宿主形态（`app.ts` 的缩样）：拆桶断言只能在**同一个实例**
 * 上看——分成两个实例时那两条断言天然绿，测不到"桶的键是否隔开"。
 */
function makeAppBothDoors(pool: Pool, limiter: LoginLimiter) {
  return new Hono<TenantEnv & SessionEnv>()
    .use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
    .use('*', sessionMiddleware({ casdoor: casdoorFor, sessionSecret: SECRET }))
    .route(
      '/api/platform/auth/wecom',
      wecomRoutes({
        casdoor: casdoorFor,
        sessionSecret: SECRET,
        pool,
        limiter,
        casdoorUrl: mock.origin,
        casdoorClientId: 'test-client',
        casdoorClientSecret: 'test-secret',
        publicOrigin: PUBLIC_ORIGIN,
        wecomFetch: fakeWecomFetch,
      }),
    )
    .route(
      '/api/platform/auth',
      authRoutes({ casdoor: casdoorFor, sessionSecret: SECRET, pool, limiter }),
    )
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

  // ① /qr：**直连企微**（issue #30）——URL 是企微扫码登录页、redirect_uri 落回我们自己
  //    并带 via=qr-corp（告诉回调"这是企微 code"）+ state cookie 绑定
  it('/qr：企微扫码登录 URL（直连，不经 Casdoor）+ redirect_uri 落自家域带 via=qr-corp；cookie HttpOnly/Max-Age=300/SameSite=Lax', async () => {
    const res = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(res.status).toBe(200)
    const { url } = (await res.json()) as { url: string }
    // **直连企微**：不再是 Casdoor 的 /login/oauth/authorize——那条会把 redirect_uri 换成
    // Casdoor 自己的域（sso.hookflow.cn），而企微自建应用**可信域名只能配一个**，
    // 客户用自有域名时永远对不上（报「redirect_uri 与配置的授权完成回调域名不一致」）
    expect(url.startsWith('https://login.work.weixin.qq.com/wwlogin/sso/login?')).toBe(true)
    expect(url).not.toContain('sso.hookflow.cn')
    const q = new URL(url).searchParams
    expect(q.get('login_type')).toBe('CorpApp')
    expect(q.get('appid')).toBe('ww_demo_corp')
    expect(q.get('agentid')).toBe('1000002')
    // redirect_uri 必须**原样是我们自己的回调**并带 via=qr-corp（回调据此走企微换票支路）
    expect(q.get('redirect_uri')).toBe(`${CALLBACK}?via=qr-corp`)
    const state = stateToken(res)
    expect(q.get('state')).toBe(state) // url 里的 state 与 cookie 里的是同一枚
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

  // ⑥.5 扫码**直连**全链（issue #30）：/qr 给企微登录页 → 企微 code 回调（via=qr-corp）
  //      → 假企微 fetch 换 userid wo_alice → Casdoor 用户 → authVia=wecom-qr
  //      （authVia 仍是 'wecom-qr'——它确实是"企微扫码"；与经 Casdoor 的代开发路同名，
  //        两条路的区别在 **code 的类型**，由 via=qr-corp 标明）
  it('via=qr-corp 全链：/qr 直连企微；企微 code 回调 → platform_session authVia=wecom-qr', async () => {
    const q1 = await client.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    expect(q1.status).toBe(200)
    const state = stateToken(q1)

    // 用**企微** code（不是 Casdoor OIDC code）——自建应用直连拿到的就是前者
    const res = await client.api.platform.auth.wecom.callback.$get(
      { query: { code: 'wecom-qr-corp-code', state, via: 'qr-corp' } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.authVia).toBe('wecom-qr')
    expect(p?.name).toBe('wo_alice')
    expect(p?.org).toBe('acme')
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
  it('★ 负例：租户失败达阈值 → 回调被拦且仍走本路由的【导航】契约（非 iframe 302 /login?error=；iframe sso-fail），不落任何 audit', async () => {
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

    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) limiter.record(acmeId, 'wecom', null, false)

    // 非 iframe（顶层导航）：302 回登录页按码展示——**不是** JSON 429
    // （PR#5 评审 R2：JSON 错误体在这条路由上是用户死胡同，见 :204 的自陈契约）
    const res = await c2.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json')
    // Retry-After 信号不因呈现形态变化而丢失
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await auditCount()).toBe(0) // ← 限速挡在 audit 之前：被拦的回调一行都不写

    // iframe（登录页内嵌扫码页回跳）：200 + 与 sso-done 对称的 sso-fail——父页壳 SPA 能收，
    // 扫码区不会显示一坨 JSON（旧实现走 rate-limit 的 JSON 429，WecomQrTab 的 onError 永不触发）
    const resIframe = await c2.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}`, 'sec-fetch-dest': 'iframe' } },
    )
    expect(resIframe.status).toBe(200)
    expect(await resIframe.text()).toContain(
      `parent.postMessage({type:'sso-fail', error:'TOO_MANY_REQUESTS'},'*')`,
    )
    expect(await auditCount()).toBe(0)
  })

  // 上一条用例是【手工喂计数】造出 429——它只证明"计数高时 check 会拦"，没证明"企微流量会把
  // 计数推上去"。下面两条走真路由、不喂计数（PR#5 评审 R1：BAD_CODE/BAD_STATE 此前不 record
  // ⇒ 计数恒不增长 ⇒ 该路径永不 429）。反证方式：删掉 auth-wecom.ts 对应分支的 record，红。
  it('★ 坏 code 流量自己把租户失败计数推满 ⇒ 第 N+1 次 429（每次都会真的打到上游 SSO）', async () => {
    const limiter = createLoginLimiter()
    const c3 = testClient(makeApp(pool, casdoorFor, limiter))
    const qr = await c3.api.platform.auth.wecom.qr.$get(undefined, { headers: { host: 'acme.test' } })
    const state = stateToken(qr)
    const call = (code: string) =>
      c3.api.platform.auth.wecom.callback.$get(
        { query: { code, state } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
    // 前 TENANT_FAIL_LIMIT 次：每次通过 state 校验、每次向 mock SSO 发一次换票请求、每次 BAD_CODE
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) {
      const res = await call(`bogus-code-${i}`)
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=BAD_CODE')
    }
    const blocked = await call('bogus-code-final')
    expect(blocked.status).toBe(302)
    expect(blocked.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
  })

  it('★ 坏 state 流量同样计数（连 /qr 都不需要）⇒ 第 N+1 次 429', async () => {
    const limiter = createLoginLimiter()
    const c4 = testClient(makeApp(pool, casdoorFor, limiter))
    const call = () =>
      c4.api.platform.auth.wecom.callback.$get(
        { query: { code: 'x', state: 'not-the-cookie-state' } },
        { headers: { host: 'acme.test', cookie: 'wecom_state=different' } },
      )
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) {
      const res = await call()
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=BAD_STATE')
    }
    // 状态码断言不能省（PR#5 终轮评审 S3）：本轮把原来的 `status).toBe(429)` 换成了只剩
    // location 的断言——若哪天被拦的响应退回 JSON 却恰好带上 Location，这条回归会静默通过。
    // 与本文件同类用例（bad-code 路的 `expect(blocked.status).toBe(302)`）保持同一口径
    const blocked = await call()
    expect(blocked.status).toBe(302)
    expect(blocked.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
  })

  // ---------------------------------------------------------------------------------------
  // PR#5 评审 R2 ①：`catch` 分支（silent 路的**唯一**出口、qr 路的上游退化出口）与
  // `WECOM_NOT_CONFIGURED` 此前都不 record ⇒ 这两条路永不 429，且每次都在发出站调用。
  // ---------------------------------------------------------------------------------------

  it('★ silent 路（catch 分支）自己把企微门推满 ⇒ 第 N+1 次被拦（第 301 次不再出站）', async () => {
    // 出站计数：这条断言是"空转"的直接证据——旧实现 300 次请求 = 300 次 getuserinfo，
    // 第 301 次照样再打一次（计数不增长 ⇒ check 永不 deny）
    let outbound = 0
    const brokenWecom: typeof globalThis.fetch = (input) => {
      outbound += 1
      if (String(input).startsWith('https://qyapi.weixin.qq.com/cgi-bin/gettoken')) {
        return Promise.resolve(
          Response.json({ errcode: 0, access_token: 'mock-corp-token', expires_in: 7200 }),
        )
      }
      // getuserinfo 对坏 code 回 errcode≠0 ⇒ wecomUserIdForCode **抛错**（不是返 null）
      return Promise.resolve(Response.json({ errcode: 40029, errmsg: 'invalid code' }))
    }
    const limiter = createLoginLimiter()
    const c5 = testClient(makeApp(pool, casdoorFor, limiter, brokenWecom))
    const qr = await c5.api.platform.auth.wecom.qr.$get(undefined, { headers: { host: 'acme.test' } })
    const state = stateToken(qr)
    // via 只来自查询串（回调上没有 wxwork UA 校验）⇒ 攻击面与 qr 路逐字等价 + 一个 &via=silent
    const call = (code: string) =>
      c5.api.platform.auth.wecom.callback.$get(
        { query: { code, state, via: 'silent' } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) {
      const res = await call(`bogus-silent-${i}`)
      expect(res.status).toBe(302)
      // catch 分支：企微传输故障如实呈现（不是 BAD_CODE）
      expect(res.headers.get('location')).toBe('/login?error=WECOM_UNAVAILABLE')
    }
    const beforeBlocked = outbound
    expect(outbound).toBeGreaterThanOrEqual(TENANT_FAIL_LIMIT) // 旧实现：300 次请求 = 300 次出站
    const blocked = await call('bogus-silent-final')
    expect(blocked.status).toBe(302)
    expect(blocked.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
    expect(outbound).toBe(beforeBlocked) // 被拦即不再出站（刹车真的咬住了）
  })

  it('★ qr 路上游退化（Casdoor token 端点 5xx）同样计数 ⇒ 第 N+1 次被拦', async () => {
    // 同一族缺陷的另一半：qr 路在上游退化时也落那条 catch。旧实现在这里同样不计数 ⇒
    // 「上游一出问题刹车就失效」——每一次被打都还照旧向共享 SSO 发出站调用。
    mock.setTokenEndpointFault('http502')
    try {
      const limiter = createLoginLimiter()
      const c7 = testClient(makeApp(pool, casdoorFor, limiter))
      const qr = await c7.api.platform.auth.wecom.qr.$get(undefined, {
        headers: { host: 'acme.test' },
      })
      const state = stateToken(qr)
      const call = (code: string) =>
        c7.api.platform.auth.wecom.callback.$get(
          { query: { code, state } },
          { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
        )
      for (let i = 0; i < TENANT_FAIL_LIMIT; i++) {
        const res = await call(`code-${i}`)
        expect(res.status).toBe(302)
        expect(res.headers.get('location')).toBe('/login?error=CASDOOR_UNAVAILABLE')
      }
      expect((await call('code-final')).headers.get('location')).toBe(
        '/login?error=TOO_MANY_REQUESTS',
      )
    } finally {
      mock.setTokenEndpointFault('off')
    }
  })

  it('★ 未配 corp 租户的 WECOM_NOT_CONFIGURED 出口同样计数 ⇒ 第 N+1 次被拦', async () => {
    const limiter = createLoginLimiter()
    const c6 = testClient(makeApp(pool, casdoorFor, limiter))
    const call = () =>
      c6.api.platform.auth.wecom.callback.$get(
        { query: { code: 'x', state: 'st', via: 'silent' } },
        { headers: { host: 'beta.test', cookie: 'wecom_state=st' } },
      )
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) {
      const res = await call()
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=WECOM_NOT_CONFIGURED')
    }
    expect((await call()).headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
  })

  it('★ qr 路 getUser/getPermissions 抛错同样计数 ⇒ 第 N+1 次被拦', async () => {
    // 同一族缺陷的第三处（PR#5 终轮评审 M1）：`name` 已解析成功、进到 `getUser +
    // getPermissions` 这一对出站调用（**两次**打共享 SSO，比无出站的 WECOM_NOT_CONFIGURED
    // 高危害一档），上游一抛错就 302 CASDOOR_UNAVAILABLE 走人——这条 catch 此前**没有
    // record**，于是计数不增长、永不 429，而每一次请求都照旧发两次出站调用。反证：删掉
    // `catch` 里的 record，本用例红（第 301 次仍是 CASDOOR_UNAVAILABLE 而非 TOO_MANY_REQUESTS）。
    const brokenCasdoor: CasdoorFactory = (org) => {
      const c = casdoorFor(org)
      c.getUser = () => {
        throw new Error('casdoor get-user down')
      }
      return c
    }
    const limiter = createLoginLimiter()
    const c8 = testClient(makeApp(pool, brokenCasdoor, limiter))
    const qr = await c8.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const call = (code: string) =>
      c8.api.platform.auth.wecom.callback.$get(
        { query: { code, state } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
    // 每次换一枚新签发的有效 OIDC code：code 单次即焚，而本用例要的是"每次都真的走到
    // getUser 那一步"（name 解析成功才谈得上后面这处出口）
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) {
      const res = await call(mock.issueOidcCode('alice'))
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=CASDOOR_UNAVAILABLE')
    }
    const blocked = await call(mock.issueOidcCode('alice'))
    expect(blocked.status).toBe(302) // 状态码断言同 S3 口径
    expect(blocked.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
  })

  // ---------------------------------------------------------------------------------------
  // PR#5 评审 R2 ②（协调者裁定）：第 2/3 层按 (tenantId, door) 分桶——300 次匿名企微回调
  // 不得把同租户的账密登录一起锁死。反证：不分门时下面两条断言都会红（另一扇门一起被拦）。
  // ---------------------------------------------------------------------------------------

  it('★ 拆桶①：灌满【企微门】⇒ 企微回调被拦，同租户账密路照常 200（不被牵连）', async () => {
    const { rows } = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug = 'acme'",
    )
    const acmeId = rows[0]!.id
    const limiter = createLoginLimiter()
    const c7 = testClient(makeAppBothDoors(pool, limiter))
    const qr = await c7.api.platform.auth.wecom.qr.$get(undefined, { headers: { host: 'acme.test' } })
    const state = stateToken(qr)
    const code = mock.issueOidcCode('alice') // 若不被限速，这条会正常登录成功

    // 灌满企微门：等价于 300 次匿名 GET /wecom/callback?code=x&state=<不匹配>
    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) limiter.record(acmeId, 'wecom', null, false)

    const wecom = await c7.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(wecom.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')

    // ← 改动前这里 429（企微洪泛把账密路一起推满）= 全租户两种登录一起瘫
    const pw = await c7.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(pw.status).toBe(200)
    expect(setCookies(pw).join('\n')).toContain('platform_session=')
  })

  it('★ 拆桶②（反向）：灌满【账密门】⇒ 账密路 429，同租户企微路照常登录（不被牵连）', async () => {
    const { rows } = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug = 'acme'",
    )
    const acmeId = rows[0]!.id
    const limiter = createLoginLimiter()
    const c8 = testClient(makeAppBothDoors(pool, limiter))
    const qr = await c8.api.platform.auth.wecom.qr.$get(undefined, { headers: { host: 'acme.test' } })
    const state = stateToken(qr)
    const code = mock.issueOidcCode('alice')

    for (let i = 0; i < TENANT_FAIL_LIMIT; i++) limiter.record(acmeId, 'password', 'alice', false)

    // 账密门自己的闸照常咬住（分桶没有把限速放松掉）
    const pw = await c8.api.platform.auth.login.$post(
      { json: { username: 'alice', password: 'pw' } },
      { headers: { host: 'acme.test' } },
    )
    expect(pw.status).toBe(429)
    expect(await pw.json()).toEqual({ error: 'TOO_MANY_REQUESTS' })

    // ← 改动前这里 302 /login?error=TOO_MANY_REQUESTS（账密洪泛把企微路一起锁死）
    const wecom = await c8.api.platform.auth.wecom.callback.$get(
      { query: { code, state } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(wecom.status).toBe(302)
    expect(wecom.headers.get('location')).toBe('/')
    expect((await verifySession(sessionToken(wecom), SECRET))?.authVia).toBe('wecom-qr')
  })

  // ---------------------------------------------------------------------------------------
  // JIT 自动建号（issue #32）：企微直连两路（qr-corp/silent）拿到合法 userid 但 org 内
  // 无此账号时，租户旗标 wecom_auto_signup 开 ⇒ admin API 建号 + 挂全量模块权限码后放行；
  // 旗标关 ⇒ 维持 #31 的 fail-closed NO_ACCOUNT。Casdoor OIDC code 路（代开发）**永不** JIT。
  // ---------------------------------------------------------------------------------------

  /** 翻 acme 租户的 JIT 旗标（迁移 004 的列；用例用 try/finally 保证恢复 false） */
  async function setAutoSignup(on: boolean): Promise<void> {
    await pool.query('update platform.tenant set wecom_auto_signup = $1 where slug = $2', [
      on,
      'acme',
    ])
  }

  it('★ JIT（qr-corp）：旗标开 + 陌生企微号 → 自动建号 + 挂全量码 → 302 / 全 scopes + audit login.ok', async () => {
    await setAutoSignup(true)
    try {
      const c = testClient(makeApp(pool, casdoorFor, createLoginLimiter(), wecomFetchFor('wo_new')))
      const qr = await c.api.platform.auth.wecom.qr.$get(undefined, {
        headers: { host: 'acme.test' },
      })
      const state = stateToken(qr)
      const res = await c.api.platform.auth.wecom.callback.$get(
        { query: { code: 'jit-qr-corp-code', state, via: 'qr-corp' } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')
      const p = await verifySession(sessionToken(res), SECRET)
      expect(p?.authVia).toBe('wecom-qr')
      expect(p?.name).toBe('wo_new')
      expect(p?.org).toBe('acme')
      // 新号无角色，全量权限码挂 users ⇒ 直挂全集（p-view + p-admin），排序后即平台全集
      expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view'])
      // 建号载荷落档：signupApplication 缺省 app-built-in（与 #login 同口径）
      expect(mock.userIn('acme', 'wo_new')).toMatchObject({
        owner: 'acme',
        name: 'wo_new',
        type: 'normal-user',
        signupApplication: 'app-built-in',
      })
      // 绑定侧证据：p-view 的 users 追加了 wo_new（alice/wo_alice 原值保留）
      const pView = mock.permissionsIn('acme').find((x) => x.name === 'p-view')
      expect(pView?.users).toEqual(['alice', 'wo_alice', 'wo_new'])
      const { rows } = await pool.query<{ action: string; actor: string; detail: { via?: string } }>(
        "select action, actor, detail from platform.audit where action='login.ok' and actor='wo_new' order by id desc limit 1",
      )
      expect(rows[0]).toMatchObject({ action: 'login.ok', actor: 'wo_new', detail: { via: 'wecom-qr' } })
    } finally {
      await setAutoSignup(false)
    }
  })

  it('★ 旗标关（回归钉）：陌生企微号仍 NO_ACCOUNT，且**不建号**（#31 fail-closed 不回退）', async () => {
    // 旗标保持迁移缺省 false（上一条 finally 已恢复）；不 setAutoSignup(true)
    const c = testClient(makeApp(pool, casdoorFor, createLoginLimiter(), wecomFetchFor('wo_off')))
    const qr = await c.api.platform.auth.wecom.qr.$get(undefined, {
      headers: { host: 'acme.test' },
    })
    const state = stateToken(qr)
    const res = await c.api.platform.auth.wecom.callback.$get(
      { query: { code: 'flag-off-code', state, via: 'qr-corp' } },
      { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=NO_ACCOUNT')
    expect(mock.userIn('acme', 'wo_off')).toBeUndefined() // 一个号都没建出来
    const { rows } = await pool.query<{ actor: string; detail: { reason?: string } }>(
      "select actor, detail from platform.audit where action='login.fail' and actor='wo_off' order by id desc limit 1",
    )
    expect(rows[0]).toMatchObject({ actor: 'wo_off', detail: { reason: 'no-account' } })
  })

  it('★ Casdoor OIDC code 路**永不** JIT：旗标开 + org 外用户照旧 NO_ACCOUNT（JIT 只属企微直连两路）', async () => {
    await setAutoSignup(true)
    try {
      const qr = await client.api.platform.auth.wecom.qr.$get(undefined, {
        headers: { host: 'acme.test' },
      })
      const state = stateToken(qr)
      const code = mock.issueOidcCode('oidc_stranger') // Casdoor 已认证、但 acme org 无此用户
      const res = await client.api.platform.auth.wecom.callback.$get(
        { query: { code, state } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=NO_ACCOUNT')
      expect(mock.userIn('acme', 'oidc_stranger')).toBeUndefined()
    } finally {
      await setAutoSignup(false)
    }
  })

  it('★ JIT 建号失败（add-user 故障）→ CASDOOR_UNAVAILABLE + audit login.fail(jit-create-failed)，绝不静默放行', async () => {
    await setAutoSignup(true)
    try {
      const brokenCasdoor: CasdoorFactory = (org) => {
        const c = casdoorFor(org)
        c.ensureUser = async () => {
          throw new Error('casdoor add-user down')
        }
        return c
      }
      const c = testClient(
        makeApp(pool, brokenCasdoor, createLoginLimiter(), wecomFetchFor('wo_broken')),
      )
      const qr = await c.api.platform.auth.wecom.qr.$get(undefined, {
        headers: { host: 'acme.test' },
      })
      const state = stateToken(qr)
      const res = await c.api.platform.auth.wecom.callback.$get(
        { query: { code: 'jit-broken-code', state, via: 'qr-corp' } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=CASDOOR_UNAVAILABLE')
      const { rows } = await pool.query<{ actor: string; detail: { reason?: string } }>(
        "select actor, detail from platform.audit where action='login.fail' and actor='wo_broken' order by id desc limit 1",
      )
      expect(rows[0]).toMatchObject({ actor: 'wo_broken', detail: { reason: 'jit-create-failed' } })
    } finally {
      await setAutoSignup(false)
    }
  })

  it('★ JIT（silent）：企微内静默路同样吃旗标 → authVia=wecom-silent 全链建号放行', async () => {
    await setAutoSignup(true)
    try {
      const c = testClient(
        makeApp(pool, casdoorFor, createLoginLimiter(), wecomFetchFor('wo_silent_new')),
      )
      const s1 = await c.api.platform.auth.wecom.silent.$get(undefined, {
        headers: { host: 'acme.test', 'user-agent': WXWORK_UA },
      })
      const state = stateToken(s1)
      const res = await c.api.platform.auth.wecom.callback.$get(
        { query: { code: 'jit-silent-code', state, via: 'silent' } },
        { headers: { host: 'acme.test', cookie: `wecom_state=${state}` } },
      )
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/')
      const p = await verifySession(sessionToken(res), SECRET)
      expect(p?.authVia).toBe('wecom-silent')
      expect(p?.name).toBe('wo_silent_new')
      expect(p?.scopes).toEqual(['ticket:admin', 'ticket:view'])
      expect(mock.userIn('acme', 'wo_silent_new')).toMatchObject({ name: 'wo_silent_new' })
    } finally {
      await setAutoSignup(false)
    }
  })
})
