// scripts/lemeng/phase-audit.test.ts — 排班相位审计的纯函数机检（#2960）。
//
// 钉三件：① 可变面归类对**未知写法显式标 unknown**（不猜）；② cron 分钟解析覆盖常见形态；
// ③ 时钟重叠判定是「相差 ≤tol」而不是「相等」——错峰 1–2 分钟在真机上仍然撞。
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLASSIFY, classify, minutesOf, overlapsInClock } from './phase-audit.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

describe('phase-audit · 可变面归类', () => {
  it('库存快照类：每小时重采 T-0..T-2', () => {
    expect(classify('lemeng.inventory.snapshot.l0.3120').days).toEqual([0, 1, 2])
    expect(classify('lemeng.inventory.snapshot.catchup.3120').days).toEqual([0, 1, 2])
  })
  it('窗口重采 / 日结 / 封版对账 / 对账父管线', () => {
    expect(classify('lemeng.retail.windows.l1').days).toEqual([1, 2])
    expect(classify('lemeng.retail.close.l1').days).toEqual([1])
    expect(classify('lemeng.retail_order_line.daily_sealed.reconcile').days).toEqual([1])
    expect(classify('lemeng.recon.preagg').days).toEqual([3])
  })
  it('回填/压缩不改周期可变面', () => {
    expect(classify('lemeng.lake.compact').days).toEqual([])
    expect(classify('lemeng.retail.day.backfill').days).toEqual([])
  })
  it('★ 未知写法标 unknown，不猜一个天数', () => {
    expect(classify('lemeng.some.brand.new.pipeline').why).toContain('unknown')
  })
  it('★ 库里每条 console 排班都必须能归类（新增管线要先登记声明）', () => {
    const dir = join(HERE, '../../deploy/duckle/console/schedules')
    const unknown = []
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const list = JSON.parse(readFileSync(join(dir, f), 'utf8'))
      for (const s of Array.isArray(list) ? list : []) {
        const id = String(s?.pipeline_id ?? s?.id ?? '')
        if (id && classify(id).why.startsWith('unknown')) unknown.push(id)
      }
    }
    expect(unknown, `未登记可变面：${unknown.join(', ')}`).toEqual([])
  })
})

describe('phase-audit · cron 与重叠', () => {
  it('分钟解析：固定 / 星号步长 / 区间步长 / 逗号列表', () => {
    expect(minutesOf('30 18 * * *')).toEqual([30])
    expect(minutesOf('*/10 9-23 * * *')).toEqual([0, 10, 20, 30, 40, 50])
    expect(minutesOf('5,35 16-23 * * *')).toEqual([5, 35])
  })

  it('重叠判据是「相差 ≤2 分钟」，不是相等', () => {
    expect(overlapsInClock([7], [7], 2)).toBe(true)
    expect(overlapsInClock([7], [9], 2)).toBe(true) // 错峰 2 分钟仍算撞
    expect(overlapsInClock([7], [10], 2)).toBe(false)
  })

  it('归类表本身没有重叠语义的重复条目（顺序即优先级，写清楚）', () => {
    // snapshot 必须在 l0 之前（`inventory.snapshot.l0` 同时命中 `.l0`）
    const iSnap = CLASSIFY.findIndex((c) => String(c.match).includes('snapshot'))
    const iL0 = CLASSIFY.findIndex((c) => String(c.match).includes('\\.l0'))
    expect(iSnap).toBeGreaterThanOrEqual(0)
    expect(iL0).toBeGreaterThan(iSnap)
  })
})
