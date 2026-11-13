// cross-table.test.ts — 交叉表透视（R3 组件①）：行列摆放、缺格与格式。
import { describe, expect, it } from 'vitest'
import { pivotOf } from './cross-table'

const RESULT = {
  columns: ['branch_name', 'category_name', 'value'],
  rows: [
    ['一店', '水果', 1000],
    ['一店', '蔬菜', 500],
    ['二店', '水果', 800],
    // 二店·蔬菜 缺
  ] as unknown[][],
}

describe('pivotOf', () => {
  it('行×列摆放；列序按首次出现；缺格不出键（渲染为 -）', () => {
    const d = pivotOf(RESULT, ['branch_name'], 'category_name', 'number')
    expect(d.rowLabels).toEqual(['一店', '二店'])
    expect(d.colLabels).toEqual(['水果', '蔬菜'])
    expect(d.cells.get('一店')!.get('水果')).toBe('1,000')
    expect(d.cells.get('二店')!.get('蔬菜')).toBeUndefined()
  })

  it('多行维度按 ` / ` 连接', () => {
    const r = { columns: ['area', 'branch_name', 'category_name', 'value'], rows: [['东', '一店', '水果', 10]] as unknown[][] }
    const d = pivotOf(r, ['area', 'branch_name'], 'category_name', 'currency')
    expect(d.rowLabels).toEqual(['东 / 一店'])
    expect(d.cells.get('东 / 一店')!.get('水果')).toBe('¥10.00')
  })

  it('缺列（列维不在结果里）⇒ 空表，不抛', () => {
    const d = pivotOf({ columns: ['value'], rows: [[1]] }, ['branch_name'], 'category_name', 'number')
    expect(d).toEqual({ rowLabels: [], colLabels: [], cells: new Map() })
  })
})
