// monitor-state.test.ts — 状态机（W7-V1 Task 3）。
import { describe, expect, it } from 'vitest'
import { transitionOf } from './monitor-state'
import { MONITOR_FAIL_LIMIT } from './monitor-spec'

const NOW = new Date('2026-11-15T02:00:00Z')
const base = {
  prev: 'ok' as const,
  prevStateSince: new Date('2026-11-14T02:00:00Z'),
  notifiedAt: null,
  cooldownSecs: 3600,
  consecutiveFail: 0,
  now: NOW,
}

describe('transitionOf', () => {
  it('ok → firing 跃迁发 fired，并刷新 state_since', () => {
    const r = transitionOf({ ...base, outcome: { verdict: 'missing', value: 0, watermarkRef: null } })
    expect(r).toMatchObject({ state: 'firing', notify: 'fired', disable: false, consecutiveFail: 0 })
    expect(r.stateSince).toEqual(NOW)
  })

  it('firing → ok 发 resolved', () => {
    const r = transitionOf({
      ...base, prev: 'firing', outcome: { verdict: 'ok', watermarkRef: null },
    })
    expect(r).toMatchObject({ state: 'ok', notify: 'resolved' })
  })

  it('同状态重复求值不发（state_since 不变）', () => {
    const r = transitionOf({
      ...base, prev: 'firing', prevStateSince: new Date('2026-11-10T00:00:00Z'),
      outcome: { verdict: 'stale', value: null, watermarkRef: 'x' },
    })
    expect(r.notify).toBeNull()
    expect(r.stateSince).toEqual(new Date('2026-11-10T00:00:00Z'))
  })

  it('冷却期内的跃迁：状态照改，但不投递', () => {
    const r = transitionOf({
      ...base, prev: 'firing', notifiedAt: new Date(NOW.getTime() - 60_000),
      outcome: { verdict: 'ok', watermarkRef: null },
    })
    expect(r.state).toBe('ok')
    expect(r.notify).toBeNull()
  })

  it('unknown 不改 state、只累计失败；达到阈值熔断并发 disabled', () => {
    const r1 = transitionOf({
      ...base, prev: 'firing', outcome: { verdict: 'unknown', error: 'boom', watermarkRef: null },
    })
    expect(r1).toMatchObject({ state: 'firing', notify: null, consecutiveFail: 1, disable: false })

    const r2 = transitionOf({
      ...base, prev: 'firing', consecutiveFail: MONITOR_FAIL_LIMIT - 1,
      outcome: { verdict: 'unknown', error: 'boom', watermarkRef: null },
    })
    expect(r2).toMatchObject({ state: 'firing', notify: 'disabled', disable: true })
    expect(r2.consecutiveFail).toBe(MONITOR_FAIL_LIMIT)
  })

  it('unknown 之后恢复正常 ⇒ 计数清零', () => {
    const r = transitionOf({
      ...base, consecutiveFail: 3, outcome: { verdict: 'ok', watermarkRef: null },
    })
    expect(r.consecutiveFail).toBe(0)
  })
})
