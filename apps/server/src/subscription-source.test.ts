import { describe, expect, it } from 'vitest'
import { enabledFromSubscriptions, SubscriptionCache } from './subscription-source'

const SUB = (over: Partial<{ plan: string; state: string; endTime: string }>) => ({
  owner: 'acme', name: 'n', user: 'u', plan: 'mod-demo',
  startTime: '2026-01-01T00:00:00Z', endTime: '2999-01-01T00:00:00Z', state: 'Active', ...over,
})

describe('enabledFromSubscriptions（spec D5 口径）', () => {
  it('只认 mod- 前缀 + Active + 未过期；去前缀回模块 id；未装载模块不进集合', () => {
    const out = enabledFromSubscriptions(
      [SUB({}), SUB({ plan: 'plan-pro' }), SUB({ state: 'Terminated' }), SUB({ endTime: '2020-01-01T00:00:00Z' }), SUB({ plan: 'mod-ghost' })],
      ['demo', 'case-engine'],
      Date.parse('2026-09-13T00:00:00Z'),
    )
    expect([...out]).toEqual(['demo'])
  })
})

describe('SubscriptionCache', () => {
  it('TTL 内命中不重查，过期后重查', async () => {
    let t = 1000
    const cache = new SubscriptionCache({ ttlMs: 5000, now: () => t })
    let calls = 0
    const load = async () => { calls += 1; return new Set(['demo']) }
    await expect(cache.get('acme', load)).resolves.toEqual(new Set(['demo']))
    t = 4000
    await expect(cache.get('acme', load)).resolves.toEqual(new Set(['demo']))
    expect(calls).toBe(1)
    t = 7000
    await expect(cache.get('acme', load)).resolves.toEqual(new Set(['demo']))
    expect(calls).toBe(2)
  })
})
