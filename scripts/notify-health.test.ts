// notify-health.test.ts — 健康判定纯核（无 DB；scripts/ 测试只钉纯核）
import { describe, it, expect } from 'vitest'
import { healthVerdict, type Health } from '../modules/notify/health.ts'

const clean = (over: Partial<Health> = {}): Health => ({
  dead: 0, stale: 0, workers: 1,
  oldestPendingSeconds: 0, failedLastHour: 0, channelErrors: 0,
  eventsNoRecipients: 0, eventsNoChannel: 0, eventsInvalid: 0,
  ...over,
})

describe('healthVerdict', () => {
  it('全清 ⇒ 0；任一异常 ⇒ 1', () => {
    expect(healthVerdict(clean())).toBe(0)
    expect(healthVerdict(clean({ dead: 1 }))).toBe(1)
    expect(healthVerdict(clean({ stale: 1 }))).toBe(1)
    expect(healthVerdict(clean({ workers: 0 }))).toBe(1)
  })

  it('近 1 小时失败超阈值 ⇒ 1', () => {
    expect(healthVerdict(clean({ failedLastHour: 51 }))).toBe(1)
  })

  it('零收件人/零通道 ⇒ 直接红；invalid 超阈值才红', () => {
    expect(healthVerdict(clean({ eventsNoRecipients: 1 }))).toBe(1)
    expect(healthVerdict(clean({ eventsNoChannel: 1 }))).toBe(1)
    expect(healthVerdict(clean({ eventsInvalid: 5 }))).toBe(0)
    expect(healthVerdict(clean({ eventsInvalid: 6 }))).toBe(1)
  })
})
