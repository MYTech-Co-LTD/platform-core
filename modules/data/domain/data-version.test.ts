import { beforeEach, describe, expect, it } from 'vitest'
import { dataVersion, resetDataVersionCache } from './data-version'

describe('dataVersion（明细数据版本戳，#1953）', () => {
  beforeEach(() => { delete process.env.DATA_VERSION_TTL_MS; resetDataVersionCache({}) })

  it('取回版本并缓存 TTL 内不重复查询', async () => {
    let calls = 0
    const q = async () => { calls += 1; return { rows: [{ v: '2026-11-11T00:00:00Z|2026-11-11T00:10:00Z' }] } }
    let now = 1_000
    expect(await dataVersion(q, () => now)).toContain('2026-11-11')
    now = 2_000
    await dataVersion(q, () => now)
    expect(calls).toBe(1)
    now = 1_000 + 5_001
    await dataVersion(q, () => now)
    expect(calls).toBe(2)
  })

  it('版本变化 ⇒ 新值（键随之变化）', async () => {
    let v = 'a'
    const q = async () => ({ rows: [{ v }] })
    let now = 0
    expect(await dataVersion(q, () => now)).toBe('a')
    v = 'b'; now += 10_000
    expect(await dataVersion(q, () => now)).toBe('b')
  })

  it('查询失败 ⇒ 返回空串且不缓存坏值', async () => {
    let fail = true
    const q = async () => { if (fail) throw new Error('boom'); return { rows: [{ v: 'ok' }] } }
    let now = 0
    expect(await dataVersion(q, () => now)).toBe('')
    fail = false
    expect(await dataVersion(q, () => now)).toBe('ok')
  })

  it('env 可把 TTL 设为 0（每次都查）', async () => {
    resetDataVersionCache({ DATA_VERSION_TTL_MS: '0' })
    let calls = 0
    const q = async () => { calls += 1; return { rows: [{ v: 'x' }] } }
    await dataVersion(q); await dataVersion(q)
    expect(calls).toBe(2)
  })
})
