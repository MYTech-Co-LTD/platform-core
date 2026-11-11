import { beforeEach, describe, expect, it } from 'vitest'
import { cacheClear, cacheGet, cacheKey, cacheSet, cacheStats } from './result-cache'

const v = (n: number) => ({ columns: ['a'], rows: [[n]], rowCountTotal: n, retried: false })

describe('result-cache（明细结果缓存）', () => {
  beforeEach(() => cacheClear())

  it('键 = 最终 SQL 的 sha256：SQL 同 ⇒ 同键；任一字节不同 ⇒ 不同键', () => {
    expect(cacheKey('select 1', 'select count(*)')).toBe(cacheKey('select 1', 'select count(*)'))
    expect(cacheKey('select 1', 'select count(*)')).not.toBe(cacheKey('select 2', 'select count(*)'))
    expect(cacheKey('select 1', 'select count(*)')).not.toBe(cacheKey('select 1', 'select count(2)'))
  })

  it('命中返回值并累计 stats', () => {
    const k = cacheKey('s', 'c')
    cacheSet(k, v(1))
    expect(cacheGet(k)).toEqual(v(1))
    const s = cacheStats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(0)
  })

  it('过期后不再命中（TTL）', () => {
    const k = cacheKey('s', 'c')
    cacheSet(k, v(1), 1_000)
    expect(cacheGet(k, 1_000 + 60_001)).toBeNull()
    expect(cacheStats().misses).toBe(1)
  })

  it('未命中不产生条目', () => {
    expect(cacheGet(cacheKey('x', 'y'))).toBeNull()
    expect(cacheStats().size).toBe(0)
  })

  it('LRU 淘汰：超过上限删最久未用', () => {
    // 默认上限 200；写 201 条后第一条应被淘汰
    for (let i = 0; i < 201; i += 1) cacheSet(cacheKey(`s${i}`, 'c'), v(i))
    expect(cacheStats().size).toBeLessThanOrEqual(200)
    expect(cacheGet(cacheKey('s0', 'c'))).toBeNull()
    expect(cacheGet(cacheKey('s200', 'c'))).toEqual(v(200))
  })
})
