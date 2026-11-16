// internal-identity.test.ts — 网关→模块内部签名身份的契约（签发/验签/中间件）。
import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
import {
  INTERNAL_IDENTITY_HEADER,
  identityFromInternal,
  internalIdentityMiddleware,
  issueInternalIdentity,
  verifyInternalIdentity,
} from './internal-identity'
import type { RequesterEnv } from './pat-auth'
import type { TenantRow } from './tenant'

/** 中间件租户封印测试用的最小 tenant 行。 */
const baseTenant: TenantRow = {
  id: 9003, slug: 'acme', casdoor_org: 'acme', product_name: 'P', logo: null,
  primary_color: '#1677ff', background: '', login_methods: ['password'],
  wecom_corp_id: null, wecom_agent_id: null, wecom_secret: null, wecom_provider: null,
  wecom_auto_signup: false,
  wechat_oa_app_id: null, wechat_oa_secret: null,
  storage_endpoint: null, storage_region: null, storage_bucket: null,
  storage_access_key: null, storage_secret: null,
  // 审批应用凭据五列（OA P2，022）：本组用例不消费 ⇒ null（未配置）即可
  wecom_approval_corp_id: null, wecom_approval_agent_id: null, wecom_approval_secret: null,
  wecom_approval_token: null, wecom_approval_aes_key: null,
  created_at: new Date(),
}

const PAYLOAD = {
  org: 'acme',
  userId: 'u1',
  channel: 'wecom' as const,
  scopes: ['data:query'],
  sessionId: 's1',
}

/** 翻转 MAC 的末位字符（长度不变；末位为 A 时换 B，避免“翻转成自身”）。 */
function tamperMac(header: string): string {
  const [payload, mac] = header.split('.')
  return `${payload}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`
}

describe('internal identity', () => {
  it('签发后可验', () => {
    const h = issueInternalIdentity(PAYLOAD)
    expect(verifyInternalIdentity(h)).toMatchObject({
      org: 'acme', userId: 'u1', channel: 'wecom', scopes: ['data:query'], sessionId: 's1',
    })
  })

  it('缺头 / 空头 / 无分隔符 ⇒ null', () => {
    expect(verifyInternalIdentity(undefined)).toBeNull()
    expect(verifyInternalIdentity('')).toBeNull()
    expect(verifyInternalIdentity('no-dot')).toBeNull()
  })

  it('篡改 MAC / 篡改 payload ⇒ null', () => {
    const h = issueInternalIdentity(PAYLOAD)
    expect(verifyInternalIdentity(tamperMac(h))).toBeNull()

    const [payload, mac] = h.split('.')
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...PAYLOAD, exp: Date.now() + 30_000, userId: 'attacker' }),
    ).toString('base64url')
    expect(verifyInternalIdentity(`${forgedPayload}.${mac}`)).toBeNull()
    expect(verifyInternalIdentity(`${payload}.${mac}`)).not.toBeNull()
  })

  it('过期 ⇒ null（30s TTL）', () => {
    const h = issueInternalIdentity(PAYLOAD)
    expect(verifyInternalIdentity(h, Date.now() + 60_000)).toBeNull()
  })

  it('多字节 MAC（同字符数、不同字节数）⇒ null 且不抛', () => {
    const [payload] = issueInternalIdentity(PAYLOAD).split('.')
    // 43 个 `中` 的 UTF-16 字符数 = 43（与 base64url MAC 相同），UTF-8 字节数 = 129。
    expect(() => verifyInternalIdentity(`${payload}.${'中'.repeat(43)}`)).not.toThrow()
    expect(verifyInternalIdentity(`${payload}.${'中'.repeat(43)}`)).toBeNull()
  })

  it('多段 header（valid + trailing garbage）⇒ null', () => {
    const h = issueInternalIdentity(PAYLOAD)
    expect(verifyInternalIdentity(`${h}.garbage`)).toBeNull()
    expect(verifyInternalIdentity(h)).toMatchObject({ userId: 'u1' })
  })

  it('signed-but-malformed payload（缺 scopes / 空 userId / 空 org）⇒ null', () => {
    const noScopes = issueInternalIdentity(
      { ...PAYLOAD, scopes: undefined } as unknown as Parameters<typeof issueInternalIdentity>[0],
    )
    expect(verifyInternalIdentity(noScopes)).toBeNull()
    expect(verifyInternalIdentity(issueInternalIdentity({ ...PAYLOAD, userId: '' }))).toBeNull()
    expect(verifyInternalIdentity(issueInternalIdentity({ ...PAYLOAD, org: '' }))).toBeNull()
  })

  it('两个模块实例密钥不共享：A 签发 ⇒ B 验证为 null', async () => {
    vi.resetModules()
    const a = await import('./internal-identity')
    vi.resetModules()
    const b = await import('./internal-identity')
    const h = a.issueInternalIdentity(PAYLOAD)
    expect(a.verifyInternalIdentity(h)).not.toBeNull()
    expect(b.verifyInternalIdentity(h)).toBeNull()
  })

  it('头名固定为 x-internal-identity', () => {
    expect(INTERNAL_IDENTITY_HEADER).toBe('x-internal-identity')
  })
})

describe('identityFromInternal', () => {
  it('透出 scopes / hasScope 与可选 accountName / sessionId', () => {
    const id = identityFromInternal({
      org: 'acme', userId: 'u1', channel: 'pat', scopes: ['data:query', 'data:admin'],
      accountName: 'alice', sessionId: 'sess-1', roles: ['analyst'],
      boundExternalIds: ['wx-openid-1'], exp: Date.now() + 30_000,
    })
    expect(id).toMatchObject({
      userId: 'u1', orgId: 'acme', displayName: 'u1', accountName: 'alice',
      sessionId: 'sess-1', roles: ['analyst'], boundExternalIds: ['wx-openid-1'],
    })
    expect(id.hasScope('data:query')).toBe(true)
    expect(id.hasScope('nope')).toBe(false)
  })

  it('无可选字段时不留空键', () => {
    const id = identityFromInternal({
      org: 'acme', userId: 'u1', channel: 'session', scopes: [], exp: Date.now() + 30_000,
    })
    expect(id.displayName).toBe('u1')
    expect('accountName' in id).toBe(false)
    expect('sessionId' in id).toBe(false)
    expect('roles' in id).toBe(false)
    expect('boundExternalIds' in id).toBe(false)
  })
})

describe('internalIdentityMiddleware', () => {
  const probeApp = (opts: { preset?: Identity; tenantOrg?: string } = {}) => {
    const app = new Hono<RequesterEnv>()
    // 租户中间件（与 wecom-channel-auth.test.ts 同形）：internal identity 需要当前 tenant 做 org 封印。
    app.use('/api/modules/*', async (c, next) => {
      c.set('tenant', { ...baseTenant, casdoor_org: opts.tenantOrg ?? 'acme' })
      await next()
    })
    if (opts.preset) {
      app.use('/api/modules/*', async (c, next) => {
        c.set('identity', opts.preset as Identity)
        c.set(REQUESTER_CHANNEL, 'pat')
        c.set(REQUESTER_KEY_ID, 7)
        await next()
      })
    }
    app.use('/api/modules/*', internalIdentityMiddleware())
    app.get('/api/modules/probe', (c) => {
      const id = c.get('identity')
      return c.json({
        userId: id?.userId ?? null,
        orgId: id?.orgId ?? null,
        scopes: id?.scopes ?? null,
        channel: c.get(REQUESTER_CHANNEL) ?? null,
        keyId: c.get(REQUESTER_KEY_ID) ?? null,
      })
    })
    return app
  }

  const call = (app: Hono<RequesterEnv>, h: string) =>
    app.request('/api/modules/probe', { headers: { [INTERNAL_IDENTITY_HEADER]: h } })

  const EMPTY = { userId: null, orgId: null, scopes: null, channel: null, keyId: null }

  it('合法内部头 ⇒ 注入 identity + 通道变量（wecom 不写 keyId）', async () => {
    const h = issueInternalIdentity({ ...PAYLOAD, keyId: 42 })
    const res = await call(probeApp(), h)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      userId: 'u1', orgId: 'acme', scopes: ['data:query'], channel: 'wecom', keyId: null,
    })
  })

  it('keyId 仅在 channel=pat 时写 REQUESTER_KEY_ID', async () => {
    const pat = issueInternalIdentity({ ...PAYLOAD, channel: 'pat', keyId: 42 })
    expect(await (await call(probeApp(), pat)).json()).toMatchObject({ channel: 'pat', keyId: 42 })

    const patNull = issueInternalIdentity({ ...PAYLOAD, channel: 'pat', keyId: null })
    expect(await (await call(probeApp(), patNull)).json()).toMatchObject({ channel: 'pat', keyId: null })
  })

  it('session 通道不显式写 REQUESTER_CHANNEL（缺省即会话）', async () => {
    const h = issueInternalIdentity({ ...PAYLOAD, channel: 'session' })
    expect(await (await call(probeApp(), h)).json()).toMatchObject({ userId: 'u1', channel: null })
  })

  it('org 与当前 tenant 不匹配 ⇒ 不设 identity（租户封印）', async () => {
    const h = issueInternalIdentity(PAYLOAD) // org=acme
    expect(await (await call(probeApp({ tenantOrg: 'other' }), h)).json()).toEqual(EMPTY)
  })

  it('org 与当前 tenant 匹配 ⇒ 设 identity', async () => {
    const h = issueInternalIdentity(PAYLOAD) // org=acme
    expect(await (await call(probeApp({ tenantOrg: 'acme' }), h)).json())
      .toMatchObject({ userId: 'u1', orgId: 'acme' })
  })

  it('first-setter-wins：已有 identity 时内部头不覆盖', async () => {
    const preset: Identity = {
      userId: 'preset-user', orgId: 'preset-org', displayName: 'preset',
      scopes: ['preset:scope'], hasScope: (code) => code === 'preset:scope',
    }
    const h = issueInternalIdentity({ ...PAYLOAD, keyId: 42 })
    const res = await call(probeApp({ preset }), h)
    expect(await res.json()).toEqual({
      userId: 'preset-user', orgId: 'preset-org', scopes: ['preset:scope'], channel: 'pat', keyId: 7,
    })
  })

  it('过期 token 走中间件 ⇒ 不设 identity', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const h = issueInternalIdentity(PAYLOAD)
      vi.setSystemTime(Date.now() + 31_000)
      const res = await call(probeApp(), h)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual(EMPTY)
    } finally {
      vi.useRealTimers()
    }
  })

  it('伪造内部头（MAC 被篡改）不设 identity，放行给下游门卫', async () => {
    const h = tamperMac(issueInternalIdentity(PAYLOAD))
    const res = await call(probeApp(), h)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(EMPTY)
  })
})
