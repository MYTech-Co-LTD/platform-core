// narrative-golden.test.ts — 叙事黄金集（R5）：20 条「模型话术 → 接受/拒绝」判据。
//
// 目的：白名单/单位/负数/日期这些规则一旦回退，典型输出会被判越界 ⇒ 整段回退模板（用户看到
// 「又套模板了」）。这里把 20 种真实写法钉成金标：**只要规则漂移，CI 立刻红**，不必等用户发现。
//
// 只测校验层（allowedNumbers / badNumbers），不调模型：确定性、零成本、跑在 unit job 里。
import { describe, expect, it } from 'vitest'
import type { FactBundle } from './report-facts'
import { allowedNumbers, badNumbers } from './narrative'

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
