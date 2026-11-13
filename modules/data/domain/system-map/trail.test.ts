import { describe, expect, it } from 'vitest'
import { buildMetricTrail, lakeOfStaging, lakePrefixOfKey, pipelineIdsOf, stagingRelationsOf } from './trail'
import type { SystemMapModel } from './map'

function modelOf(over: Partial<SystemMapModel>): SystemMapModel {
  return {
    generatedAt: '2026-11-14T00:00:00.000Z',
    health: {} as SystemMapModel['health'],
    metrics: [], entities: [], sources: [], orphans: [], tables: [], orphanTables: [],
    candidateQuality: { total: 0, junk: 0, junkPct: 0, samples: [] },
    valueMetrics: {} as SystemMapModel['valueMetrics'],
    reports: [], demands: [], dimensions: [], invariants: [], warnings: [],
    ...over,
  } as SystemMapModel
}

const METRIC = {
  id: 'lemeng:retail:net_sales', title: '净销售额', label: '净销售额',
  definition: '', entity: '门店', entityLabel: '门店', synonyms: [], grain: [],
  expression: '', selectSql: '', relations: ['fct_retail_sale'], source: 'l1' as const,
  basis: 'l1_tree' as const, certified: 'certified' as const, requiredScope: null, unit: null,
  bizDescription: null, caliberNote: null, auditFile: '', auditExists: true, usage30d: 3,
  trace: { metric: 'lemeng:retail:net_sales', entity: '门店', relation: 'fct_retail_sale', model: 'fct_retail_sale', modelPath: null, upstream: [], contracts: [] },
}

const MODEL = modelOf({
  metrics: [METRIC],
  sources: [{
    name: 'fct_retail_sale', modelPath: 'dbt/models/lemeng/marts/fct_retail_sale.sql', metricIds: [METRIC.id],
    upstream: [{ name: 'stg_lemeng_retail_order_line', depth: 1, path: null, contracts: [] }], contracts: [],
  }],
})

const PIPELINE = { id: 'lemeng.retail_order_line.l0.3120', lakeKeys: ['lemeng/retail_order_line/system_book=${ENV:SYSTEM_BOOK}/bizday=${date-1d}/all.parquet'] }

describe('链路投影', () => {
  it('完整链路：指标 → marts → staging → 湖 → 管线，全部 declared', () => {
    const trail = buildMetricTrail(MODEL, 'lemeng:retail:net_sales', [PIPELINE])!
    expect(trail.steps.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'metric:净销售额',
      'mart:fct_retail_sale',
      'staging:stg_lemeng_retail_order_line',
      'lake:lemeng/retail_order_line',
      'pipeline:lemeng.retail_order_line.l0.3120',
    ])
    expect(trail.steps.every((s) => s.from === 'declared')).toBe(true)
    expect(trail.notes).toEqual([])
  })

  it('找不到写湖的管线 ⇒ 湖那步标 inferred，并留一条 note', () => {
    const trail = buildMetricTrail(MODEL, 'lemeng:retail:net_sales', [])!
    const lake = trail.steps.find((s) => s.kind === 'lake')!
    expect(lake.from).toBe('inferred')
    expect(lake.detail).toContain('没有在仓内管线里找到写入方')
    expect(trail.notes.join('\n')).toContain('没有在仓内管线定义里找到')
  })

  it('模型图没读到 staging ⇒ 只剩 mart 一步 + note，不编造下游', () => {
    const model = modelOf({
      metrics: [METRIC],
      sources: [{ name: 'fct_retail_sale', modelPath: null, metricIds: [], upstream: [], contracts: [] }],
    })
    const trail = buildMetricTrail(model, 'lemeng:retail:net_sales', [PIPELINE])!
    expect(trail.steps.map((s) => s.kind)).toEqual(['metric', 'mart'])
    expect(trail.notes.join('\n')).toContain('没有读到这个指标的 staging 上游')
  })

  it('契约给了湖前缀 ⇒ 用契约（dim_* 资产的 staging 名不带 dim）', () => {
    const model = modelOf({
      metrics: [{ ...METRIC, relations: ['fct_branch_dim'] }],
      sources: [{
        name: 'fct_branch_dim', modelPath: null, metricIds: [],
        upstream: [{ name: 'stg_lemeng_branch', depth: 1, path: null, contracts: [] }], contracts: [],
      }],
    })
    const trail = buildMetricTrail(model, 'lemeng:retail:net_sales', [], new Map([['stg_lemeng_branch', 'lemeng/dim_branch']]))!
    const lake = trail.steps.find((s) => s.kind === 'lake')!
    expect(lake.label).toBe('lemeng/dim_branch')
    expect(lake.from).toBe('declared')
  })

  it('指标不存在 ⇒ null（路由给 404，不编链路）', () => {
    expect(buildMetricTrail(MODEL, 'no:such:metric', [])).toBeNull()
  })

  it('辅助函数：staging / lake 前缀推导与管线 id 提取', () => {
    expect(lakeOfStaging('stg_lemeng_branch_expense')).toBe('lemeng/branch_expense')
    expect(lakeOfStaging('stg_forms_submission')).toBe('forms/submission')
    expect(lakeOfStaging('fct_retail_sale')).toBeNull()
    expect(lakePrefixOfKey('lemeng/x/bizday=1/all.parquet')).toBe('lemeng/x')
    expect(lakePrefixOfKey('${ENV:BUCKET}/x/a.parquet')).toBeNull()
    const trail = buildMetricTrail(MODEL, 'lemeng:retail:net_sales', [PIPELINE])!
    expect(stagingRelationsOf(trail)).toEqual(['stg_lemeng_retail_order_line'])
    expect(pipelineIdsOf(trail)).toEqual(['lemeng.retail_order_line.l0.3120'])
  })
})
