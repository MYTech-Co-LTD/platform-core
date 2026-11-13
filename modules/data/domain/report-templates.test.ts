// report-templates.test.ts — 模板槽位（R2）：必填/可选/未知槽与 schema 收口。
import { describe, expect, it } from 'vitest'
import { compileTemplate, REPORT_TEMPLATES, templateById } from './report-templates'
import { lintReportSpec } from './report-lint'

const daily = templateById('daily_ops')!

describe('compileTemplate', () => {
  it('必填槽齐 ⇒ 产出合法 spec，且通过语义 lint', () => {
    const out = compileTemplate(daily, { revenue: 'm:sales', orders: 'm:orders', trend: 'm:sales' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.spec.panels.map((p) => p.chart)).toEqual(['kpi', 'kpi', 'line', 'ai_text'])
    expect(out.spec.period).toEqual({ mode: 'last_7_days' })
    expect(lintReportSpec(out.spec)).toEqual([])
  })

  it('可选槽留空 ⇒ 省略该面板（不给残缺面板）', () => {
    const out = compileTemplate(daily, { revenue: 'm:sales', orders: 'm:orders', trend: 'm:sales' })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.spec.panels.filter((p) => p.chart === 'kpi')).toHaveLength(2)
  })

  it('缺必填槽 ⇒ 失败并列出键', () => {
    const out = compileTemplate(daily, { revenue: 'm:sales' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('MISSING_REQUIRED_SLOT')
    expect(out.keys).toEqual(['orders', 'trend'])
  })

  it('未知槽 ⇒ 失败（防拼写错误静默丢失）', () => {
    const out = compileTemplate(daily, {
      revenue: 'm:sales', orders: 'm:orders', trend: 'm:sales', revenu: 'm:x',
    })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('UNKNOWN_SLOT')
    expect(out.keys).toEqual(['revenu'])
  })

  it('内置模板本身都能用最小填法编译（防止模板与 schema 漂移）', () => {
    for (const t of REPORT_TEMPLATES) {
      const values = Object.fromEntries(
        t.slots.filter((s) => s.chart !== 'ai_text').map((s) => [s.key, 'm:x']),
      )
      const out = compileTemplate(t, values)
      expect(out.ok, `模板 ${t.id} 编译失败：${out.ok ? '' : out.reason}`).toBe(true)
    }
  })
})
