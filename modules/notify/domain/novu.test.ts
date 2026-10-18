// novu.test.ts — Novu trigger 客户端（mock fetch，无 DB）。计划 Task 5。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { novuFromEnv, trigger } from './novu'

describe('novuFromEnv', () => {
  it('两键都在 ⇒ 配置', () => {
    expect(novuFromEnv({ NOVU_BASE_URL: 'https://n.example', NOVU_API_KEY: 'k' } as NodeJS.ProcessEnv)).toEqual({
      baseUrl: 'https://n.example',
      apiKey: 'k',
    })
  })
  it('缺任一 ⇒ null（⇒ /emit 回可解释 503，不是启动失败）', () => {
    expect(novuFromEnv({ NOVU_BASE_URL: 'https://n.example' } as NodeJS.ProcessEnv)).toBeNull()
    expect(novuFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
  })
})

describe('trigger', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /v1/events/trigger，携 name/to/payload 与 ApiKey 头', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await trigger(
      { baseUrl: 'https://n.example', apiKey: 'k' },
      { templateId: 'case_awaiting_approval', subscriberId: 'u1', payload: { title: 't' } },
    )
    expect(r).toEqual({ ok: true })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(String(url)).toBe('https://n.example/v1/events/trigger')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('ApiKey k')
    expect(JSON.parse(init.body as string)).toEqual({
      name: 'case_awaiting_approval',
      to: 'u1',
      payload: { title: 't' },
    })
  })

  it('非 2xx ⇒ ok:false + error（不抛，fail-open）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })))
    const r = await trigger(
      { baseUrl: 'https://n.example', apiKey: 'k' },
      { templateId: 't', subscriberId: 'u', payload: {} },
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('500')
  })

  it('网络异常 ⇒ ok:false（不抛）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const r = await trigger(
      { baseUrl: 'https://n.example', apiKey: 'k' },
      { templateId: 't', subscriberId: 'u', payload: {} },
    )
    expect(r.ok).toBe(false)
  })
})
