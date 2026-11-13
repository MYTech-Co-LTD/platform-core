// report-spec-v2.test.ts — IR v2（V1）：解析、扁平化等价、筛选未支持时拒绝。
import { describe, expect, it } from 'vitest'
import { parseReportInput, parseReportSpec } from './report-spec'

const v2 = (over: Record<string, unknown> = {}) => ({
  ir: 2,
  period: { mode: 'last_7_days' },
  datasets: [{ key: 'sales', metricId: 'm:sales', args: { branch_num: '92' } }],
  blocks: [
    { type: 'kpi', dataset: 'sales', title: '营业额', format: 'currency' },
    { type: 'chart', chart: 'line', dataset: 'sales', title: '趋势' },
  ],
  ...over,
})

/** 与 v2 等价的 v1：扁平化后必须逐字段相等（DOM 快照等价的结构基础）。 */
const v1 = (over: Record<string, unknown> = {}) => ({
  period: { mode: 'last_7_days' },
  panels: [
    { chart: 'kpi', title: '营业额', metricId: 'm:sales', format: 'currency', args: { branch_num: '92' } },
    { chart: 'line', title: '趋势', metricId: 'm:sales', dims: [], args: { branch_num: '92' } },
  ],
  ...over,
})

describe('IR v2：解析与扁平化等价', () => {
  const cases: Array<{ name: string; v2: unknown; v1: unknown }> = [
    { name: 'kpi + line 共用数据集', v2: v2(), v1: v1() },
    {
      name: 'kpi 带对比与方向',
      v2: v2({ blocks: [{ type: 'kpi', dataset: 'sales', title: '营业额', format: 'currency', compare: 'prev_month', compareYoY: true, goodDirection: 'up', span: 8 }] }),
      v1: v1({ panels: [{ chart: 'kpi', title: '营业额', metricId: 'm:sales', format: 'currency', args: { branch_num: '92' }, compare: 'prev_month', compareYoY: true, goodDirection: 'up', span: 8 }] }),
    },
    {
      name: '图表带 slice 与同比',
      v2: v2({ blocks: [{ type: 'chart', chart: 'bar', dataset: 'sales', title: '趋势', compare: 'prev_period', compareYoY: true, slice: { dimensions: ['bizday'], limit: 10 } }] }),
      v1: v1({ panels: [{ chart: 'bar', title: '趋势', metricId: 'm:sales', dims: [], args: { branch_num: '92' }, compare: 'prev_period', compareYoY: true, slice: { dimensions: ['bizday'], limit: 10 } }] }),
    },
    {
      name: '数据集 dims 传给表格；块内 dims 覆盖',
      v2: {
        ir: 2,
        datasets: [{ key: 'd', metricId: 'm:sales', dims: ['bizday'] }],
        blocks: [
          { type: 'table', dataset: 'd', title: '按日' },
          { type: 'table', dataset: 'd', title: '按店', dims: ['branch_num'] },
        ],
      },
      v1: { panels: [
        { chart: 'table', title: '按日', metricId: 'm:sales', dims: ['bizday'], args: {} },
        { chart: 'table', title: '按店', metricId: 'm:sales', dims: ['branch_num'], args: {} },
      ] },
    },
    {
      name: 'text markdown 透传',
      v2: { ir: 2, datasets: [{ key: 'x', metricId: 'm:sales' }], blocks: [{ type: 'text', content: '**说明**', format: 'markdown' }] },
      v1: { panels: [{ chart: 'text', content: '**说明**', format: 'markdown' }] },
    },
    {
      name: 'ai_text + 数据块',
      v2: {
        ir: 2, period: { mode: 'day', day: '2026-11-09' },
        datasets: [{ key: 's', metricId: 'm:sales' }],
        blocks: [
          { type: 'kpi', dataset: 's', title: '营业额', format: 'currency' },
          { type: 'ai_text', title: '分析', focus: 'daily_review' },
        ],
      },
      v1: {
        period: { mode: 'day', day: '2026-11-09' },
        panels: [
          { chart: 'kpi', title: '营业额', metricId: 'm:sales', format: 'currency', args: {} },
          { chart: 'ai_text', title: '分析', focus: 'daily_review' },
        ],
      },
    },
    {
      name: '数据集 timeScoped=false',
      v2: { ir: 2, datasets: [{ key: 's', metricId: 'm:sales', timeScoped: false }], blocks: [{ type: 'table', dataset: 's', title: '排行' }] },
      v1: { panels: [{ chart: 'table', title: '排行', metricId: 'm:sales', dims: [], args: {}, timeScoped: false }] },
    },
    {
      name: '两个数据集',
      v2: {
        ir: 2,
        datasets: [{ key: 'a', metricId: 'm:sales' }, { key: 'b', metricId: 'm:orders' }],
        blocks: [
          { type: 'kpi', dataset: 'a', title: '营业额', format: 'currency' },
          { type: 'kpi', dataset: 'b', title: '订单', format: 'number' },
        ],
      },
      v1: { panels: [
        { chart: 'kpi', title: '营业额', metricId: 'm:sales', format: 'currency', args: {} },
        { chart: 'kpi', title: '订单', metricId: 'm:orders', format: 'number', args: {} },
      ] },
    },
    {
      name: '块顺序即面板顺序',
      v2: {
        ir: 2,
        datasets: [{ key: 's', metricId: 'm:sales' }],
        blocks: [
          { type: 'text', content: '先说明' },
          { type: 'kpi', dataset: 's', title: '营业额', format: 'currency' },
        ],
      },
      v1: { panels: [
        { chart: 'text', content: '先说明' },
        { chart: 'kpi', title: '营业额', metricId: 'm:sales', format: 'currency', args: {} },
      ] },
    },
    {
      name: '无 period 的 v2',
      v2: { ir: 2, filters: undefined, datasets: [{ key: 's', metricId: 'm:sales' }], blocks: [{ type: 'kpi', dataset: 's', title: '销售额', format: 'number' }] },
      v1: { panels: [{ chart: 'kpi', title: '销售额', metricId: 'm:sales', format: 'number', args: {} }] },
    },
  ]

  for (const c of cases) {
    it(c.name, () => {
      const parsed = parseReportInput(c.v2)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) return
      expect(parsed.ir).toBe(2)
      const expected = parseReportSpec(c.v1)
      expect(expected.ok).toBe(true)
      if (!expected.ok) return
      expect(parsed.spec).toEqual(expected.spec)
    })
  }

  it('v1 输入仍走 v1 分支（ir=1）', () => {
    const parsed = parseReportInput(v1())
    expect(parsed).toMatchObject({ ok: true, ir: 1 })
  })

  it('非空 filters ⇒ IR_V2_FILTERS_UNSUPPORTED（V4 前不静默丢）', () => {
    const parsed = parseReportInput({
      ir: 2, datasets: [{ key: 's', metricId: 'm:sales' }],
      blocks: [{ type: 'kpi', dataset: 's', title: 'x', format: 'number' }],
      filters: [{ key: 'branch', column: 'branch_num', label: '门店', type: 'string' }],
    })
    expect(parsed).toEqual({ ok: false, code: 'IR_V2_FILTERS_UNSUPPORTED' })
  })

  it('未知数据集引用 ⇒ INVALID_SPEC', () => {
    const parsed = parseReportInput({
      ir: 2, datasets: [{ key: 's', metricId: 'm:sales' }],
      blocks: [{ type: 'kpi', dataset: 'nope', title: 'x', format: 'number' }],
    })
    expect(parsed).toEqual({ ok: false, code: 'INVALID_SPEC' })
  })

  it('v1/v2 键混用 ⇒ INVALID_SPEC（v2 strict 拒 panels；v1 strict 拒 ir）', () => {
    expect(parseReportInput({ ir: 2, panels: [], datasets: [{ key: 's', metricId: 'm' }], blocks: [{ type: 'text', content: 'x' }] }).ok).toBe(false)
    expect(parseReportSpec({ ir: 2, panels: [] }).ok).toBe(false)
  })
})
