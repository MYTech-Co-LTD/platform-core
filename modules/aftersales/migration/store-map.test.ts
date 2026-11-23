// store-map 纯核单测：CSV 形状、注释/空行/表头、重复、非法行（fail-closed）。
import { describe, expect, it } from 'vitest'
import { buildStoreMapCsv, matchStores, parseStoreMap } from './store-map'

describe('parseStoreMap', () => {
  it('基本两列 ⇒ 映射成立', () => {
    const r = parseStoreMap('wuji-01,LM001\nwuji-02,LM002\n')
    expect(r.errors).toEqual([])
    expect(r.map.get('wuji-01')).toBe('LM001')
    expect(r.map.get('wuji-02')).toBe('LM002')
    expect(r.map.size).toBe(2)
  })

  it('注释与空行跳过；CRLF 兼容', () => {
    const r = parseStoreMap('# 说明\r\n\r\nwuji-01,LM001\r\n')
    expect(r.errors).toEqual([])
    expect(r.map.size).toBe(1)
    expect(r.map.get('wuji-01')).toBe('LM001')
  })

  it('首行表头（第一列不是编号形态）跳过', () => {
    const r = parseStoreMap('wuji_store_id,dim_code\nwuji-01,LM001\n')
    expect(r.errors).toEqual([])
    expect(r.map.size).toBe(1)
    expect(r.map.has('wuji_store_id')).toBe(false)
  })

  it('重复的无忌 id：后者覆盖并计数（可复现，不静默二选一）', () => {
    const r = parseStoreMap('wuji-01,LM001\nwuji-01,LM009\n')
    expect(r.errors).toEqual([])
    expect(r.duplicates).toBe(1)
    expect(r.map.get('wuji-01')).toBe('LM009')
  })

  it('列数不对 / 空列 ⇒ 报错（映射是迁移配置，不允许半信半疑）', () => {
    const r = parseStoreMap('wuji-01,LM001\noops\nwuji-02,\n')
    expect(r.errors).toHaveLength(2)
    expect(r.errors[0]).toContain('第 2 行')
    expect(r.errors[1]).toContain('第 3 行')
  })

  it('值里有空格 ⇒ trim 后成立', () => {
    const r = parseStoreMap(' wuji-01 , LM001 \n')
    expect(r.errors).toEqual([])
    expect(r.map.get('wuji-01')).toBe('LM001')
  })
})

describe('matchStores（编码优先 + 名称兜底；100% 对上 = 同一条平台门店）', () => {
  const dims = [
    { code: 'LM001', name: '品品甜临沧沧源2店', sourceBook: '3120' },
    { code: 'LM002', name: '熊喵临沧云县3店', sourceBook: '3120' },
    { code: 'LM003', name: '同名店', sourceBook: '3120' },
    { code: 'LM004', name: '同名店', sourceBook: '64188' },
    { code: 'LM005', name: '品品甜保山隆阳1店', sourceBook: '64188' },
    { code: 'LM006', name: '保山隆阳1店', sourceBook: '3120' },
  ]

  it('编码与名称指向同一条 ⇒ matched', () => {
    const r = matchStores([{ sourceId: 's1', name: '品品甜临沧沧源2店', storeCode: 'LM001' }], dims)
    expect(r.matched).toEqual([{ sourceId: 's1', name: '品品甜临沧沧源2店', code: 'LM001' }])
    expect(r.review).toEqual([])
  })

  it('名称仅差品牌前缀（归一命中同一编码）⇒ matched', () => {
    const r = matchStores([{ sourceId: 's2', name: ' 熊喵临沧云县3店 ', storeCode: 'LM002' }], dims)
    expect(r.matched[0]?.code).toBe('LM002')
  })

  it('编码命中、名称不命中 ⇒ review name_missing（带平台该编码门店）', () => {
    const r = matchStores([{ sourceId: 's3', name: '临沧云县新店', storeCode: 'LM002' }], dims)
    expect(r.matched).toEqual([])
    expect(r.review[0]).toMatchObject({ reason: 'name_missing', dimByCode: { code: 'LM002' } })
  })

  it('编码命中、名称归一后多候选 ⇒ review name_ambiguous（跨账套同名）', () => {
    const r = matchStores([{ sourceId: 's4', name: '同名店', storeCode: 'LM003' }], dims)
    expect(r.review[0]).toMatchObject({ reason: 'name_ambiguous' })
    expect(r.review[0].dimByName?.map((d) => d.code)).toEqual(['LM003', 'LM004'])
  })

  it('编码与名称指向不同门店 ⇒ review code_and_name_disagree（必须裁决）', () => {
    // 名称「品品甜临沧沧源2店」唯一指向 LM001；源编码却给 LM002 ⇒ 自相矛盾
    const r = matchStores([{ sourceId: 's5', name: '品品甜临沧沧源2店', storeCode: 'LM002' }], dims)
    expect(r.review[0]).toMatchObject({ reason: 'code_and_name_disagree' })
    expect(r.review[0].dimByCode?.code).toBe('LM002')
    expect(r.review[0].dimByName?.[0]?.code).toBe('LM001')
  })

  it('编码未命中、名称唯一命中 ⇒ review code_missing（带名称候选）', () => {
    const r = matchStores([{ sourceId: 's6', name: '熊喵临沧云县3店', storeCode: 'WUJI-X' }], dims)
    expect(r.review[0]).toMatchObject({ reason: 'code_missing' })
    expect(r.review[0].dimByName?.[0]?.code).toBe('LM002')
  })

  it('编码为空、名称也没有 ⇒ review both_missing', () => {
    const r = matchStores([{ sourceId: 's7', name: '不存在的店', storeCode: '' }], dims)
    expect(r.review[0]).toMatchObject({ reason: 'both_missing' })
  })
})

describe('buildStoreMapCsv', () => {
  it('只渲染 matched，带注释头（可被 parseStoreMap 直接吃）', () => {
    const csv = buildStoreMapCsv({ matched: [{ sourceId: 's1', name: 'x', code: 'LM001' }], review: [] })
    expect(csv).toContain('# 由 gen-store-map 生成')
    expect(csv).toContain('s1,LM001')
    const r = parseStoreMap(csv)
    expect(r.errors).toEqual([])
    expect(r.map.get('s1')).toBe('LM001')
  })
})
