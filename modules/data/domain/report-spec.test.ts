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
  it('period 四种模式通过；month/day/custom 缺参拒', () => {
    const ok = { period: { mode: 'month', month: '2026-10' }, panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: base, span: 24 }] }
    expect(parseReportSpec(ok).ok).toBe(true)
    expect(parseReportSpec({ ...ok, period: { mode: 'month' } }).ok).toBe(false)
    expect(parseReportSpec({ ...ok, period: { mode: 'day', day: '2026-10-13' } }).ok).toBe(true)
    expect(parseReportSpec({ ...ok, period: { mode: 'day' } }).ok).toBe(false)
    expect(parseReportSpec({ ...ok, period: { mode: 'custom', from: '2026-10-19', to: '2026-10-01' } }).ok).toBe(false)
  })

  it('kpi / line / bar 都可带 compare；非法枚举拒', () => {
    const kpi = { chart: 'kpi', title: '客单价', metricId: 'm1', denominatorMetricId: 'm2', format: 'currency', compare: 'prev_month', span: 12 }
    expect(parseReportSpec({ panels: [kpi] }).ok).toBe(true)
    const line = { chart: 'line', title: 't', metricId: 'm', dims: [], args: {}, span: 24, compare: 'prev_month', compareYoY: true }
    expect(parseReportSpec({ panels: [line] }).ok).toBe(true)
    const bad = { panels: [{ ...line, compare: 'last_year' }] }
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

  it('expandable（R3 ⑤）：table + 分组通过；无分组/非 table/越界 limit 拒', () => {
    const grouped = {
      chart: 'table', title: '门店销售', metricId: 'm', dims: ['branch_num'], args: {}, span: 24,
      slice: { dimensions: ['branch_num'] }, expandable: { limit: 20 },
    }
    expect(parseReportSpec({ panels: [grouped] }).ok).toBe(true)
    // 只有 dims（slice 没有 dimensions）也算分组——与 panelQueryBodyOf 同一回退顺序
    expect(parseReportSpec({ panels: [{ ...grouped, slice: {} }] }).ok).toBe(true)
    expect(parseReportSpec({ panels: [{ ...grouped, dims: [], slice: {} }] }).ok).toBe(false)
    expect(parseReportSpec({
      panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 24, expandable: {} }],
    }).ok).toBe(false)
    expect(parseReportSpec({ panels: [{ ...grouped, expandable: { limit: 501 } }] }).ok).toBe(false)
    expect(parseReportSpec({ panels: [{ ...grouped, expandable: { dimensions: ['order_no'] } }] }).ok).toBe(true)
  })

  it('多页（R3）：pages + 面板 page 通过；page 无 pages / 越界拒', () => {
    const p2 = { ...ok.panels[0], page: 2 }
    expect(parseReportSpec({
      pages: [{ title: '概览' }, { title: '明细' }], panels: [{ ...ok.panels[0], page: 1 }, p2],
    }).ok).toBe(true)
    // 只有 1 页也合法（= 单页报表，渲染不出现导航）
    expect(parseReportSpec({ pages: [{ title: '概览' }], panels: [ok.panels[0]] }).ok).toBe(true)
    // page 声明但没有 pages ⇒ 无处安放（写侧拒绝，不留到观看时静默丢失）
    expect(parseReportSpec({ panels: [{ ...ok.panels[0], page: 2 }] }).ok).toBe(false)
    // 越界页码 ⇒ 该面板永远不会显示
    expect(parseReportSpec({ pages: [{ title: 'a' }], panels: [{ ...ok.panels[0], page: 2 }] }).ok).toBe(false)
    // 页数上限
    expect(parseReportSpec({
      pages: Array.from({ length: 13 }, () => ({})), panels: [ok.panels[0]],
    }).ok).toBe(false)
  })

  it('文本 L2 引用（R3）：只能引用本报表已有的指标；语法必须合法', () => {
    const line = { chart: 'line', title: 't', metricId: 'm:sales', dims: ['bizday'], args: {}, span: 12 }
    const text = (content: string) => ({ chart: 'text', content, span: 24 })
    expect(parseReportSpec({ panels: [line, text('本期 {{metric:m:sales|fmt:currency}}')] }).ok).toBe(true)
    expect(parseReportSpec({ panels: [line, text('{{delta:m:sales|vs:prev_month}}')] }).ok).toBe(true)
    // 报表外的指标 ⇒ 拒（引用即授权面）
    expect(parseReportSpec({ panels: [line, text('{{metric:m:secret}}')] }).ok).toBe(false)
    // 语法/参数不合法 ⇒ 拒，不静默当文本
    expect(parseReportSpec({ panels: [line, text('{{metric:m:sales')] }).ok).toBe(false)
    expect(parseReportSpec({ panels: [line, text('{{metric:m:sales|nope:1}}')] }).ok).toBe(false)
  })

  it('旧规格仍通过（默认值补齐）', () => {
    const old = { panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 12 }] }
    expect(parseReportSpec(old).ok).toBe(true)
  })
})

describe('ai_text（AI 生成文本组件，focus=overview/root_cause/daily_review）', () => {
  const period = { mode: 'custom' as const, from: '2026-10-01', to: '2026-10-19' }
  const ai = { chart: 'ai_text' as const, title: '本月结论', focus: 'overview' as const, span: 24 }
  const line = {
    chart: 'line' as const, title: '趋势', metricId: 'lemeng:retail:net_sales',
    dims: ['bizday'], args: { branch_num: '92' }, span: 24, timeScoped: true,
  }

  it('ai_text 通过；focus 越界给 UNKNOWN_AI_FOCUS（与未知图型区分开）', () => {
    expect(parseReportSpec({ period, panels: [ai, line] }).ok).toBe(true)
    expect(parseReportSpec({ period, panels: [{ ...ai, focus: 'root_cause' }, line] }).ok).toBe(true)
    expect(parseReportSpec({ period, panels: [{ ...ai, focus: 'daily_review' }, line] }).ok).toBe(true)
    expect(parseReportSpec({ period, panels: [{ ...ai, focus: 'cost' }, line] }))
      .toEqual({ ok: false, code: 'UNKNOWN_AI_FOCUS' })
  })

  it('ai_text 带未知键 ⇒ INVALID_SPEC（白名单不放宽）', () => {
    expect(parseReportSpec({ period, panels: [{ ...ai, content: 'x' }, line] }))
      .toEqual({ ok: false, code: 'INVALID_SPEC' })
  })
})

describe('text 面板 format（R3）', () => {
  const parse = (panel: unknown) => parseReportSpec({ panels: [panel] })

  it('缺省 plain；显式 markdown 合法；未知格式拒', () => {
    const plain = parse({ chart: 'text', content: '说明' })
    expect(plain.ok).toBe(true)
    if (plain.ok) expect(plain.spec.panels[0]).toMatchObject({ chart: 'text', format: 'plain' })

    expect(parse({ chart: 'text', content: '**说明**', format: 'markdown' }).ok).toBe(true)
    expect(parse({ chart: 'text', content: '说明', format: 'html' }).ok).toBe(false)
  })
})

describe('cross_table（R3 组件①）', () => {
  const parse = (panel: unknown) => parseReportSpec({ panels: [panel] })
  const base = { chart: 'cross_table', title: '门店×品类', metricId: 'm:sales', rows: ['branch_name'], columns: 'category_name' }

  it('最少字段可解析；format 缺省 number、span 缺省 24', () => {
    const out = parse(base)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.spec.panels[0]).toMatchObject({ chart: 'cross_table', format: 'number', span: 24 })
  })

  it('行维度 1–2 个；0 或 3 个都拒', () => {
    expect(parse({ ...base, rows: [] }).ok).toBe(false)
    expect(parse({ ...base, rows: ['a', 'b', 'c'] }).ok).toBe(false)
    expect(parse({ ...base, rows: ['a', 'b'] }).ok).toBe(true)
  })

  it('未知键拒（白名单不放宽）', () => {
    expect(parse({ ...base, slice: { dimensions: ['x'] } }).ok).toBe(false)
  })
})

describe('waterfall（R3 组件②）', () => {
  const parse = (panel: unknown) => parseReportSpec({ panels: [panel] })
  const base = { chart: 'waterfall', title: '门店贡献', metricId: 'm:sales', dims: ['branch_name'] }

  it('缺省 compare=prev_period、format=number、span=24', () => {
    const out = parse(base)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.spec.panels[0]).toMatchObject({ chart: 'waterfall', compare: 'prev_period', format: 'number', span: 24 })
  })

  it('维度必须恰好 1 个', () => {
    expect(parse({ ...base, dims: [] }).ok).toBe(false)
    expect(parse({ ...base, dims: ['a', 'b'] }).ok).toBe(false)
  })
})

describe('bullet（R3 组件③）', () => {
  const parse = (panel: unknown) => parseReportSpec({ panels: [panel] })
  const base = { chart: 'bullet', title: '净毛利目标', metricId: 'm:net', target: 100000 }

  it('缺省 format=number、span=12', () => {
    const out = parse(base)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.spec.panels[0]).toMatchObject({ chart: 'bullet', format: 'number', span: 12 })
  })

  it('target 必填且有限', () => {
    expect(parse({ ...base, target: undefined }).ok).toBe(false)
    expect(parse({ ...base, target: Infinity }).ok).toBe(false)
  })
})

describe('sparkline（R3 组件④）', () => {
  const parse = (panel: unknown) => parseReportSpec({ panels: [panel] })
  const base = { chart: 'sparkline', title: '营业额趋势', metricId: 'm:sales' }

  it('缺省 compare=auto、format=number、span=6', () => {
    const out = parse(base)
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.spec.panels[0]).toMatchObject({ chart: 'sparkline', compare: 'auto', format: 'number', span: 6 })
  })

  it('timeScoped=false 可关期间注入（字典/排行快照场景）', () => {
    expect(parse({ ...base, timeScoped: false }).ok).toBe(true)
  })
})
