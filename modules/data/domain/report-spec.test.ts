import { describe, expect, it } from 'vitest'
import { parseReportSpec, MAX_PANELS } from './report-spec'

const ok = {
  panels: [{
    chart: 'line', title: '净销售额趋势', metricId: 'lemeng:retail:net_sales',
    dims: ['bizday'], args: { system_book: '3120' }, span: 12,
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
