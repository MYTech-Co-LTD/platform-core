// notify-delay.test.ts — 一次性延迟的归一化契约（宿主端口与模块路由共用）
import { describe, it, expect } from 'vitest'
import { MAX_NOTIFY_DELAY_MS, normalizeAvailableAt } from './notify-delay'

describe('normalizeAvailableAt', () => {
  it('缺省/空串 ⇒ 立即', () => {
    expect(normalizeAvailableAt(undefined)).toEqual({ ok: true })
    expect(normalizeAvailableAt('')).toEqual({ ok: true })
  })

  it('过去 ⇒ 立即（不保留过去值）', () => {
    expect(normalizeAvailableAt(new Date(Date.now() - 60_000).toISOString()))
      .toEqual({ ok: true })
  })

  it('未来 ⇒ 归一化为 ISO；非法/超上限 ⇒ 机检错误码', () => {
    const future = new Date(Date.now() + 60_000).toISOString()
    expect(normalizeAvailableAt(future)).toEqual({ ok: true, value: future })
    expect(normalizeAvailableAt('not-a-date')).toEqual({
      ok: false, reason: 'available_at_invalid',
    })
    expect(normalizeAvailableAt(new Date(Date.now() + MAX_NOTIFY_DELAY_MS + 60_000).toISOString()))
      .toEqual({ ok: false, reason: 'available_at_too_far' })
  })
})
