// report-period.test.ts — 报表期间与上一期间计算的单元测试（TDD 第一步：先落盘、先红）。
//
// 边界口径（计划 Part B，2026-10-26 月报重做）：
//  · 「今天」一律按**上海时区**取日（服务器进程时区不可依赖）；
//  · `month` 模式：历史月取整月，当月只到**今天**（不把未来日当数据日）；
//  · `prev_period`：等长前移（长度含首尾，`to` 紧贴本段 `from` 前一天）；
//  · `prev_month`：同日期段前移一个月，**按上月月末夹取**（3 月 31 日的上一月不是 2 月 31 日）。
import { describe, expect, it } from 'vitest'
import { periodRangeOf, previousRangeOf } from './report-period'

const now = new Date('2026-10-26T12:00:00+08:00')

describe('periodRangeOf', () => {
  it('month 取整月；当月取今天', () => {
    expect(periodRangeOf({ mode: 'month', month: '2026-09' }, now)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(periodRangeOf({ mode: 'month', month: '2026-10' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-26' })
  })
  it('last_7_days 与 custom', () => {
    expect(periodRangeOf({ mode: 'last_7_days' }, now)).toEqual({ from: '2026-10-20', to: '2026-10-26' })
    expect(periodRangeOf({ mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-19' })
  })
})

describe('previousRangeOf', () => {
  it('prev_period 等长前移', () => {
    expect(previousRangeOf({ from: '2026-10-01', to: '2026-10-19' }, 'prev_period')).toEqual({ from: '2026-09-12', to: '2026-09-30' })
  })
  it('prev_month 同日期段并按月末夹取', () => {
    expect(previousRangeOf({ from: '2026-10-01', to: '2026-10-19' }, 'prev_month')).toEqual({ from: '2026-09-01', to: '2026-09-19' })
    expect(previousRangeOf({ from: '2026-03-01', to: '2026-03-31' }, 'prev_month')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})
