// cron.ts — cron 解析与下一次触发（纯函数、零依赖）。
//
// 只支持 * , - / 与数字；不支持的语法**抛错**（seed 期即拒绝，绝不静默按错时间跑）。
// 周几：0 与 7 都是周日。DOM/DOW 采用标准 cron 语义：两个字段都被限制时取「或」，否则取「与」。
// 时区：按 IANA 名用 Intl 求偏移；目标时区无 DST 时（如 Asia/Shanghai）结果稳定。
export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
]

function parseField(raw: string, min: number, max: number): number[] {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    if (part === '') throw new Error(`cron: 空字段片段 "${raw}"`)
    const slashParts = part.split('/')
    if (slashParts.length > 2) throw new Error(`cron: 不支持的语法 "${part}"（步长只能出现一次）`)
    const [rangeRaw, stepRaw] = slashParts
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw new Error(`cron: 非法步长 "${part}"`)
      step = Number(stepRaw)
      // 超长数字串会变 Infinity（`Number.isSafeInteger` 拦下），不能只判 `step <= 0`。
      if (!Number.isSafeInteger(step) || step <= 0) throw new Error(`cron: 步长必须为正且可安全表示 "${part}"`)
    }
    let lo: number
    let hi: number
    if (rangeRaw === '*') {
      lo = min
      hi = max
    } else if (/^\d+$/.test(rangeRaw)) {
      lo = Number(rangeRaw)
      hi = stepRaw === undefined ? lo : max
    } else if (/^\d+-\d+$/.test(rangeRaw)) {
      const [a, b] = rangeRaw.split('-').map(Number)
      lo = a
      hi = b
    } else {
      throw new Error(`cron: 不支持的语法 "${part}"（只支持 * , - / 与数字）`)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron: 越界 "${part}"（允许 ${min}-${max}）`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron: 需要 5 个字段，得到 ${parts.length} 个`)
  const [mi, ho, dom, mo, dow] = parts
  const spec: CronSpec = {
    minutes: parseField(mi, FIELDS[0].min, FIELDS[0].max),
    hours: parseField(ho, FIELDS[1].min, FIELDS[1].max),
    daysOfMonth: parseField(dom, FIELDS[2].min, FIELDS[2].max),
    months: parseField(mo, FIELDS[3].min, FIELDS[3].max),
    daysOfWeek: parseField(dow, FIELDS[4].min, FIELDS[4].max).map((d) => (d === 7 ? 0 : d)),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
  spec.daysOfWeek = [...new Set(spec.daysOfWeek)].sort((a, b) => a - b)
  return spec
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

const fmt = new Map<string, Intl.DateTimeFormat>()

function partsIn(instant: Date, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  let f = fmt.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    fmt.set(timeZone, f)
  }
  const p: Record<string, string> = {}
  for (const { type, value } of f.formatToParts(instant)) p[type] = value
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute }
}

function offsetMs(instantMs: number, timeZone: string): number {
  const p = partsIn(new Date(instantMs), timeZone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - instantMs
}

/**
 * 把「时区里的墙钟时间」换成 UTC instant。
 * 二次校正只吸收整点偏移的取整误差；**它不解决 DST 缺口** —— `nextRunAt` 入口已拒绝有夏令时的时区。
 */
function zonedToInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const off1 = offsetMs(guess, timeZone)
  const t1 = guess - off1
  const off2 = offsetMs(t1, timeZone)
  return off2 === off1 ? t1 : guess - off2
}

function dowOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

/** 有 DST 的时区在一年内的两个整点偏移不相等；入口即拒绝，避免静默算出错误墙钟。 */
function assertNoDst(timeZone: string, year: number): void {
  const jan = zonedToInstant(year, 1, 1, 0, 0, timeZone)
  const jul = zonedToInstant(year, 7, 1, 0, 0, timeZone)
  if (offsetMs(jan, timeZone) !== offsetMs(jul, timeZone)) {
    throw new Error(`cron: 不支持有夏令时的时区（${timeZone}）`)
  }
}

export function nextRunAt(expr: string, timeZone: string, from: Date): Date {
  const spec = parseCron(expr)
  const base = partsIn(from, timeZone)
  assertNoDst(timeZone, base.y)
  // 从「当前分钟的下一个分钟」开始逐日扫描；最多看 8 年：`0 0 29 2 *` 从 2096 起下一次是
  // 2104-02-29（2100 非闰），5 年上界会假抛。
  let y = base.y
  let mo = base.mo
  let d = base.d
  for (let day = 0; day < 366 * 8; day++) {
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const dow = dowOf(y, mo, d)
    const domOk = spec.daysOfMonth.includes(d)
    const dowOk = spec.daysOfWeek.includes(dow)
    const dayOk = spec.domRestricted && spec.dowRestricted ? domOk || dowOk : domOk && dowOk
    if (spec.months.includes(mo) && dayOk) {
      for (const h of spec.hours) {
        for (const mi of spec.minutes) {
          const t = zonedToInstant(y, mo, d, h, mi, timeZone)
          if (t > from.getTime()) return new Date(t)
        }
      }
    }
    d += 1
    if (d > dim) {
      d = 1
      mo += 1
      if (mo > 12) {
        mo = 1
        y += 1
      }
    }
  }
  throw new Error(`cron: 8 年内没有下一次触发（${expr} @ ${timeZone}）`)
}
