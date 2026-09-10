// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { platformFetch } from './platform-fetch'

/**
 * platformFetch：模块用户端（web/console）唯一 API 客户端。
 * 约定（任务书锁定）：透传 globalThis.fetch；credentials 默认 same-origin（init 已带不覆盖）；
 * 响应 401 → 写 location.href = /login?next=<pathname+hash 编码> 后抛 Error('UNAUTHENTICATED')。
 */

afterEach(() => {
  vi.unstubAllGlobals()
  location.hash = ''
})

describe('platformFetch', () => {
  it('401 → 跳 /login?next= 并抛 UNAUTHENTICATED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 401 })))
    location.hash = '#/tickets/42'

    await expect(platformFetch('/api/whoami')).rejects.toThrow('UNAUTHENTICATED')
    // 浏览器/happy-dom 的 location.href 读回为绝对 URL，故断言解析后的 path + search
    expect(location.pathname).toBe('/login')
    expect(location.search).toBe('?next=' + encodeURIComponent('/#/tickets/42'))
  })

  it('200 → 原样透传 Response', async () => {
    const res = new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    const fetchMock = vi.fn(async () => res)
    vi.stubGlobal('fetch', fetchMock)

    const out = await platformFetch('/api/things')
    expect(out).toBe(res)
    expect(out.status).toBe(200)
    expect(await out.json()).toEqual({ ok: true })
  })

  it('credentials 默认 same-origin；init 已带 credentials 时不覆盖', async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchMock)

    await platformFetch('/api/a')
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: 'same-origin' })

    await platformFetch('/api/b', { credentials: 'include', method: 'POST' })
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ credentials: 'include', method: 'POST' })
  })
})
