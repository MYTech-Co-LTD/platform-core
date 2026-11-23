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
        t.slots.flatMap((s) => {
          if (s.chart === 'ai_text') return []
          // 宽表槽：列键各填一条不同指标（同 id 会撞 DUPLICATE_MEASURE）
          if (s.measures !== undefined) return s.measures.map((m) => [m.key, `m:${m.key}`])
          return [[s.key, 'm:x']]
        }),
      )
      const out = compileTemplate(t, values)
      expect(out.ok, `模板 ${t.id} 编译失败：${out.ok ? '' : out.reason}`).toBe(true)
    }
  })
})

describe('目标达成模板（件② #2708 / C2）', () => {
  const goal = templateById('goal_achievement')!

  it('槽位形状：双 KPI + 按门店达标表（target=1 着色）+ 节奏 + 分析', () => {
    expect(goal.slots.map((s) => s.chart)).toEqual(['kpi', 'kpi', 'table', 'line', 'ai_text'])
    const table = goal.slots.find((s) => s.key === 'by_store')!
    expect(table.dims).toEqual(['branch_num'])
    const sale = table.measures!.find((m) => m.key === 'sale_rate')!
    expect(sale).toMatchObject({ target: 1, colorSemantics: 'target', format: 'percent', required: true })
  })

  it('编译 → 合法 spec，且 target/colorSemantics 透传到宽表列（不是模板层的死字段）', () => {
    const out = compileTemplate(goal, {
      achievement: 'lemeng:goal:monthly_store_sale_sale_achievement_rate',
      progress: 'lemeng:goal:monthly_store_sale_sale_progress_rate',
      sale_rate: 'lemeng:goal:monthly_store_sale_sale_achievement_rate',
      outbound_rate: 'lemeng:goal:monthly_store_sale_outbound_achievement_rate',
      pace: 'lemeng:goal:monthly_store_sale_sale_progress_rate',
      rhythm: 'lemeng:goal:monthly_store_sale_sale_achievement_rate',
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // 无默认期间只会得到 MISSING_PERIOD（warn）；不许有 error 级问题
    expect(lintReportSpec(out.spec).filter((i) => i.level === 'error')).toEqual([])
    const table = out.spec.panels.find((p) => p.chart === 'table')!
    expect(table.measures![0]).toMatchObject({ target: 1, colorSemantics: 'target' })
  })

  it('缺必填达成率槽 ⇒ 失败（不产出没有达成率的「目标」报表）', () => {
    const out = compileTemplate(goal, { sale_rate: 'm:sale' })
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.reason).toBe('MISSING_REQUIRED_SLOT')
  })
})
