// report-lint.test.ts — 语义 lint 的结构判据（R2）。
import { describe, expect, it } from 'vitest'
import { lintBlocksPublish, lintReportSpec, type LintIssue } from './report-lint'
import { parseReportSpec, type ReportSpec } from './report-spec'

function specOf(raw: unknown): ReportSpec {
  const parsed = parseReportSpec(raw)
  if (!parsed.ok) throw new Error(`fixture 不合法: ${parsed.code}`)
  return parsed.spec
}

const kpi = (over: Record<string, unknown> = {}) => ({
  chart: 'kpi', title: '销售额', metricId: 'm:sales', format: 'number',
  compare: 'none', goodDirection: 'none', span: 12, args: {}, ...over,
})

const codes = (issues: LintIssue[]): string[] => issues.map((i) => i.code)

describe('lintReportSpec', () => {
  it('干净报表 ⇒ 无问题', () => {
    const spec = specOf({ period: { mode: 'day', day: '2026-11-09' }, panels: [kpi()] })
    expect(lintReportSpec(spec)).toEqual([])
  })

  it('面板自带 bizday + 报表 period ⇒ 错（会被静默覆盖）', () => {
    const spec = specOf({
      period: { mode: 'day', day: '2026-11-09' },
      panels: [kpi({ args: { bizday: { from: '2026-01-01', to: '2026-01-31' } } })],
    })
    const issues = lintReportSpec(spec)
    expect(codes(issues)).toContain('PANEL_BIZDAY_OVERRIDDEN')
    expect(issues[0]?.level).toBe('error')
    expect(lintBlocksPublish(issues)).toBe(true)
  })

  it('ai_text 没有数据面板 ⇒ 错（叙事无事实）', () => {
    // 写侧有结构闸，这里直接构造「绕过写侧」的形状来验证 lint 的兜底
    const spec = {
      panels: [{ chart: 'ai_text', title: '结论', focus: 'overview' }],
    } as unknown as ReportSpec
    const issues = lintReportSpec(spec)
    expect(codes(issues)).toContain('AI_WITHOUT_DATA')
    expect(lintBlocksPublish(issues)).toBe(true)
  })

  it('同名 KPI 指向不同指标 ⇒ warn（读者无法分辨）', () => {
    const spec = specOf({
      period: { mode: 'day', day: '2026-11-09' },
      panels: [kpi(), kpi({ metricId: 'm:gross', title: '销售额' })],
    })
    const issues = lintReportSpec(spec)
    const hit = issues.find((i) => i.code === 'DUPLICATE_KPI_TITLE')
    expect(hit?.level).toBe('warn')
    expect(hit?.panelIndexes).toEqual([0, 1])
    expect(lintBlocksPublish(issues)).toBe(false)
  })

  it('timeScoped=false 声明对比 ⇒ 错（对比无定义）', () => {
    const spec = specOf({
      period: { mode: 'day', day: '2026-11-09' },
      panels: [kpi({ timeScoped: false, compare: 'prev_period' })],
    })
    expect(codes(lintReportSpec(spec))).toContain('COMPARE_ON_NON_TIME_SCOPED')
  })

  it('没有 period 却有按时间的面板 ⇒ warn（观看时按昨天兜底）', () => {
    const spec = specOf({ panels: [kpi()] })
    const issues = lintReportSpec(spec)
    expect(codes(issues)).toContain('MISSING_PERIOD')
    expect(lintBlocksPublish(issues)).toBe(false)
  })
})
