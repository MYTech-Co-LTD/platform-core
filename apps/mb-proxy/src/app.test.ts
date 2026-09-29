// app.test.ts — HTTP 级测试：**上游纪律** + **401/403 契约**（Task 2 欠下的契约，本任务兑现）。
//
// 为什么必须 HTTP 级（而不是只测纯函数）：本轮的三条**安全不变量**全在「中间件 + 透传」这条
// 组装链上，纯单测（rules.test.ts）看不到它们——
//   ① 浏览器 Cookie 绝不上行、② 上游头改写、③ 401/403 契约。
// 用 `createApp(fakeCfg)` + 桩 `globalThis.fetch`：不绑端口、不要 env（app.ts 拆工厂就是为了这个）。
//
// ⚠️ 桩的形状照模块侧 `fakeMetabase`（modules/data/routes/reports.test.ts:82）：记 `calls` 以便
//    对「发出去的头/URL」做直证，而不是只看最终响应——「Cookie 没上行」这件事在响应里根本看不见。
// ⚠️ `cardCache` 是**模块级**（60s），故每个碰它的用例用**不同的 did**（下划线注释见各 `did`）。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import { createApp } from './app'
import { signProxySession, verifyProxySession } from './handoff'

const SECRET = 'test-secret-test-secret-test-secret!'
const CONSOLE_ORIGIN = 'https://console.example'
const UPSTREAM = 'https://mb.example'
const UPSTREAM_KEY = 'test-upstream-key'

const cfg = {
  port: 0,
  sessionSecret: SECRET,
  consoleOrigin: CONSOLE_ORIGIN,
  upstreamUrl: UPSTREAM,
  upstreamApiKey: UPSTREAM_KEY,
}

/** 一次被桩捕获的上游调用。头**摊平成小写键的对象**（Headers 迭代即小写）——便于断言「有没有」。 */
interface CapturedCall {
  url: string
  pathname: string
  method: string
  headers: Record<string, string>
  body: string | null
}

/**
 * 装一个上游桩。`handler` 拿 (pathname, call) 决定响应；**默认**：`/api/dashboard/*` ⇒ 空 dashcards
 * （多数用例不关心卡片面），其余 ⇒ 200 空 JSON。
 */
function installFetch(
  handler?: (pathname: string, call: CapturedCall) => Response | Promise<Response>,
): { calls: CapturedCall[] } {
  const calls: CapturedCall[] = []
  const fn = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    const pathname = new URL(url).pathname
    const raw = init?.body
    // 代理把请求体缓冲成 ArrayBuffer（见 upstream.ts）⇒ 桩要自己解码，不能 `String()`（那得到 '[object ArrayBuffer]'）
    const body = typeof raw === 'string' ? raw
      : raw instanceof ArrayBuffer ? Buffer.from(raw).toString('utf8')
        : raw instanceof Uint8Array ? Buffer.from(raw).toString('utf8')
          : raw === undefined || raw === null ? null : String(raw)
    const call: CapturedCall = {
      url,
      pathname: pathname === '' ? '/' : pathname,
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    }
    calls.push(call)
    if (handler) return await handler(pathname, call)
    if (/^\/api\/dashboard\/\d+$/.test(pathname)) {
      return new Response(JSON.stringify({ dashcards: [] }), { headers: { 'content-type': 'application/json' } })
    }
    return new Response('{}', { headers: { 'content-type': 'application/json' } })
  }
  vi.stubGlobal('fetch', fn)
  return { calls }
}

afterEach(() => { vi.unstubAllGlobals() })

const cookieFor = (did: number, secret = SECRET, ttlSec?: number): string =>
  `mb_edit=${signProxySession({ org: 'acme', did }, secret, ttlSec)}`

const callsTo = (calls: CapturedCall[], pathname: string): CapturedCall[] =>
  calls.filter((c) => c.pathname === pathname)

describe('★ 上游纪律 ①：浏览器 Cookie 绝不上行，且服务身份是 X-API-Key', () => {
  it('带合法 mb_edit Cookie 打放行路径 ⇒ 桩收到的头里**没有** cookie/authorization/referer，**有** x-api-key', async () => {
    // did=101：本用例专属（cardCache 是模块级 60s 缓存）
    const { calls } = installFetch()
    const app = createApp(cfg)
    const res = await app.request('/api/session/properties', {
      headers: {
        cookie: cookieFor(101),
        accept: 'application/json',
        // 以下三个都是「浏览器身份/来源」类头：白名单之外，**一个都不许**上行
        authorization: 'Bearer browser-token-must-not-leak',
        referer: `${CONSOLE_ORIGIN}/reports/1/edit`,
        'x-api-key': 'browser-forged-key-must-not-win',
      },
    })
    expect(res.status).toBe(200)

    const proxied = callsTo(calls, '/api/session/properties')
    expect(proxied).toHaveLength(1)
    const h = proxied[0].headers
    // ① Cookie 不上行（两条 Cookie 名字都断一遍：命门是「整条 cookie 头别过」）
    expect(h.cookie).toBeUndefined()
    // ② 浏览器身份/来源类头不上行
    expect(h.authorization).toBeUndefined()
    expect(h.referer).toBeUndefined()
    // ③ 服务身份来自 env，**不是**浏览器覆盖的那把
    expect(h['x-api-key']).toBe(UPSTREAM_KEY)
    // ④ 白名单**确实在透传**（否则「拦住了 cookie」可能只是因为什么都没转发）
    expect(h.accept).toBe('application/json')
    // ⑤ 打到配置的上游 host 上（不是在本地自转）
    expect(proxied[0].url).toBe(`${UPSTREAM}/api/session/properties`)
    // ⑥ 取卡片那条腿同样是服务身份、同样不带 Cookie
    const dashboard = callsTo(calls, '/api/dashboard/101')
    expect(dashboard).toHaveLength(1)
    expect(dashboard[0].headers['x-api-key']).toBe(UPSTREAM_KEY)
    expect(dashboard[0].headers.cookie).toBeUndefined()
  })

  it('POST 的请求体与 content-type 照常上行（白名单不是「什么都不转发」）', async () => {
    // did=102
    const { calls } = installFetch((p) => /^\/api\/dashboard\/102$/.test(p)
      ? new Response(JSON.stringify({ dashcards: [{ id: 1, card_id: 70 }] }), { headers: { 'content-type': 'application/json' } })
      : new Response('{"data":{}}', { headers: { 'content-type': 'application/json' } }))
    const app = createApp(cfg)
    const res = await app.request('/api/card/70/query', {
      method: 'POST',
      headers: { cookie: cookieFor(102), 'content-type': 'application/json' },
      body: JSON.stringify({ parameters: [] }),
    })
    expect(res.status).toBe(200)
    const sent = callsTo(calls, '/api/card/70/query')
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].headers['content-type']).toBe('application/json')
    expect(sent[0].body).toBe('{"parameters":[]}')
    expect(sent[0].headers.cookie).toBeUndefined()
  })
})

describe('★ 上游纪律 ②：头改写（剥 X-Frame-Options，设只许 console 嵌的 CSP）', () => {
  it('上游回 x-frame-options:DENY + 自带 CSP ⇒ 响应无 x-frame-options，CSP 是我们的 frame-ancestors', async () => {
    // did=103
    installFetch((p) => /^\/api\/dashboard\/103$/.test(p)
      ? new Response(JSON.stringify({ dashcards: [] }), { headers: { 'content-type': 'application/json' } })
      : new Response('<html>shell</html>', {
        headers: {
          'content-type': 'text/html',
          'x-frame-options': 'DENY',
          'content-security-policy': "default-src 'none'",
          'x-keep-me': 'yes',
        },
      }))
    const app = createApp(cfg)
    const res = await app.request('/', { headers: { cookie: cookieFor(103) } })
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('<html>shell</html>')
    // ① X-Frame-Options 必须没了（留着 ⇒ console 的 iframe 打不开）
    expect(res.headers.get('x-frame-options')).toBeNull()
    // ② CSP **替换**为我们这条（不是追加：同名指令先到先得，追加等于没放行——见 upstream.ts 注）
    expect(res.headers.get('content-security-policy')).toBe(`frame-ancestors ${CONSOLE_ORIGIN}`)
    // ③ 只许 console 嵌：CSP 里不能出现别的来源/通配
    expect(res.headers.get('content-security-policy')).not.toMatch(/\*|\bself\b/)
    // ④ 其它头照常透传（不是「把头上全清空」）
    expect(res.headers.get('x-keep-me')).toBe('yes')
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})

describe('★ 401/403 契约（Task 2 欠下的）', () => {
  it('无 Cookie ⇒ 401 UNAUTHORIZED + no-store（不区分「没带」与「带坏了」给攻击者探针）', async () => {
    const { calls } = installFetch()
    const app = createApp(cfg)
    const res = await app.request('/api/session/properties')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' })
    expect(res.headers.get('cache-control')).toBe('no-store')
    // 鉴权不过就**根本没碰上游**（除卡片集合那条腿：它也在鉴权之后，故这里应零调用）
    expect(calls).toHaveLength(0)
  })

  const badCookies: [label: string, cookie: string][] = [
    ['不是 JWT', `mb_edit=${'not-a-jwt'}`],
    ['签名坏（尾字符改掉）', `mb_edit=${signProxySession({ org: 'acme', did: 1 }, SECRET)}x`],
    ['另一把 secret 签的', `mb_edit=${signProxySession({ org: 'acme', did: 1 }, 'another-secret-another-secret!!')}`],
    ['**原始** secret 签的（域分隔：会拿它当合法会话，正是不许的串用）', `mb_edit=${rawSecretSession(1)}`],
    ['已过期', `mb_edit=${signProxySession({ org: 'acme', did: 1 }, SECRET, -10)}`],
    ['Cookie 名不对（拿平台的 platform_session 冒充）', `platform_session=${signProxySession({ org: 'acme', did: 1 }, SECRET)}`],
  ]

  it.each(badCookies)('%s ⇒ 401（不抛）', async (_label, cookie) => {
    installFetch()
    const app = createApp(cfg)
    const res = await app.request('/api/session/properties', { headers: { cookie } })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHORIZED' })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('有效 Cookie 但路径不在规则表 ⇒ 403 NOT_ALLOWED + no-store，且**不**把该路径打到上游', async () => {
    // did=104
    const { calls } = installFetch()
    const app = createApp(cfg)
    for (const p of ['/api/search', '/api/dataset', '/collection/1', '/admin/settings', '/dashboard/8']) {
      const res = await app.request(p, { headers: { cookie: cookieFor(104) } })
      expect(res.status, p).toBe(403)
      expect(await res.json(), p).toEqual({ error: 'NOT_ALLOWED' })
      expect(res.headers.get('cache-control'), p).toBe('no-store')
      // deny 是**在透传之前**断的：被拒路径一次都没到上游（否则「拒绝」只是话术）
      expect(callsTo(calls, p), p).toHaveLength(0)
    }
  })

  it('/healthz 免鉴权（探活不带业务身份）——401 契约的唯一例外', async () => {
    installFetch()
    const app = createApp(cfg)
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('★ 编码分隔符绕过（`/app/..%2f..%2fapi/search`）⇒ 403，且那次枚举请求**没到上游**', async () => {
    // did=107。不做归一化的话这条会 200 且上游收到 `/api/search`（放行表被前缀骗过）——
    // 这正是「判的是 A、发的 B」的开洞方式，见 rules.normalizePath 头注。
    const { calls } = installFetch()
    const app = createApp(cfg)
    for (const p of ['/app/..%2f..%2fapi/search', '/app/..%252f..%252fapi/search', '/app/..%5c..%5capi/search']) {
      const res = await app.request(p, { headers: { cookie: cookieFor(107) } })
      expect(res.status, p).toBe(403)
      expect(await res.json(), p).toEqual({ error: 'NOT_ALLOWED' })
      // 一次都没打到上游的那条路径上（判了 deny 就在本地断掉）
      expect(calls.filter((c) => c.pathname === '/api/search'), p).toHaveLength(0)
    }
  })

  it('★ 上行的路径就是判过的那一份（归一化结果，不是原串）', async () => {
    // did=108：`/app/dist%2fmain.js` 的 `%2f` 原样留在 Hono 的 c.req.path 里（decodeURI 不解保留字），
    // 归一化后才是 `/app/dist/main.js`。上行必须是**归一后**那份（若各自现取，两条就分叉了）。
    const { calls } = installFetch()
    const app = createApp(cfg)
    const res = await app.request('/app/dist%2fmain.js', { headers: { cookie: cookieFor(108) } })
    expect(res.status).toBe(200)
    const proxied = calls.filter((c) => c.pathname !== '/api/dashboard/108')
    expect(proxied).toHaveLength(1)
    expect(proxied[0].pathname).toBe('/app/dist/main.js')
    expect(proxied[0].url).toBe(`${UPSTREAM}/app/dist/main.js`)
  })

  it('★ 上游的 Set-Cookie 不许落到反代自己的域上（纪律 ② 的镜像面）', async () => {
    // did=109
    installFetch((p) => /^\/api\/dashboard\/109$/.test(p)
      ? new Response(JSON.stringify({ dashcards: [] }), { headers: { 'content-type': 'application/json' } })
      : new Response('{}', { headers: { 'content-type': 'application/json', 'set-cookie': 'metabase.SESSION=upstream-secret; Path=/' } }))
    const app = createApp(cfg)
    const res = await app.request('/api/session/properties', { headers: { cookie: cookieFor(109) } })
    expect(res.status).toBe(200)
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  // ⚠️ `/handoff` 免鉴权（无 Cookie 仍能兑换）由 handoff.test.ts 的 HTTP describe 钉住：
  //    它走的也是 `createApp(cfg)`，若有人把 `use('*')` 提到 `/handoff` 之前，那里立刻变红。
})

describe('★ 卡片集合：fail-closed（取不到 ⇒ 空集 ⇒ 卡片面不放行）', () => {
  it('上游读 dashboard 失败（500）⇒ 卡片 query **403**（不因为「读不出」而放行一切）', async () => {
    // did=105
    installFetch((p) => /^\/api\/dashboard\/105$/.test(p)
      ? new Response('boom', { status: 500 })
      : new Response('{}', { headers: { 'content-type': 'application/json' } }))
    const app = createApp(cfg)
    const res = await app.request('/api/card/70/query', { method: 'POST', headers: { cookie: cookieFor(105) } })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'NOT_ALLOWED' })
  })

  it('上游正常 ⇒ 属于该 dashboard 的卡片可查（POST /api/card/70/query），不在集合里的 403', async () => {
    // did=106
    const { calls } = installFetch((p) => /^\/api\/dashboard\/106$/.test(p)
      // 含一张 `card_id: null` 的文本卡：必须被跳过而不是让整组解析失败
      ? new Response(JSON.stringify({ dashcards: [{ id: 1, card_id: 70 }, { id: 2, card_id: null }] }),
        { headers: { 'content-type': 'application/json' } })
      : new Response('{"data":{"rows":[]}}', { headers: { 'content-type': 'application/json' } }))
    const app = createApp(cfg)

    const ok = await app.request('/api/card/70/query', {
      method: 'POST',
      headers: { cookie: cookieFor(106), 'content-type': 'application/json' },
      body: '{"parameters":[]}',
    })
    expect(ok.status).toBe(200)
    const sent = callsTo(calls, '/api/card/70/query')
    expect(sent).toHaveLength(1)
    expect(sent[0].method).toBe('POST')
    expect(sent[0].body).toBe('{"parameters":[]}')   // 请求体确实转发（不是空打成上游）

    const other = await app.request('/api/card/71/query', { method: 'POST', headers: { cookie: cookieFor(106) } })
    expect(other.status).toBe(403)
    // 卡片**内容**面（GET /api/card/70）仍拒
    expect((await app.request('/api/card/70', { headers: { cookie: cookieFor(106) } })).status).toBe(403)
  })
})

// ——— 直接单测 `verifyProxySession`（会话解身份是安全关键件；HTTP 级只覆盖到「用它之后」的行为）———
describe('verifyProxySession（鉴权的解身份件）', () => {
  it('有效会话 ⇒ {org,did}；过期/坏签名/结构错/原始密钥签 ⇒ null', () => {
    expect(verifyProxySession(signProxySession({ org: 'acme', did: 7 }, SECRET, 60, 1000), SECRET, 1000))
      .toEqual({ org: 'acme', did: 7 })
    // 边界：恰好到期不收（与 verifyEditHandoff 同侧，`exp <= now`）
    expect(verifyProxySession(signProxySession({ org: 'acme', did: 7 }, SECRET, 60, 1000), SECRET, 1060)).toBeNull()
    expect(verifyProxySession(signProxySession({ org: 'acme', did: 7 }, SECRET, 60, 1000) + 'x', SECRET, 1000)).toBeNull()
    expect(verifyProxySession('not-a-jwt', SECRET, 1000)).toBeNull()
    expect(verifyProxySession(signProxySession({ org: 'acme', did: 7 }, 'other-secret-other-secret-yes!!', 60, 1000), SECRET, 1000)).toBeNull()
    // ★ 域分隔：用**原始** secret 签的 ⇒ null（否则宿主 verifySession 会把代理会话当空 scope 合法会话收下）
    expect(verifyProxySession(rawSecretSession(7), SECRET, 9_999_999_999)).toBeNull()
  })

  it('★ 形状守卫：签名已过，只有形状检查能拒（did 非整数 / org 空 / exp 字符串）', () => {
    // 正向对照：同一签名器签**合法**载荷 ⇒ 通过（否则整组恒真、什么都没测到）
    expect(verifyProxySession(signRawSession({ org: 'acme', did: 7, iat: 1000, exp: 9_999_999_999 }), SECRET, 1000))
      .toEqual({ org: 'acme', did: 7 })
    for (const payload of [
      { org: 'acme', did: 1.5, iat: 1000, exp: 9_999_999_999 },
      { org: 'acme', did: '7', iat: 1000, exp: 9_999_999_999 },
      { org: 'acme', did: null, iat: 1000, exp: 9_999_999_999 },
      { org: '', did: 7, iat: 1000, exp: 9_999_999_999 },
      { org: 'acme', did: 7, iat: 1000, exp: '9999999999' },
      { org: 'acme', did: 7, iat: 1000 },          // exp 缺失
    ]) {
      expect(verifyProxySession(signRawSession(payload), SECRET, 1000)).toBeNull()
    }
  })
})

// —— 域分隔的两个反面样本：**刻意用错的密钥**签，用来钉住「必须走派生密钥」。 ——
/** 用**原始** secret（不经 'mb-edit-session-v1' 派生）签一枚同形状会话 ⇒ 必须验不过。 */
function rawSecretSession(did: number): string {
  return jwt({ org: 'acme', did, iat: 1000, exp: 9_999_999_999 }, (m) => createHmac('sha256', SECRET).update(m).digest())
}

/** 用**正确**的派生密钥签一枚**任意** payload（形状守卫用；`signProxySession` 签不出畸形载荷）。 */
function signRawSession(payload: Record<string, unknown>): string {
  const key = createHmac('sha256', SECRET).update('mb-edit-session-v1').digest()
  // payload **原样**签（不再补默认值）：否则「exp 缺失」那条会被这里补上 exp ⇒ 用例恒真、什么都没测到
  return jwt(payload, (m) => createHmac('sha256', key).update(m).digest())
}

function jwt(payload: Record<string, unknown>, sign: (msg: string) => Buffer): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${h}.${p}.${sign(`${h}.${p}`).toString('base64url')}`
}
