// report-period.ts — 报表「期间」到具体日期段的数学（计划 Part B）。
//
// 为什么不直接用 `new Date()` 的本地日：宿主容器时区不可依赖，而业务日一律是**上海日**。
// 所以「今天」只经 `todayShanghai()` 取（Intl 指定 Asia/Shanghai），dayjs 仅做纯日期加减。
//
// 两条对比口径（kpi 面板 `compare`，spec 里是枚举值，不是提示词）：
//  · `prev_period`：**等长前移**——本段长度（含首尾）不变，末日前移，贴着本段首日；
//  · `prev_month`：**同日期段前移一个月**，并按上月月末夹取（3/31 的上一月是 2/28，不是 2/31）。
import dayjs from 'dayjs'
import type { PeriodSpec } from './report-spec'

export interface DateRange { from: string; to: string }

const FMT = 'YYYY-MM-DD'

function todayShanghai(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

export function periodRangeOf(period: PeriodSpec, now: Date): DateRange {
  if (period.mode === 'custom') {
    if (period.from === undefined || period.to === undefined || period.from > period.to) {
      throw new Error('INVALID_PERIOD')
    }
    return { from: period.from, to: period.to }
  }
  if (period.mode === 'last_7_days') {
    const to = todayShanghai(now)
    return { from: dayjs(to).subtract(6, 'day').format(FMT), to }
  }
  if (period.month === undefined) throw new Error('INVALID_PERIOD')
  const start = dayjs(`${period.month}-01`)
  const end = start.endOf('month')
  const today = todayShanghai(now)
  const to = today.startsWith(period.month) ? today : end.format(FMT)
  return { from: start.format(FMT), to }
}

export function previousRangeOf(range: DateRange, mode: 'prev_period' | 'prev_month'): DateRange {
  if (mode === 'prev_period') {
    const len = dayjs(range.to).diff(dayjs(range.from), 'day') + 1
    const to = dayjs(range.from).subtract(1, 'day')
    return { from: to.subtract(len - 1, 'day').format(FMT), to: to.format(FMT) }
  }
  const start = dayjs(range.from).subtract(1, 'month')
  const len = dayjs(range.to).diff(dayjs(range.from), 'day')
  const wanted = start.add(len, 'day')
  const end = start.endOf('month')
  return { from: start.format(FMT), to: (wanted.isAfter(end) ? end : wanted).format(FMT) }
}
