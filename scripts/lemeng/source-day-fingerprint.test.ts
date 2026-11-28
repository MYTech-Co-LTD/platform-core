// scripts/lemeng/source-day-fingerprint.test.ts — 可变窗口测量（#2972）的纯函数机检。
//
// 钉三件：① 观测窗口只取**已封日**（T-1 起，T-0 还在被写）；② 对象路径与**实测湖布局**逐字一致
// （`system_book=<b>/bizday=<YYYY-MM-DD>/chunk=all.parquet`——猜错路径是这条线最常见的坑）；
// ③ 表结构把**观测日**放进主键（同一天可被多次观测，历史保留），否则「变化」永远看不出来。
import { describe, expect, it } from 'vitest'
import { SOURCES, ensureTable, observeDays, rowsOf } from './source-day-fingerprint.mjs'

describe('source-day-fingerprint · 观测窗口', () => {
  const now = new Date('2026-11-28T05:00:00Z') // 13:00 CST

  it('默认从 T-1 起，不含 T-0（当天还在被写，指纹没意义）', () => {
    expect(observeDays(3, 1, now)).toEqual(['2026-11-27', '2026-11-26', '2026-11-25'])
  })
  it('★ 起点按源的发布滞后：lagDays=2 ⇒ 从 T-2 起（inventory_snapshot 实测没有 T-1）', () => {
    expect(observeDays(3, 2, now)).toEqual(['2026-11-26', '2026-11-25', '2026-11-24'])
  })
  it('lagDays 非法（0/负数）按 1 处理，不观测 T-0', () => {
    expect(observeDays(2, 0, now)[0]).toBe('2026-11-27')
    expect(observeDays(2, -3, now)[0]).toBe('2026-11-27')
  })
  it('跨月正确', () => {
    const m = new Date('2026-12-02T05:00:00Z')
    expect(observeDays(3, 1, m)).toEqual(['2026-12-01', '2026-11-30', '2026-11-29'])
  })
})

describe('source-day-fingerprint · 路径', () => {
  it('★ 与实测湖布局逐字一致（bizday=YYYY-MM-DD/chunk=all.parquet）', () => {
    const s = SOURCES[0]
    expect(s.source).toBe('inventory_snapshot')
    expect(s.lagDays).toBe(2) // 源端 D+1 22:35 发布（#1079 实测）
    expect(s.file(3120, '2026-11-27')).toBe(
      's3://shanhai-data/lemeng/inventory_snapshot/system_book=3120/bizday=2026-11-27/chunk=all.parquet',
    )
  })
})

describe('source-day-fingerprint · 表与读取', () => {
  it('★ 表主键含 observed_on（否则「变化」看不出来）', async () => {
    let ddl = ''
    const pool = { query: async (sql: string) => { ddl = sql; return { rows: [] } } }
    await ensureTable(pool)
    expect(ddl).toContain('primary key (source, system_book, bizday, observed_on)')
    expect(ddl).toContain('check (rows >= 0)')
  })

  it('rowsOf 只做 count，不做任何写', async () => {
    let sql = ''
    const pool = { query: async (s: string) => { sql = s; return { rows: [{ n: '4208' }] } } }
    await expect(rowsOf(pool, 's3://x/y.parquet')).resolves.toBe(4208)
    expect(sql).toContain('count(*)')
    expect(sql).not.toMatch(/\b(insert|update|delete|create)\b/i)
  })
})
