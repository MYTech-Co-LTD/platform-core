// rate-limit.test.ts — 限流判定（纯函数）
import { describe, it, expect } from 'vitest'
import { rateLimitVerdict } from './rate-limit'

describe('rateLimitVerdict', () => {
  it('limit=3：窗口内 <3 放行；>=3 顺延一个窗口', () => {
    expect(rateLimitVerdict(0, 3)).toEqual({ allow: true, retryAfterMs: 0 })
    expect(rateLimitVerdict(2, 3)).toEqual({ allow: true, retryAfterMs: 0 })
    expect(rateLimitVerdict(3, 3).allow).toBe(false)
    expect(rateLimitVerdict(3, 3).retryAfterMs).toBe(60_000)
  })

  it('limit 缺省/0/负数 ⇒ 不限', () => {
    for (const limit of [0, -1, Number.NaN]) {
      expect(rateLimitVerdict(99, limit)).toEqual({ allow: true, retryAfterMs: 0 })
    }
  })

  it('自定义窗口', () => {
    expect(rateLimitVerdict(5, 5, 30_000)).toEqual({ allow: false, retryAfterMs: 30_000 })
  })
})
