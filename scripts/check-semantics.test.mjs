import { describe, expect, it } from 'vitest'
import { entityIssues, metricEntities } from './check-semantics.mjs'

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
