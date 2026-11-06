// system-map.test.ts — 体系地图的纯函数测试（不碰文件系统 / 数据库，全部走注入）。
import { describe, expect, it } from 'vitest'
import type { ContractRef } from './pipelines/defs'
import {
  buildSystemMapModel,
  escapeJsonForScript,
  parseSelectSql,
  parseSystemMapSemantics,
  renderSystemMapHtml,
} from './system-map'
import type { SystemMapInput, SystemMapMetricFact } from './system-map'

const contract: ContractRef = {
  id: 'lemeng.retail_order_line',
  domain: 'lemeng',
  table: 'retail_order_line',
  path: 'contracts/common/lemeng.retail_order_line.json',
  columns: 25,
  doc: {},
}

const metric = (partial: Partial<SystemMapMetricFact> & { id: string }): SystemMapMetricFact => ({
  title: partial.id,
  description: '',
  selectSql: 'select sum(fct_retail_sale.sale_amount) as value, branch_num from fct_retail_sale',
  ...partial,
})

function baseInput(metrics: SystemMapMetricFact[]): SystemMapInput {
  return {
    semantics: {
      entities: new Map([['branch', { label: '门店', synonyms: ['店铺', '分店'] }]]),
      metrics: new Map([
        ['lemeng:retail:net_sales', {
          label: '净销售额',
          definition: '销售侧 − 退货侧',
          expression: 'sum(fct_retail_sale.net_amount)',
          grain: ['system_book', 'bizday', 'branch_num'],
          entity: 'branch',
          synonyms: ['净销售金额'],
          unit: '元',
          owner: 'data-platform',
          tier: 'experimental',
        }],
        ['lemeng:retail:orphan', {
          label: '孤儿指标',
          definition: '没有实体的指标',
          expression: 'sum(fct_retail_sale.sale_amount)',
          grain: [],
          entity: null,
          synonyms: [],
          unit: null,
          owner: null,
          tier: null,
        }],
      ]),
    },
    metrics,
    contracts: [contract],
    models: [
      { name: 'fct_retail_sale', path: 'dbt/models/lemeng/marts/fct_retail_sale.sql', refs: ['stg_lemeng_retail_order_line'] },
      { name: 'stg_lemeng_retail_order_line', path: 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql', refs: [] },
    ],
    auditFiles: ['audit_lemeng__retail__net_sales.sql'],
    reports: [{ id: 'r1', title: '经营日报', latestVersion: 3, latestVersionTitle: '经营日报 v3', publishedVersion: 2 }],
    usage: { 'lemeng:retail:net_sales': 7 },
    demands: [
      { kind: 'alias_gap', target: '营业额', occurrences: 4, lastSeen: '2026-11-05T00:00:00.000Z' },
      { kind: 'new_metric', target: '客单价', occurrences: 2, lastSeen: '2026-11-04T00:00:00.000Z' },
    ],
    generatedAt: '2026-11-06T00:00:00.000Z',
  }
}

const METRICS: SystemMapMetricFact[] = [
  metric({ id: 'lemeng:retail:net_sales', title: '净销售额', entity: 'branch', source: 'l1' }),
  metric({
    id: 'lemeng:retail:orphan',
    title: '孤儿指标',
    entity: null,
    source: 'l1',
    selectSql: 'select sum(fct_retail_sale.sale_amount) as value from fct_retail_sale',
  }),
  metric({
    id: 'l2_self_built',
    title: '自建指标',
    entity: null,
    source: 'l2',
    basis: 'l1_tree',
    selectSql: 'select sum(fct_retail_sale.net_amount) as value from fct_retail_sale',
  }),
  metric({
    id: 'private_metric',
    title: '私有测度',
    entity: null,
    source: 'l2',
    basis: 'column_agg',
    selectSql: 'select sum(fct_retail_sale.sale_amount) as value from fct_retail_sale',
  }),
]

describe('buildSystemMapModel：健康卡片', () => {
  it('指标分层 / 实体覆盖 / 对账覆盖 / 零使用 / 未消解需求逐项正确', () => {
    const model = buildSystemMapModel(baseInput(METRICS))
    expect(model.health).toEqual({
      totalMetrics: 4,
      l1Metrics: 2,
      l2Metrics: 1,
      privateMetrics: 1,
      entityBound: 1,
      entityCoveragePct: 25,
      auditCovered: 1,
      auditCoveragePct: 25,
      zeroUsageMetrics: 3,
      unresolvedDemands: 2,
    })
  })

  it('空词表不除零：覆盖率 0，不产生 NaN', () => {
    const model = buildSystemMapModel({ ...baseInput([]), metrics: [] })
    expect(model.health.entityCoveragePct).toBe(0)
    expect(model.health.auditCoveragePct).toBe(0)
    expect(Number.isNaN(model.health.entityCoveragePct)).toBe(false)
  })
})

describe('buildSystemMapModel：孤儿指标 / 实体 / 数据源 / 回溯链', () => {
  const model = buildSystemMapModel(baseInput(METRICS))

  it('未绑定实体或源关系不在模型图的指标被列为孤儿，并给出原因', () => {
    expect(model.orphans.map((o) => o.id).sort()).toEqual([
      'l2_self_built',
      'lemeng:retail:orphan',
      'private_metric',
    ])
    expect(model.orphans.find((o) => o.id === 'lemeng:retail:orphan')?.reasons).toContain('未绑定实体')
  })

  it('实体分组带上 YAML 标签与同义词，并挂上指标与关系', () => {
    const branch = model.entities.find((e) => e.name === 'branch')
    expect(branch).toMatchObject({
      label: '门店',
      synonyms: ['店铺', '分店'],
      metricIds: ['lemeng:retail:net_sales'],
      relations: ['fct_retail_sale'],
    })
  })

  it('数据源关系聚合引用指标，并带两层上游链与契约', () => {
    const src = model.sources.find((s) => s.name === 'fct_retail_sale')
    expect(src?.metricIds.sort()).toEqual([
      'l2_self_built',
      'lemeng:retail:net_sales',
      'lemeng:retail:orphan',
      'private_metric',
    ])
    expect(src?.upstream).toEqual([
      {
        name: 'stg_lemeng_retail_order_line',
        depth: 1,
        path: 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql',
        contracts: ['lemeng.retail_order_line'],
      },
    ])
    expect(src?.contracts, 'marts 本身无契约时应透出上游 staging 匹配到的契约').toEqual([
      'lemeng.retail_order_line',
    ])
  })

  it('指标回溯链：指标 → 实体 → 关系 → 上游模型 → 契约', () => {
    const m = model.metrics.find((x) => x.id === 'lemeng:retail:net_sales')
    expect(m?.trace).toEqual({
      metric: 'lemeng:retail:net_sales',
      entity: 'branch',
      relation: 'fct_retail_sale',
      model: 'fct_retail_sale',
      modelPath: 'dbt/models/lemeng/marts/fct_retail_sale.sql',
      upstream: [{
        name: 'stg_lemeng_retail_order_line',
        depth: 1,
        path: 'dbt/models/lemeng/staging/stg_lemeng_retail_order_line.sql',
        contracts: ['lemeng.retail_order_line'],
      }],
      contracts: ['lemeng.retail_order_line'],
    })
    expect(m?.auditFile).toBe('audit_lemeng__retail__net_sales.sql')
    expect(m?.auditExists).toBe(true)
    expect(m?.usage30d).toBe(7)
  })
})

describe('渲染：中文标题与 XSS 转义', () => {
  it('HTML 含关键中文标题与数据脚本', () => {
    const html = renderSystemMapHtml(buildSystemMapModel(baseInput(METRICS)))
    for (const title of ['数据体系地图', '总览', '指标', '实体', '数据源', '需求台账', '回溯链']) {
      expect(html).toContain(title)
    }
    expect(html).toContain('<script type="application/json" id="system-map-data">')
    // 零 CDN：页面不引用任何外部资源
    expect(html).not.toContain('http://')
    expect(html).not.toContain('https://')
  })

  it('恶意 definition（含 </script>）在嵌入 JSON 里被转义，不能逃逸脚本块', () => {
    const input = baseInput(METRICS)
    input.semantics = {
      entities: new Map([['branch', { label: '门店', synonyms: [] }]]),
      metrics: new Map([[
        'lemeng:retail:net_sales',
        {
          label: '净销售额',
          definition: '</script><script>alert("xss")</script>',
          expression: 'sum(fct_retail_sale.net_amount)',
          grain: [],
          entity: 'branch',
          synonyms: [],
          unit: null,
          owner: null,
          tier: null,
        },
      ]]),
    }
    const html = renderSystemMapHtml(buildSystemMapModel(input))
    expect(html).not.toContain('<script>alert("xss")</script>')
    expect(html).not.toContain('</script><script>alert')
    expect(html).toContain('\\u003c/script\\u003e\\u003cscript\\u003ealert')
  })

  it('escapeJsonForScript 同时处理 & < > 与 U+2028/U+2029', () => {
    const out = escapeJsonForScript({ text: '&<>' + '\u2028' + '\u2029' })
    expect(out).toContain('\\u0026')
    expect(out).toContain('\\u003c')
    expect(out).toContain('\\u003e')
    expect(out).toContain('\\u2028')
    expect(out).toContain('\\u2029')
    // 仍是合法 JSON
    expect(JSON.parse(out)).toEqual({ text: '&<>' + '\u2028' + '\u2029' })
  })
})

describe('解析器', () => {
  it('parseSelectSql 拆出表达式 / 维度 / 关系（支持 schema 限定与引号）', () => {
    expect(parseSelectSql('select sum(fct.x) as value, a, b from dbt.fct_retail_sale')).toEqual({
      expression: 'sum(fct.x)',
      dimensions: ['a', 'b'],
      relation: 'dbt.fct_retail_sale',
    })
    expect(parseSelectSql('select 1 as value from "fct_x"')).toEqual({
      expression: '1',
      dimensions: [],
      relation: 'fct_x',
    })
    expect(parseSelectSql('not sql')).toEqual({ expression: '', dimensions: [], relation: '' })
  })

  it('parseSelectSql 兼容 L2 expr 的嵌套产物（取内层真实关系）', () => {
    const sql = 'select sum(t.value) as value from (select sum(fct_retail_sale.net_amount) as value from fct_retail_sale) t'
    expect(parseSelectSql(sql)).toEqual({
      expression: 'sum(t.value)',
      dimensions: [],
      relation: 'fct_retail_sale',
    })
  })

  it('parseSystemMapSemantics 对坏 YAML 不抛（空结构）', () => {
    expect(parseSystemMapSemantics('metrics: [oops').metrics.size).toBe(0)
    expect(parseSystemMapSemantics(null).entities.size).toBe(0)
  })
})
