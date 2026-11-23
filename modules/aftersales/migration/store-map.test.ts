// store-map 纯核单测：CSV 形状、注释/空行/表头、重复、非法行（fail-closed）。
import { describe, expect, it } from 'vitest'
import { parseStoreMap } from './store-map'

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
