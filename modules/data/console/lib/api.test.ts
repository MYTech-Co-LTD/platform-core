// lib/api.test.ts —— 模块 API 薄封装：前缀拼接、两种失败体翻译、非 JSON 回落。
// ⚠️ 失败体有**两种形状**（月报重做 Task 12 起）：既有端点 `{ error: code }`、版本端点
//    `{ ok:false, reason, detail }`。两种都必须落到同一个 `ApiError.code` 上——否则版本端点的
//    失败会塌成 `HTTP_400/409`，界面只剩「操作未通过校验」，看不出是哪个指标不可加。
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { ApiError, apiGet, apiSend, messageOf, streamPost } from './api'

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
    await apiGet('/reports/manage')
    expect(calls[0]!.url).toBe('/api/modules/data/reports/manage')
  })

  it('apiSend 带 JSON body 与 Content-Type；DELETE 无 body 时不带', async () => {
    await apiSend('/reports/r1', 'PUT', { expectedVersion: 1 })
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ expectedVersion: 1 }))
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')

    await apiSend('/reports/r1', 'DELETE')
    expect(calls[1]!.init?.body).toBeUndefined()
    expect(calls[1]!.init?.headers).toBeUndefined()
  })

  it('204 ⇒ 不解析空体，回 undefined', async () => {
    m.mockImplementation(async () => new Response(null, { status: 204 }))
    await expect(apiSend('/reports/r1', 'DELETE')).resolves.toBeUndefined()
  })
})

describe('失败体 → ApiError', () => {
  it('既有 `{ error }` 契约不变：code 取 error，detail 缺省', async () => {
    m.mockImplementation(async () => json({ error: 'STALE_WRITE' }, 409))
    await expect(apiGet('/reports/r1')).rejects.toMatchObject({
      status: 409, code: 'STALE_WRITE', detail: undefined,
    })
  })

  it('版本端点 `{ ok:false, reason, detail }` ⇒ code 取 reason、detail 原样保留', async () => {
    m.mockImplementation(async () => json({ ok: false, reason: 'KPI_NOT_TOTALABLE', detail: 'ratio' }, 400))
    const err = await apiGet('/reports/r1/publish').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 400, code: 'KPI_NOT_TOTALABLE', detail: 'ratio' })
  })

  it('版本端点不带 detail ⇒ code 取 reason、detail 仍缺省', async () => {
    m.mockImplementation(async () => json({ ok: false, reason: 'NO_SPEC' }, 400))
    await expect(apiSend('/reports/r1/publish', 'POST', {})).rejects.toMatchObject({
      status: 400, code: 'NO_SPEC', detail: undefined,
    })
  })

  it('detail: \'\' 当没给（不在文案后留空括号）', async () => {
    m.mockImplementation(async () => json({ ok: false, reason: 'NO_SPEC', detail: '' }, 400))
    await expect(apiGet('/reports/r1/publish')).rejects.toMatchObject({ code: 'NO_SPEC', detail: undefined })
  })

  it('同体既有 error 又有 reason ⇒ error 优先（既有解析不变）', async () => {
    m.mockImplementation(async () => json({ error: 'INVALID_BODY', reason: 'KPI_NOT_TOTALABLE' }, 400))
    await expect(apiGet('/reports/r1')).rejects.toMatchObject({ code: 'INVALID_BODY' })
  })

  it('两者都不是 / 非 JSON ⇒ 回落成 HTTP_<status>（不因解析失败吞掉状态码）', async () => {
    m.mockImplementation(async () => json({ ok: false }, 400))
    await expect(apiGet('/reports/r1')).rejects.toMatchObject({ status: 400, code: 'HTTP_400' })

    m.mockImplementation(async () => new Response('<html>502</html>', { status: 502 }))
    await expect(apiGet('/reports')).rejects.toMatchObject({ status: 502, code: 'HTTP_502', detail: undefined })
  })
})

describe('streamPost（SSE）', () => {
  it('拼前缀 + POST JSON + 透传 signal；成功时原样返回未解析的 Response', async () => {
    const res = json({ ok: true })
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return res
    })
    const ac = new AbortController()
    await expect(streamPost('/reports/r1/narrative/stream', { panelIndex: 8 }, ac.signal)).resolves.toBe(res)
    expect(calls[0]!.url).toBe('/api/modules/data/reports/r1/narrative/stream')
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBe(JSON.stringify({ panelIndex: 8 }))
    expect((calls[0]!.init?.headers as Record<string, string>)['Content-Type']).toBe('application/json')
    expect(calls[0]!.init?.signal).toBe(ac.signal)
  })

  it('失败体走同一套翻译（SSE 端点的 404/400/502 都是普通 JSON）', async () => {
    m.mockImplementation(async () => json({ error: 'NOT_FOUND' }, 404))
    await expect(streamPost('/reports/r1/narrative/stream', {})).rejects.toMatchObject({
      status: 404, code: 'NOT_FOUND',
    })
  })
})

describe('messageOf', () => {
  it('已知码给中文文案；未知码回落成码本身（便于排障）', () => {
    expect(messageOf(new ApiError(409, 'STALE_WRITE'))).toContain('刚被别人改过')
    expect(messageOf(new ApiError(400, 'SOMETHING_NEW'))).toBe('SOMETHING_NEW')
  })

  it('版本拒绝码有专属文案（不塌成 HTTP_400）', () => {
    expect(messageOf(new ApiError(400, 'KPI_NOT_TOTALABLE'))).toContain('KPI')
    expect(messageOf(new ApiError(400, 'UNKNOWN_PANEL_METRIC'))).toContain('词表')
  })

  it('有 detail 就附在文案后 ⇒ 精确到哪个指标', () => {
    expect(messageOf(new ApiError(400, 'KPI_NOT_TOTALABLE', 'ratio'))).toBe(
      'KPI 大数字本身就是合计值，不能放不可加的指标（比率/去重计数）：ratio',
    )
    // 未知码同样带 detail：裸码 + 定位，排障时都拿得到
    expect(messageOf(new ApiError(400, 'SOMETHING_NEW', 'ratio'))).toBe('SOMETHING_NEW：ratio')
  })

  it('非 ApiError（网络异常等）给统一文案', () => {
    expect(messageOf(new TypeError('fetch failed'))).toContain('网络')
  })
})
