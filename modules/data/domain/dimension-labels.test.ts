// dimension-labels.test.ts — 维度名称解析的纯函数面（issue #857）
//
// 钉三件事：① 标签**插在对应键之后**且原 key 保留；② 查不到的键给 `null`（不猜、不抛）；
// ③ 没有键列的形态（`args.total` 的单行）**原样返回**——合计/明细的整形不能互相污染。
import { describe, expect, it } from 'vitest'
import { decorateWithLabels, loadDimensionLookup, type DimensionLookup } from './dimension-labels'

const LOOKUP: DimensionLookup = {
  brandByBook: new Map([
    ['3120', '熊喵鲜生'],
    ['64188', '品品甜'],
  ]),
  branchNameByKey: new Map([
    ['3120|142', '品品甜折扣昆明壹号广场店'],
    ['64188|1', '甜选蒙自1店'],
  ]),
  regionByKey: new Map([
    ['3120|25422', { name: '东部一区', l1: '东部战区' }],
    ['3120|21278', { name: '其余门店1', l1: null }],
  ]),
}

describe('decorateWithLabels —— 键之后插标签，原 key 保留', () => {
  it('D1 system_book + branch_num ⇒ 各自后面紧跟 brand_name / branch_name', () => {
    const out = decorateWithLabels(
      {
        columns: ['system_book', 'bizday', 'branch_num', 'value'],
        rows: [['3120', '2026-10-16', 142, 1234.5]],
      },
      LOOKUP,
    )
    expect(out.columns).toEqual(['system_book', 'brand_name', 'bizday', 'branch_num', 'branch_name', 'value'])
    expect(out.rows).toEqual([['3120', '熊喵鲜生', '2026-10-16', 142, '品品甜折扣昆明壹号广场店', 1234.5]])
  })

  it('D2 查不到的键 ⇒ null（不猜、不抛），其余列不受影响', () => {
    const out = decorateWithLabels(
      { columns: ['system_book', 'branch_num', 'value'], rows: [['3120', 999, 7]] },
      LOOKUP,
    )
    expect(out.rows).toEqual([['3120', '熊喵鲜生', 999, null, 7]])
  })

  it('D3 账套没登记品牌 ⇒ brand_name 为 null（新账套不静默借用别人的品牌）', () => {
    const out = decorateWithLabels(
      { columns: ['system_book', 'value'], rows: [['9999', 1]] },
      LOOKUP,
    )
    expect(out.rows).toEqual([['9999', null, 1]])
  })

  it('D4 没有键列（args.total 的单行）⇒ 原样返回，列名与行都不动', () => {
    const input = { columns: ['total'], rows: [[1470.5]] }
    const out = decorateWithLabels(input, LOOKUP)
    expect(out.columns).toEqual(['total'])
    expect(out.rows).toEqual([[1470.5]])
  })

  it('D5 空结果集 ⇒ 列扩了、行仍是空（表头与数据同形）', () => {
    const out = decorateWithLabels({ columns: ['system_book', 'branch_num', 'value'], rows: [] }, LOOKUP)
    expect(out.columns).toEqual(['system_book', 'brand_name', 'branch_num', 'branch_name', 'value'])
    expect(out.rows).toEqual([])
  })

  it('D6 region_id ⇒ 紧跟 region_name + region_l1（一级为空给 null，不拿二级名去截）', () => {
    const out = decorateWithLabels(
      { columns: ['system_book', 'region_id', 'value'], rows: [['3120', 25422, 1], ['3120', 21278, 2]] },
      LOOKUP,
    )
    expect(out.columns).toEqual(['system_book', 'brand_name', 'region_id', 'region_name', 'region_l1', 'value'])
    expect(out.rows).toEqual([
      ['3120', '熊喵鲜生', 25422, '东部一区', '东部战区', 1],
      ['3120', '熊喵鲜生', 21278, '其余门店1', null, 2],
    ])
  })

  it('D7 标签列**已存在**（marts 已物化 region_name）⇒ 不重复插、不覆盖原值，缺的照插', () => {
    // 场景：消费方直接查 `dim_lemeng_branch`（#883）⇒ 结果集里 region_name 已在。
    // 期望：region_name 不重复出现、原值不动；**缺的 region_l1 仍补上**（插在键列之后）。
    const out = decorateWithLabels(
      {
        columns: ['system_book', 'region_id', 'region_name', 'value'],
        rows: [['3120', 25422, '东部一区', 1]],
      },
      LOOKUP,
    )
    expect(out.columns).toEqual([
      'system_book', 'brand_name', 'region_id', 'region_l1', 'region_name', 'value',
    ])
    expect(out.rows).toEqual([['3120', '熊喵鲜生', 25422, '东部战区', '东部一区', 1]])
  })

  it('D8 标签列全已存在 ⇒ 无重名列，且表头与行体**同长**（不错位）', () => {
    const out = decorateWithLabels(
      {
        columns: ['system_book', 'branch_num', 'region_id', 'region_name', 'region_l1'],
        rows: [['3120', 142, 25422, '东部一区', '东部战区']],
      },
      LOOKUP,
    )
    // 战区两个标签都已在 ⇒ 一个都不补；品牌/门店名缺 ⇒ 各补一个。
    expect(out.columns).toEqual([
      'system_book', 'brand_name', 'branch_num', 'branch_name', 'region_id', 'region_name', 'region_l1',
    ])
    expect(new Set(out.columns).size).toBe(out.columns.length)
    expect(out.rows[0]).toHaveLength(out.columns.length)
  })
})

describe('loadDimensionLookup —— 取不到就返回 null（缺账不反噬主查询）', () => {
  it('L1 三条小查询都成功 ⇒ 建出三张映射（战区含 region_l1 的空值语义）', async () => {
    const exec = async (sql: string) => {
      if (sql.includes('dim_brand')) return { columns: ['b', 'brand_name'], rows: [['3120', '熊喵鲜生']] }
      if (sql.includes('dim_region')) {
        return {
          columns: ['b', 'r', 'region_name', 'region_l1'],
          rows: [['3120', 25422, '东部一区', '东部战区'], ['3120', 21278, '其余门店1', null]],
        }
      }
      return { columns: ['b', 'n', 'name'], rows: [['3120', 142, '某店']] }
    }
    const lk = await loadDimensionLookup(exec)
    expect(lk?.brandByBook.get('3120')).toBe('熊喵鲜生')
    expect(lk?.branchNameByKey.get('3120|142')).toBe('某店')
    expect(lk?.regionByKey.get('3120|25422')).toEqual({ name: '东部一区', l1: '东部战区' })
    expect(lk?.regionByKey.get('3120|21278')).toEqual({ name: '其余门店1', l1: null })
  })

  it('L2 维表缺席（抛错）⇒ null，调用方据此不加名称列', async () => {
    const exec = async () => {
      throw new Error('relation "dim_brand" does not exist')
    }
    expect(await loadDimensionLookup(exec)).toBeNull()
  })
})
