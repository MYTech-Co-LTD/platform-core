import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createApp } from './app'
import { claimNonce, signProxySession, verifyEditHandoff } from './handoff'
import { EDIT_TTL_SEC } from './session'
import { signForTest } from './test-sign'   // 测试专用：与模块 signEditHandoff 同算法的**极小**复刻
                                          // ⚠️ 它也必须走**派生**子密钥（同 'edit-handoff-v1' 标签），
                                          //    否则「坏签名 ⇒ null」那条会因为密钥不对而恒真

const SECRET = 'test-secret-test-secret-test-secret!'

/**
 * 用**派生**子密钥签一个**任意** payload（独立复算，不复用被测的 `handoffKey`）。
 * 为什么要它：`signForTest` 只接受形状合法的入参，签不出「缺 did / nonce 是数字」这类畸形载荷；
 * 而形状守卫只有在**签名已经通过**时才走得到——所以畸形用例必须用派生密钥签（用原始密钥签的话
 * 一定在签名步就返回 null，那样测的是签名、不是形状，正是本轮评审抓到的假证据）。
 */
function signRaw(payload: Record<string, unknown>): string {
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const key = createHmac('sha256', SECRET).update('edit-handoff-v1').digest()
  return `${h}.${p}.${createHmac('sha256', key).update(`${h}.${p}`).digest('base64url')}`
}

describe('handoff 验签', () => {
  it('★ 金样本（与 modules/data/domain/edit-handoff.test.ts 同一个串）', () => {
    const t = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJvcmciOiJhY21lIiwiZGlkIjo3LCJub25jZSI6ImdvbGRlbiIsImlhdCI6MTcwMDAwMDAwMCwiZXhwIjoxNzAwMDAwMTIwfQ.oSuZ8-zjA2GF42ugFh-KgGgMGHhRrqZHi2oTtAVX3xE'
    // 算例核对：金样本 iat=1700000000、exp=1700000120（TTL 120）。判定是 `exp <= now ⇒ 过期`
    // （RFC 7519 的严格侧：到期时刻即不收），故「有效」取**到期前 1 秒**。
    // ⚠️ brief 此处写的是 1_700_000_120，恰等于 exp ⇒ 按 brief Step 3 的实现自身会判过期
    //    （计划算例与计划实现冲突，见 task-3-report.md「偏离」节）：本测试改成 1_700_000_119，
    //    并把 1_700_000_120 保留为**边界断言**（不删该值，也不留红）。
    expect(verifyEditHandoff(t, SECRET, 1_700_000_119)).toMatchObject({ org: 'acme', did: 7, nonce: 'golden' })
    expect(verifyEditHandoff(t, SECRET, 1_700_000_120)).toBeNull()   // 恰好到期 ⇒ 不收
  })

  it('坏签名 / 过期 / 结构错 ⇒ null（不抛）', () => {
    const good = signForTest({ org: 'a', did: 1, nonce: 'n' }, SECRET, 60, 1000)
    expect(verifyEditHandoff(good + 'x', SECRET, 1000)).toBeNull()
    expect(verifyEditHandoff(good, SECRET, 1061)).toBeNull()          // exp=1060 < now
    expect(verifyEditHandoff('not-a-jwt', SECRET, 1000)).toBeNull()
    expect(verifyEditHandoff(good, 'another-secret-another-secret!!', 1000)).toBeNull()
  })

  it('★ 域分隔（评审 I-1/I-2）：**会话形状**的 token（原始密钥签）⇒ null —— 在**签名步**即被拒，与形状无关', async () => {
    // 这是「只持 data:query 的登录用户拿自己的会话 Cookie 当票据使」的攻击面。
    // ⚠️ 本用例只证明**密钥维度**（派生 vs 原始）：它用原始密钥签 ⇒ 签名比对就返回 null 了，
    //    payload 里有没有 did/nonce 根本没被看到。**不得**拿它当形状守卫的证据——那是下面
    //    「payload 形状守卫」组的职责（评审 Important）。
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({
      sub: 'u1', org: 'acme', name: '路人', scopes: ['data:query'], authVia: 'password',
      iat: 1000, exp: 9_999_999_999, sfa: 1000,
    })).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url')
    expect(verifyEditHandoff(`${header}.${payload}.${sig}`, SECRET, 1000)).toBeNull()
  })
})

describe('★ payload 形状守卫（评审 Important：守卫必须被咬住）', () => {
  const base = { org: 'acme', did: 7, nonce: 'shape-ok', iat: 1000, exp: 9_999_999_999 }

  it('正向对照：同一签名器签**合法** payload ⇒ 通过（否则整组恒真、什么都没测到）', () => {
    expect(verifyEditHandoff(signRaw(base), SECRET, 1000)).toMatchObject({ org: 'acme', did: 7, nonce: 'shape-ok' })
  })

  const malformed: [label: string, payload: Record<string, unknown>][] = [
    // did
    ['did 缺失', { org: 'acme', nonce: 'n', iat: 1000, exp: 9_999_999_999 }],
    ['did 是字符串 "7"', { ...base, did: '7' }],
    ['did 是小数 1.5', { ...base, did: 1.5 }],
    ['did 是 null', { ...base, did: null }],
    // nonce
    ['nonce 缺失', { org: 'acme', did: 7, iat: 1000, exp: 9_999_999_999 }],
    ['nonce 是数字 123', { ...base, nonce: 123 }],
    ['nonce 是空串', { ...base, nonce: '' }],
    // org
    ['org 缺失', { did: 7, nonce: 'n', iat: 1000, exp: 9_999_999_999 }],
    ['org 是空串', { ...base, org: '' }],
    ['org 是 null', { ...base, org: null }],
    // exp（本轮 Minor ③ 的严格类型：字符串 exp 不收）
    ['exp 缺失', { org: 'acme', did: 7, nonce: 'n', iat: 1000 }],
    ['exp 是数字字符串 "9999999999"', { ...base, exp: '9999999999' }],
    ['exp 是 null', { ...base, exp: null }],
  ]

  it.each(malformed)('%s ⇒ null（签名已过，只有形状检查能拒）', (_label, payload) => {
    expect(verifyEditHandoff(signRaw(payload), SECRET, 1000)).toBeNull()
  })
})

describe('nonce 一次性', () => {
  it('首次 true、重复 false', () => {
    expect(claimNonce('n-once', 1000)).toBe(true)
    expect(claimNonce('n-once', 1000)).toBe(false)
  })
  it('过期后可再用同一 nonce（窗口只有 TTL，无状态可丢）', () => {
    expect(claimNonce('n-ttl', 1000)).toBe(true)
    expect(claimNonce('n-ttl', 1000 + 121)).toBe(true)
  })
})

// —— 以下为 HTTP 级的兑换路测试（brief Step 1 未列；**加它的理由**：Step 4 挂的 `/handoff`
// 是实现主体，纯单测不覆盖「302 + Set-Cookie + 不设 Cookie 的 401 + 二次兑换被拒」这条真实
// 契约；而 app.ts 拆分（brief Files）本身就写着「为了能 HTTP 级测试而不真绑端口」）。
describe('GET /handoff 兑换', () => {
  const cfg = {
    port: 0,
    sessionSecret: SECRET,
    consoleOrigin: 'https://console.example',
    upstreamUrl: 'https://mb.example',
    upstreamApiKey: 'test-upstream-key',
  }
  const app = createApp(cfg)
  const nowSec = (): number => Math.floor(Date.now() / 1000)
  const signNow = (org: string, did: number, nonce: string): string =>
    signForTest({ org, did, nonce }, SECRET, 120, nowSec())

  it('/healthz 仍在（app.ts 拆分后没丢）', async () => {
    const res = await app.request('/healthz')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('有效票据 ⇒ 302 + Location:/dashboard/<did> + Set-Cookie mb_edit（自有会话）', async () => {
    const res = await app.request(`/handoff?t=${encodeURIComponent(signNow('acme', 7, 'http-ok'))}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('/dashboard/7')
    // 票据就在 URL 里：兑换响应不许被任何缓存留档（否则「一次性」能被缓存命中绕过）
    expect(res.headers.get('cache-control')).toBe('no-store')
    const raw = res.headers.get('set-cookie') ?? ''
    expect(raw).toMatch(/^mb_edit=/)
    expect(raw).toContain('HttpOnly')
    expect(raw).not.toMatch(/Domain=/i)
    // Cookie 里那枚是**代理自有的会话**（TTL 8h、无 nonce），不是 handoff 票据本身
    const token = raw.match(/^mb_edit=([^;]+)/)?.[1] ?? ''
    const [h, p, s] = token.split('.')
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(claims).toMatchObject({ org: 'acme', did: 7 })
    expect(claims).not.toHaveProperty('nonce')
    expect((claims.exp as number) - (claims.iat as number)).toBe(EDIT_TTL_SEC)
    // 独立复算 + 钉死标签串：Task 4 的解身份侧必须用**同一**派生密钥
    const key = createHmac('sha256', SECRET).update('mb-edit-session-v1').digest()
    expect(s).toBe(createHmac('sha256', key).update(`${h}.${p}`).digest('base64url'))
    // 且**不是**原始密钥签的（否则宿主 verifySession 会把它当空 scope 的合法会话收下 —— 反向串用）
    expect(s).not.toBe(createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'))
    // 这枚会话票据在 handoff 验签侧不成立（域分隔双向）
    expect(verifyEditHandoff(token, SECRET)).toBeNull()
  })

  it('失败 ⇒ 401 {error:INVALID_HANDOFF} 且**不设** Cookie（坏签名 / 结构错 / 已过期）', async () => {
    const expired = signForTest({ org: 'acme', did: 7, nonce: 'http-exp' }, SECRET, 60, nowSec() - 120)
    for (const t of [signNow('acme', 7, 'http-bad') + 'x', 'not-a-jwt', '', expired]) {
      const res = await app.request(`/handoff?t=${encodeURIComponent(t)}`)
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'INVALID_HANDOFF' })
      expect(res.headers.get('set-cookie')).toBeNull()
      expect(res.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('★ 同一票据第二次兑换 ⇒ 401（nonce 一次性，重放不放行）', async () => {
    const t = encodeURIComponent(signNow('acme', 9, 'http-replay'))
    expect((await app.request(`/handoff?t=${t}`)).status).toBe(302)
    const again = await app.request(`/handoff?t=${t}`)
    expect(again.status).toBe(401)
    expect(again.headers.get('set-cookie')).toBeNull()
  })

  it('signProxySession 载荷契约：org/did/iat/exp(=iat+TTL)，无 nonce', () => {
    const token = signProxySession({ org: 'o', did: 3 }, SECRET, 60, 1000)
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    expect(claims).toEqual({ org: 'o', did: 3, iat: 1000, exp: 1060 })
  })
})
