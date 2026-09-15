// auth-wechat-oa.test.ts — 公众号访客登录路（售后 spec §1.3）（TDD）
//
// 真 PG（本地 docker platform-pg，同 auth.test.ts 约定）+ 注入 fetchFn 的假微信 snsapi_base
// 端点 + enabledGuestScopes stub（真 loader 的收集逻辑归 loader.test.ts 管，这里钉路由契约）。
// 未提供 DATABASE_URL 时整体跳过。覆盖简报六件：
//  ① 未配公众号的租户 /silent 404 WECHAT_OA_NOT_CONFIGURED
//  ② MicroMessenger UA → 302 open.weixin.qq.com（snsapi_base）+ state cookie
//     （HttpOnly/Max-Age=300/SameSite=Lax/host-only）；非微信 UA → 302 /login
//  ③ callback state 与 cookie 不一致 → 302 /login?error=BAD_STATE，且该路流量自计数
//     ⇒ 第 N+1 次 TOO_MANY_REQUESTS（302 呈现 + Retry-After，非 JSON 429）
//  ④ code 被拒（假微信 200+errcode）→ 302 /login?error=BAD_CODE + audit login.fail
//     （via=wechat-oa, reason=no-openid）
//  ⑤ 成功：假微信回 openid → 302 / + platform_session；JWT sub/name=openid、org=租户 org、
//     authVia='wechat-oa'、scopes=enabledGuestScopes 的返回（按回调租户取，非全局并集）
//  ⑥ 传输层（假微信 5xx）→ 302 /login?error=WECHAT_UNAVAILABLE（不吞成 BAD_CODE，
//     不写 login.fail——非用户过错）
//
// 租户 fixture：**复用 seedDemo 的 acme**（beforeAll 幂等补上 wechat_oa_* 两列——branding
// 输出不含 OA 字段、auth-wecom 断言不碰这两列，互不干扰），beta 天然就是①的未配置租户。
// 刻意**不**另插新租户/域名：tenant.test.ts 钉死了租户清单 ['acme','beta'] 与域名收敛集，
// 持久化的第三租户会把它打红。audit 断言一律加 actor 过滤——vitest 并行文件同写 acme 的
// audit 行（auth-wecom 的 stranger/wo_* 等），只按 tenant+action 取最新行会抖。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { testClient } from 'hono/testing'
import { fileURLToPath } from 'node:url'
import { SCOPES_TTL_SEC, signSession, verifySession, type CasdoorClient } from '@platform/auth-core'
import { runMigrations } from '../migrate'
import { seedDemo } from '../seed'
import { resolveTenantMiddleware, type TenantEnv } from '../tenant'
import { sessionMiddleware, type CasdoorFactory, type SessionEnv } from '../session-middleware'
import { wechatOaRoutes, OA_ANON_ACTOR } from './auth-wechat-oa'
import { TENANT_FAIL_LIMIT, createLoginLimiter, type LoginLimiter } from '../rate-limit'

const dbUrl = process.env.DATABASE_URL
const SECRET = 'test-session-secret-0123456789abcdef' // ≥32 字符，测试专用
const PUBLIC_ORIGIN = 'https://portal.test'
const CALLBACK = `${PUBLIC_ORIGIN}/api/platform/auth/wechat-oa/callback`
/** stub 的「已启用 fixture 模块 guest 码」（enabledGuestScopes 契约的返回形状） */
const GUEST_SCOPES = ['guestmod:guest']

// 消费者微信 H5 UA（只认 MicroMessenger；带 wxwork 的是企微路，不混用）
const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.42(0x18002a30) NetType/WIFI Language/zh_CN'
const DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128.0 Safari/605.1.15'

// 本路由**不落 Casdoor**：sessionMiddleware 只在带有效 platform_session 的请求里才会调
// 工厂（scopes 刷新分支），本文件任何用例都不发该 cookie ⇒ 恒不应触达；真触达即用例写错
const neverCasdoor: CasdoorFactory = () => {
  throw new Error('wechat-oa 路不应触达 Casdoor')
}

// 假微信 snsapi_base 端点（api.weixin.qq.com/sns/oauth2/access_token）三态：
// 200+openid=成功；200+errcode≠0=code 被拒（wechatOaOpenidForCode 返 null）；5xx=传输层（throw）
function wechatJson(body: unknown, status = 200): typeof globalThis.fetch {
  return (() => Promise.resolve(Response.json(body, { status }))) as typeof globalThis.fetch
}
const okWechat = wechatJson({ errcode: 0, openid: 'o_visitor_1' })
const rejectedWechat = wechatJson({ errcode: 40029, errmsg: 'invalid code' })
const downWechat = wechatJson('bad gateway', 502)

type AppClient = ReturnType<typeof testClient<ReturnType<typeof makeApp>>>

interface MakeAppOpts {
  limiter?: LoginLimiter
  enabledGuestScopes?: (tenantId: number) => Promise<string[]>
  wechatFetch?: typeof globalThis.fetch
  /** 会话中间件的 Casdoor 工厂（生命周期用例注入「getUser 恒 null」的计数桩）；缺省不应触达 */
  sessionCasdoor?: CasdoorFactory
  /** 会话中间件的访客码解析器（app.ts 从 loader runtime.enabledGuestScopes 注入的同位物） */
  guestScopes?: (tenantId: number) => Promise<string[]>
}

/** 宿主形态缩样（app.ts 装配链的对应段）：租户 → 会话 → wechat-oa 路由 */
function makeApp(pool: Pool, opts: MakeAppOpts = {}): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  app.use('*', resolveTenantMiddleware({ pool, mode: 'multi', platformOrg: '' }))
  app.use('*', sessionMiddleware({
    casdoor: opts.sessionCasdoor ?? neverCasdoor,
    sessionSecret: SECRET,
    guestScopes: opts.guestScopes,
  }))
  app.route(
    '/api/platform/auth/wechat-oa',
    wechatOaRoutes({
      sessionSecret: SECRET,
      pool,
      limiter: opts.limiter ?? createLoginLimiter(),
      publicOrigin: PUBLIC_ORIGIN,
      enabledGuestScopes: opts.enabledGuestScopes ?? (async () => GUEST_SCOPES),
      wechatFetch: opts.wechatFetch,
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
  const m = /wechat_oa_state=([^;]+)/.exec(setCookies(res).join('\n'))
  if (!m) throw new Error('response has no wechat_oa_state Set-Cookie')
  return m[1]!
}

describe.skipIf(!dbUrl)('公众号访客登录路由（wechat-oa）', () => {
  let pool: Pool
  let acmeId: number

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await runMigrations(pool, 'platform', fileURLToPath(new URL('../migrations', import.meta.url)))
    await seedDemo(pool)
    // acme 幂等补上公众号配置（配置存在即启用——非 login_methods）；beta 保持两列 NULL
    await pool.query(
      "update platform.tenant set wechat_oa_app_id = 'wx_oa_demo', wechat_oa_secret = 'oa-secret'"
        + " where slug = 'acme'",
    )
    const { rows } = await pool.query<{ id: number }>(
      "select id from platform.tenant where slug = 'acme'",
    )
    acmeId = rows[0]!.id
  })

  afterAll(async () => {
    await pool.end()
  })

  /** 在 acme 租户上走 /silent 拿一枚有效 state（微信 UA） */
  async function silentState(client: AppClient): Promise<string> {
    const res = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': WECHAT_UA },
    })
    expect(res.status).toBe(302)
    return stateToken(res)
  }

  // ① 未配置公众号（seedDemo 的 beta 两列皆 NULL）⇒ 404 JSON（配置存在即启用的反面）
  it('/silent：未配公众号的租户 → 404 {"error":"WECHAT_OA_NOT_CONFIGURED"}', async () => {
    const client = testClient(makeApp(pool))
    const res = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
      headers: { host: 'beta.test', 'user-agent': WECHAT_UA },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'WECHAT_OA_NOT_CONFIGURED' })
  })

  // ② 微信内 UA：302 微信授权页 + state cookie 绑定；非微信 UA 降级回登录页
  it('/silent：MicroMessenger UA → 302 微信 snsapi_base 授权 URL + cookie HttpOnly/Max-Age=300/SameSite=Lax；非微信 UA → 302 /login', async () => {
    const client = testClient(makeApp(pool))
    const res = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': WECHAT_UA },
    })
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?')).toBe(true)
    const q = new URL(loc).searchParams
    expect(q.get('appid')).toBe('wx_oa_demo')
    expect(q.get('scope')).toBe('snsapi_base')
    expect(q.get('response_type')).toBe('code')
    // redirect_uri 是我们自己的回调（不带 via——本路只有一种 code，无需分路标记）
    expect(q.get('redirect_uri')).toBe(CALLBACK)
    expect(loc.endsWith('#wechat_redirect')).toBe(true)
    const state = stateToken(res)
    expect(q.get('state')).toBe(state) // url 里的 state 与 cookie 里的是同一枚
    const sc = setCookies(res).join('\n')
    expect(sc).toContain('wechat_oa_state=')
    expect(sc).toContain('HttpOnly')
    expect(sc).toContain('Max-Age=300')
    expect(sc).toContain('SameSite=Lax')
    expect(sc).not.toContain('Domain=') // host-only，与 platform_session 同纪律

    // 桌面浏览器（非 MicroMessenger）误触：降级 302 /login，不种 state、不跳微信
    const desktop = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': DESKTOP_UA },
    })
    expect(desktop.status).toBe(302)
    expect(desktop.headers.get('location')).toBe('/login')
    expect(setCookies(desktop)).toEqual([])
  })

  // ③ 错 state（cookie 与 query 不一致）→ 302 /login?error=BAD_STATE；该路自计数 ⇒ 推满后拦
  it('callback：state 与 cookie 不一致 → 302 /login?error=BAD_STATE 且 limiter 计数 ⇒ 第 N+1 次 TOO_MANY_REQUESTS', async () => {
    const limiter = createLoginLimiter()
    const client = testClient(makeApp(pool, { limiter }))
    const call = () =>
      client.api.platform.auth['wechat-oa'].callback.$get(
        { query: { code: 'any-code', state: 'aaa' } },
        { headers: { host: 'acme.test', cookie: 'wechat_oa_state=bbb' } },
      )
    const first = await call()
    expect(first.status).toBe(302)
    expect(first.headers.get('location')).toBe('/login?error=BAD_STATE')
    expect(setCookies(first)).toEqual([])
    // 反证「且 limiter 计数」：BAD_STATE 流量自己把 wechat-oa 门推满（若该分支不 record，
    // 恒 BAD_STATE 永不 429——连 /silent 都不需要即可循环打）
    for (let i = 1; i < TENANT_FAIL_LIMIT; i++) {
      const res = await call()
      expect(res.status).toBe(302)
      expect(res.headers.get('location')).toBe('/login?error=BAD_STATE')
    }
    const blocked = await call()
    expect(blocked.status).toBe(302) // 状态码断言（同 auth-wecom.test.ts S3 口径）：不是 JSON 429
    expect(blocked.headers.get('location')).toBe('/login?error=TOO_MANY_REQUESTS')
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
  })

  // ④ code 被拒（HTTP 200 + errcode≠0——微信 API 的特殊错误形状）→ BAD_CODE + audit 留痕
  it('callback：code 被拒（假微信 200+errcode）→ 302 /login?error=BAD_CODE + audit login.fail(via=wechat-oa, reason=no-openid)', async () => {
    const client = testClient(makeApp(pool, { wechatFetch: rejectedWechat }))
    const state = await silentState(client)
    const res = await client.api.platform.auth['wechat-oa'].callback.$get(
      { query: { code: 'rejected-code', state } },
      { headers: { host: 'acme.test', cookie: `wechat_oa_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=BAD_CODE')
    expect(setCookies(res)).toEqual([])
    // audit：拿不到 openid 的内容物失败——actor 过滤钉死本用例（并行文件同写 acme 的
    // login.fail，如 auth-wecom 的 no-account 行；OA_ANON_ACTOR 只有本路由会写）
    const { rows } = await pool.query<{
      action: string
      actor: string
      detail: { via?: string; reason?: string }
    }>(
      'select action, actor, detail from platform.audit'
        + ' where tenant_id = $1 and actor = $2 order by id desc limit 1',
      [acmeId, OA_ANON_ACTOR],
    )
    expect(rows[0]).toMatchObject({
      action: 'login.fail',
      actor: OA_ANON_ACTOR,
      detail: { via: 'wechat-oa', reason: 'no-openid' },
    })
  })

  // ⑤ 成功全链：微信回 openid → 访客 session（sub/name=openid、org=租户 org、scopes=guest 码）
  it('callback：成功 → 302 / + platform_session（sub=openid、authVia=wechat-oa、scopes=enabledGuestScopes 按回调租户取）+ audit login.ok', async () => {
    const seenTenantIds: number[] = []
    const client = testClient(
      makeApp(pool, {
        wechatFetch: okWechat,
        enabledGuestScopes: async (tenantId) => {
          seenTenantIds.push(tenantId)
          return GUEST_SCOPES
        },
      }),
    )
    const state = await silentState(client)
    const res = await client.api.platform.auth['wechat-oa'].callback.$get(
      { query: { code: 'good-code', state } },
      { headers: { host: 'acme.test', cookie: `wechat_oa_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/')
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.sub).toBe('o_visitor_1') // openid 即身份——不落 Casdoor，sub 不是 Casdoor UUID
    expect(p?.name).toBe('o_visitor_1')
    expect(p?.org).toBe('acme')
    expect(p?.authVia).toBe('wechat-oa')
    expect(p?.scopes).toEqual(GUEST_SCOPES) // 已启用模块的 guest 码，不是全量权限码
    expect(seenTenantIds).toEqual([acmeId]) // scopes 按【回调租户】取，非全局并集
    const { rows } = await pool.query<{ action: string; actor: string; detail: { via?: string } }>(
      'select action, actor, detail from platform.audit'
        + " where tenant_id = $1 and actor = 'o_visitor_1' and action = 'login.ok' order by id desc limit 1",
      [acmeId],
    )
    expect(rows[0]).toMatchObject({
      action: 'login.ok',
      actor: 'o_visitor_1',
      detail: { via: 'wechat-oa' },
    })
  })

  // ⑥ 传输层故障（5xx）≠ 坏 code：WECHAT_UNAVAILABLE 如实呈现，不写 login.fail
  it('callback：假微信 5xx → 302 /login?error=WECHAT_UNAVAILABLE（不吞成 BAD_CODE），且不新增 login.fail', async () => {
    const client = testClient(makeApp(pool, { wechatFetch: downWechat }))
    const failCount = async (): Promise<number> => {
      const { rows } = await pool.query<{ n: string }>(
        'select count(*) as n from platform.audit where tenant_id = $1 and actor = $2',
        [acmeId, OA_ANON_ACTOR],
      )
      return Number(rows[0]!.n)
    }
    const before = await failCount()
    const state = await silentState(client)
    const res = await client.api.platform.auth['wechat-oa'].callback.$get(
      { query: { code: 'any-code', state } },
      { headers: { host: 'acme.test', cookie: `wechat_oa_state=${state}` } },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/login?error=WECHAT_UNAVAILABLE')
    expect(res.headers.get('location')).not.toContain('BAD_CODE')
    expect(setCookies(res)).toEqual([])
    // 传输故障非用户过错（与 ④ 的 no-openid 行对照）：一行本路的 login.fail 都不多
    expect(await failCount()).toBe(before)
  })

  // ---------------------------------------------------------------------------------------
  // I1 修复轮（审查裁定）：访客 session 的生命周期。签发时 sfa=iat，5 分钟（SCOPES_TTL_SEC）
  // 后首个请求命中 scopes 刷新——通用分支拿 openid（=p.name）去 Casdoor getUser，openid 在
  // Casdoor 没有账户 ⇒ 必返 null ⇒ userGone 清会话：7 天 TTL 的访客 session 实际活不过
  // 5 分钟。修复（方案 a）：wechat-oa 分支不查 Casdoor，用注入的 guestScopes（= runtime
  // enabledGuestScopes，app.ts 同位注入）按**当前租户**重算后重签。
  // ---------------------------------------------------------------------------------------

  /** 假 Casdoor：getUser 对任何名字都答「不存在」（真机对 openid 的必然回答）并计数——
   *  证明访客路的刷新**一次都不该碰它**（修复前这里被调且直接导致清会话） */
  function casdoorUserGone(): { factory: CasdoorFactory; getUserCalls: () => number } {
    let calls = 0
    const client = {
      getUser: async () => {
        calls += 1
        return null
      },
      getPermissions: async () => [],
    } as unknown as CasdoorClient
    return { factory: () => client, getUserCalls: () => calls }
  }

  /** 老化访客 token：sfa 距今 > SCOPES_TTL_SEC（触发刷新）、exp 剩 > 6 天（不触发续期）——
   *  与 auth.test.ts ⑥ 的 stale 造法同款 */
  async function agedGuestSession(scopes: string[]): Promise<string> {
    return signSession(
      { sub: 'o_visitor_1', org: 'acme', name: 'o_visitor_1', scopes, authVia: 'wechat-oa' },
      SECRET,
      Math.floor(Date.now() / 1000) - SCOPES_TTL_SEC - 60,
    )
  }

  it('★ I1：老 sfa 的访客 session 过刷新点 → 存活并按 guestScopes 重算重签，全程不碰 Casdoor', async () => {
    const gone = casdoorUserGone()
    const seenTenantIds: number[] = []
    const client = testClient(makeApp(pool, {
      sessionCasdoor: gone.factory,
      guestScopes: async (tenantId) => {
        seenTenantIds.push(tenantId)
        return GUEST_SCOPES
      },
    }))
    const stale = await agedGuestSession(['stale:guest'])
    // 任意过中间件链的请求即可（/silent 桌面 UA → 302 /login；刷新发生在中间件层，与路由无关）
    const res = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': DESKTOP_UA, cookie: `platform_session=${stale}` },
    })
    expect(res.status).toBe(302)
    expect(setCookies(res).join('\n')).not.toContain('Max-Age=0') // 未被清（修复前：userGone 清会话）
    const p = await verifySession(sessionToken(res), SECRET) // 重签后的新 cookie
    expect(p?.sub).toBe('o_visitor_1')
    expect(p?.authVia).toBe('wechat-oa')
    expect(p?.scopes).toEqual(GUEST_SCOPES) // stale 被替换为解析器真值
    expect(p!.sfa).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000)) // sfa 已刷新
    expect(gone.getUserCalls()).toBe(0) // 访客路的刷新不碰 Casdoor（openid 在那没有账户）
    expect(seenTenantIds).toEqual([acmeId]) // 按当前租户重算，非全局并集
  })

  it('★ I1：停用模块后（guestScopes 返回 []）→ 刷新把访客 scopes 收缩为空——「停用即掉码」在 session 层延续', async () => {
    const gone = casdoorUserGone()
    const client = testClient(makeApp(pool, {
      sessionCasdoor: gone.factory,
      guestScopes: async () => [], // 模块被停用后 enabledGuestScopes 的真值
    }))
    const stale = await agedGuestSession(['guestmod:guest', 'othermod:guest'])
    const res = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
      headers: { host: 'acme.test', 'user-agent': DESKTOP_UA, cookie: `platform_session=${stale}` },
    })
    expect(res.status).toBe(302)
    const p = await verifySession(sessionToken(res), SECRET)
    expect(p?.scopes).toEqual([]) // 旧码不沿用：停用后访客在下个刷新点掉码（而非拖满 7 天）
    expect(gone.getUserCalls()).toBe(0)
  })

  it('★ I1：guestScopes 抛错（DB 故障）→ 降级沿用旧 scopes、不重签不清会话，warn 带访客解析器来源', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const gone = casdoorUserGone()
      const client = testClient(makeApp(pool, {
        sessionCasdoor: gone.factory,
        guestScopes: async () => {
          throw new Error('guest scopes db down')
        },
      }))
      const stale = await agedGuestSession(['guestmod:guest'])
      const res = await client.api.platform.auth['wechat-oa'].silent.$get(undefined, {
        headers: { host: 'acme.test', 'user-agent': DESKTOP_UA, cookie: `platform_session=${stale}` },
      })
      expect(res.status).toBe(302) // 降级放行（可用性优先，同 Casdoor 降级口径）
      // 未重签（重签会把 sfa 抹成 now 遮蔽故障）、未清会话：本响应不带任何 platform_session Set-Cookie
      expect(setCookies(res).join('\n')).not.toContain('platform_session=')
      expect(gone.getUserCalls()).toBe(0)
      const lines = warn.mock.calls.map((a) => String(a[0] ?? ''))
      expect(lines).toHaveLength(1) // 信号不丢：降级留 warn（带 org 与来源）
      expect(lines[0]).toContain('acme')
      expect(lines[0]).toContain('访客码解析器')
    } finally {
      warn.mockRestore()
    }
  })
})
