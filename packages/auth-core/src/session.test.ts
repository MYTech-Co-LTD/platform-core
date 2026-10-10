import { describe, expect, it } from 'vitest'
import { SESSION_TTL_SEC, SCOPES_TTL_SEC, needsRenew, needsScopeRefresh, signSession, verifySession, csrfToken } from './session'

const secret = 'k'.repeat(32)
describe('session', () => {
  it('签发可验签，字段完整', async () => {
    const t = await signSession({ sub: 'acme/admin1', org: 'acme', name: 'admin1', scopes: ['demo:view'], authVia: 'password' }, secret, 1000)
    const p = await verifySession(t, secret)
    expect(p?.exp).toBe(1000 + SESSION_TTL_SEC); expect(p?.sfa).toBe(1000); expect(p?.scopes).toEqual(['demo:view'])
  })
  it('错 secret 验签失败返回 null', async () => {
    const t = await signSession({ sub: 'a/b', org: 'a', name: 'b', scopes: [], authVia: 'password' }, secret)
    expect(await verifySession(t, 'x'.repeat(32))).toBeNull()
  })
  it('滑动与 scopes 刷新阈值', async () => {
    const t = await signSession({ sub: 'a/b', org: 'a', name: 'b', scopes: [], authVia: 'password' }, secret, 0)
    const p = (await verifySession(t, secret))!
    expect(needsScopeRefresh(p, 0 + SCOPES_TTL_SEC)).toBe(true)
    expect(needsScopeRefresh(p, 10)).toBe(false)
    expect(needsRenew(p, SESSION_TTL_SEC - 1)).toBe(true)   // 剩余<6天
    expect(needsRenew(p, 100)).toBe(false)
  })
  it('csrfToken 稳定且可复算', async () => {
    const t = await signSession({ sub: 'a/b', org: 'a', name: 'b', scopes: [], authVia: 'password' }, secret, 0)
    const p = (await verifySession(t, secret))!
    expect(csrfToken(p, secret)).toBe(csrfToken(p, secret))
  })
  it('acct/ext 往返保真', async () => {
    const t = await signSession({ sub: 'oA', org: 'org1', name: 'u1', scopes: ['aftersales:guest'], authVia: 'wechat-oa', acct: 'u1', ext: ['oA', 'oB'] }, secret, 1000)
    const p = await verifySession(t, secret)
    expect(p?.acct).toBe('u1'); expect(p?.ext).toEqual(['oA', 'oB'])
  })
  it('不设 acct/ext：验签得到 undefined，与旧 token 形状一致', async () => {
    const t = await signSession({ sub: 'n1', org: 'org1', name: 'n1', scopes: [], authVia: 'password' }, secret, 1000)
    const p = await verifySession(t, secret)
    expect(p?.acct).toBeUndefined(); expect(p?.ext).toBeUndefined()
  })
  it('不设 acct/ext：签出的 JWT 载荷不含这两个 claim 键（旧 token 逐字节兼容红线）', async () => {
    const t = await signSession({ sub: 'n1', org: 'org1', name: 'n1', scopes: [], authVia: 'password' }, secret, 1000)
    const claims = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()) as Record<string, unknown>
    expect('acct' in claims).toBe(false)
    expect('ext' in claims).toBe(false)
  })
})
