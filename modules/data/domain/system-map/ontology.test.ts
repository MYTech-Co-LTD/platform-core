import { describe, expect, it } from 'vitest'
import { buildSystemMapOntology } from './ontology'
import type { SystemMapModel } from './map'

/** 只填本体投影会读到的字段；其余用不到的字段给个空壳（避免为测试复制整张 model）。 */
function modelOf(over: Partial<SystemMapModel>): SystemMapModel {
  return {
    generatedAt: '2026-11-13T00:00:00.000Z',
    health: {
      metricsTotal: 0, entityBound: 0, entityBoundPct: 0, auditCovered: 0, auditCoveredPct: 0,
      zeroUseMetrics: 0, openDemands: 0, incidents: 0, l1Metrics: 0, l2Metrics: 0,
      privateMetrics: 0, incidentsTracked: true,
    },
    metrics: [], entities: [], sources: [], orphans: [], tables: [], orphanTables: [],
    candidateQuality: { total: 0, junk: 0, junkPct: 0, samples: [] },
    valueMetrics: {} as SystemMapModel['valueMetrics'],
    reports: [], demands: [], dimensions: [], invariants: [], warnings: [],
    ...over,
  } as SystemMapModel
}

const metric = (over: Partial<SystemMapModel['metrics'][number]>) => ({
  id: 'lemeng:retail:net_sales',
  title: '净销售额',
  label: '净销售额',
  definition: '按门店日结净额汇总，扣退货',
  entity: '门店',
  entityLabel: '门店',
  synonyms: [],
  grain: [],
  expression: 'sum(net_amount)',
  selectSql: '',
  relations: ['fct_retail_sale'],
  source: 'l1' as const,
  basis: 'l1_tree' as const,
  certified: 'certified' as const,
  requiredScope: null,
  unit: '元',
  bizDescription: null,
  caliberNote: null,
  auditFile: 'audit.sql',
  auditExists: true,
  usage30d: 12,
  trace: {
    metric: 'lemeng:retail:net_sales', entity: '门店', relation: 'fct_retail_sale',
    model: 'fct_retail_sale', modelPath: null, upstream: [], contracts: [],
  },
  ...over,
})

describe('buildSystemMapOntology', () => {
  it('四类节点各就位，id 带类型前缀（同名不撞车）', () => {
    const model = modelOf({
      metrics: [metric({})],
      entities: [{
        name: '门店', label: '门店', synonyms: ['store'], metricIds: ['lemeng:retail:net_sales'],
        relations: ['fct_retail_sale'],
      }],
      sources: [{ name: 'fct_retail_sale', modelPath: null, metricIds: ['lemeng:retail:net_sales'], upstream: [], contracts: [] }],
      dimensions: [{ name: 'branch_geo', label: '门店（行政区划）', relation: 'fct_retail_sale', key: 'branch_num', levels: [{ level: '省', column: 'province' }] }],
    })
    const g = buildSystemMapOntology(model)
    const ids = g.nodes.map((n) => n.id)
    expect(ids).toContain('entity:门店')
    expect(ids).toContain('metric:lemeng:retail:net_sales')
    expect(ids).toContain('source:fct_retail_sale')
    expect(ids).toContain('dimension:branch_geo')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('边类型正确：belongs_to / derives_from / has_dimension', () => {
    const model = modelOf({
      metrics: [metric({})],
      entities: [{ name: '门店', label: '门店', synonyms: [], metricIds: ['lemeng:retail:net_sales'], relations: ['fct_retail_sale'] }],
      sources: [{ name: 'fct_retail_sale', modelPath: null, metricIds: ['lemeng:retail:net_sales'], upstream: [], contracts: [] }],
      dimensions: [{ name: 'branch_geo', label: '门店（行政区划）', relation: 'fct_retail_sale', key: 'branch_num', levels: [] }],
    })
    const g = buildSystemMapOntology(model)
    expect(g.edges).toEqual(expect.arrayContaining([
      { from: 'metric:lemeng:retail:net_sales', to: 'entity:门店', type: 'belongs_to' },
      { from: 'metric:lemeng:retail:net_sales', to: 'source:fct_retail_sale', type: 'derives_from' },
      { from: 'entity:门店', to: 'dimension:branch_geo', type: 'has_dimension' },
    ]))
  })

  it('不留悬空边：上游/实体没进图 ⇒ 不产边', () => {
    const model = modelOf({
      metrics: [metric({ relations: ['fct_unknown'], trace: { ...metric({}).trace, model: 'fct_unknown' } })],
      entities: [],
      sources: [{ name: 'fct_retail_sale', modelPath: null, metricIds: [], upstream: [{ name: 'stg_missing', depth: 1, path: null, contracts: [] }], contracts: [] }],
      dimensions: [],
    })
    const g = buildSystemMapOntology(model)
    expect(g.edges).toEqual([])
  })

  it('upstream_of：上游在源表集合里才连', () => {
    const model = modelOf({
      metrics: [],
      sources: [
        { name: 'fct_retail_sale', modelPath: null, metricIds: [], upstream: [{ name: 'stg_order', depth: 1, path: null, contracts: [] }], contracts: [] },
        { name: 'stg_order', modelPath: null, metricIds: [], upstream: [], contracts: [] },
      ],
    })
    const g = buildSystemMapOntology(model)
    expect(g.edges).toEqual([{ from: 'source:fct_retail_sale', to: 'source:stg_order', type: 'upstream_of' }])
  })

  it('observations 是人话短句：口径 / 使用量 / 对账状态都在指标节点上', () => {
    const model = modelOf({ metrics: [metric({})] })
    const node = buildSystemMapOntology(model).nodes.find((n) => n.id === 'metric:lemeng:retail:net_sales')!
    expect(node.observations.join('\n')).toContain('口径：按门店日结净额汇总，扣退货')
    expect(node.observations.join('\n')).toContain('近 30 天使用 12 次')
    expect(node.observations.join('\n')).toContain('有独立复算文件')
  })
})
