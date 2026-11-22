// cron.test.ts — 排班 cron → 北京时间时点（排班泳道动画用）。
import { describe, expect, it } from 'vitest'
import { cadenceLabel, parseCronToCstSlots } from './cron'

describe('parseCronToCstSlots', () => {
  it('每 5 分钟（全天）：1440/5 = 288 个时点', () => {
    const s = parseCronToCstSlots('*/5 * * * *')
    expect(s.kind).toBe('every-minutes')
    if (s.kind !== 'every-minutes') return
    expect(s.scope).toBe('all-day')
    expect(s.minutes.length).toBe(288)
    expect(s.minutes).toContainEqual({ hour: 0, minute: 0 })
  })

  it('UTC 02:25 ⇒ 北京 10:25（每日一次）', () => {
    const s = parseCronToCstSlots('25 2 * * *')
    expect(s.kind).toBe('every-minutes')
    if (s.kind !== 'every-minutes') return
    expect(s.minutes).toEqual([{ hour: 10, minute: 25 }])
  })

  it('UTC 5,35 每小时 ⇒ 北京每小时 :05/:35（全天，分钟不变）', () => {
    const s = parseCronToCstSlots('5,35 * * * *')
    expect(s.kind).toBe('every-minutes')
    if (s.kind !== 'every-minutes') return
    expect(s.minutes.length).toBe(48)
    expect(s.minutes[0]).toEqual({ hour: 0, minute: 5 })
  })

  it('UTC 1-15 点每 10 分钟（从 2 分起）⇒ 北京 9–23 点的窗口', () => {
    const s = parseCronToCstSlots('2-59/10 1-15 * * *')
    expect(s.kind).toBe('every-minutes')
    if (s.kind !== 'every-minutes') return
    expect(s.scope).toEqual({ fromHour: 9, toHour: 23 })
    // 每天 15 小时 × 6 次 = 90
    expect(s.minutes.length).toBe(90)
  })

  it('非分钟级 cron ⇒ unknown（不猜）', () => {
    expect(parseCronToCstSlots('0 0 1 * *').kind).toBe('unknown')
    expect(parseCronToCstSlots('bad').kind).toBe('unknown')
  })
})

describe('cadenceLabel', () => {
  it('给人读的节奏标签', () => {
    expect(cadenceLabel('25 2 * * *')).toBe('每天一次')
    expect(cadenceLabel('*/5 * * * *')).toBe('每小时 12 次')
    expect(cadenceLabel('bad')).toBe('bad')
  })
})
