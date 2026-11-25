// scripts/lemeng/sla-check.test.ts — SLA 只读测量器的纯函数测试（D2）。
// 判据：时钟解析、跨零点窗口、以及每个 product 的 OK/ERR/UNKNOWN/SKIP 分支。
import { describe, expect, it } from 'vitest'
import { computeReport, inWindow, parseConsoleTime, parseRunToken } from './sla-check.mjs'

const CONFIG = {
  products: {
    retail_10m: {
      job: 'data.dbt_tick',
      window: { start: '09:00', end: '01:59' },
      sla: { sourceToBuildMinutes: 10, buildIntervalMinutes: 15, missingOkMinutes: 20 },
    },
    nonretail_1h: {
      window: { start: '09:00', end: '23:59' },
      sla: { sourceToBuildMinutes: 60, buildIntervalMinutes: 75, missingOkMinutes: 120 },
      domains: { purchase: { job: 'data.dbt_hourly_purchase', sources: ['src.a', 'src.b'] } },
    },
    daily: { job: 'data.dbt_tables', window: 'all', sla: { maxAgeMinutes: 1560 } },
  },
}

function clocks(over: Partial<{ now: Date; jobs: Map<string, Date | null>; hot: string[]; console: Map<string, Date | null> }> = {}) {
  return {
    now: over.now ?? new Date('2026-11-25T03:00:00Z'), // 11:00 CST
    jobs: over.jobs ?? new Map<string, Date | null>(),
    hotRunTokens: over.hot ?? [],
    consoleLastOk: over.console ?? new Map<string, Date | null>(),
  }
}

describe('sla-check · 时钟解析', () => {
  it('run_token（UTC）解析', () => {
    expect(parseRunToken('2026-11-25_103027')?.toISOString()).toBe('2026-11-25T10:30:27.000Z')
    expect(parseRunToken('bad')).toBeNull()
  })
  it('console last_run_at：ISO 与裸 CST 两种形态', () => {
    expect(parseConsoleTime('2026-11-25T10:30:00+08:00')?.toISOString()).toBe('2026-11-25T02:30:00.000Z')
    expect(parseConsoleTime('2026-11-25 10:30:00')?.toISOString()).toBe('2026-11-25T02:30:00.000Z')
    expect(parseConsoleTime('')).toBeNull()
  })
})

describe('sla-check · 活跃窗口（CST，跨零点）', () => {
  const w = { start: '09:00', end: '01:59' }
  it('09:00 / 00:30 / 01:59 在窗内；08:30 / 02:00 在窗外', () => {
    expect(inWindow(new Date('2026-11-25T01:00:00Z'), w)).toBe(true) // 09:00
    expect(inWindow(new Date('2026-11-24T16:30:00Z'), w)).toBe(true) // 00:30
    expect(inWindow(new Date('2026-11-24T17:59:00Z'), w)).toBe(true) // 01:59
    expect(inWindow(new Date('2026-11-25T00:30:00Z'), w)).toBe(false) // 08:30
    expect(inWindow(new Date('2026-11-24T18:00:00Z'), w)).toBe(false) // 02:00
  })
  it("window='all' 恒 true", () => {
    expect(inWindow(new Date('2026-11-25T00:30:00Z'), 'all')).toBe(true)
  })
})

describe('sla-check · 判据', () => {
  it('10m：源→建 8 分钟 ⇒ OK', () => {
    const jobs = new Map([['data.dbt_tick', new Date('2026-11-25T02:58:00Z')]])
    const r = computeReport(CONFIG, clocks({ jobs, hot: ['2026-11-25_025000'] }))
    const ten = r.products.find((p) => p.product === 'retail_10m')!
    expect(ten.verdict).toBe('OK')
    expect(ten.lagSourceToBuildMs).toBe(8 * 60_000)
  })

  it('10m：源→建 118 分钟 ⇒ ERR', () => {
    const jobs = new Map([['data.dbt_tick', new Date('2026-11-25T02:58:00Z')]])
    const r = computeReport(CONFIG, clocks({ jobs, hot: ['2026-11-25_010000'] }))
    const ten = r.products.find((p) => p.product === 'retail_10m')!
    expect(ten.verdict).toBe('ERR')
    expect(ten.detail).toContain('source↔build')
  })

  it('10m：窗口外 ⇒ SKIP（08:30 CST）', () => {
    const now = new Date('2026-11-25T00:30:00Z')
    const r = computeReport(CONFIG, clocks({ now }))
    expect(r.products.find((p) => p.product === 'retail_10m')!.verdict).toBe('SKIP')
  })

  it('1h：源→建 50 分钟 ⇒ OK（木桶取最慢源）', () => {
    const jobs = new Map([['data.dbt_hourly_purchase', new Date('2026-11-25T02:55:00Z')]])
    const console = new Map<string, Date | null>([
      ['src.a', new Date('2026-11-25T02:05:00Z')],
      ['src.b', new Date('2026-11-25T02:00:00Z')],
    ])
    const r = computeReport(CONFIG, clocks({ jobs, console }))
    const p = r.products.find((x) => x.product === 'nonretail_1h.purchase')!
    expect(p.verdict).toBe('OK')
    expect(p.lagSourceToBuildMs).toBe(55 * 60_000) // 02:00 → 02:55
  })

  it('1h：源领先 build 20 分钟是**节拍**（|lag|≤75）⇒ OK', () => {
    const jobs = new Map([['data.dbt_hourly_purchase', new Date('2026-11-25T02:55:00Z')]])
    const console = new Map<string, Date | null>([
      ['src.a', new Date('2026-11-25T03:15:00Z')],
      ['src.b', new Date('2026-11-25T03:15:00Z')],
    ])
    const r = computeReport(CONFIG, clocks({ jobs, console }))
    const p = r.products.find((x) => x.product === 'nonretail_1h.purchase')!
    expect(p.verdict).toBe('OK')
    expect(p.detail).toContain('source ahead')
  })

  it('1h：build 落后源 120 分钟（错过一个周期）⇒ ERR', () => {
    const jobs = new Map([['data.dbt_hourly_purchase', new Date('2026-11-25T02:00:00Z')]])
    const console = new Map<string, Date | null>([
      ['src.a', new Date('2026-11-25T04:00:00Z')],
      ['src.b', new Date('2026-11-25T04:00:00Z')],
    ])
    const r = computeReport(CONFIG, clocks({ jobs, console }))
    expect(r.products.find((x) => x.product === 'nonretail_1h.purchase')!.verdict).toBe('ERR')
  })

  it('1h：任一源缺 last_ok ⇒ UNKNOWN（不拿部分值冒充）', () => {
    const jobs = new Map([['data.dbt_hourly_purchase', new Date('2026-11-25T02:55:00Z')]])
    const console = new Map<string, Date | null>([
      ['src.a', new Date('2026-11-25T02:05:00Z')],
      ['src.b', null],
    ])
    const r = computeReport(CONFIG, clocks({ jobs, console }))
    expect(r.products.find((x) => x.product === 'nonretail_1h.purchase')!.verdict).toBe('UNKNOWN')
  })

  it('1h：窗口内无 ok 运行 ⇒ ERR', () => {
    const r = computeReport(CONFIG, clocks())
    expect(r.products.find((x) => x.product === 'nonretail_1h.purchase')!.verdict).toBe('ERR')
  })

  it('daily：超过 maxAge ⇒ ERR', () => {
    const jobs = new Map([['data.dbt_tables', new Date('2026-11-23T11:00:00Z')]])
    const r = computeReport(CONFIG, clocks({ jobs }))
    expect(r.products.find((p) => p.product === 'daily')!.verdict).toBe('ERR')
  })
})
