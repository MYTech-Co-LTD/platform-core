// chart-compare.test.ts — 折线/柱状图的历史对比合并（上期 / 去年同期）。
import { describe, expect, it } from 'vitest'
import { buildOption } from './ReportView'

type Ok = Parameters<typeof buildOption>[2]

const ok = (columns: string[], rows: unknown[][]): Ok => ({
  kind: 'ok', columns, rows, truncated: false,
})

describe('buildOption 历史对比', () => {
  it('日期轴按序号对齐：上期第 n 天 ↔ 本期第 n 天', () => {
    const cur = ok(['bizday', 'value'], [
      ['2026-11-01', 10], ['2026-11-02', 20], ['2026-11-03', 30],
    ])
    const prev = ok(['bizday', 'value'], [
      ['2026-10-29', 5], ['2026-10-30', 6], ['2026-10-31', 7],
    ])
    const opt = buildOption('line', ['bizday'], cur, [{ label: '上期', result: prev }]) as any
    expect(opt.series).toHaveLength(2)
    expect(opt.series[0].name).toBe('本期')
    expect(opt.series[0].data).toEqual([10, 20, 30])
    expect(opt.series[1].name).toBe('上期')
    expect(opt.series[1].data).toEqual([5, 6, 7])
    expect(opt.xAxis.data).toEqual(['2026-11-01', '2026-11-02', '2026-11-03'])
  })

  it('类目轴按值对齐：柱状图按原因/项目并列', () => {
    const cur = ok(['cause', 'value'], [['来货损', 10], ['自然损', 20]])
    const yoy = ok(['cause', 'value'], [['来货损', 8], ['自然损', 9]])
    const opt = buildOption('bar', ['cause'], cur, [{ label: '去年同期', result: yoy }]) as any
    expect(opt.baseOption.series).toHaveLength(2)
    expect(opt.baseOption.series[0].data).toEqual([10, 20])
    expect(opt.baseOption.series[1].name).toBe('去年同期')
    expect(opt.baseOption.series[1].data).toEqual([8, 9])
  })
})
