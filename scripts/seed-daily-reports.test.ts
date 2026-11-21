// scripts/seed-daily-reports.test.ts —— 纯函数/静态校验（不连库）：
//
//   ① 两份定义的规格必须过 `parseReportInput` 白名单（多一个键 = 发布 400，这是最常见的坑）；
//   ② 语义 lint 必须 0 error（`lintBlocksPublish` 为假）——否则 dry-run 看着没问题、真发布才炸；
//   ③ 只用 totalable 指标：R1 第 ④ 步「按日组成加总 = 页面值」才有意义（非可加只能记「不适用」）；
//   ④ 撞名不覆盖（`create-only`）——这条由 `seedOne` 的分支保证，这里只钉「标题唯一」。
import { describe, expect, it } from 'vitest'
import { DEFINITIONS, planSeed } from './seed-daily-reports.mjs'
import { parseReportInput } from '../modules/data/domain/report-spec'
import { lintBlocksPublish, lintReportSpec } from '../modules/data/domain/report-lint'

describe('seed-daily-reports 定义', () => {
  it('标题唯一（同一份定义不许重复播种）', () => {
    const titles = DEFINITIONS.map((d) => d.title)
    expect(new Set(titles).size).toBe(titles.length)
  })

  it('★ 每份规格都过白名单且 lint 不阻断发布', () => {
    for (const d of DEFINITIONS) {
      const parsed = parseReportInput(d.spec)
      expect(parsed.ok, `${d.title} 规格被白名单拒：${parsed.ok ? '' : parsed.code}`).toBe(true)
      if (!parsed.ok) continue
      const issues = lintReportSpec(parsed.spec)
      expect(lintBlocksPublish(issues), `${d.title} 有阻断级 lint：${JSON.stringify(issues)}`).toBe(false)
    }
  })

  it('★ KPI 面板形状与 KpiPanel.strict 对齐（chart/metricId/format 齐备）', () => {
    for (const d of DEFINITIONS) {
      expect(d.spec.panels.length).toBeGreaterThan(0)
      for (const p of d.spec.panels) {
        expect(p.chart).toBe('kpi')
        expect(typeof p.metricId).toBe('string')
        expect(['currency', 'number', 'percent']).toContain(p.format)
      }
    }
  })

  it('★ 只用 totalable 指标（可在测试里静态核对清单，防止有人换成快照类指标）', () => {
    const additive = new Set([
      'lemeng:member:branch_vip_money',
      'lemeng:member:branch_vip_nums',
      'lemeng:loss:branch_amount',
      'lemeng:outbound:gross_profit',
      'lemeng:purchase:amount',
      'lemeng:retail:net_sales',
    ])
    for (const d of DEFINITIONS) {
      for (const p of d.spec.panels) {
        expect(additive.has(p.metricId), `${p.metricId} 不在可加白名单`).toBe(true)
        if (p.denominatorMetricId) expect(additive.has(p.denominatorMetricId)).toBe(true)
      }
    }
  })
})

describe('seed-daily-reports planSeed（dry-run 绝不写库）', () => {
  it('★ 不存在 + dry-run ⇒ dry-run-create（这一步不许碰库）', () => {
    expect(planSeed(null, false)).toBe('dry-run-create')
  })

  it('★ 不存在 + apply ⇒ create-and-publish', () => {
    expect(planSeed(null, true)).toBe('create-and-publish')
  })

  it('★ 已存在但未发布：dry-run 只报告，apply 才就地发布（不新建）', () => {
    const draft = { id: 'x', published_version_id: null }
    expect(planSeed(draft, false)).toBe('dry-run-publish-existing')
    expect(planSeed(draft, true)).toBe('publish-existing')
  })

  it('已发布 ⇒ 幂等跳过（两种模式都不写）', () => {
    const live = { id: 'x', published_version_id: 'v1' }
    expect(planSeed(live, false)).toBe('skipped-exists-published')
    expect(planSeed(live, true)).toBe('skipped-exists-published')
  })
})
