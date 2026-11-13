// waterfall.test.ts — 瀑布数据（R3 组件②）：本期/上期按维度对齐、贡献排序、合计校验位。
import { describe, expect, it } from 'vitest'
import { waterfallBarsOf } from './waterfall'

const cur = {
  columns: ['branch_name', 'value'],
  rows: [['一店', 1200], ['二店', 700]] as unknown[][],
}
const prev = {
  columns: ['branch_name', 'value'],
  rows: [['一店', 1000], ['三店', 300]] as unknown[][],
}

describe('waterfallBarsOf', () => {
  it('按维度对齐；新增/消失的店按 0 计；按 |delta| 降序；末位合计', () => {
    const bars = waterfallBarsOf(cur, prev, ['branch_name'])
    expect(bars).toEqual([
      { label: '二店', delta: 700, kind: 'delta' },
      { label: '三店', delta: -300, kind: 'delta' },
      { label: '一店', delta: 200, kind: 'delta' },
      { label: '合计变化', delta: 600, kind: 'total' },
    ])
    // 合计 = 本期合计 1900 − 上期合计 1300
    expect(bars.at(-1)!.delta).toBe(600)
  })

  it('两侧完全一致 ⇒ 没有可画的柱子', () => {
    expect(waterfallBarsOf(cur, cur, ['branch_name'])).toEqual([])
  })

  it('缺列（维度或 value 不在结果里）⇒ 空，不抛', () => {
    expect(waterfallBarsOf({ columns: ['value'], rows: [[1]] }, prev, ['branch_name'])).toEqual([])
  })
})
