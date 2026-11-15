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
    // 图例放底部，避免压住折线
    expect(opt.legend.bottom).toBe(0)
    expect(opt.grid.bottom).toBe(34)
  })

  it('堆叠（L4）：本期多系列共用 stack 名；不传时仍是分组柱', () => {
    const cur = ok(['bizday', 'branch_num', 'value'], [
      ['2026-11-01', '1', 10], ['2026-11-01', '2', 5],
      ['2026-11-02', '1', 7], ['2026-11-02', '2', 3],
    ])
    const stacked = buildOption('bar', ['bizday', 'branch_num'], cur, [], { stack: true }) as any
    expect(stacked.baseOption.series).toHaveLength(2)
    expect(stacked.baseOption.series.map((s: { stack?: string }) => s.stack)).toEqual(['total', 'total'])
    // 组合（分组）是默认形态：不传 opts 时不得出现 stack 键
    const grouped = buildOption('bar', ['bizday', 'branch_num'], cur) as any
    expect(grouped.baseOption.series.every((s: { stack?: string }) => s.stack === undefined)).toBe(true)
  })

  it('堆叠与对比基线并存时：stack 只加给本期系列（写侧已拒，这里防御性不误叠）', () => {
    const cur = ok(['bizday', 'branch_num', 'value'], [['2026-11-01', '1', 10], ['2026-11-01', '2', 5]])
    const prev = ok(['bizday', 'branch_num', 'value'], [['2026-10-31', '1', 8], ['2026-10-31', '2', 4]])
    const opt = buildOption('bar', ['bizday', 'branch_num'], cur, [{ label: '上期', result: prev }], {
      stack: true,
    }) as any
    // 4 条系列：前两条本期（有 stack），后两条上期（无）
    expect(opt.baseOption.series.map((s: { stack?: string }) => s.stack))
      .toEqual(['total', 'total', undefined, undefined])
  })

  it('目标线（L4）：挂在第一条本期系列，虚线 + 目标标签；不传时无 markLine', () => {
    const cur = ok(['bizday', 'value'], [['2026-11-01', 10], ['2026-11-02', 20]])
    const withTarget = buildOption('line', ['bizday'], cur, [], { target: 15 }) as any
    const ml = withTarget.series[0].markLine
    expect(ml).toMatchObject({
      silent: true, symbol: 'none',
      lineStyle: { type: 'dashed', color: '#E08A00' },
      data: [{ yAxis: 15 }],
    })
    expect(ml.label.formatter).toBe('目标')
    const plain = buildOption('line', ['bizday'], cur) as any
    expect(plain.series[0].markLine).toBeUndefined()
  })

  it('颜色语义（L4）：按目标线给每根柱着色；缺值不染色', () => {
    const cur = ok(['branch_num', 'value'], [['1', 1200], ['2', 800], ['3', null]])
    const opt = buildOption('bar', ['branch_num'], cur, [], {
      target: 1000, colorSemantics: 'target',
    }) as any
    const data = opt.baseOption.series[0].data
    expect(data[0]).toEqual({ value: 1200, itemStyle: { color: '#0FA958' } })
    expect(data[1]).toEqual({ value: 800, itemStyle: { color: '#E5484D' } })
    // 没数据 ≠ 未达标：不染色（保持 null）
    expect(data[2]).toBeNull()
    // 不传 colorSemantics ⇒ 仍是裸数值（颜色由主题决定）
    const plain = buildOption('bar', ['branch_num'], cur, [], { target: 1000 }) as any
    expect(plain.baseOption.series[0].data).toEqual([1200, 800, null])
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
