// notify-health.test.ts — 健康判定纯核（无 DB；scripts/ 测试只钉纯核）
import { describe, it, expect } from 'vitest'
import { healthVerdict } from '../modules/notify/health.ts'

describe('healthVerdict', () => {
  it('全清 ⇒ 0；任一异常 ⇒ 1', () => {
    expect(healthVerdict({ dead: 0, stale: 0, workers: 1 })).toBe(0)
    expect(healthVerdict({ dead: 1, stale: 0, workers: 1 })).toBe(1)
    expect(healthVerdict({ dead: 0, stale: 1, workers: 1 })).toBe(1)
    expect(healthVerdict({ dead: 0, stale: 0, workers: 0 })).toBe(1)
  })
})
