// report-review.test.ts — 审阅面纯核（R2）：diff 可定位 + 说明书口径 + lint 透传。
import { describe, expect, it } from 'vitest'
import type { MetricRow } from './metric-store'
import { buildReportReview } from './report-review'
import { parseReportSpec, type ReportSpec } from './report-spec'

const specOf = (raw: unknown): ReportSpec => {
  const p = parseReportSpec(raw)
  if (!p.ok) throw new Error(p.code)
  return p.spec
}

const catalog = [
  {
    id: 'm:sales', title: '净销售额', description: '销售金额 − 退货金额',
    unit: '元', certified: 'certified', bizDescription: null,
  },
  {
    id: 'm:orders', title: '订单数', description: '有效订单笔数',
    unit: '单', certified: 'draft', bizDescription: null,
  },
] as unknown as MetricRow[]

const panel = (over: Record<string, unknown> = {}) => ({
  chart: 'kpi', title: '销售额', metricId: 'm:sales', format: 'number',
  compare: 'none', goodDirection: 'none', span: 12, args: {}, ...over,
})

const base = (panels: unknown[], period: unknown = { mode: 'day', day: '2026-11-09' }) =>
  specOf({ period, panels })

describe('buildReportReview', () => {
  it('首次发布前：无基线 ⇒ diff 为 null；说明书带口径', () => {
    const r = buildReportReview(base([panel()]), null, catalog, '月报')
    expect(r.diff).toBeNull()
    expect(r.doc.metrics).toEqual([{
      id: 'm:sales', title: '净销售额', definition: '销售金额 − 退货金额',
      unit: '元', caliber: 'certified', panels: [0],
    }])
    expect(r.doc.panels[0]).toMatchObject({ chart: 'kpi', metricId: 'm:sales', metricTitle: '净销售额' })
  })

  it('改指标 ⇒ diff 点名 metricId 字段', () => {
    const r = buildReportReview(
      base([panel({ metricId: 'm:orders', title: '订单数' })]),
      base([panel()]),
      catalog, '月报', '月报',
    )
    expect(r.diff?.unchanged).toBe(false)
    expect(r.diff?.panels).toEqual([{ index: 0, change: 'changed', fields: ['metricId', 'title'] }])
  })

  it('增删面板与期间变更都能定位', () => {
    const r = buildReportReview(
      base([panel(), panel({ title: '第二张' })], { mode: 'month', month: '2026-11' }),
      base([panel()], { mode: 'day', day: '2026-11-09' }),
      catalog, '月报', '月报',
    )
    expect(r.diff?.panels).toEqual([{ index: 1, change: 'added' }])
    expect(r.diff?.periodChanged).toBeDefined()
  })

  it('标题变更进 diff；lint 与发布门同一份判据', () => {
    const draft = base([panel({ args: { bizday: { from: '2026-01-01', to: '2026-01-31' } } })])
    const r = buildReportReview(draft, base([panel()]), catalog, '新标题', '旧标题')
    expect(r.diff?.titleChanged).toEqual({ from: '旧标题', to: '新标题' })
    expect(r.lint.some((i) => i.code === 'PANEL_BIZDAY_OVERRIDDEN')).toBe(true)
  })

  it('内容一致 ⇒ unchanged（标题也一致时）', () => {
    const r = buildReportReview(base([panel()]), base([panel()]), catalog, '月报', '月报')
    expect(r.diff?.unchanged).toBe(true)
    expect(r.diff?.panels).toEqual([])
  })
})
