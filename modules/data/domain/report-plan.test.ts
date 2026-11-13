// report-plan.test.ts — V0：v1 → plan 规范化与逐面板读取逐字段一致。
import { describe, expect, it } from 'vitest'
import { toReportPlan } from './report-plan'
import { parseReportSpec } from './report-spec'

const specOf = (raw: unknown) => {
  const p = parseReportSpec(raw)
  if (!p.ok) throw new Error(p.code)
  return p.spec
}

const SPEC = {
  period: { mode: 'last_7_days' as const },
  panels: [
    { chart: 'kpi', title: '营业额', metricId: 'm:sales', format: 'currency', args: { branch_num: '92' } },
    { chart: 'line', title: '趋势', metricId: 'm:sales', dims: ['bizday'], args: { branch_num: '92' } },
    { chart: 'table', title: '明细', metricId: 'm:orders', dims: ['bizday'] },
    { chart: 'text', content: '**说明**', format: 'markdown' },
    { chart: 'ai_text', title: '分析', focus: 'overview' },
  ],
}

describe('toReportPlan（v1）', () => {
  it('面板顺序与 panelIndex 一一对应；数据面板各有匿名数据集', () => {
    const plan = toReportPlan(specOf(SPEC))
    expect(plan.panels.map((p) => p.index)).toEqual([0, 1, 2, 3, 4])
    expect(plan.panels.map((p) => p.kind)).toEqual(['kpi', 'line', 'table', 'text', 'ai_text'])
    expect(plan.datasets.map((d) => d.key)).toEqual(['p0', 'p1', 'p2'])
    expect(plan.panels.map((p) => p.datasetKey)).toEqual(['p0', 'p1', 'p2', null, null])
  })

  it('数据集字段与原面板逐字段一致（metricId/dims/args/timeScoped）', () => {
    const spec = specOf(SPEC)
    const plan = toReportPlan(spec)
    for (const p of plan.panels) {
      if (p.datasetKey === null) continue
      const panel = spec.panels[p.index]!
      if (!('metricId' in panel)) throw new Error('fixture')
      const ds = plan.datasets.find((d) => d.key === p.datasetKey)!
      expect(ds.metricId).toBe(panel.metricId)
      expect(ds.dims).toEqual('dims' in panel ? (panel.dims ?? []) : [])
      expect(ds.args).toEqual(panel.args ?? {})
      expect(ds.timeScoped).toBe(panel.timeScoped !== false)
    }
  })

  it('期间透传；v1 没有 filters', () => {
    const plan = toReportPlan(specOf(SPEC))
    expect(plan.period).toEqual({ mode: 'last_7_days' })
    expect(plan.filters).toEqual([])
  })

  it('文本面板保留原始 panel（呈现字段不改写）', () => {
    const plan = toReportPlan(specOf(SPEC))
    const text = plan.panels[3]!
    expect(text.panel.chart).toBe('text')
    if (text.panel.chart === 'text') {
      expect(text.panel.content).toBe('**说明**')
      expect(text.panel.format).toBe('markdown')
    }
  })
})
