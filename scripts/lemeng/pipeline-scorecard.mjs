#!/usr/bin/env node
// @ts-nocheck —— 调度器入口薄壳：判定本体仍是 `deploy/duckle/console/pipeline-scorecard.py`（python，只读）。
//
// pipeline-scorecard.mjs —— 采集健康 scorecard 判据化（#2600，Wave 8 ④）。
//
// 与两条 openship job（`pipeline-scorecard-3120` / `-64188`）的差别只有三处，**判据一行不改**：
//   ① 账套清单在仓内循环（一条 job 跑两账套），不再按账套复制 job 副本；
//   ② 不 `docker cp` / `docker exec`：console workspace 以**命名卷只读**挂进本容器
//      （`/data/ws3120`、`/data/ws64188`）⇒ 不需要 docker sock，也不需要 console 在场；
//   ③ 判红结论进 OO `data_plane_probes`（逐管线一行），不再只靠退出码 + job 通知
//      （job 通知不进站内 deliveries feed ⇒ 事实上静默，2026-11-07 实测）。
//
// 退出码（与现役 python 判据同语义）：
//   0 = 全 GREEN/AMBER 且无 UNKNOWN
//   1 = 至少一条 RED 或 UNKNOWN（=`pipeline-scorecard.py` 的判定）
//   2 = 跑不成（工作区不可达 / python 起不来 / 输出不可解析）——**这类必须响亮**，
//       因为「0 条管线跑绿」和「根本没读到工作区」在退出码 0 上长得一模一样。
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { emitFailure, emitProbe } from '../probe-emit.mjs'

/** 与现役两条 openship job 一致的账套清单（写死便于审阅；`SCORECARD_BOOKS` 可覆盖）。 */
export const DEFAULT_BOOKS = ['3120', '64188']

/** console workspace 在容器里的读点（compose 把命名卷只读挂在这里）。 */
export const DEFAULT_WS_ROOT = '/data'

/** 判据本体（仓内路径，镜像 WORKDIR=/app）。 */
export const SCORECARD_SCRIPT = 'deploy/duckle/console/pipeline-scorecard.py'

/**
 * 账套清单：逗号/空白分隔；空串或全非法 ⇒ 抛错（**不许静默跑 0 个账套**——空跑成功就是假绿）。
 * @param {string|undefined} raw
 * @returns {string[]}
 */
export function parseBooks(raw) {
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_BOOKS]
  const books = raw.split(/[\s,]+/).map((s) => s.trim()).filter((s) => s !== '')
  if (books.length === 0) throw new Error(`SCORECARD_BOOKS 解析为空：${JSON.stringify(raw)}`)
  for (const b of books) {
    if (!/^[0-9A-Za-z_-]+$/.test(b)) throw new Error(`账套号非法：${JSON.stringify(b)}`)
  }
  return books
}

/**
 * 某账套的 workspace 读点。
 * @param {string} book
 * @param {Record<string, string|undefined>} [env]
 */
export function workspaceFor(book, env = process.env) {
  const root = (env.SCORECARD_WS_ROOT ?? '').trim() || DEFAULT_WS_ROOT
  return join(root, `ws${book}`)
}

/**
 * 判据行 → 探针行（纯函数）。**只投非 GREEN**：GREEN 是常态，投它只会在预警面制造噪声。
 *
 * 映射：RED→ERR、AMBER→WARN、UNKNOWN→UNKNOWN（排班里启用但从未跑过 —— 也是要人看一眼的）。
 * @param {string} book
 * @param {Array<({pipeline?: string, level?: string, status?: string|null, last_ok_at?: string|null, error?: string|null}|null)>} rows
 * @returns {Array<{probe:string, check:string, verdict:'ERR'|'WARN'|'UNKNOWN', detail:string}>}
 */
export function probeRows(book, rows) {
  const out = []
  for (const r of rows ?? []) {
    const level = String(r?.level ?? '').toUpperCase()
    const verdict = level === 'RED' ? 'ERR' : level === 'AMBER' ? 'WARN' : level === 'UNKNOWN' ? 'UNKNOWN' : null
    if (!verdict) continue
    const pipeline = String(r?.pipeline ?? '?')
    const detail = [
      `level=${level}`,
      `status=${r?.status ?? '?'}`,
      `last_ok=${r?.last_ok_at ?? '-'}`,
      r?.error ? `error=${String(r.error).slice(0, 160)}` : '',
    ].filter(Boolean).join(' ')
    out.push({ probe: 'scorecard', check: `scorecard:${book}:${pipeline}`, verdict, detail })
  }
  return out
}

/** 汇总（供台账 output_tail 一眼读数）。 */
export function summarize(rows) {
  const count = (lv) => (rows ?? []).filter((r) => String(r?.level ?? '').toUpperCase() === lv).length
  return { total: (rows ?? []).length, red: count('RED'), amber: count('AMBER'), unknown: count('UNKNOWN') }
}

/** 判据 argv（纯函数，单测用）。`--json` 是机器读的唯一形态。 */
export function scorecardArgv() {
  return [SCORECARD_SCRIPT, '--json']
}

/**
 * 跑一个账套的判据。返回 `{rows, rc, output}`；跑不成时 `rows=null`（调用方据此判 2）。
 * @param {string} book
 * @param {{env?: Record<string, string|undefined>, spawn?: typeof spawnSync, ws?: string}} [opts]
 */
export function runBook(book, opts = {}) {
  const env = opts.env ?? process.env
  const spawn = opts.spawn ?? spawnSync
  const ws = opts.ws ?? workspaceFor(book, env)
  if (!existsSync(ws)) {
    return { rows: null, rc: 2, output: `SCORECARD_WS_MISSING ${ws}（compose 是否把命名卷挂进来？）` }
  }
  const r = spawn('python3', scorecardArgv(), {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...env, DUCKLE_WORKSPACE: ws },
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  if (r.error) return { rows: null, rc: 2, output: `SCORECARD_DEP_FAILED spawn: ${r.error.message}` }
  let rows = null
  try {
    rows = JSON.parse(String(r.stdout ?? ''))
  } catch {
    rows = null
  }
  if (!Array.isArray(rows)) {
    return { rows: null, rc: 2, output: `SCORECARD_PARSE_FAILED rc=${r.status}\n${output.slice(-400)}` }
  }
  return { rows, rc: r.status ?? 2, output }
}

async function main() {
  let books
  try {
    books = parseBooks(process.env.SCORECARD_BOOKS)
  } catch (e) {
    console.error(`SCORECARD_CONFIG_FAILED: ${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
  let rc = 0
  for (const book of books) {
    const { rows, rc: bookRc, output } = runBook(book)
    if (!rows) {
      console.error(output)
      console.error(`SCORECARD_BOOK_FAILED book=${book}`)
      if (process.env.NODE_ENV !== 'test') await emitFailure(`scorecard:${book}:run`, output.slice(-300))
      rc = 2
      continue
    }
    const s = summarize(rows)
    console.log(`scorecard ${book}: ${s.total} pipelines · RED=${s.red} AMBER=${s.amber} UNKNOWN=${s.unknown}`)
    for (const r of rows) {
      if (String(r?.level ?? '').toUpperCase() === 'GREEN') continue
      console.log(`  ${r.level}  ${r.pipeline}  last_ok=${r.last_ok_at ?? '-'}  ${r.error ? `err=${String(r.error).slice(0, 80)}` : ''}`)
    }
    if (bookRc === 1 && rc === 0) rc = 1
    // 判红行进预警面（桥按 12h 冷却转企微）；投递失败只打 stderr，不改判定。
    if (process.env.NODE_ENV !== 'test') {
      for (const row of probeRows(book, rows)) {
        const r = await emitProbe(row)
        if (!r.ok) console.error(`probe-emit: 未投递（${row.check}）：${r.error ?? 'unknown'}`)
      }
    }
  }
  console.log(`SCORECARD_DONE rc=${rc} books=${books.join(',')}`)
  return rc
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exit(await main())
}
