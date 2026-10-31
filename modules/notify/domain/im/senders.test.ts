// senders.test.ts — 出站 provider 表（spec 2026-10-31 §3.1；本轮只留架构空间）
//
// 断言两件事：① 每个已知 provider 都真的有一张 sender（漏注册 = 线上「provider_unsupported」）；
// ② 未知 provider 的失败码与改造前**逐字相同**（重构不改契约）。
import { describe, it, expect } from 'vitest'
import { dispatchSend } from './senders'
import { NOTIFY_PROVIDERS } from '../providers'

/** 最小假 pool：in_app 会写库，穷举测试只需要它不抛。 */
const fakePool = { query: async () => ({ rows: [], rowCount: 0 }) } as never
const ctx = (over: Record<string, unknown> = {}) => ({
  pool: fakePool,
  channelId: 'c1',
  config: {},
  secrets: { bridge_url: 'https://bridge.test/wecom/org?t=tok' },
  ...over,
})
const delivery = {
  org: 'o', eventId: 'e1', eventKey: 'm.a.b', recipient: 'u1', address: 'wecom-u1',
  templateKey: 't1', revision: 1, rendered: { text: 'hi' },
}

describe('dispatchSend', () => {
  it('未知 provider ⇒ provider_unsupported（与改造前同码同形）', async () => {
    const r = await dispatchSend('feishu', ctx(), delivery)
    expect(r).toEqual({ ok: false, kind: 'permanent', code: 'provider_unsupported', summary: 'feishu' })
  })

  it('★ 每个已知 provider 都注册了 sender（不存在「清单有、表里没有」的洞）', async () => {
    for (const p of NOTIFY_PROVIDERS) {
      // 未注册会走 provider_unsupported；这里只要不是它，就说明进了真实现
      const r = await dispatchSend(p, ctx({ fetchImpl: async () => new Response(null, { status: 204 }) }), delivery)
      const code = 'code' in r ? r.code : null
      expect(code, `provider ${p} 未注册`).not.toBe('provider_unsupported')
    }
  })

  it('wecom_chat 走 bridge_url（secrets 键名对不上会立刻炸在 sendWecom 里）', async () => {
    let seen = ''
    const f = (async (u: string) => {
      seen = String(u)
      return new Response(null, { status: 204 })
    }) as unknown as typeof fetch
    const r = await dispatchSend('wecom_chat', ctx({ fetchImpl: f }), delivery)
    expect(r).toEqual({ ok: true })
    expect(seen).toContain('bridge.test')
    expect(seen).toContain('to=wecom-u1')
  })
})
