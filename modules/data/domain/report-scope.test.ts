// report-scope.test.ts — 报表写入侧校验的单测（requiredScope 派生 + 面板指标校验）。纯函数，不连库。
import { describe, expect, it } from 'vitest'
import { deriveRequiredScope, validatePanelMetrics } from './report-scope'
import type { ReportSpec } from './report-spec'

/**
 * 词表行只造校验用得到的四个字段——纯函数的入参故意收窄，别把整个 MetricDef 搬进来。
 * 默认 `totalable: true` / `sourceSystem: 'lemeng'`（最宽松的合法行），用例只显式声明例外。
 */
const cat = (...rows: Array<[string, string | null, (boolean | undefined)?, (string | null)?]>) =>
  rows.map(([id, requiredScope, totalable = true, sourceSystem = 'lemeng']) => ({
    id, requiredScope, totalable, sourceSystem,
  }))

/** 面板照 schema 造；与派生/校验无关的字段（args/compare…）刻意省略——本文件只测纯函数。 */
const specOf = (...panels: Array<Record<string, unknown>>): ReportSpec =>
  ({ panels } as unknown as ReportSpec)

/** 全是 table 面板的简写（既有派生用例只关心 metricId）。 */
const spec = (...metricIds: string[]): ReportSpec =>
  specOf(...metricIds.map((metricId) => ({
    metricId, title: metricId, chart: 'table', dims: [], args: {}, span: 12,
  })))

describe('deriveRequiredScope（spec §4.2）', () => {
  it('空面板 ⇒ null', () => {
    expect(deriveRequiredScope(spec(), cat())).toEqual({ ok: true, requiredScope: null })
  })

  it('面板指标都无 requiredScope ⇒ null', () => {
    expect(deriveRequiredScope(spec('a', 'b'), cat(['a', null], ['b', null])))
      .toEqual({ ok: true, requiredScope: null })
  })

  it('面板指标同一个码 ⇒ 该码', () => {
    expect(deriveRequiredScope(spec('a', 'b'), cat(['a', 'data:cost'], ['b', 'data:cost'])))
      .toEqual({ ok: true, requiredScope: 'data:cost' })
  })

  it('无码与有码混用 ⇒ 取那个码（无码的不放松限制）', () => {
    expect(deriveRequiredScope(spec('a', 'b'), cat(['a', null], ['b', 'data:cost'])))
      .toEqual({ ok: true, requiredScope: 'data:cost' })
  })

  it('两个不同码 ⇒ 拒绝并点名（单值列表达不了「都要有」）', () => {
    const r = deriveRequiredScope(spec('a', 'b'), cat(['a', 'data:cost'], ['b', 'data:margin']))
    expect(r.ok).toBe(false)
    // 按 `reason` 收窄（`ok` 不区分两种失败态，只判 `ok` 收不到 `scopes`）
    if (r.ok || r.reason !== 'CONFLICTING_PANEL_SCOPES') throw new Error('unreachable')
    expect(r.reason).toBe('CONFLICTING_PANEL_SCOPES')
    expect(r.scopes.sort()).toEqual(['data:cost', 'data:margin'])
  })

  it('面板指向不存在的指标 ⇒ 拒绝并点名 metricId', () => {
    const r = deriveRequiredScope(spec('ghost'), cat(['a', null]))
    expect(r.ok).toBe(false)
    if (r.ok || r.reason !== 'UNKNOWN_PANEL_METRIC') throw new Error('unreachable')
    expect(r.reason).toBe('UNKNOWN_PANEL_METRIC')
    expect(r.metricId).toBe('ghost')
  })

  it('text 面板不参与派生（它没有 metricId，不能当未知指标拒）', () => {
    expect(deriveRequiredScope(specOf({ chart: 'text', content: 'x', span: 24 }), cat()))
      .toEqual({ ok: true, requiredScope: null })
  })

  it('kpi 的分母指标同样参与派生（分母面板也要可见）', () => {
    expect(deriveRequiredScope(
      specOf({ chart: 'kpi', title: 't', metricId: 'sales', denominatorMetricId: 'cost', format: 'number', span: 12 }),
      cat(['sales', null], ['cost', 'data:cost']),
    )).toEqual({ ok: true, requiredScope: 'data:cost' })
  })

  it('kpi 分母指向不存在的指标 ⇒ 同样拒绝并点名（分母不是可跳过的脚注）', () => {
    const r = deriveRequiredScope(
      specOf({ chart: 'kpi', title: 't', metricId: 'sales', denominatorMetricId: 'ghost_cost', format: 'number', span: 12 }),
      cat(['sales', null]),
    )
    expect(r.ok).toBe(false)
    if (r.ok || r.reason !== 'UNKNOWN_PANEL_METRIC') throw new Error('unreachable')
    expect(r.metricId).toBe('ghost_cost')
  })
})

describe('validatePanelMetrics（写入侧可加性 / 源裁剪）', () => {
  const catRows = cat(
    ['sales', null, true, 'lemeng'],
    ['ratio', null, false, 'lemeng'],
    ['cost', 'data:cost', true, 'other'],
  )
  const adopted = new Set(['lemeng'])

  it('line/bar 用不可加指标 ⇒ 拒（图上求和会加出假数）', () => {
    expect(validatePanelMetrics(
      specOf({ chart: 'line', title: 't', metricId: 'ratio', dims: [], args: {}, span: 24 }),
      catRows, adopted,
    )).toEqual({ ok: false, reason: 'CHART_REQUIRES_ADDITIVE', metricId: 'ratio' })
  })

  it('table 用不可加指标 ⇒ 放行（明细不过合计）', () => {
    expect(validatePanelMetrics(
      specOf({ chart: 'table', title: 't', metricId: 'ratio', dims: [], args: {}, span: 24 }),
      catRows, adopted,
    )).toEqual({ ok: true })
  })

  it('kpi 用不可加指标 ⇒ 拒（大数字本身就是合计值）', () => {
    expect(validatePanelMetrics(
      specOf({ chart: 'kpi', title: 't', metricId: 'ratio', format: 'number', span: 12 }),
      catRows, adopted,
    )).toEqual({ ok: false, reason: 'KPI_NOT_TOTALABLE', metricId: 'ratio' })
  })

  it('指标所属源系统未接入 ⇒ 拒', () => {
    expect(validatePanelMetrics(
      specOf({ chart: 'table', title: 't', metricId: 'cost', dims: [], args: {}, span: 24 }),
      catRows, adopted,
    )).toEqual({ ok: false, reason: 'METRIC_SOURCE_NOT_ADOPTED', metricId: 'cost' })
  })

  it('指标不存在 ⇒ 拒并点名', () => {
    expect(validatePanelMetrics(
      specOf({ chart: 'table', title: 't', metricId: 'ghost', dims: [], args: {}, span: 24 }),
      catRows, adopted,
    )).toEqual({ ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: 'ghost' })
  })

  it('text 面板跳过；可加且源已接入 ⇒ 通过', () => {
    expect(validatePanelMetrics(
      specOf(
        { chart: 'text', content: 'x', span: 24 },
        { chart: 'bar', title: 't', metricId: 'sales', dims: [], args: {}, span: 12 },
      ),
      catRows, adopted,
    )).toEqual({ ok: true })
  })
})

describe('ai_text 的写侧结构闸（必须有数据面板 + 报表期间）', () => {
  const period = { mode: 'custom' as const, from: '2026-10-01', to: '2026-10-19' }
  const ai = { chart: 'ai_text' as const, title: '结论', focus: 'overview' as const, span: 24 }
  const line = { chart: 'line' as const, title: '趋势', metricId: 'sales', dims: [], args: {}, span: 24, timeScoped: true }
  const catRows = cat(['sales', null, true, 'lemeng'])
  const adopted = new Set(['lemeng'])

  it('ai_text 无数据面板 ⇒ AI_TEXT_REQUIRES_DATA_PANEL（没有事实可依据）', () => {
    expect(validatePanelMetrics(specOf(ai), catRows, adopted))
      .toEqual({ ok: false, reason: 'AI_TEXT_REQUIRES_DATA_PANEL' })
  })

  it('ai_text 无 report period ⇒ AI_TEXT_REQUIRES_PERIOD（不知道说哪段时间）', () => {
    expect(validatePanelMetrics(specOf(ai, line), catRows, adopted))
      .toEqual({ ok: false, reason: 'AI_TEXT_REQUIRES_PERIOD' })
  })

  it('ai_text + 数据面板 + period 通过；且不引入任何 scope', () => {
    const spec = { ...specOf(ai, line), period }
    expect(validatePanelMetrics(spec, catRows, adopted)).toEqual({ ok: true })
    expect(deriveRequiredScope(spec, catRows)).toEqual({ ok: true, requiredScope: null })
  })
})
