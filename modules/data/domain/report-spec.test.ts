import { describe, expect, it } from 'vitest'
import { parseReportSpec, MAX_PANELS, MAX_TEXT } from './report-spec'

const ok = {
  panels: [{
    chart: 'line', title: '净销售额趋势', metricId: 'lemeng:retail:net_sales',
    dims: ['bizday'], args: { system_book: '3120' }, span: 12, timeScoped: true,
  }],
}

describe('报表规格（严格白名单）', () => {
  it('合法规格通过', () => {
    // ⚠️ 夹具必须**把 zod 默认值写全**（dims/args/span）：schema 里它们有 `.default()`，
    //    解析结果会补齐 ⇒ 拿一个缺省的夹具去做 `toEqual` 必红（这是实施时最容易踩的一步）。
    expect(parseReportSpec(ok)).toEqual({ ok: true, spec: ok })
  })

  it('★ 白名单外的键一律拒（含可执行字段）——spec §3⑥ 的实测回归', () => {
    for (const extra of [
      { selectSql: 'select 1' },                    // 可执行内容
      { panels: [{ ...ok.panels[0], script: 'alert(1)' }] },
      { panels: [{ ...ok.panels[0], args: { x: 1 } }], extra: true },
    ]) {
      const out = parseReportSpec({ ...ok, ...extra })
      expect(out.ok).toBe(false)
      expect(out.ok === false && out.code).toBe('INVALID_SPEC')
    }
  })

  it('★ 图型必须在白名单里（未知图型给专门码，便于前端出人话）', () => {
    const out = parseReportSpec({ panels: [{ ...ok.panels[0], chart: 'sankey3d' }] })
    expect(out).toEqual({ ok: false, code: 'UNKNOWN_CHART_TYPE' })
  })

  it('args 放行 date_range 窗口对象（{from,to}），坏对象拒（#1047 报表页日期窗）', () => {
    // 合法档：bizday 窗口与 /query 参数面同形（rangeLiteral 在查询侧校验形状/顺序）
    const windowed = {
      panels: [{
        ...ok.panels[0],
        args: { system_book: '3120', bizday: { from: '2026-10-01', to: '2026-10-19' } },
      }],
    }
    expect(parseReportSpec(windowed).ok).toBe(true)
    // 坏档：外壳不符（缺 to / 多余键）一律 INVALID_SPEC——值合法性的单一事实源在 /query
    for (const bad of [{ from: '2026-10-01' }, { from: '2026-10-01', to: '2026-10-19', till: 'x' }]) {
      const out = parseReportSpec({ panels: [{ ...ok.panels[0], args: { bizday: bad } }] })
      expect(out.ok).toBe(false)
    }
  })

  it('面板数与字段长度有上限（体量闸）', () => {
    const many = { panels: Array.from({ length: MAX_PANELS + 1 }, () => ok.panels[0]) }
    expect(parseReportSpec(many)).toEqual({ ok: false, code: 'SPEC_TOO_LARGE' })
  })
})

const base = { system_book: '3120', branch_num: '92', bizday: { from: '2026-10-01', to: '2026-10-19' } }

describe('B+C schema', () => {
  it('period 三种模式通过；month/custom 缺参拒', () => {
    const ok = { period: { mode: 'month', month: '2026-10' }, panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: base, span: 24 }] }
    expect(parseReportSpec(ok).ok).toBe(true)
    expect(parseReportSpec({ ...ok, period: { mode: 'month' } }).ok).toBe(false)
    expect(parseReportSpec({ ...ok, period: { mode: 'custom', from: '2026-10-19', to: '2026-10-01' } }).ok).toBe(false)
  })

  it('kpi 通过；compare 只能出现在 kpi', () => {
    const kpi = { chart: 'kpi', title: '客单价', metricId: 'm1', denominatorMetricId: 'm2', format: 'currency', compare: 'prev_month', span: 12 }
    const spec = { panels: [kpi] }
    expect(parseReportSpec(spec).ok).toBe(true)
    const bad = { panels: [{ chart: 'line', title: 't', metricId: 'm', dims: [], args: {}, span: 24, compare: 'prev_month' }] }
    expect(parseReportSpec(bad).ok).toBe(false)
  })

  it('text 通过；超长/带 metricId 拒', () => {
    expect(parseReportSpec({ panels: [{ chart: 'text', content: '本月结论', span: 24 }] }).ok).toBe(true)
    expect(parseReportSpec({ panels: [{ chart: 'text', content: 'x'.repeat(MAX_TEXT + 1), span: 24 }] }).ok).toBe(false)
    expect(parseReportSpec({ panels: [{ chart: 'text', content: 'x', metricId: 'm', span: 24 }] }).ok).toBe(false)
  })

  it('slice 只在 line/bar/table；kpi 带 slice 拒', () => {
    const table = { chart: 'table', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 24, slice: { dimensions: ['bizday'], orderBy: [{ column: 'bizday', dir: 'asc' }], limit: 100 } }
    expect(parseReportSpec({ panels: [table] }).ok).toBe(true)
    const kpi = { chart: 'kpi', title: 't', metricId: 'm', format: 'number', slice: {}, span: 12 }
    expect(parseReportSpec({ panels: [kpi] }).ok).toBe(false)
  })

  it('columns 只在 table：非空、唯一；其它图型带 columns 拒', () => {
    const table = {
      chart: 'table', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 24,
      columns: ['bizday', 'value'],
    }
    expect(parseReportSpec({ panels: [table] }).ok).toBe(true)
    expect(parseReportSpec({ panels: [{ ...table, columns: [] }] }).ok).toBe(false)
    expect(parseReportSpec({ panels: [{ ...table, columns: ['value', 'value'] }] }).ok).toBe(false)
    expect(parseReportSpec({
      panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 24, columns: ['value'] }],
    }).ok).toBe(false)
  })

  it('旧规格仍通过（默认值补齐）', () => {
    const old = { panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 12 }] }
    expect(parseReportSpec(old).ok).toBe(true)
  })
})

describe('ai_text（AI 生成文本组件，v1 只有 focus=overview）', () => {
  const period = { mode: 'custom' as const, from: '2026-10-01', to: '2026-10-19' }
  const ai = { chart: 'ai_text' as const, title: '本月结论', focus: 'overview' as const, span: 24 }
  const line = {
    chart: 'line' as const, title: '趋势', metricId: 'lemeng:retail:net_sales',
    dims: ['bizday'], args: { branch_num: '92' }, span: 24, timeScoped: true,
  }

  it('ai_text 通过；focus 越界给 UNKNOWN_AI_FOCUS（与未知图型区分开）', () => {
    expect(parseReportSpec({ period, panels: [ai, line] }).ok).toBe(true)
    expect(parseReportSpec({ period, panels: [{ ...ai, focus: 'cost' }, line] }))
      .toEqual({ ok: false, code: 'UNKNOWN_AI_FOCUS' })
  })

  it('ai_text 带未知键 ⇒ INVALID_SPEC（白名单不放宽）', () => {
    expect(parseReportSpec({ period, panels: [{ ...ai, content: 'x' }, line] }))
      .toEqual({ ok: false, code: 'INVALID_SPEC' })
  })
})
