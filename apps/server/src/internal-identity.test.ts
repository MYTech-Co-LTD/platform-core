// internal-identity.test.ts — 网关→模块内部签名身份的契约（签发/验签/中间件）。
import { describe, expect, it } from 'vitest'
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

  it('头名固定为 x-internal-identity', () => {
    expect(INTERNAL_IDENTITY_HEADER).toBe('x-internal-identity')
  })
})

describe('identityFromInternal', () => {
  it('透出 scopes / hasScope 与可选 accountName / sessionId', () => {
    const id = identityFromInternal({
      org: 'acme', userId: 'u1', channel: 'pat', scopes: ['data:query', 'data:admin'],
      accountName: 'alice', sessionId: 'sess-1', roles: ['analyst'], exp: Date.now() + 30_000,
    })
    expect(id).toMatchObject({
      userId: 'u1', orgId: 'acme', displayName: 'u1', accountName: 'alice',
      sessionId: 'sess-1', roles: ['analyst'],
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
  })
})

describe('internalIdentityMiddleware', () => {
  const probeApp = (preset?: Identity) => {
    const app = new Hono<RequesterEnv>()
    if (preset) {
      app.use('/api/modules/*', async (c, next) => {
        c.set('identity', preset)
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

  it('合法内部头 ⇒ 注入 identity + 通道变量', async () => {
    const h = issueInternalIdentity({ ...PAYLOAD, keyId: 42 })
    const res = await probeApp().request('/api/modules/probe', {
      headers: { [INTERNAL_IDENTITY_HEADER]: h },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      userId: 'u1', orgId: 'acme', scopes: ['data:query'], channel: 'wecom', keyId: 42,
    })
  })

  it('session 通道不显式写 REQUESTER_CHANNEL（缺省即会话）', async () => {
    const h = issueInternalIdentity({ ...PAYLOAD, channel: 'session' })
    const res = await probeApp().request('/api/modules/probe', {
      headers: { [INTERNAL_IDENTITY_HEADER]: h },
    })
    expect(await res.json()).toMatchObject({ userId: 'u1', channel: null })
  })

  it('first-setter-wins：已有 identity 时内部头不覆盖', async () => {
    const preset: Identity = {
      userId: 'preset-user', orgId: 'preset-org', displayName: 'preset',
      scopes: ['preset:scope'], hasScope: (code) => code === 'preset:scope',
    }
    const h = issueInternalIdentity({ ...PAYLOAD, keyId: 42 })
    const res = await probeApp(preset).request('/api/modules/probe', {
      headers: { [INTERNAL_IDENTITY_HEADER]: h },
    })
    expect(await res.json()).toEqual({
      userId: 'preset-user', orgId: 'preset-org', scopes: ['preset:scope'], channel: 'pat', keyId: 7,
    })
  })

  it('伪造内部头（MAC 被篡改）不设 identity，放行给下游门卫', async () => {
    const h = tamperMac(issueInternalIdentity(PAYLOAD))
    const res = await probeApp().request('/api/modules/probe', {
      headers: { [INTERNAL_IDENTITY_HEADER]: h },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      userId: null, orgId: null, scopes: null, channel: null, keyId: null,
    })
  })
})
