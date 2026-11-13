// report-period.ts — 报表「窗口与对比」的**唯一实现**（2026-11-13，R0）。
//
// 为什么单独一个文件：同一套窗口语义曾被四处各写一遍——渲染器（ReportView）、面板对比
// （report-query）、日报事实包（report-daily-review）、以及提示词/模板。四处各算一次 =
// 合计窗口与日序列可能不是同一个事实（2026-11-10 实测：区间合计截止 11-09，日序列却画到
// 11-10）。**新增窗口/对比一律加在这里**，消费方只许调用，不许再写第二份。
//
// 为什么不直接用 `new Date()` 的本地日：宿主容器时区不可依赖，而业务日一律是**上海日**。
// 所以「今天」只经 `todayShanghai()` 取（Intl 指定 Asia/Shanghai），dayjs 仅做纯日期加减。
//
// 四条对比口径：
//  · `prev_period`：**等长前移**——本段长度（含首尾）不变，末日前移，贴着本段首日；
//  · `prev_month`：**同日期段前移一个月**，并按上月月末夹取（3/31 的上一月是 2/28，不是 2/31）；
//  · `yearAgoRangeOf`：**去年同期、等长**（图表的同比序列）；
//  · `lastYearMonthToDate`：**去年同月 1 日 ~ 去年同日**（日报的「去年同月日均」基线）。
//    两种「去年」语义不同，别互相替代。
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
  if (period.mode === 'day') {
    if (period.day === undefined) throw new Error('INVALID_PERIOD')
    return { from: period.day, to: period.day }
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

/** 去年同期：同月同日、等长区间（2/29 → 2/28 由 dayjs 自动夹取）。 */
export function yearAgoRangeOf(range: DateRange): DateRange {
  return {
    from: dayjs(range.from).subtract(1, 'year').format(FMT),
    to: dayjs(range.to).subtract(1, 'year').format(FMT),
  }
}

/** 某日的自然月首日（MTD 窗口的左端）。 */
export function monthStartOf(day: string): string {
  return dayjs(day).startOf('month').format(FMT)
}

/** 本月至某日（含）：日报的 «本月至今日均» 基线窗口。 */
export function monthToDate(day: string): DateRange {
  return { from: monthStartOf(day), to: day }
}

/**
 * 去年同月 1 日 ~ 去年同日（含）。2/29 由 dayjs 夹到 2/28。
 * ⚠️ 与 `yearAgoRangeOf` 不同：那个是「等长平移」，这个是「同月同日之前」，日报基线用本函数。
 */
export function lastYearMonthToDate(day: string): DateRange {
  const ly = dayjs(day).subtract(1, 'year')
  return { from: ly.startOf('month').format(FMT), to: ly.format(FMT) }
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
