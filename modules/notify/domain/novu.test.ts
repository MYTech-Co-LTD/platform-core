// novu.test.ts — Novu trigger 客户端（mock fetch，无 DB）。计划 Task 5。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { novuEnvKeyForOrg, novuFromEnv, trigger } from './novu'

// §2.6（2026-10-19 定案，方案 A）：`NOVU_API_KEY__<ORG>` 优先，回落 `NOVU_API_KEY`。
describe('novuEnvKeyForOrg（env 变量名规范化，纯函数）', () => {
  it('小写 → 大写（正典示例 mytech → NOVU_API_KEY__MYTECH）', () => {
    expect(novuEnvKeyForOrg('mytech')).toBe('NOVU_API_KEY__MYTECH')
  })
  it('非 [A-Za-z0-9] → 下划线，不折叠连续下划线', () => {
    expect(novuEnvKeyForOrg('org-notify-abc')).toBe('NOVU_API_KEY__ORG_NOTIFY_ABC')
    expect(novuEnvKeyForOrg('a--b')).toBe('NOVU_API_KEY__A__B')
  })
  it('非 ASCII → 逐字符下划线（正典称「待实测、不得据以声称可用」，这里只钉住确定性）', () => {
    expect(novuEnvKeyForOrg('山海')).toBe('NOVU_API_KEY____')
  })
  it('空串 → 基名（调用方不得拿它查 env，见 novuFromEnv 的空白 org 分支）', () => {
    expect(novuEnvKeyForOrg('')).toBe('NOVU_API_KEY__')
  })
})

describe('novuFromEnv', () => {
  const BASE = 'https://n.example'
  const env = (extra: Record<string, string>) => ({ NOVU_BASE_URL: BASE, ...extra }) as NodeJS.ProcessEnv

  it('不传 org（单租户旧语义）⇒ 只认全局 key', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: 'org-key' }))).toEqual({
      baseUrl: BASE,
      apiKey: 'global',
    })
  })

  it('① 有 per-org key ⇒ 命中（优先于全局）', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: 'org-key' }), 'mytech')).toEqual({
      baseUrl: BASE,
      apiKey: 'org-key',
    })
  })

  it('① org 经规范化后命中（大小写 / 连字符）', () => {
    expect(
      novuFromEnv(env({ NOVU_API_KEY__ORG_NOTIFY_ABC: 'org-key' }), 'org-notify-abc'),
    ).toEqual({ baseUrl: BASE, apiKey: 'org-key' })
    expect(novuFromEnv(env({ NOVU_API_KEY__MYTECH: 'org-key' }), 'MYTECH')).toEqual({
      baseUrl: BASE,
      apiKey: 'org-key',
    })
  })

  it('② 无 per-org、有全局 ⇒ 回落全局', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global' }), 'mytech')).toEqual({ baseUrl: BASE, apiKey: 'global' })
  })

  it('③ 两者都无 ⇒ null（调用方记 failed，不抛）', () => {
    expect(novuFromEnv(env({}), 'mytech')).toBeNull()
  })

  it('per-org 值为空串 ⇒ 视同未配置，回落全局', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: '' }), 'mytech')).toEqual({
      baseUrl: BASE,
      apiKey: 'global',
    })
  })

  it('④ 无 org（undefined / 空串 / 空白）⇒ 跳过 per-org 查找，走全局', () => {
    const e = env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: 'org-key' })
    expect(novuFromEnv(e, undefined)).toEqual({ baseUrl: BASE, apiKey: 'global' })
    expect(novuFromEnv(e, '')).toEqual({ baseUrl: BASE, apiKey: 'global' })
    expect(novuFromEnv(e, '   ')).toEqual({ baseUrl: BASE, apiKey: 'global' })
  })

  it('缺 NOVU_BASE_URL ⇒ null（base url 全局唯一，per-org 只换 key）', () => {
    expect(novuFromEnv({ NOVU_API_KEY__MYTECH: 'org-key' } as NodeJS.ProcessEnv, 'mytech')).toBeNull()
  })

  it('缺任一旧键 ⇒ null（⇒ /emit 回可解释 503，不是启动失败）', () => {
    expect(novuFromEnv({ NOVU_BASE_URL: BASE } as NodeJS.ProcessEnv)).toBeNull()
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
