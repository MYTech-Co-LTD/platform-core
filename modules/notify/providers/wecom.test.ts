// wecom.test.ts — bridge 直发的状态映射（fetch 注入，不连网）
import { describe, it, expect } from 'vitest'
import { sendWecom } from './wecom'

const args = (fetchImpl: typeof fetch) => ({
  bridgeUrl: 'https://push.example/wecom/woke?t=tok',
  to: 'u1',
  content: 'hi',
  fetchImpl,
})

describe('sendWecom', () => {
  it('204 ⇒ ok，URL 用 & 追加 to=', async () => {
    let seen = ''
    const f = (async (url: string) => {
      seen = String(url)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    expect(await sendWecom(args(f))).toEqual({ ok: true })
    expect(seen).toBe('https://push.example/wecom/woke?t=tok&to=u1')
  })

  it('502 + errcode 45009 ⇒ retryable', async () => {
    const f = (async () => new Response(JSON.stringify({ errcode: 45009, error: 'limit' }), { status: 502 })) as unknown as typeof fetch
    expect(await sendWecom(args(f))).toMatchObject({
      ok: false, kind: 'retryable', code: '45009',
    })
  })

  it('401 / 400 ⇒ permanent', async () => {
    for (const status of [400, 401]) {
      const f = (async () => new Response('bad', { status })) as unknown as typeof fetch
      expect(await sendWecom(args(f))).toMatchObject({ ok: false, kind: 'permanent', code: String(status) })
    }
  })

  it('网络异常 ⇒ retryable', async () => {
    const f = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await sendWecom(args(f))).toMatchObject({ ok: false, kind: 'retryable', code: 'network' })
  })
})
