import { describe, expect, it } from 'vitest'
import { dimensionIssues, entityIssues, metricEntities } from './check-semantics.mjs'

const branch = {
  label: '门店', synonyms: ['店铺'],
  system_of_record: 'lemeng', identity_keys: ['branch_num'],
  merge_rule: 'prefer_source', owner: 'data-platform',
}
/** @param {Record<string, unknown>} entities @param {any[]} [metrics] */
const doc = (entities, metrics = []) => ({ version: 1, entities, metrics })

describe('entityIssues（顶层 entities 是唯一事实源）', () => {
  it('干净声明 ⇒ 无 issue', () => {
    expect(entityIssues(doc({ branch }))).toEqual([])
  })

  it('entities 段缺失 / 是数组 ⇒ issue（不是空声明）', () => {
    expect(entityIssues({ version: 1 }).join('\n')).toContain('entities')
    expect(entityIssues({ entities: [branch] }).join('\n')).toContain('entities')
  })

  it('对象名不合规 ⇒ issue', () => {
    expect(entityIssues(doc({ Branch: branch })).join('\n')).toContain('不合规')
  })

  it('缺 W4 四个必填字段 ⇒ 各自报一条', () => {
    const out = entityIssues(doc({ x: { label: 'X' } })).join('\n')
    for (const k of ['system_of_record', 'identity_keys', 'merge_rule', 'owner']) expect(out).toContain(k)
  })

  it('identity_keys 为空数组 ⇒ issue（空数组等于没有对齐键）', () => {
    expect(entityIssues(doc({ x: { ...branch, identity_keys: [] } })).join('\n')).toContain('identity_keys')
  })

  it('merge_rule 不在闭集 ⇒ issue', () => {
    expect(entityIssues(doc({ x: { ...branch, merge_rule: 'latest_wins' } })).join('\n')).toContain('merge_rule')
  })

  it('★ 未知 ≠ 没有：指标引用了未声明的 entity ⇒ issue', () => {
    const out = entityIssues(doc({ branch }, [
      { name: 'a:b:c', entity: 'branch' },
      { name: 'a:b:d', entity: 'ghost' },
    ]))
    expect(out.join('\n')).toContain('a:b:d')
    expect(out.join('\n')).toContain('ghost')
    expect(out.filter((s) => s.includes('a:b:c'))).toEqual([])
  })
})

describe('metricEntities', () => {
  it('name → entity；未声明记空串', () => {
    const map = metricEntities({ metrics: [{ name: 'a:b:c', entity: 'branch' }, { name: 'a:b:d' }] })
    expect(map.get('a:b:c')).toBe('branch')
    expect(map.get('a:b:d')).toBe('')
  })
})

describe('dimensionIssues（W4 Task 3）', () => {
  const cols = new Map([
    ['branch', new Set(['branch_num', 'province', 'city'])],
    ['item', new Set(['item_num', 'item_category_name'])],
  ])
  /** @param {Record<string, unknown>} [over] */
  const dim = (over = {}) => ({
    name: 'branch_geo', relation: 'branch', key: 'branch_num',
    hierarchy: [{ level: 'province', column: 'province' }, { level: 'branch', column: 'branch_num' }], ...over,
  })
  /** @param {any[]} dimensions */
  const doc = (dimensions) => ({ version: 1, dimensions })

  it('干净声明 ⇒ 无 issue', () => {
    expect(dimensionIssues(doc([dim()]), cols)).toEqual([])
  })
  it('relation 无契约 ⇒ issue（未知 ≠ 没有）', () => {
    expect(dimensionIssues(doc([dim({ relation: 'ghost' })]), cols).join('\n')).toContain('契约')
  })
  it('层级引用了契约里没有的列 ⇒ issue', () => {
    const out = dimensionIssues(doc([dim({ hierarchy: [{ level: 'x', column: 'nope' }, { level: 'branch', column: 'branch_num' }] })]), cols)
    expect(out.join('\n')).toContain('nope')
  })
  it('层级末级不是 key ⇒ issue', () => {
    const out = dimensionIssues(doc([dim({ hierarchy: [{ level: 'branch', column: 'branch_num' }, { level: 'province', column: 'province' }] })]), cols)
    expect(out.join('\n')).toContain('末级')
  })
  it('同一 (relation,key) 声明两次 ⇒ issue', () => {
    expect(dimensionIssues(doc([dim(), dim({ name: 'b2' })]), cols).join('\n')).toContain('多个维度')
  })
  it('level 重复 / 少于两级 ⇒ issue', () => {
    expect(dimensionIssues(doc([dim({ hierarchy: [{ level: 'p', column: 'province' }, { level: 'p', column: 'branch_num' }] })]), cols).join('\n')).toContain('重复')
    expect(dimensionIssues(doc([dim({ hierarchy: [{ level: 'only', column: 'branch_num' }] })]), cols).join('\n')).toContain('两级')
  })
})
