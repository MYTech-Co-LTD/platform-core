import { describe, expect, it } from 'vitest'
import { buildAuthorizeUrl, buildWecomSilentUrl, wecomUserIdForCode } from './wecom'

// URL 形状钉死（移植参考：旧仓 gateway provider-login.js / sso-shell.js 生产验证版）：
//   - authorize（qr/silent）：Casdoor /login/oauth/authorize 基座 + provider 预选 + mode 区分。
//   - 静默：open.weixin.qq.com snsapi_base（免扫码免确认），#wechat_redirect 收尾。
//   - state 一律原样透传：旧仓的 btoa 内层编码不在本层（编码责任在调用方宿主路由）。
// 断言只按端点名（gettoken/getuserinfo）区分 mock 请求，不硬编码真实域名。

describe('buildAuthorizeUrl', () => {
  const origin = 'https://sso.example.com'
  const redirect = 'https://portal.example.com/api/platform/auth/wecom/callback'

  it('qr 模式：authorize 基座 + provider=provider_wecom&mode=qr，redirect_uri/state 正确编码', () => {
    const url = buildAuthorizeUrl(origin, 'client_1', redirect, 'st/ate+1&x=2', 'qr')
    expect(url.startsWith(`${origin}/login/oauth/authorize?`)).toBe(true)
    expect(url).toContain('provider=provider_wecom&mode=qr')
    // 编码证据：/ + & = 必须转义进 query（裸拼会被截断成多个参数）
    expect(url).toContain('state=st%2Fate%2B1%26x%3D2')
    expect(url).toMatch(/redirect_uri=https%3A%2F%2F/)
    const q = new URL(url).searchParams
    expect(q.get('client_id')).toBe('client_1')
    expect(q.get('redirect_uri')).toBe(redirect) // 编码后往返还原
    expect(q.get('state')).toBe('st/ate+1&x=2')
    expect(q.get('response_type')).toBe('code')
  })

  it('silent 模式：同基座 provider 预选 + mode=silent（宿主整页跳转用）', () => {
    const url = buildAuthorizeUrl(origin, 'client_1', redirect, 'abc', 'silent')
    expect(url.startsWith(`${origin}/login/oauth/authorize?`)).toBe(true)
    expect(url).toContain('provider=provider_wecom&mode=silent')
    expect(new URL(url).searchParams.get('redirect_uri')).toBe(redirect)
  })

  it('casdoorOrigin 尾斜杠容忍', () => {
    const url = buildAuthorizeUrl(`${origin}/`, 'client_1', redirect, 's', 'qr')
    expect(url.startsWith(`${origin}/login/oauth/authorize?`)).toBe(true)
  })

  // ---- providerName（issue #27）：租户级 provider，共享 Casdoor 上 provider 名全局唯一 ----

  it('★ providerName 可传：用租户自己那个 provider，其余参数不受影响', () => {
    const url = buildAuthorizeUrl(origin, 'client_1', redirect, 's', 'qr', 'wecom_mytech')
    expect(url).toContain('provider=wecom_mytech&mode=qr')
    expect(url).not.toContain('provider=provider_wecom')
    const q = new URL(url).searchParams
    expect(q.get('redirect_uri')).toBe(redirect) // 编码往返仍对
    expect(q.get('scope')).toBe('read')          // 与本改动无关的既有断言不漂
    expect(q.get('response_type')).toBe('code')
  })

  it('★ 缺省不变（回归钉）：不传 与 显式传 undefined 生成**逐字相同**的 URL', () => {
    // 路由用 `t.wecom_provider ?? undefined` 取值 ⇒ 「列里是 NULL」走的正是这条等价路径。
    // 上面那两条 provider=provider_wecom 的用例即"与改动前逐字相同"的正面证据；
    // 这里再钉住"undefined 与不传同义"，避免将来有人把缺省值从参数默认值挪到别处。
    expect(buildAuthorizeUrl(origin, 'client_1', redirect, 'st', 'qr', undefined))
      .toBe(buildAuthorizeUrl(origin, 'client_1', redirect, 'st', 'qr'))
  })
})

describe('buildWecomSilentUrl', () => {
  it('含 scope=snsapi_base&appid=<corpId>，redirect_uri 编码，#wechat_redirect 收尾', () => {
    const url = buildWecomSilentUrl(
      { corpId: 'ww_corp_1', agentId: '1000002' },
      'https://portal.example.com/api/platform/auth/wecom/callback?via=silent',
      'st=ate&1',
    )
    expect(url.startsWith('https://open.weixin.qq.com/connect/oauth2/authorize?')).toBe(true)
    expect(url).toContain('scope=snsapi_base&appid=ww_corp_1')
    expect(url.endsWith('#wechat_redirect')).toBe(true)
    const q = new URL(url).searchParams
    expect(q.get('redirect_uri')).toBe('https://portal.example.com/api/platform/auth/wecom/callback?via=silent')
    expect(q.get('response_type')).toBe('code')
    expect(q.get('state')).toBe('st=ate&1')
    expect(q.get('agentid')).toBe('1000002')
  })

  it('agentId 未配 → 不带 agentid 参数', () => {
    const url = buildWecomSilentUrl({ corpId: 'ww_corp_1' }, 'https://h.example.com/cb', 's')
    expect(new URL(url).searchParams.has('agentid')).toBe(false)
  })
})

// ---- wecomUserIdForCode：gettoken → getuserinfo → userid（注入 fetchFn，零真实网络） ----

interface FakeOpts {
  token?: string
  expiresIn?: number
  userid?: string
  tokenErrcode?: number
  userinfoErrcode?: number
}

/** 假企微 API：按 URL 内端点名（gettoken/auth/getuserinfo）分发 canned JSON，并记录调用序列 */
function wecomFetchSpy(calls: string[], o: FakeOpts = {}): typeof globalThis.fetch {
  const json = (obj: unknown) => new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } })
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('gettoken')) {
      if (o.tokenErrcode != null) return json({ errcode: o.tokenErrcode, errmsg: 'bad secret' })
      return json({ errcode: 0, access_token: o.token ?? 'TOK_1', expires_in: o.expiresIn ?? 7200 })
    }
    if (url.includes('getuserinfo')) {
      if (o.userinfoErrcode != null) return json({ errcode: o.userinfoErrcode, errmsg: 'bad code' })
      return json({ errcode: 0, userid: o.userid ?? 'wo_user_1' })
    }
    throw new Error('unexpected fetch url: ' + url)
  }) as unknown as typeof globalThis.fetch
}

const endpointOf = (u: string): string => (u.includes('gettoken') ? 'gettoken' : 'getuserinfo')

describe('wecomUserIdForCode', () => {
  it('gettoken → getuserinfo → 返回 userid（调用序列 gettoken,getuserinfo）', async () => {
    const calls: string[] = []
    const uid = await wecomUserIdForCode({ corpId: 'ww_corp_happy', secret: 'sec' }, 'CODE_1', wecomFetchSpy(calls, { userid: 'wo_zhang' }))
    expect(uid).toBe('wo_zhang')
    expect(calls.map(endpointOf)).toEqual(['gettoken', 'getuserinfo'])
  })

  it('token 缓存命中：同 corpId 第二次只打一次 gettoken（序列 gettoken,getuserinfo,getuserinfo）', async () => {
    const calls: string[] = []
    const uid1 = await wecomUserIdForCode({ corpId: 'ww_corp_cache', secret: 'sec' }, 'C1', wecomFetchSpy(calls))
    const uid2 = await wecomUserIdForCode({ corpId: 'ww_corp_cache', secret: 'sec' }, 'C2', wecomFetchSpy(calls))
    expect([uid1, uid2]).toEqual(['wo_user_1', 'wo_user_1'])
    expect(calls.map(endpointOf)).toEqual(['gettoken', 'getuserinfo', 'getuserinfo'])
  })

  it('expires_in 短于 60s 提前量 → 缓存立即失效，第二次重新 gettoken', async () => {
    const calls: string[] = []
    await wecomUserIdForCode({ corpId: 'ww_corp_exp', secret: 'sec' }, 'C1', wecomFetchSpy(calls, { expiresIn: 1 }))
    await wecomUserIdForCode({ corpId: 'ww_corp_exp', secret: 'sec' }, 'C2', wecomFetchSpy(calls, { expiresIn: 1 }))
    expect(calls.map(endpointOf)).toEqual(['gettoken', 'getuserinfo', 'gettoken', 'getuserinfo'])
  })

  it('getuserinfo errcode 非 0 → 抛错且带 errcode', async () => {
    const calls: string[] = []
    await expect(
      wecomUserIdForCode({ corpId: 'ww_corp_uerr', secret: 'sec' }, 'BAD', wecomFetchSpy(calls, { userinfoErrcode: 40029 })),
    ).rejects.toThrow('wecom api errcode 40029')
  })

  it('gettoken errcode 非 0 → 抛错且带 errcode，不再打 getuserinfo', async () => {
    const calls: string[] = []
    await expect(
      wecomUserIdForCode({ corpId: 'ww_corp_terr', secret: 'bad' }, 'C', wecomFetchSpy(calls, { tokenErrcode: 40001 })),
    ).rejects.toThrow('wecom api errcode 40001')
    expect(calls).toHaveLength(1)
  })
})
