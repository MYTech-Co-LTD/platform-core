// report-scope.test.ts — 报表 requiredScope 派生的单测。纯函数，不连库。
import { describe, expect, it } from 'vitest'
import { deriveRequiredScope } from './report-scope'
import type { ReportSpec } from './report-spec'

/** 只造派生动得到的那两个字段——纯函数的入参故意收窄，别把整个 MetricDef 搬进来。 */
const cat = (...rows: Array<[string, string | null]>) =>
  rows.map(([id, requiredScope]) => ({ id, requiredScope }))

/** 面板只需要 `metricId`；其余字段填最小合法值（`ReportSpec` 的 schema 与派生无关）。 */
const spec = (...metricIds: string[]): ReportSpec =>
  ({
    panels: metricIds.map((metricId) => ({
      metricId, title: metricId, chart: 'table' as const, dims: [], args: {}, span: 12,
    })),
  }) as ReportSpec

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
})
