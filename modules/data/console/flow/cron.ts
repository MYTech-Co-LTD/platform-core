// cron.ts — 把仓内用到的 cron 形态解析成「北京时间的一天里的时点」（排班泳道动画用）。
//
// 只支持本仓实际出现的形态（不引第三方 cron 库）：
//   `* /5 * * * *`（每 5 分钟）、`2-59/10 1-15 * * *`（1–15 点每 10 分钟，从 2 分起）、
//   `25 2 * * *`（每天 UTC 02:25）、`5,35 * * * *`（每小时 5/35 分）、`0 0 * * *`。
// 解析不了的返回 `{ kind: 'unknown' }`——调用方如实显示原文，不猜。

export interface CronSlot {
  /** 小时（0–23，北京时间） */
  hour: number
  /** 分钟（0–59） */
  minute: number
}

export type CronShape =
  | { kind: 'every-minutes'; minutes: CronSlot[]; scope: 'all-day' | { fromHour: number; toHour: number } }
  | { kind: 'unknown' }

/** 展开一个字段（支持 `*`、`* /n`、`a-b`、`a-b/n`、逗号列表）。 */
function expandField(field: string, min: number, max: number): number[] | null {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const p = part.trim()
    if (p === '') return null
    const stepMatch = /^(\*|\d+(?:-\d+)?)\/(\d+)$/.exec(p)
    if (stepMatch !== null) {
      const step = Number(stepMatch[2])
      if (!Number.isInteger(step) || step <= 0) return null
      let lo = min
      let hi = max
      if (stepMatch[1] !== '*') {
        const [a, b] = stepMatch[1].split('-')
        lo = Number(a)
        hi = b === undefined ? max : Number(b)
      }
      for (let v = lo; v <= hi; v += step) out.add(v)
      continue
    }
    const rangeMatch = /^(\d+)-(\d+)$/.exec(p)
    if (rangeMatch !== null) {
      const lo = Number(rangeMatch[1])
      const hi = Number(rangeMatch[2])
      if (lo > hi) return null
      for (let v = lo; v <= hi; v += 1) out.add(v)
      continue
    }
    if (p === '*') {
      for (let v = min; v <= max; v += 1) out.add(v)
      continue
    }
    const v = Number(p)
    if (!Number.isInteger(v)) return null
    out.add(v)
  }
  if (out.size === 0) return null
  return [...out].sort((a, b) => a - b)
}

/** UTC 小时 → 北京小时（跨日回绕）。 */
const cstHour = (utcHour: number): number => (utcHour + 8) % 24

/**
 * 解析 cron 为「北京时间一天里的触发时点」。
 *
 * 只对 `minute hour * * *`（每日/每小时的分钟级调度）建模；日/月/星期字段非 `*` 时返回 unknown
 * （本仓没有那种排班；出现就是新形态，交给调用方显示原文）。
 * @param cron 五段 cron（UTC）
 */
export function parseCronToCstSlots(cron: string): CronShape {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return { kind: 'unknown' }
  const [minF, hourF, domF, monF, dowF] = parts
  if (domF !== '*' || monF !== '*' || dowF !== '*') return { kind: 'unknown' }
  const minutes = expandField(minF, 0, 59)
  const hours = expandField(hourF, 0, 23)
  if (minutes === null || hours === null) return { kind: 'unknown' }
  const slots: CronSlot[] = []
  for (const h of hours) {
    for (const m of minutes) slots.push({ hour: cstHour(h), minute: m })
  }
  const allDay = hours.length === 24
  const sortedHours = [...hours].sort((a, b) => a - b)
  return {
    kind: 'every-minutes',
    minutes: slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute)),
    scope: allDay
      ? 'all-day'
      : { fromHour: cstHour(sortedHours[0]), toHour: cstHour(sortedHours[sortedHours.length - 1]) },
  }
}

/**
 * 排班「节奏标签」：给人在泳道上快速读（每分钟/每 10 分钟/每天 …）。
 * @param cron 五段 cron（UTC）
 */
export function cadenceLabel(cron: string): string {
  const shape = parseCronToCstSlots(cron)
  if (shape.kind === 'unknown') return cron
  const minutes = new Set(shape.minutes.map((s) => s.minute))
  if (shape.scope === 'all-day' && minutes.size === 1) return '每小时一次'
  if (shape.scope === 'all-day') {
    const step = shape.minutes.filter((s) => s.minute === 0 || shape.minutes.some((o) => o.minute === s.minute - 1)).length
    void step
    return `每小时 ${minutes.size} 次`
  }
  if (minutes.size === 1) return '每天一次'
  return `每天 ${minutes.size} 次`
}
