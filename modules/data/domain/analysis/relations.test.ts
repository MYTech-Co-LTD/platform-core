import { describe, expect, it } from 'vitest'
import { joinClauseOf, joinableOf, joinsForRelation, parseRelationsYaml } from './relations'

const yaml = `
version: 1
relations:
  - name: retail_sale_branch
    from: { relation: fct_retail_sale, column: branch_num }
    to:   { relation: dim_lemeng_branch, column: branch_num }
    keys: [{ from: system_book, to: system_book }]
    cardinality: N:1
    dedupRule: latest_snapshot
    status: verified
    evidence: { matchRate: 1.0, sampledDay: '2026-10-01' }
  - name: retail_item_sale_item
    from: { relation: fct_retail_item_sale, column: item_num }
    to:   { relation: dim_item_latest, column: item_num }
    keys: [{ from: system_book, to: system_book }]
    cardinality: N:1
    dedupRule: latest_snapshot
    status: verified
    evidence: { matchRate: 1.0 }
  - name: outbound_client
    from: { relation: fct_hq_outbound, column: client_fid }
    to:   { relation: dim_lemeng_client, column: client_fid }
    keys: [{ from: system_book, to: system_book }]
    cardinality: N:1
    status: candidate
    evidence: { matchRate: null }
  - name: bad shape
    from: { relation: 'x;drop', column: c }
    to: { relation: y, column: c }
    cardinality: N:1
  - name: bad keys
    from: { relation: a, column: b }
    to: { relation: c, column: d }
    keys: [{ from: 'x;drop', to: e }]
    cardinality: N:1
  - name: bad dedup
    from: { relation: a, column: b }
    to: { relation: c, column: d }
    cardinality: N:1
    dedupRule: magic
`

describe('parseRelationsYaml', () => {
  it('解析三条合法关系，坏形状进 issues（不静默丢）', () => {
    const { relations, issues } = parseRelationsYaml(yaml)
    expect(relations.map((r) => r.name)).toEqual(['retail_sale_branch', 'retail_item_sale_item', 'outbound_client'])
    expect(issues).toHaveLength(3)
  })

  it('解析附加等值键（跨账套串表的硬约束）', () => {
    const { relations } = parseRelationsYaml(yaml)
    expect(relations[0].keys).toEqual([{ from: 'system_book', to: 'system_book' }])
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

describe('joinClauseOf（dedup 生成去重子查询 + 复合键）', () => {
  it('普通关系直连；键全部进 on（不只主键）', () => {
    const { relations } = parseRelationsYaml(yaml)
    const clause = joinClauseOf(relations[2], 'cli')
    expect(clause).toBe(
      'join dim_lemeng_client cli on cli.client_fid = fct_hq_outbound.client_fid'
      + ' and cli.system_book = fct_hq_outbound.system_book',
    )
  })

  it('dedup=latest_snapshot 按「主键+附加键」取最新快照', () => {
    const { relations } = parseRelationsYaml(yaml)
    const dedup = joinClauseOf(relations[1], 'it')
    expect(dedup).toBe(
      'join (select distinct on (item_num, system_book) * from dim_item_latest'
      + ' order by item_num, system_book, snapshot desc) it'
      + ' on it.item_num = fct_retail_item_sale.item_num'
      + ' and it.system_book = fct_retail_item_sale.system_book',
    )
  })

  it('目标表有 org 时：去重分区带 org，join 也钉同 org（不跨租户取标签）', () => {
    const { relations } = parseRelationsYaml(yaml)
    const dedup = joinClauseOf(relations[0], 'b', { targetHasOrg: true })
    expect(dedup).toContain('distinct on (org, branch_num, system_book)')
    expect(dedup).toContain('order by org, branch_num, system_book, snapshot desc')
    expect(dedup).toContain('and b.org = fct_retail_sale.org')
  })

  it('未知 dedupRule 进 issues（不进 relations），显式报错不猜', () => {
    const { relations, issues } = parseRelationsYaml(yaml)
    expect(issues.some((i) => i.name === 'bad dedup')).toBe(true)
    expect(relations.map((r) => r.name)).not.toContain('bad dedup')
    expect(() => joinClauseOf({ ...relations[1], dedupRule: 'magic' }, 'x')).toThrow(/dedupRule/)
  })
})

describe('joinsForRelation（只挑本表 from 侧且通过闸门的关系）', () => {
  it('只返回 verified + 命中率达标、且 from 侧匹配的关系；别名即关系名', () => {
    const { relations } = parseRelationsYaml(yaml)
    const forSale = joinsForRelation(relations, 'fct_retail_sale')
    expect(forSale).toHaveLength(1)
    expect(forSale[0].alias).toBe('retail_sale_branch')
    expect(forSale[0].clause).toContain('join (select distinct on (branch_num, system_book) * from dim_lemeng_branch')
    expect(joinsForRelation(relations, 'fct_hq_outbound')).toHaveLength(0)   // candidate 被拒
  })
})
