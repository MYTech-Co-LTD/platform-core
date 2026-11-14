// narrative-golden.test.ts — 叙事黄金集（R5）：20 条「模型话术 → 接受/拒绝」判据。
//
// 目的：白名单/单位/负数/日期这些规则一旦回退，典型输出会被判越界 ⇒ 整段回退模板（用户看到
// 「又套模板了」）。这里把 20 种真实写法钉成金标：**只要规则漂移，CI 立刻红**，不必等用户发现。
//
// 只测校验层（allowedNumbers / badNumbers），不调模型：确定性、零成本、跑在 unit job 里。
import { describe, expect, it } from 'vitest'
import type { FactBundle } from './report-facts'
import { allowedNumbers, badNumbers, templateOf } from './narrative'

/** 黄金事实包：刻意包含金额、小数、百分数、负数、带单位值、期间日期。 */
const facts: FactBundle = {
  reportTitle: '门店经营日报',
  specKey: 'published:1',
  focus: 'daily_review',
  period: { from: '2026-10-01', to: '2026-10-19', label: '2026-10-01 ~ 2026-10-19' },
  branchNum: '92',
  branchName: '熊喵曲靖沾益2店',
  hasData: true,
  dataAsOf: '2026-10-25 06:00:00 +08:00',
  kpis: [
    { panel: '销售额', metricId: 'n:sales', format: 'currency', current: '51,273.89', previous: '48,000.00', delta: '6.82%' },
    { panel: '订单数', metricId: 'n:orders', format: 'number', current: '1,254.60', previous: '1,200', delta: '-58.6%' },
  ],
  breakdowns: [
    { panel: '费用构成', dimension: 'item', rows: [{ label: '配送费', value: '12.5mm' }] },
  ],
  daily: { min: { day: '2026-10-13', value: '1,024.50' }, max: { day: '2026-10-05', value: '4,800.00' } },
  analysis: null,
  dailyReview: null,
  missing: [],
  numbers: ['51,273.89', '48,000.00', '6.82%', '1,254.60', '1,200', '-58.6%', '12.5mm', '1,024.50', '4,800.00'],
  dates: ['2026-10-01', '2026-10-19'],
  factsHash: 'golden-1',
}

const allowed = allowedNumbers(facts)
const bad = (text: string): string[] => badNumbers(text, allowed)

type Golden = { name: string; text: string; ok: boolean }

const CASES: Golden[] = [
  { name: '金额逐字复制', text: '营业额 **51,273.89**，环比 +6.82%。', ok: true },
  { name: '去千分位', text: '营业额 51273.89。', ok: true },
  { name: '带货币符号', text: '营业额 ¥51,273.89。', ok: true },
  { name: '百分数去单位', text: '环比 6.82。', ok: true },
  { name: '百分数带单位', text: '环比 6.82%。', ok: true },
  { name: 'pp 与 % 互换', text: '毛利率变化 6.82pp。', ok: true },
  { name: '负数写绝对值（事实为负）', text: '订单下滑 58.6%。', ok: true },
  { name: '负数带负号（事实为负）', text: '订单 -58.6%。', ok: true },
  { name: '小数尾零归一', text: '订单数 1,254.6。', ok: true },
  { name: '去逗号且去尾零', text: '订单数 1254.6。', ok: true },
  { name: '带单位值（mm）', text: '降水 12.5mm。', ok: true },
  { name: '小序号恒放行', text: '第 1 条、第 2 条建议。', ok: true },
  { name: '缺数写短横', text: '去年同期：-。', ok: true },
  { name: 'ISO 日期整段放行', text: '最低销售日 2026-10-13。', ok: true },
  { name: '中文日期整段放行', text: '最低销售日 10月13日。', ok: true },
  { name: '裸年份放行', text: '2026 年整体承压。', ok: true },
  // ── 以下必须判越界 ─────────────────────────────────────────────
  { name: '编造金额', text: '营业额 52,000.00。', ok: false },
  { name: '正数事实写成负号', text: '营业额 -6.82%。', ok: false },
  { name: '改精度', text: '环比 6.8%。', ok: false },
  { name: '裸日期片段', text: '这批数据来自 04。', ok: false },
]

describe('叙事黄金集（20 条）', () => {
  for (const c of CASES) {
    it(`${c.ok ? '接受' : '拒绝'}：${c.name}`, () => {
      const got = bad(c.text)
      expect(got.length === 0, `越界数字 ${JSON.stringify(got)}`).toBe(c.ok)
    })
  }
})

// ── 模板必含段（R5 金标扩展）─────────────────────────────────────────────────────
// 回退模板是「模型不可用时用户实际看到的东西」，它的段落结构也是契约：
//   · overview     = 结论 / 异常 / 行动 / 数据截至；
//   · root_cause   = 上面 + 根因（无分析时也必须给可解释的兜底句，不能空着）；
//   · daily_review = 结论 / 对比 / 成本 / MTD / 驱动 / 根因 / 建议（少一段等于日报残废）；
//   · 无数据       = 只留结论 + 数据截至（不许编「异常/行动」）。
//   · **模板里的数字必须全部落在校验白名单内**——模板与校验同一把尺，否则回退文本自己就「越界」。
describe('模板必含段（R5）', () => {
  const withFocus = (focus: FactBundle['focus'], over: Partial<FactBundle> = {}): FactBundle =>
    ({ ...facts, focus, ...over })
  const linesOf = (f: FactBundle): string[] => templateOf(f).split('\n')

  it('overview：结论 / 异常 / 行动 / 数据截至 四段齐全，且不出现根因段', () => {
    const lines = linesOf(withFocus('overview'))
    expect(lines.some((l) => l.startsWith('结论：'))).toBe(true)
    expect(lines.some((l) => l.startsWith('异常：'))).toBe(true)
    expect(lines.some((l) => l.startsWith('行动：'))).toBe(true)
    expect(lines.some((l) => l.startsWith('数据截至'))).toBe(true)
    expect(lines.some((l) => l.startsWith('根因：'))).toBe(false)
  })

  it('root_cause：必须给根因段；没有分析时是「不足以分解」的兜底，不是空白', () => {
    const text = templateOf(withFocus('root_cause'))
    expect(text).toContain('根因：当前报表数据不足以分解根因。')
  })

  it('daily_review（数据不足）：明确说不符，不硬凑六段', () => {
    const text = templateOf(withFocus('daily_review'))
    expect(text).toContain('结论：')
    expect(text).toContain('不足以生成日报')
    expect(text).toContain('数据截至')
  })

  it('无数据：只留结论 + 数据截至，不编异常/行动', () => {
    const lines = linesOf(withFocus('overview', { hasData: false }))
    expect(lines.some((l) => l.startsWith('结论：'))).toBe(true)
    expect(lines.some((l) => l.startsWith('数据截至'))).toBe(true)
    expect(lines.some((l) => l.startsWith('异常：'))).toBe(false)
    expect(lines.some((l) => l.startsWith('行动：'))).toBe(false)
  })

  it('★ 模板与校验同一把尺：三种 focus 的模板文本都不含白名单外的数字', () => {
    for (const focus of ['overview', 'root_cause', 'daily_review'] as const) {
      const f = withFocus(focus)
      expect(badNumbers(templateOf(f), allowedNumbers(f)), `focus=${focus}`).toEqual([])
    }
  })
})
