import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import { driftPctOf, primaryValueOf, refreshBaseline } from './verified-baseline-refresh'
import type { Baseline } from './verified-questions'

const baseline = (sum: number): Baseline => ({
  columns: ['value'],
  rowCount: 1,
  summary: { value: { sum, min: sum, max: sum, nulls: 0, numeric: true } },
})

/** 只回答 select 的假池；记录 update 载荷。 */
function fakePool(row: Record<string, unknown> | null) {
  const updates: unknown[][] = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (/^\s*select/i.test(sql)) return { rows: row === null ? [] : [row] }
      if (/^\s*update/i.test(sql)) { updates.push(params ?? []); return { rows: [] } }
      throw new Error(`unexpected sql: ${sql}`)
    },
  } as unknown as Pool
  return { pool, updates }
}

describe('refreshBaseline（W6 Task 4：有主体的基线刷新）', () => {
  it('正常刷新：写回新基线 + 操作人/原因/时间，返回漂移', async () => {
    const { pool, updates } = fakePool({ id: 3, metric_id: 'm:a:b', params: {}, slicing: {}, baseline: baseline(100), status: 'verified' })
    const out = await refreshBaseline(pool, 'acme', 3, { by: 'duo', reason: '数据回填后基线过期' }, {
      compute: async () => baseline(75),
      now: () => new Date('2026-11-06T08:00:00.000Z'),
    })
    expect(out).toMatchObject({ ok: true, id: 3, driftPct: 0.25 })
    expect(updates).toHaveLength(1)
    expect(updates[0][3]).toBe('duo')
    expect(updates[0][4]).toBe('2026-11-06T08:00:00.000Z')
    expect(updates[0][5]).toBe('数据回填后基线过期')
  })

  it('操作人或原因缺失 ⇒ bad_input，一次写都不发', async () => {
    const { pool, updates } = fakePool({ id: 3, metric_id: 'm:a:b', params: {}, slicing: {}, baseline: baseline(1), status: 'verified' })
    const out = await refreshBaseline(pool, 'acme', 3, { by: ' ', reason: 'x' }, { compute: async () => baseline(2) })
    expect(out).toMatchObject({ ok: false, reason: 'bad_input' })
    expect(updates).toHaveLength(0)
  })

  it('非 verified 行拒刷（candidate/rejected 不该有基线可言）', async () => {
    const { pool, updates } = fakePool({ id: 9, metric_id: 'm:a:b', params: {}, slicing: {}, baseline: null, status: 'candidate' })
    const out = await refreshBaseline(pool, 'acme', 9, { by: 'duo', reason: 'x' }, { compute: async () => baseline(2) })
    expect(out).toMatchObject({ ok: false, reason: 'not_verified' })
    expect(updates).toHaveLength(0)
  })

  it('重放失败 ⇒ compute_failed，不写库（不拿失败当新基线）', async () => {
    const { pool, updates } = fakePool({ id: 4, metric_id: 'm:a:b', params: {}, slicing: {}, baseline: baseline(1), status: 'verified' })
    const out = await refreshBaseline(pool, 'acme', 4, { by: 'duo', reason: 'x' }, { compute: async () => { throw new Error('boom') } })
    expect(out).toMatchObject({ ok: false, reason: 'compute_failed' })
    expect(updates).toHaveLength(0)
  })

  it('行不存在 ⇒ not_found', async () => {
    const { pool } = fakePool(null)
    const out = await refreshBaseline(pool, 'acme', 404, { by: 'duo', reason: 'x' }, { compute: async () => baseline(1) })
    expect(out).toMatchObject({ ok: false, reason: 'not_found' })
  })
})

describe('漂移计算', () => {
  it('primaryValueOf 优先取 value 列，退化为第一列', () => {
    expect(primaryValueOf(baseline(5))).toBe(5)
    expect(primaryValueOf(null)).toBeNull()
    expect(primaryValueOf({ columns: ['a'], rowCount: 1, summary: { a: { sum: 7, min: 7, max: 7, nulls: 0 } } })).toBe(7)
  })

  it('driftPctOf：相对漂移，基线 0 时用 1e-9 兜底不产生 NaN', () => {
    expect(driftPctOf(baseline(100), baseline(75))).toBe(0.25)
    expect(driftPctOf(baseline(0), baseline(5))).toBe(5e9)
    expect(driftPctOf(null, baseline(1))).toBeNull()
  })
})
