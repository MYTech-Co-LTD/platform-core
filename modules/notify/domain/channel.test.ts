// channel.test.ts — bridge healthz 映射（fetch 注入）
import { describe, it, expect } from 'vitest'
import { checkWecomHealth } from './channel'

const BRIDGE = 'https://push.example/wecom/woke?t=tok'

describe('checkWecomHealth', () => {
  it('200 ⇒ ok；URL 取 host 根 /healthz', async () => {
    let seen = ''
    const f = (async (url: string) => {
      seen = String(url)
      return new Response('ok', { status: 200 })
    }) as unknown as typeof fetch
    expect(await checkWecomHealth(BRIDGE, f)).toEqual({ ok: true })
    expect(seen).toBe('https://push.example/healthz')
  })

  it('非 200 ⇒ detail HTTP 状态', async () => {
    const f = (async () => new Response('bad', { status: 503 })) as unknown as typeof fetch
    expect(await checkWecomHealth(BRIDGE, f)).toEqual({ ok: false, detail: 'HTTP 503' })
  })

  it('网络异常 ⇒ detail 错误信息', async () => {
    const f = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect(await checkWecomHealth(BRIDGE, f)).toMatchObject({ ok: false, detail: 'ECONNREFUSED' })
  })
})
