// single-flight.test.ts — 同键并发共享一次执行；settle 后重新执行；失败同样共享。
import { describe, expect, it } from 'vitest'
import { singleFlight } from './single-flight'

const tick = () => new Promise<void>((r) => setTimeout(r, 5))

describe('singleFlight', () => {
  it('并发同键 ⇒ 只执行一次，全部拿到同一结果', async () => {
    const map = new Map<string, Promise<number>>()
    let calls = 0
    const fn = async () => { calls += 1; await tick(); return 42 }
    const [a, b, c] = await Promise.all([
      singleFlight(map, 'k', fn),
      singleFlight(map, 'k', fn),
      singleFlight(map, 'k', fn),
    ])
    expect([a, b, c]).toEqual([42, 42, 42])
    expect(calls).toBe(1)
    expect(map.size).toBe(0)
  })

  it('不同键 ⇒ 各执行一次', async () => {
    const map = new Map<string, Promise<string>>()
    let calls = 0
    const fn = async (v: string) => { calls += 1; await tick(); return v }
    expect(await Promise.all([
      singleFlight(map, 'a', () => fn('a')),
      singleFlight(map, 'b', () => fn('b')),
    ])).toEqual(['a', 'b'])
    expect(calls).toBe(2)
  })

  it('settle 之后再调用 ⇒ 重新执行（不缓存结果）', async () => {
    const map = new Map<string, Promise<number>>()
    let calls = 0
    const fn = async () => { calls += 1; return calls }
    expect(await singleFlight(map, 'k', fn)).toBe(1)
    expect(await singleFlight(map, 'k', fn)).toBe(2)
  })

  it('失败共享给所有等待者，且键被清理（下一次可重试）', async () => {
    const map = new Map<string, Promise<number>>()
    let calls = 0
    const bad = () => { calls += 1; return Promise.reject(new Error('boom')) }
    const results = await Promise.allSettled([
      singleFlight(map, 'k', bad),
      singleFlight(map, 'k', bad),
    ])
    expect(results.every((r) => r.status === 'rejected')).toBe(true)
    expect(calls).toBe(1)
    expect(map.size).toBe(0)
  })
})
