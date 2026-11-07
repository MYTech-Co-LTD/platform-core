import { describe, expect, it } from 'vitest'
import { joinClauseOf, joinableOf, parseRelationsYaml } from './relations'

const yaml = `
version: 1
relations:
  - name: retail_sale_branch
    from: { relation: fct_retail_sale, column: branch_num }
    to:   { relation: dim_lemeng_branch, column: branch_num }
    cardinality: N:1
    status: verified
    evidence: { matchRate: 1.0, sampledDay: '2026-10-01' }
  - name: retail_item_sale_item
    from: { relation: fct_retail_item_sale, column: item_num }
    to:   { relation: dim_item_latest, column: item_num }
    cardinality: N:1
    dedupRule: latest_snapshot
    status: verified
    evidence: { matchRate: 1.0 }
  - name: outbound_client
    from: { relation: fct_hq_outbound, column: client_fid }
    to:   { relation: dim_lemeng_client, column: client_fid }
    cardinality: N:1
    status: candidate
    evidence: { matchRate: null }
  - name: bad shape
    from: { relation: 'x;drop', column: c }
    to: { relation: y, column: c }
    cardinality: N:1
`

describe('parseRelationsYaml', () => {
  it('解析三条合法关系，坏形状进 issues（不静默丢）', () => {
    const { relations, issues } = parseRelationsYaml(yaml)
    expect(relations.map((r) => r.name)).toEqual(['retail_sale_branch', 'retail_item_sale_item', 'outbound_client'])
    expect(issues).toHaveLength(1)
  })

  it('空/坏 YAML ⇒ 空集，不抛', () => {
    expect(parseRelationsYaml(null).relations).toHaveLength(0)
    expect(parseRelationsYaml('relations: [oops').relations).toHaveLength(0)
  })
})

describe('joinableOf（只有 verified + 命中率 ≥0.95 可用）', () => {
  it('candidate 与低命中率都被拒', () => {
    const { relations } = parseRelationsYaml(yaml)
    const [branch, item, client] = relations
    expect(joinableOf(branch)).toBeNull()
    expect(joinableOf(item)).toBeNull()
    expect(joinableOf(client)).toBe('NOT_VERIFIED')
    expect(joinableOf({ ...branch, evidence: { matchRate: 0.9 } })).toBe('LOW_MATCH')
  })
})

describe('joinClauseOf（dedup 生成去重子查询）', () => {
  it('普通关系直连；dedup=latest_snapshot 走 distinct on 子查询', () => {
    const { relations } = parseRelationsYaml(yaml)
    expect(joinClauseOf(relations[0], 'dim')).toContain('join dim_lemeng_branch dim on dim.branch_num = fct_retail_sale.branch_num')
    const dedup = joinClauseOf(relations[1], 'it')
    expect(dedup).toContain('distinct on (item_num)')
    expect(dedup).toContain('order by item_num desc')
  })

  it('未知 dedupRule 显式报错（不猜）', () => {
    const { relations } = parseRelationsYaml(yaml)
    expect(() => joinClauseOf({ ...relations[1], dedupRule: 'magic' }, 'x')).toThrow(/dedupRule/)
  })
})
