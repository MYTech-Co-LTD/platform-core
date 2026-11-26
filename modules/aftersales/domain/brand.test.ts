// brand.test.ts — 品牌解析的优先级与 fail-open（#2892）。
import { describe, expect, it, vi } from 'vitest'
import { resolveBrand } from './brand'

function dbOf(rows: unknown[]) {
  return { query: vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows })) }
}

describe('resolveBrand', () => {
  it('返回视图给的第一行（SQL 已按 product=0/store=1 排序）', async () => {
    const db = dbOf([{ subject_type: 'product', brand_code: 'pptd', brand_name: '品品甜', source: 'manual' }])
    await expect(resolveBrand(db, 'org', 'I001', 'S01')).resolves.toEqual({
      code: 'pptd', name: '品品甜', source: 'product', origin: 'manual',
    })
    // org / product / store 三个参数都进 SQL；参数化，别拼字符串
    expect(db.query.mock.calls[0]![1]).toEqual(['org', 'I001', 'S01'])
  })

  it('store 行也映射为 source=store', async () => {
    const db = dbOf([{ subject_type: 'store', brand_code: 'xiongmao', brand_name: '熊喵', source: 'source_field' }])
    await expect(resolveBrand(db, 'org', 'I001', 'S01')).resolves.toEqual({
      code: 'xiongmao', name: '熊喵', source: 'store', origin: 'source_field',
    })
  })

  it('没有分配 ⇒ 未分类', async () => {
    const db = dbOf([])
    await expect(resolveBrand(db, 'org', 'I001', 'S01')).resolves.toEqual({
      code: '', name: '', source: 'unavailable', origin: '',
    })
  })

  it('★ 视图缺失/查询失败 ⇒ fail-open 未分类（不阻断提单），并打 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = { query: vi.fn(async () => { throw new Error('relation "data.v_brand_assignment" does not exist') }) }
    await expect(resolveBrand(db, 'org', 'I001', 'S01')).resolves.toEqual({
      code: '', name: '', source: 'unavailable', origin: '',
    })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('空 product/store 不查库', async () => {
    const db = dbOf([])
    await expect(resolveBrand(db, 'org', '', '')).resolves.toMatchObject({ source: 'unavailable' })
    expect(db.query).not.toHaveBeenCalled()
  })
})
