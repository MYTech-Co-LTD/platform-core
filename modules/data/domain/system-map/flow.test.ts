// flow.test.ts — 全流程节点图组装（#2687）：分层、聚合、连线、坐标。
import { describe, expect, it } from 'vitest'
import { buildFlowGraph, FLOW_LAYERS, type FlowInput } from './flow'

const base: FlowInput = {
  contracts: [{ id: 'lemeng.retail_order_line', domain: 'lemeng', table: 'retail_order_line', prefix: 'lemeng/retail_order_line' }],
  pipelines: [
    { id: 'lemeng.retail_order_line.tick', lakeKeys: ['lemeng/retail_order_line/system_book=${B}/bizday=${D}/hour=${H}/all.parquet'] },
    { id: 'lemeng.retail_order_line.day', lakeKeys: ['lemeng/retail_order_line/system_book=${B}/bizday=${D}/all.parquet'] },
  ],
  staging: [{ name: 'stg_lemeng_retail_order_line', lakePrefix: 'lemeng/retail_order_line' }],
  marts: [{ name: 'fct_retail_sale', refs: ['stg_lemeng_retail_order_line'] }],
  metrics: [
    { id: 'sale_amount', title: '销售额', entity: 'sales', relations: ['fct_retail_sale'] },
    { id: 'net_amount', title: '净销售额', entity: 'sales', relations: ['fct_retail_sale'] },
  ],
}

describe('buildFlowGraph', () => {
  it('七层齐全，完整链路连通：源 → 管线 → 湖 → staging → mart → 指标 → 消费', () => {
    const g = buildFlowGraph(base)
    const byId = new Map(g.nodes.map((n) => [n.id, n]))
    expect(byId.get('src:lemeng.retail_order_line')?.kind).toBe('source')
    expect(byId.get('pipe:lemeng/retail_order_line')?.kind).toBe('pipeline')
    expect(byId.get('lake:lemeng/retail_order_line')?.kind).toBe('lake')
    expect(byId.get('stg:stg_lemeng_retail_order_line')?.kind).toBe('staging')
    expect(byId.get('mart:fct_retail_sale')?.kind).toBe('mart')
    expect(byId.get('met:sales')?.kind).toBe('metric')
    expect(byId.get('use:report')?.kind).toBe('consumer')

    const has = (s: string, t: string) => g.edges.some((e) => e.source === s && e.target === t)
    expect(has('src:lemeng.retail_order_line', 'pipe:lemeng/retail_order_line')).toBe(true)
    expect(has('pipe:lemeng/retail_order_line', 'lake:lemeng/retail_order_line')).toBe(true)
    expect(has('lake:lemeng/retail_order_line', 'stg:stg_lemeng_retail_order_line')).toBe(true)
    expect(has('stg:stg_lemeng_retail_order_line', 'mart:fct_retail_sale')).toBe(true)
    expect(has('mart:fct_retail_sale', 'met:sales')).toBe(true)
    expect(has('met:sales', 'use:report')).toBe(true)
  })

  it('同前缀的多条管线聚合为一个组节点（count=2，members 列出两条）', () => {
    const g = buildFlowGraph(base)
    const pipe = g.nodes.find((n) => n.id === 'pipe:lemeng/retail_order_line')
    expect(pipe?.count).toBe(2)
    expect(pipe?.members?.sort()).toEqual(['lemeng.retail_order_line.day', 'lemeng.retail_order_line.tick'])
  })

  it('指标按实体聚合（同实体两个指标 = 一个 ×2 节点）', () => {
    const g = buildFlowGraph(base)
    const met = g.nodes.find((n) => n.id === 'met:sales')
    expect(met?.count).toBe(2)
    expect(met?.members?.every((m) => m.includes('｜'))).toBe(true)
  })

  it('坐标：每层 x 固定（取自 FLOW_LAYERS），层内 y 递增', () => {
    const g = buildFlowGraph(base)
    for (const layer of FLOW_LAYERS) {
      const xs = new Set(g.nodes.filter((n) => n.kind === layer.kind).map((n) => n.x))
      expect([...xs]).toEqual([layer.x])
    }
    const stages = g.nodes.filter((n) => n.kind === 'staging').sort((a, b) => a.y - b.y)
    for (let i = 1; i < stages.length; i += 1) expect(stages[i].y).toBeGreaterThan(stages[i - 1].y)
  })

  it('空输入不崩：只有四个消费面节点，并给出「没有连线」的提示', () => {
    const g = buildFlowGraph({ contracts: [], pipelines: [], staging: [], marts: [], metrics: [] })
    expect(g.nodes.map((n) => n.kind)).toEqual(['consumer', 'consumer', 'consumer', 'consumer'])
    expect(g.edges).toEqual([])
    expect(g.notes.some((n) => n.includes('没有识别出任何连线'))).toBe(true)
  })

  it('管线湖 key 全含模板/无前缀 ⇒ 不上图并记 note（不伪造节点）', () => {
    const g = buildFlowGraph({
      ...base,
      pipelines: [{ id: 'weird', lakeKeys: ['${X}/${Y}'] }],
    })
    expect(g.nodes.some((n) => n.id === 'pipe:weird')).toBe(false)
    expect(g.notes.some((n) => n.includes('weird'))).toBe(true)
  })
})

describe('buildFlowGraph · 审计旁路与对账（#2687 追加）', () => {
  const withAudit: FlowInput = {
    ...base,
    marts: [
      { name: 'fct_retail_sale', refs: ['stg_lemeng_retail_order_line'] },
      { name: 'recon_fact', refs: ['fct_retail_sale'] },
    ],
    audits: [
      { id: 'audit_lemeng__retail__order_line', refs: ['stg_lemeng_retail_order_line'] },
      { id: 'audit_lemeng__retail__order_line_2', refs: ['stg_lemeng_retail_order_line'] },
      { id: 'audit_lemeng__unknown__thing', refs: ['nonexistent_model'] },
    ],
  }

  it('recon_* 归为 recon 类（与普通 mart 区分着色）', () => {
    const g = buildFlowGraph(withAudit)
    expect(g.nodes.find((n) => n.id === 'mart:recon_fact')?.kind).toBe('recon')
    expect(g.nodes.find((n) => n.id === 'mart:fct_retail_sale')?.kind).toBe('mart')
  })

  it('审计按被审对象聚合：同对象两条审计 = ×2，成员列出', () => {
    const g = buildFlowGraph(withAudit)
    const a = g.nodes.find((n) => n.id === 'audit:stg_lemeng_retail_order_line')
    expect(a?.kind).toBe('audit')
    expect(a?.count).toBe(2)
    expect(a?.members?.length).toBe(2)
  })

  it('审计边是虚线（旁路不是数据流），且被审对象 → 审计', () => {
    const g = buildFlowGraph(withAudit)
    const e = g.edges.find((x) => x.source === 'stg:stg_lemeng_retail_order_line' && x.target === 'audit:stg_lemeng_retail_order_line')
    expect(e?.style).toBe('dashed')
  })

  it('审计读了不在图上的对象 ⇒ 不画悬空节点', () => {
    const g = buildFlowGraph(withAudit)
    expect(g.nodes.some((n) => n.id === 'audit:nonexistent_model')).toBe(false)
  })

  it('审计节点排在主体下方（旁路泳道）', () => {
    const g = buildFlowGraph(withAudit)
    const mainMaxY = Math.max(...g.nodes.filter((n) => n.kind !== 'audit').map((n) => n.y))
    const auditY = Math.min(...g.nodes.filter((n) => n.kind === 'audit').map((n) => n.y))
    expect(auditY).toBeGreaterThan(mainMaxY)
  })

  it('recon 族虚线连到对账台账消费面', () => {
    const g = buildFlowGraph(withAudit)
    const e = g.edges.find((x) => x.source === 'mart:recon_fact' && x.target === 'use:recon')
    expect(e?.style).toBe('dashed')
  })
})
