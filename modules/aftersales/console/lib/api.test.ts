// lib/api.test.ts — 模块 API 薄封装：前缀拼接、错误体翻译、非 JSON 回落
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { ApiError, apiGet, apiSend, messageOf } from './api'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; init?: RequestInit }> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return json({ ok: true })
  })
})

describe('apiGet / apiSend', () => {
  it('拼上模块前缀（三同纪律：模块 id = DB schema = API 前缀）', async () => {
    await apiGet('/tickets?page=1')
    expect(calls[0]!.url).toBe('/api/modules/aftersales/tickets?page=1')
  })

  it('apiSend 带 JSON body 与 Content-Type；DELETE 无 body 时不带', async () => {
    await apiSend('/rules/1', 'PUT', { name: 'x' })
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ name: 'x' }))
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    await apiSend('/rules/1', 'DELETE')
    expect(calls[1]!.init?.body).toBeUndefined()
    expect(calls[1]!.init?.headers).toBeUndefined()
  })

  it('非 2xx → 抛 ApiError，code 取自响应体的 error 字段', async () => {
    m.mockImplementation(async () => json({ error: 'ALREADY_PROCESSED' }, 409))
    await expect(apiGet('/tickets/1')).rejects.toBeInstanceOf(ApiError)
    await expect(apiGet('/tickets/1')).rejects.toMatchObject({ status: 409, code: 'ALREADY_PROCESSED' })
  })

  it('响应体不是 JSON 时回落成 HTTP_<status>（不因解析失败吞掉状态码）', async () => {
    m.mockImplementation(async () => new Response('<html>502</html>', { status: 502 }))
    await expect(apiGet('/tickets')).rejects.toMatchObject({ status: 502, code: 'HTTP_502' })
  })
})

describe('messageOf', () => {
  it('已知码给中文文案；未知码回落成码本身（便于排障）', () => {
    expect(messageOf(new ApiError(409, 'ALREADY_PROCESSED'))).toContain('已被他人处理')
    expect(messageOf(new ApiError(400, 'SOMETHING_NEW'))).toBe('SOMETHING_NEW')
  })

  it('非 ApiError（网络异常等）给统一文案', () => {
    expect(messageOf(new TypeError('fetch failed'))).toContain('网络')
  })
})
