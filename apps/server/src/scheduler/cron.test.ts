import { describe, expect, it } from 'vitest'
import { isValidCron, nextRunAt, parseCron } from './cron'

const at = (iso: string) => new Date(iso)

describe('parseCron', () => {
  it('支持 * , - / 与数字；周几 0 与 7 都是周日', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('1-3 * * * *').minutes).toEqual([1, 2, 3])
    expect(parseCron('1,5,9 * * * *').minutes).toEqual([1, 5, 9])
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parseCron('0 0 * * 0').daysOfWeek).toEqual([0])
  })

  it('★ 不支持的语法直接抛错（不许静默按错时间跑）', () => {
    for (const bad of ['0 0 * * MON', '0 0 L * *', '@daily', '0 0 * * * *', '60 * * * *', '0 0 32 * *']) {
      expect(() => parseCron(bad)).toThrow()
      expect(isValidCron(bad)).toBe(false)
    }
  })
})

describe('nextRunAt（Asia/Shanghai，无 DST）', () => {
  it('每小时第 7 分：从 10:07:30 起跳到 11:07', () => {
    expect(nextRunAt('7 * * * *', 'Asia/Shanghai', at('2026-11-14T02:07:30Z')).toISOString())
      .toBe('2026-11-14T03:07:00.000Z') // 11:07 +08:00
  })

  it('每日 03:43（沪）：跨日', () => {
    expect(nextRunAt('43 3 * * *', 'Asia/Shanghai', at('2026-11-14T05:31:00Z')).toISOString())
      .toBe('2026-11-14T19:43:00.000Z') // 次日 03:43 +08:00
  })

  it('UTC 口径（迁入的系统 job 用这个）', () => {
    expect(nextRunAt('43 3 * * *', 'UTC', at('2026-11-14T05:31:00Z')).toISOString())
      .toBe('2026-11-15T03:43:00.000Z')
  })

  it('跨月：每月 1 日 01:00（沪）', () => {
    expect(nextRunAt('0 1 1 * *', 'Asia/Shanghai', at('2026-11-14T00:00:00Z')).toISOString())
      .toBe('2026-11-30T17:00:00.000Z')
  })

  it('★ 严格晚于 from：恰好命中当前分钟时跳到下一次', () => {
    expect(nextRunAt('7 * * * *', 'UTC', at('2026-11-14T02:07:00Z')).toISOString())
      .toBe('2026-11-14T03:07:00.000Z')
  })
})
