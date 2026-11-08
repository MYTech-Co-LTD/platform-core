#!/usr/bin/env node
// check-schedule-conflicts.mjs — 小时档采集「同账套不重叠」门禁。
//
// 判据（只判小时档；tick / 2 小时档 / 日档不参与）：
//   ① 同一账套内，两条小时档的 `[minute, minute+ceil(dur/60))` 不得相交；
//   ② 分钟必须落在 tick 之后的窗口（`minute % 10 ∈ 2..9`）——tick 在 :00/:10/… 起跑；
//   ③ 耗时取 `schedule-durations.json`（未列出的用 defaultMaxDurationMs）。
// 失败字面量：`SCHEDULE_CONFLICT: <book> <a> <b> ...`（exit 1）。
// 用法：pnpm exec tsx scripts/check-schedule-conflicts.mjs
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { HOURLY_RE, baseId } from './gen-schedules.mjs'

const CONSOLE_DIR = 'deploy/duckle/console'
const DUR_PATH = join(CONSOLE_DIR, 'schedule-durations.json')

/** @param {string} p @returns {any} */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** @param {string} s @returns {boolean} */
const isNumericBook = (s) => /^[0-9]+\.json$/.test(s)

function main() {
  const dur = readJson(DUR_PATH)
  const books = readdirSync(join(CONSOLE_DIR, 'schedules')).filter(isNumericBook).sort()
  /** @type {string[]} */
  const violations = []
  let total = 0
  for (const book of books) {
    const entries = readJson(join(CONSOLE_DIR, 'schedules', book))
    /** @type {{ id: string, minute: number, dur: number }[]} */
    const hourly = []
    for (const e of entries) {
      const kind = e?.kind
      if (kind?.type !== 'cron' || typeof kind.expr !== 'string') continue
      const m = HOURLY_RE.exec(kind.expr)
      if (m === null) continue
      const id = String(e.pipeline_id ?? '')
      const minute = Number(m[1])
      const ms = dur.pipelines[baseId(id)] ?? dur.defaultMaxDurationMs
      hourly.push({ id, minute, dur: ms })
      if (minute % 10 < 2) {
        violations.push(`SCHEDULE_CONFLICT: ${book} ${id} minute=${minute} 落在 tick 窗口（应 ≥2 mod 10）`)
      }
    }
    hourly.sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id))
    for (let i = 1; i < hourly.length; i += 1) {
      const prev = hourly[i - 1]
      const cur = hourly[i]
      const end = prev.minute + Math.ceil(prev.dur / 60000)
      if (cur.minute < end) {
        violations.push(
          `SCHEDULE_CONFLICT: ${book} ${prev.id}@${prev.minute} 与 ${cur.id}@${cur.minute} 重叠` +
            `（前者 ${Math.ceil(prev.dur / 60000)} 分钟，到 ${end}）`
        )
      }
    }
    total += hourly.length
  }
  if (violations.length > 0) {
    for (const v of violations) console.error(v)
    process.exit(1)
  }
  console.log(`check-schedule-conflicts: OK（${books.length} 本排班 / ${total} 条小时档无重叠）`)
}

main()
