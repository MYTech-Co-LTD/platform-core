import { describe, expect, it } from 'vitest'
import { buildWechatOaSilentUrl, wechatOaOpenidForCode } from './wechat-oa'

describe('buildWechatOaSilentUrl', () => {
  it('snsapi_base 静默授权：appid/redirect_uri/state 正确编码，尾带 #wechat_redirect', () => {
    const url = buildWechatOaSilentUrl('wx123', 'https://x.example.com/cb?via=silent', 'st-1')
    expect(url).toContain('https://open.weixin.qq.com/connect/oauth2/authorize')
    expect(url).toContain('appid=wx123')
    expect(url).toContain('redirect_uri=' + encodeURIComponent('https://x.example.com/cb?via=silent'))
    expect(url).toContain('scope=snsapi_base')
    expect(url).toContain('state=st-1')
    expect(url.endsWith('#wechat_redirect')).toBe(true)
  })
})

describe('wechatOaOpenidForCode', () => {
  const ok = (openid: string) => (input: string | URL | Request) =>
    Promise.resolve(new Response(JSON.stringify({ access_token: 't', expires_in: 7200, openid }), { status: 200 }))

  it('200 + openid ⇒ 返回 openid', async () => {
    expect(await wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', ok('oX1') as typeof fetch)).toBe('oX1')
  })
  it('200 + errcode≠0（微信以 200 回错误）⇒ null（被拒，非传输）', async () => {
    const f = () => Promise.resolve(new Response(JSON.stringify({ errcode: 40029, errmsg: 'invalid code' }), { status: 200 }))
    expect(await wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', f as typeof fetch)).toBeNull()
  })
  it('200 无 openid ⇒ null', async () => {
    const f = () => Promise.resolve(new Response(JSON.stringify({ access_token: 't' }), { status: 200 }))
    expect(await wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', f as typeof fetch)).toBeNull()
  })
  it('5xx / 非 JSON ⇒ throw（传输层，路由按 502 类，不吞成 BAD_CODE）', async () => {
    const f5 = () => Promise.resolve(new Response('bad gateway', { status: 502 }))
    await expect(wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', f5 as typeof fetch)).rejects.toThrow()
    const fHtml = () => Promise.resolve(new Response('<html>', { status: 200 }))
    await expect(wechatOaOpenidForCode({ appId: 'a', secret: 's' }, 'c', fHtml as typeof fetch)).rejects.toThrow()
  })
})
