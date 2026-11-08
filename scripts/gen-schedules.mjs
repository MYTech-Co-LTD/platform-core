#!/usr/bin/env node
// gen-schedules.mjs — 按实测耗时给「小时档」管线分配分钟槽（9-23，避开 10 分钟 tick）。
//
// 判据（只改小时档，别的档位一律不动）：
//   · 小时档 = cron `<单分钟> <小时范围> * * *`（如 `6 9-23 * * *`）；
//   · tick（`*/10 9-23 * * *`）、2 小时档（`30 10,18 * * *`）、日档（`0 0 * * *` 等）不动；
//   · 分槽窗口 = 每个 10 分钟 tick 之后的 7 分钟：:02-:09 / :12-:19 / … / :52-:59；
//   · 按耗时降序排；每条占 `ceil(dur/60)+1` 分钟（1 分钟缓冲）；
//   · 超过 7 分钟的（dim.item 525s）放 :02，允许跨一个 tick（同账套最多 1 采集 + 1 tick）。
//
// 用法：
//   pnpm exec tsx scripts/gen-schedules.mjs            # 写 schedules/<账套>.json
//   pnpm exec tsx scripts/gen-schedules.mjs --check    # 只比不写（CI 用）
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const CONSOLE_DIR = 'deploy/duckle/console'
const DUR_PATH = join(CONSOLE_DIR, 'schedule-durations.json')
/** 每个 10 分钟 tick 之后的 7 分钟窗口（分钟）。 */
const WINDOWS = [
  [2, 9],
  [12, 19],
  [22, 29],
  [32, 39],
  [42, 49],
  [52, 59],
]
/** 小时档：`<单分钟> <起>-<止> * * *`。 */
export const HOURLY_RE = /^(\d+)\s+(\d+)-(\d+)\s+\*\s+\*\s+\*$/

/** @param {string} p @returns {any} */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** @param {string} id @returns {string} 去掉账套后缀（`lemeng.x.l0.3120` → `lemeng.x.l0`）。 */
export function baseId(id) {
  return id.replace(/\.(3120|64188)$/, '')
}

/**
 * 给一本排班重新分配小时档的分钟。
 * @param {any[]} entries
 * @param {{ defaultMaxDurationMs: number, pipelines: Record<string, number> }} dur
 * @returns {{ expr: string, id: string, minute: number, spansTick: boolean }[]}
 */
export function allocate(entries, dur) {
  /** @type {{ idx: number, id: string, expr: string, hours: string, dur: number }[]} */
  const hourly = []
  entries.forEach((e, idx) => {
    const kind = e?.kind
    if (kind?.type !== 'cron' || typeof kind.expr !== 'string') return
    const m = HOURLY_RE.exec(kind.expr)
    if (m === null) return
    const id = String(e.pipeline_id ?? '')
    const ms = dur.pipelines[baseId(id)] ?? dur.defaultMaxDurationMs
    hourly.push({ idx, id, expr: kind.expr, hours: `${m[2]}-${m[3]}`, dur: ms })
  })
  // 长管线先排，保证 dim.item 拿到 :02；同耗时按 id 稳定排序。
  hourly.sort((a, b) => b.dur - a.dur || a.id.localeCompare(b.id))
  /** @type {number[]} 每个窗口的下一可用分钟 */
  const cursor = WINDOWS.map((w) => w[0])
  /** @type {{ expr: string, id: string, minute: number, spansTick: boolean }[]} */
  const out = []
  for (const h of hourly) {
    const need = Math.ceil(h.dur / 60000) + 1
    let placed = false
    for (let w = 0; w < WINDOWS.length; w += 1) {
      const [lo, hi] = WINDOWS[w]
      const start = Math.max(cursor[w], lo)
      if (start + need - 1 <= hi) {
        cursor[w] = start + need
        out.push({ expr: `${start} ${h.hours} * * *`, id: h.id, minute: start, spansTick: false })
        placed = true
        break
      }
    }
    if (!placed) {
      // 超 7 分钟：放 :02，允许跨一个 tick；后续条目从它结束后的下一个窗口起排。
      const start = WINDOWS[0][0]
      const blocked = start + need
      for (let w = 0; w < WINDOWS.length; w += 1) {
        const [lo] = WINDOWS[w]
        if (lo < blocked) cursor[w] = Math.max(cursor[w], blocked)
      }
      out.push({ expr: `${start} ${h.hours} * * *`, id: h.id, minute: start, spansTick: true })
    }
  }
  return out.sort((a, b) => a.minute - b.minute || a.id.localeCompare(b.id))
}

/**
 * 生成一本排班的完整 JSON 文本（只改小时档的 `kind.expr`，其余逐字保留）。
 * @param {any[]} entries
 * @param {{ defaultMaxDurationMs: number, pipelines: Record<string, number> }} dur
 * @returns {{ text: string, assignments: ReturnType<typeof allocate> }}
 */
export function buildBook(entries, dur) {
  const assignments = allocate(entries, dur)
  const byId = new Map(assignments.map((a) => [a.id, a]))
  const next = entries.map((e) => {
    const a = byId.get(String(e.pipeline_id ?? ''))
    if (a === undefined || e.kind?.type !== 'cron') return e
    return { ...e, kind: { ...e.kind, expr: a.expr } }
  })
  return { text: `${JSON.stringify(next, null, 2)}\n`, assignments }
}

/** @param {string} s @returns {boolean} */
const isNumericBook = (s) => /^[0-9]+\.json$/.test(s)

function main() {
  const check = process.argv.includes('--check')
  const dur = readJson(DUR_PATH)
  const books = readdirSync(join(CONSOLE_DIR, 'schedules')).filter(isNumericBook).sort()
  let drift = 0
  for (const book of books) {
    const path = join(CONSOLE_DIR, 'schedules', book)
    const entries = readJson(path)
    const { text, assignments } = buildBook(entries, dur)
    const current = readFileSync(path, 'utf8')
    const spans = assignments.filter((a) => a.spansTick).map((a) => a.id)
    if (check) {
      if (current !== text) {
        drift += 1
        console.error(`SCHEDULE_DRIFT: ${path} 与 gen-schedules 不一致（改了耗时表/新增管线后重跑）`)
      }
      continue
    }
    writeFileSync(path, text)
    console.log(
      `gen-schedules: ${book} → ${assignments.length} 条小时档` +
        (spans.length > 0 ? `（跨 tick：${spans.join(', ')}）` : '')
    )
  }
  if (check) {
    if (drift > 0) process.exit(1)
    console.log(`gen-schedules: OK（${books.length} 本排班与耗时表一致）`)
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main()
