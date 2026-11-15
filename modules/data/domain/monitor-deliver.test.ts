// monitor-deliver.test.ts — 监控事件构造（W7-V1 Task 6）。
// 硬约束：payload 不带数值/阈值；eventId 以「跃迁身份」去重。
import { describe, expect, it } from 'vitest'
import { monitorEventOf } from './monitor-deliver'

const M = { id: '7', name: '华东断供盯防', windowDays: 3 }
const SINCE = new Date('2026-11-15T02:00:00Z')
const fired = { notify: 'fired' as const, state: 'firing' as const, stateSince: SINCE }

describe('monitorEventOf', () => {
  it('★ fired：带窗口与水位来源，不带数值/阈值', () => {
    const e = monitorEventOf(M, fired, { verdict: 'stale', value: null, watermarkRef: 'load_log:stg_x' }, ['alice', 'bob'])
    expect(e.eventKey).toBe('data.monitor.fired')
    expect(e.eventId).toBe('monitor:7:firing:2026-11-15T02:00:00.000Z')
    expect(e.scope).toBe('monitor:7')
    expect(e.producer).toBe('data')
    expect(e.payload).toMatchObject({ to: 'alice,bob', windowDays: 3, verdict: 'stale', watermarkRef: 'load_log:stg_x' })
    expect(Object.hasOwn(e.payload, 'value')).toBe(false)
    expect(Object.hasOwn(e.payload, 'threshold')).toBe(false)
  })

  it('★ 即使求值带了数值，payload 也不携带（reveal=report 泄露面）', () => {
    const e = monitorEventOf(M, fired, { verdict: 'missing', value: 0, watermarkRef: null }, ['alice'])
    expect(Object.hasOwn(e.payload, 'value')).toBe(false)
  })

  it('resolved：带窗口、无水位；disabled：无窗口（模板不需要）', () => {
    const r = monitorEventOf(M, { notify: 'resolved', state: 'ok', stateSince: SINCE }, { verdict: 'ok', watermarkRef: null }, ['alice'])
    expect(r.eventKey).toBe('data.monitor.resolved')
    expect(r.payload.windowDays).toBe(3)
    expect(Object.hasOwn(r.payload, 'watermarkRef')).toBe(false)

    const d = monitorEventOf(M, { notify: 'disabled', state: 'firing', stateSince: SINCE }, { verdict: 'unknown', error: 'x', watermarkRef: null }, ['alice'])
    expect(d.eventKey).toBe('data.monitor.disabled')
    expect(Object.hasOwn(d.payload, 'windowDays')).toBe(false)
  })

  it('eventId 以跃迁身份去重：同 state 不同 stateSince ⇒ 不同 id', () => {
    const a = monitorEventOf(M, fired, { verdict: 'missing', value: 0, watermarkRef: null }, ['alice'])
    const b = monitorEventOf(M, { ...fired, stateSince: new Date('2026-11-16T02:00:00Z') },
      { verdict: 'missing', value: 0, watermarkRef: null }, ['alice'])
    expect(a.eventId).not.toBe(b.eventId)
  })

  it('notify=null 是编程错误（调用方必须先判跃迁）', () => {
    expect(() => monitorEventOf(M, { notify: null, state: 'ok', stateSince: SINCE }, { verdict: 'ok', watermarkRef: null }, ['a']))
      .toThrow(/notify is null/)
  })
})
