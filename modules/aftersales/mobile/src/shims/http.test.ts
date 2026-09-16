import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, apiGet, apiSend } from './http'

const origFetch = globalThis.fetch
const origLocation = window.location

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('shims/http', () => {
  let calls: Array<{ url: string; init?: RequestInit }>
  let hrefs: string[]

  beforeEach(() => {
    calls = []
    hrefs = []
    // happy-dom 的 location 不可直接赋值 —— 换成一个只记 href 的替身
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/app/aftersales/', search: '?x=1', set href(v: string) { hrefs.push(v) } },
    })
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return json(200, { ok: true })
    }) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = origFetch
    Object.defineProperty(window, 'location', { configurable: true, value: origLocation })
  })

  it('拼上模块前缀，且带 same-origin 凭据（访客会话是 cookie）', async () => {
    await apiGet('/guest/stores?q=x')
    expect(calls[0]!.url).toBe('/api/modules/aftersales/guest/stores?q=x')
    expect(calls[0]!.init?.credentials).toBe('same-origin')
  })

  it('401 ⇒ 跳 silent 静默授权，并带上 next（本期补的回跳）', async () => {
    globalThis.fetch = vi.fn(async () => json(401, { error: 'UNAUTHENTICATED' })) as unknown as typeof fetch
    await expect(apiGet('/guest/me/registration')).rejects.toMatchObject({ status: 401 })
    expect(hrefs).toHaveLength(1)
    expect(hrefs[0]).toBe(
      '/api/platform/auth/wechat-oa/silent?next=' + encodeURIComponent('/app/aftersales/?x=1'),
    )
  })

  it('非 2xx ⇒ 抛 ApiError，code 取自响应体的 error 字段', async () => {
    globalThis.fetch = vi.fn(async () => json(409, { error: 'APPROVAL_PENDING' })) as unknown as typeof fetch
    await expect(apiGet('/x')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGet('/x')).rejects.toMatchObject({ status: 409, code: 'APPROVAL_PENDING' })
  })

  it('响应体带 message ⇒ 收进 ApiError.message（「您没有修改任何信息」靠这条透出）', async () => {
    globalThis.fetch = vi.fn(async () =>
      json(400, { error: 'INVALID_BODY', message: '您没有修改任何信息' }),
    ) as unknown as typeof fetch
    await expect(apiGet('/x')).rejects.toMatchObject({ code: 'INVALID_BODY', message: '您没有修改任何信息' })
  })

  it('响应体不是 JSON ⇒ 回落成 HTTP_<status>（不因解析失败吞掉状态码）', async () => {
    globalThis.fetch = vi.fn(async () => new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch
    await expect(apiGet('/x')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' })
  })

  it('apiSend 带 JSON body 与 Content-Type；无 body 时不带', async () => {
    await apiSend('/guest/tickets', 'POST', { a: 1 })
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ a: 1 }))
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    await apiSend('/guest/tickets', 'POST')
    expect(calls[1]!.init?.body).toBeUndefined()
  })
})
