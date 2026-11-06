import { describe, expect, it } from 'vitest'
import { entityIssues, metricEntities } from './check-semantics.mjs'

const good = (over = {}) => ({
  name: 'branch', label: '门店', aliases: ['店铺'],
  system_of_record: 'lemeng', identity_keys: ['branch_num'],
  merge_rule: 'prefer_source', owner: 'data-platform', ...over,
})
const doc = (entities) => ({ version: 1, entities })
const noMetrics = new Map()

describe('entityIssues', () => {
  it('干净声明 ⇒ 无 issue', () => {
    expect(entityIssues(doc([good()]), noMetrics)).toEqual([])
  })

  it('name 重复 / 不合规 ⇒ issue', () => {
    expect(entityIssues(doc([good(), good()]), noMetrics).join('\n')).toContain('重复')
    expect(entityIssues(doc([good({ name: 'Branch' })]), noMetrics).join('\n')).toContain('不合规')
  })

  it('缺 system_of_record / identity_keys / owner ⇒ 各自报一条', () => {
    const out = entityIssues(doc([{ name: 'x', label: 'X' }]), noMetrics)
    expect(out.join('\n')).toContain('system_of_record')
    expect(out.join('\n')).toContain('identity_keys')
    expect(out.join('\n')).toContain('owner')
  })

  it('identity_keys 为空数组 ⇒ issue（空数组等于没有对齐键）', () => {
    expect(entityIssues(doc([good({ identity_keys: [] })]), noMetrics).join('\n')).toContain('identity_keys')
  })

  it('merge_rule 不在闭集 ⇒ issue', () => {
    expect(entityIssues(doc([good({ merge_rule: 'latest_wins' })]), noMetrics).join('\n')).toContain('merge_rule')
  })

  it('★ 未知 ≠ 没有：指标引用了未声明的 entity ⇒ issue', () => {
    const out = entityIssues(doc([good()]), new Map([['lemeng:retail:sales', 'branch'], ['lemeng:x:y', 'ghost']]))
    expect(out.join('\n')).toContain('lemeng:x:y')
    expect(out.join('\n')).toContain('ghost')
    // 已声明的 branch 不算违规
    expect(out.filter((s) => s.includes('lemeng:retail:sales'))).toEqual([])
  })

  it('entities 段缺失 ⇒ issue（不是空声明）', () => {
    expect(entityIssues({ version: 1 }, noMetrics).join('\n')).toContain('entities')
  })
})

describe('metricEntities', () => {
  it('解析 name → entity，未声明 entity 的指标记空串', () => {
    const map = metricEntities('version: 1\nmetrics:\n  - name: \'a:b:c\'\n    entity: branch\n  - name: \'a:b:d\'\n')
    expect(map.get('a:b:c')).toBe('branch')
    expect(map.get('a:b:d')).toBe('')
  })

  it('坏 YAML ⇒ 空 Map（不抛）', () => {
    expect(metricEntities('metrics: [oops').size).toBe(0)
  })
})
