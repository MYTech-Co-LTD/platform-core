// wechat-oa.test.ts — 公众号模板消息 sender（#2805）：token 缓存、错误码分类、48h 窗口语义。
// 全部走注入的 fetchImpl：不发真请求。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DeliveryLike, SendContext } from './senders'
import { __resetWechatTokenCache, sendWechatOa } from './wechat-oa'

const CRED = { appId: 'wxappid', appSecret: 'secret' }

const delivery = (over: Partial<DeliveryLike> = {}): DeliveryLike => ({
  org: 'o1',
  eventId: 'e1',
  eventKey: 'aftersales.ticket.submitted',
  recipient: 'openid-1',
  address: 'openid-1',
  templateKey: 'aftersales_ticket_submitted',
  revision: 1,
  rendered: { template_id: 'TPL_1', first: '已提交', keyword1: 'AS-00000001', url: 'https://x/y' },
  ...over,
})

const ctx = (fetchImpl: typeof fetch): SendContext => ({
  pool: {} as never,
  channelId: 'wechat_default',
  config: {},
  secrets: {},
  credential: CRED,
  fetchImpl,
})

/** 按顺序回放的 fetch 桩；记录调用次数与请求体。 */
function stubFetch(responses: Array<{ body: unknown; ok?: boolean }>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init })
    const next = responses.shift() ?? { body: { errcode: 0 } }
    return {
      ok: next.ok ?? true,
      status: next.ok === false ? 500 : 200,
      json: async () => next.body,
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

beforeEach(() => __resetWechatTokenCache())

describe('sendWechatOa', () => {
  it('成功：先取 token 再发模板消息，touser=openid、data 剔除保留键', async () => {
    const { fn, calls } = stubFetch([
      { body: { access_token: 'TOK', expires_in: 7200 } },
      { body: { errcode: 0, errmsg: 'ok' } },
    ])
    const r = await sendWechatOa(ctx(fn), delivery())
    expect(r).toEqual({ ok: true })
    expect(calls[0]!.url).toContain('/cgi-bin/token?grant_type=client_credential&appid=wxappid')
    expect(calls[1]!.url).toContain('/cgi-bin/message/template/send?access_token=TOK')
    const body = JSON.parse(String(calls[1]!.init!.body))
    expect(body.touser).toBe('openid-1')
    expect(body.template_id).toBe('TPL_1')
    expect(body.url).toBe('https://x/y')
    // template_id / url 是保留键，不进 data
    expect(Object.keys(body.data).sort()).toEqual(['first', 'keyword1'])
    expect(body.data.keyword1).toEqual({ value: 'AS-00000001' })
  })

  it('token 缓存：第二次调用不再请求 /cgi-bin/token', async () => {
    const { fn, calls } = stubFetch([
      { body: { access_token: 'TOK', expires_in: 7200 } },
      { body: { errcode: 0 } },
    ])
    await sendWechatOa(ctx(fn), delivery())
    await sendWechatOa(ctx(fn), delivery({ eventId: 'e2' }))
    const tokenCalls = calls.filter((c) => c.url.includes('/cgi-bin/token'))
    expect(tokenCalls).toHaveLength(1)
  })

  it('40001（token 失效）⇒ 强制刷新一次再重试', async () => {
    const { fn, calls } = stubFetch([
      { body: { access_token: 'OLD', expires_in: 7200 } },
      { body: { errcode: 40001, errmsg: 'invalid credential' } },   // 第一次发失败
      { body: { access_token: 'NEW', expires_in: 7200 } },          // 强制刷新
      { body: { errcode: 0 } },                                     // 重试成功
    ])
    const r = await sendWechatOa(ctx(fn), delivery())
    expect(r).toEqual({ ok: true })
    expect(calls.filter((c) => c.url.includes('/cgi-bin/token'))).toHaveLength(2)
    expect(calls.at(-1)!.url).toContain('access_token=NEW')
  })

  it('43004（未关注/超出 48h 窗口）⇒ **永久失败**且 summary 点明窗口', async () => {
    const { fn } = stubFetch([
      { body: { access_token: 'TOK', expires_in: 7200 } },
      { body: { errcode: 43004, errmsg: 'require subscribe' } },
    ])
    const r = await sendWechatOa(ctx(fn), delivery())
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: 'wechat_43004' })
    expect((r as { summary: string }).summary).toContain('48h')
  })

  it('45009（频率超限）⇒ 可重试', async () => {
    const { fn } = stubFetch([
      { body: { access_token: 'TOK', expires_in: 7200 } },
      { body: { errcode: 45009, errmsg: 'api freq out of limit' } },
    ])
    const r = await sendWechatOa(ctx(fn), delivery())
    expect(r).toMatchObject({ ok: false, kind: 'retryable', code: 'wechat_45009' })
  })

  it('模板没填 template_id ⇒ 永久失败 template_id_missing（缺配可见，不静默）', async () => {
    const { fn, calls } = stubFetch([])
    const r = await sendWechatOa(ctx(fn), delivery({ rendered: { first: 'x' } }))
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: 'template_id_missing' })
    expect(calls).toHaveLength(0) // 连 token 都不取
  })

  it('没有 openid（缺地址）⇒ 永久失败，不发请求', async () => {
    const { fn, calls } = stubFetch([])
    const r = await sendWechatOa(ctx(fn), delivery({ address: '' }))
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: 'missing_channel_address' })
    expect(calls).toHaveLength(0)
  })

  it('凭据缺失 ⇒ 永久失败 credential_missing', async () => {
    const { fn } = stubFetch([])
    const c = { ...ctx(fn), credential: undefined }
    const r = await sendWechatOa(c, delivery())
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: 'credential_missing' })
  })
})
