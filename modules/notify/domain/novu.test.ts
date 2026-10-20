// novu.test.ts — Novu trigger 客户端（mock fetch，无 DB）。计划 Task 5。
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  chatWebhookUrlFor,
  ensureChannel,
  novuChatWebhookEnvKeyForOrg,
  novuChatWebhookUrlFromEnv,
  novuEnvKeyForOrg,
  novuFromEnv,
  trigger,
} from './novu'

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
      chatWebhookUrl: null,
    })
  })

  it('① 有 per-org key ⇒ 命中（优先于全局）', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: 'org-key' }), 'mytech')).toEqual({
      baseUrl: BASE,
      apiKey: 'org-key',
      chatWebhookUrl: null,
    })
  })

  it('① org 经规范化后命中（大小写 / 连字符）', () => {
    expect(
      novuFromEnv(env({ NOVU_API_KEY__ORG_NOTIFY_ABC: 'org-key' }), 'org-notify-abc'),
    ).toEqual({ baseUrl: BASE, apiKey: 'org-key', chatWebhookUrl: null })
    expect(novuFromEnv(env({ NOVU_API_KEY__MYTECH: 'org-key' }), 'MYTECH')).toEqual({
      baseUrl: BASE,
      apiKey: 'org-key',
      chatWebhookUrl: null,
    })
  })

  it('② 无 per-org、有全局 ⇒ 回落全局', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global' }), 'mytech')).toEqual({
      baseUrl: BASE,
      apiKey: 'global',
      chatWebhookUrl: null,
    })
  })

  it('③ 两者都无 ⇒ null（调用方记 failed，不抛）', () => {
    expect(novuFromEnv(env({}), 'mytech')).toBeNull()
  })

  it('per-org 值为空串 ⇒ 视同未配置，回落全局', () => {
    expect(novuFromEnv(env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: '' }), 'mytech')).toEqual({
      baseUrl: BASE,
      apiKey: 'global',
      chatWebhookUrl: null,
    })
  })

  it('④ 无 org（undefined / 空串 / 空白）⇒ 跳过 per-org 查找，走全局', () => {
    const e = env({ NOVU_API_KEY: 'global', NOVU_API_KEY__MYTECH: 'org-key' })
    expect(novuFromEnv(e, undefined)).toEqual({ baseUrl: BASE, apiKey: 'global', chatWebhookUrl: null })
    expect(novuFromEnv(e, '')).toEqual({ baseUrl: BASE, apiKey: 'global', chatWebhookUrl: null })
    expect(novuFromEnv(e, '   ')).toEqual({ baseUrl: BASE, apiKey: 'global', chatWebhookUrl: null })
  })

  it('缺 NOVU_BASE_URL ⇒ null（base url 全局唯一，per-org 只换 key）', () => {
    expect(novuFromEnv({ NOVU_API_KEY__MYTECH: 'org-key' } as NodeJS.ProcessEnv, 'mytech')).toBeNull()
  })

  it('缺任一旧键 ⇒ null（⇒ /emit 回可解释 503，不是启动失败）', () => {
    expect(novuFromEnv({ NOVU_BASE_URL: BASE } as NodeJS.ProcessEnv)).toBeNull()
    expect(novuFromEnv({} as NodeJS.ProcessEnv)).toBeNull()
  })

  it('ADR 0008 ②：随 apiKey 一并解析出**本 org** 的 chat bridge URL（他 org / 缺失 ⇒ null）', () => {
    const e = env({ NOVU_API_KEY: 'global', [novuChatWebhookEnvKeyForOrg('mytech')]: 'https://h/a?t=1' })
    expect(novuFromEnv(e, 'mytech')).toEqual({
      baseUrl: BASE,
      apiKey: 'global',
      chatWebhookUrl: 'https://h/a?t=1',
    })
    expect(novuFromEnv(e, 'shanhai')).toEqual({ baseUrl: BASE, apiKey: 'global', chatWebhookUrl: null })
  })
})

// ── ADR 0008 ②（2026-10-20 人审）：trigger 前给订阅者挂 chat 渠道 ──────────────────
// 实测闸门：chat 送达看 `subscriber.channels[]`，集成级 webhookUrl **不参与**；
// 无渠道 ⇒ chat 作业恒 `canceled`。挂渠道 = PUT /v1/subscribers/:id/credentials。
describe('chatWebhookUrlFor（bridge 端点 + to= 的拼接，纯函数）', () => {
  it('URL 已带 ?t=<token> ⇒ 追加用 &（用 ? 会让 token 变成 to 的一部分而失效）', () => {
    expect(chatWebhookUrlFor('https://push.hookflow.cn/wecom/woke?t=tok', 'u1')).toBe(
      'https://push.hookflow.cn/wecom/woke?t=tok&to=u1',
    )
  })

  it('URL 不带查询串 ⇒ 用 ?（与参考实现 push.mjs 同形）', () => {
    expect(chatWebhookUrlFor('https://push.hookflow.cn/wecom/woke', 'u1')).toBe(
      'https://push.hookflow.cn/wecom/woke?to=u1',
    )
  })

  it('subscriberId 必须 URL 编码', () => {
    expect(chatWebhookUrlFor('https://h/w?t=t', 'a b/c')).toBe('https://h/w?t=t&to=a%20b%2Fc')
  })
})

describe('novuChatWebhookEnvKeyForOrg（与 NOVU_API_KEY 共用同一套 org→env 名规范化）', () => {
  it('mytech → NOVU_CHAT_WEBHOOK_URL__MYTECH', () => {
    expect(novuChatWebhookEnvKeyForOrg('mytech')).toBe('NOVU_CHAT_WEBHOOK_URL__MYTECH')
  })

  it('连字符 / 大小写与 novuEnvKeyForOrg 逐字同规则', () => {
    expect(novuChatWebhookEnvKeyForOrg('org-notify-abc')).toBe('NOVU_CHAT_WEBHOOK_URL__ORG_NOTIFY_ABC')
    expect(novuChatWebhookEnvKeyForOrg('MYTECH')).toBe('NOVU_CHAT_WEBHOOK_URL__MYTECH')
  })
})

// ⚠️ 本组是**安全判据**，不是配置便利性：该 URL 是一条带租户 token 的投递端点，
// bridge 按 URL 里的 tenant+token 决定「用哪个企微 corp 发、发到哪个群」。
// 一旦回落，A 租户的通知会投进 B 租户的企微群 = **跨租户数据泄露**（不是投递失败）
// ⇒ 本键 fail-closed：只认本 org 的键，缺则视为未配置。**刻意**不同于 NOVU_API_KEY 的回落范式。
describe('novuChatWebhookUrlFromEnv（只认本 org 的键，不回落全局）', () => {
  const env = (extra: Record<string, string>) => ({ ...extra }) as NodeJS.ProcessEnv

  it('① per-org 键命中', () => {
    expect(novuChatWebhookUrlFromEnv(env({ NOVU_CHAT_WEBHOOK_URL__MYTECH: 'https://h/a?t=1' }), 'mytech')).toBe(
      'https://h/a?t=1',
    )
  })

  it('② 无 per-org 键 ⇒ null，**即便全局键在场也不回落**', () => {
    expect(
      novuChatWebhookUrlFromEnv(env({ NOVU_CHAT_WEBHOOK_URL: 'https://h/global?t=1' }), 'mytech'),
    ).toBeNull()
  })

  it('③ 不得命中他 org 的键', () => {
    expect(
      novuChatWebhookUrlFromEnv(env({ NOVU_CHAT_WEBHOOK_URL__SHANHAI: 'https://h/b?t=2' }), 'mytech'),
    ).toBeNull()
  })

  it('④ org 缺失 / 空白 ⇒ null（拿不到 org 就选不出 per-org 键，不能退化成全局）', () => {
    const e = env({ NOVU_CHAT_WEBHOOK_URL__MYTECH: 'https://h/a?t=1', NOVU_CHAT_WEBHOOK_URL: 'https://h/g?t=1' })
    expect(novuChatWebhookUrlFromEnv(e, undefined)).toBeNull()
    expect(novuChatWebhookUrlFromEnv(e, '')).toBeNull()
    expect(novuChatWebhookUrlFromEnv(e, '   ')).toBeNull()
  })

  it('per-org 值为空串 ⇒ 视同未配置（null），不回落', () => {
    expect(
      novuChatWebhookUrlFromEnv(env({ NOVU_CHAT_WEBHOOK_URL__MYTECH: '', NOVU_CHAT_WEBHOOK_URL: 'https://h/g?t=1' }), 'mytech'),
    ).toBeNull()
  })
})

describe('ensureChannel', () => {
  afterEach(() => vi.unstubAllGlobals())

  const cfg = { baseUrl: 'https://n.example', apiKey: 'k', chatWebhookUrl: null }
  const HOOK = 'https://push.hookflow.cn/wecom/woke?t=tok'
  const okFetch = () => vi.fn(async () => new Response('{}', { status: 201 }))
  type Call = [string, RequestInit]
  const callsOf = (m: ReturnType<typeof okFetch>) => m.mock.calls as unknown as Call[]

  it('先 POST /v1/subscribers（upsert），再 PUT credentials（webhookUrl 含 &to=）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)

    const r = await ensureChannel(cfg, { subscriberId: 'u-ens-1', webhookUrl: HOOK })

    expect(r).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [u1, i1] = callsOf(fetchMock)[0]!
    expect(String(u1)).toBe('https://n.example/v1/subscribers')
    expect(i1.method).toBe('POST')
    expect((i1.headers as Record<string, string>).Authorization).toBe('ApiKey k')
    expect(JSON.parse(i1.body as string)).toEqual({ subscriberId: 'u-ens-1' })

    const [u2, i2] = callsOf(fetchMock)[1]!
    expect(String(u2)).toBe('https://n.example/v1/subscribers/u-ens-1/credentials')
    expect(i2.method).toBe('PUT')
    expect((i2.headers as Record<string, string>).Authorization).toBe('ApiKey k')
    expect(JSON.parse(i2.body as string)).toEqual({
      providerId: 'chat-webhook',
      credentials: { webhookUrl: `${HOOK}&to=u-ens-1` },
    })
  })

  it('subscriberId 在路径段里 URL 编码', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await ensureChannel(cfg, { subscriberId: 'a b/c', webhookUrl: HOOK })
    expect(String(callsOf(fetchMock)[1]![0])).toBe('https://n.example/v1/subscribers/a%20b%2Fc/credentials')
  })

  it('同一 (webhookUrl, subscriberId) 第二次 ⇒ 不再打 HTTP（进程内缓存）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await ensureChannel(cfg, { subscriberId: 'u-ens-2', webhookUrl: HOOK })
    await ensureChannel(cfg, { subscriberId: 'u-ens-2', webhookUrl: HOOK })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('同一 subscriber 换了 webhookUrl ⇒ 视为未挂过，重挂（缓存键含 URL）', async () => {
    const fetchMock = okFetch()
    vi.stubGlobal('fetch', fetchMock)
    await ensureChannel(cfg, { subscriberId: 'u-ens-3', webhookUrl: HOOK })
    await ensureChannel(cfg, { subscriberId: 'u-ens-3', webhookUrl: 'https://h/other?t=2' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(JSON.parse(callsOf(fetchMock)[3]![1].body as string)).toEqual({
      providerId: 'chat-webhook',
      credentials: { webhookUrl: 'https://h/other?t=2&to=u-ens-3' },
    })
  })

  it('POST subscribers 非 2xx ⇒ ok:false 且**不**继续 PUT', async () => {
    const fetchMock = vi.fn(async () => new Response('nope', { status: 422 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await ensureChannel(cfg, { subscriberId: 'u-ens-4', webhookUrl: HOOK })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('422')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('PUT credentials 非 2xx ⇒ ok:false，且**不入缓存**（下次重试）', async () => {
    let putStatus = 500
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) =>
      new Response('x', { status: init.method === 'PUT' ? putStatus : 201 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const first = await ensureChannel(cfg, { subscriberId: 'u-ens-5', webhookUrl: HOOK })
    expect(first.ok).toBe(false)
    putStatus = 200
    const second = await ensureChannel(cfg, { subscriberId: 'u-ens-5', webhookUrl: HOOK })
    expect(second).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('网络异常 ⇒ ok:false（不抛）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED')
      }),
    )
    const r = await ensureChannel(cfg, { subscriberId: 'u-ens-6', webhookUrl: HOOK })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('ECONNREFUSED')
  })
})

describe('trigger', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('POST /v1/events/trigger，携 name/to/payload 与 ApiKey 头', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 201 }))
    vi.stubGlobal('fetch', fetchMock)
    const r = await trigger(
      { baseUrl: 'https://n.example', apiKey: 'k', chatWebhookUrl: null },
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
      { baseUrl: 'https://n.example', apiKey: 'k', chatWebhookUrl: null },
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
      { baseUrl: 'https://n.example', apiKey: 'k', chatWebhookUrl: null },
      { templateId: 't', subscriberId: 'u', payload: {} },
    )
    expect(r.ok).toBe(false)
  })
})
