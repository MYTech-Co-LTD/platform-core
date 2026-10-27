// webhook.test.ts — 出站 webhook：签名 / 状态映射 / SSRF 防护
import { describe, it, expect } from 'vitest'
import { createHmac } from 'node:crypto'
import { sendWebhook, signBody } from './webhook'

const url = 'https://hooks.example.com/x'

const okFetch = (capture: { body?: string; headers?: Record<string, string> }) =>
  (async (_u: string, init?: RequestInit) => {
    capture.body = String(init?.body)
    capture.headers = init?.headers as Record<string, string>
    return new Response(null, { status: 204 })
  }) as unknown as typeof fetch

const safeResolve = async () => ['93.184.216.34']

describe('signBody', () => {
  it('HMAC-SHA256(timestamp + "." + body)，形如 sha256=<hex>', () => {
    const ts = 1_700_000_000
    const body = '{"a":1}'
    const expected = createHmac('sha256', 'k').update(`${ts}.${body}`).digest('hex')
    expect(signBody('k', ts, body)).toBe(`sha256=${expected}`)
  })
})

describe('sendWebhook', () => {
  it('2xx ⇒ ok；带签名头与时间戳', async () => {
    const cap: { body?: string; headers?: Record<string, string> } = {}
    const r = await sendWebhook({
      url, secret: 'k', payload: { a: 1 }, fetchImpl: okFetch(cap), resolveHost: safeResolve,
    })
    expect(r).toEqual({ ok: true })
    expect(cap.body).toBe('{"a":1}')
    expect(cap.headers!['X-Notify-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(cap.headers!['X-Notify-Timestamp']).toMatch(/^\d+$/)
    expect(cap.headers!['content-type']).toBe('application/json')
  })

  it('4xx（除 408/429）⇒ permanent；408/429/5xx ⇒ retryable；网络异常 ⇒ retryable', async () => {
    const mk = (status: number) =>
      (async () => new Response('x', { status })) as unknown as typeof fetch

    expect(await sendWebhook({
      url, secret: 'k', payload: {}, fetchImpl: mk(400), resolveHost: safeResolve,
    })).toMatchObject({ ok: false, kind: 'permanent', code: '400' })

    for (const s of [408, 429, 500, 503]) {
      expect(await sendWebhook({
        url, secret: 'k', payload: {}, fetchImpl: mk(s), resolveHost: safeResolve,
      })).toMatchObject({ ok: false, kind: 'retryable', code: String(s) })
    }

    const boom = (async () => { throw new Error('ECONNRESET') }) as unknown as typeof fetch
    expect(await sendWebhook({
      url, secret: 'k', payload: {}, fetchImpl: boom, resolveHost: safeResolve,
    })).toMatchObject({ ok: false, kind: 'retryable', code: 'network' })
  })

  it('不安全 URL ⇒ permanent（不再外发）', async () => {
    let called = false
    const spy = (async () => {
      called = true
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    expect(await sendWebhook({
      url: 'http://hooks.example.com/x', secret: 'k', payload: {}, fetchImpl: spy,
    })).toMatchObject({ ok: false, kind: 'permanent', code: 'unsafe_url' })
    expect(called).toBe(false)
  })

  it('DNS 解析出私网 IP ⇒ permanent（DNS rebinding 防护）', async () => {
    expect(await sendWebhook({
      url, secret: 'k', payload: {}, fetchImpl: okFetch({}),
      resolveHost: async () => ['10.0.0.7'],
    })).toMatchObject({ ok: false, kind: 'permanent', code: 'forbidden_ip' })
  })

  it('body 超过 32KB ⇒ permanent', async () => {
    expect(await sendWebhook({
      url, secret: 'k', payload: { big: 'x'.repeat(40_000) },
      fetchImpl: okFetch({}), resolveHost: safeResolve,
    })).toMatchObject({ ok: false, kind: 'permanent', code: 'body_too_large' })
  })

  it('不跟随重定向（3xx ⇒ permanent）', async () => {
    expect(await sendWebhook({
      url, secret: 'k', payload: {},
      fetchImpl: (async () => new Response(null, { status: 302 })) as unknown as typeof fetch,
      resolveHost: safeResolve,
    })).toMatchObject({ ok: false, kind: 'permanent', code: '302' })
  })
})
