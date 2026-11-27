#!/usr/bin/env node
// recon-gap-restate.mjs — 对账**「缺整天」**的自愈驱动（#2742 第②刀；平台调度器 `data.recon_restate`）
//
// ── 它补的是哪一格 ────────────────────────────────────────────────────────────
// 对账链路对「某一天」有两种失败，性质完全不同（`deploy/jobs.md` §1.1 第③问 + 判据拆分）：
//   · **gap**：这天在 `recon_break` 里**根本没有行** ⇒ 源快照当天没落湖。**无需判别**，
//     直接按日重触发 console 回填即可 —— 本脚本只管这一半。
//   · **diff**：台账有行但不平（如 64188 2026-11-19）⇒ 要逐小时比行数判「真缺口 vs 通道坏」，
//     那是宿主编排脚本 `lemeng-recon-restate` + `recon-day-heal` + `diagnose.sh` 的活
//     （65KB 宿主 shell，同时是人工排障工具）⇒ **暂留 openship**，退役条件见 `deploy/jobs.md`。
//
// 为什么 gap 这半边不需要 diagnose：这天是**空的**，「判别」没有对象；重采就是答案。
//
// ── 闭环怎么接上 ──────────────────────────────────────────────────────────────
// 本 job（CST 03:50）只负责**把源快照重新拿回来**；随后 04:30 的 `data.recon_ledger_guard`
// 会重建 `recon_fact/recon_break/recon_run` ⇒ 第二天 ⑪ 自然转绿。**本脚本不碰 dbt、不判口径。**
//
// ── 选日判据（与 `lemeng-recon-restate.sh` 的 `kind=gap` 逐字同源）────────────────
// 窗口 = T-3 .. T-9（只取已定稿日；更新的源还在变，重采是白采），对每个账套：
//   ① 该日在 `recon_run` 里没有行；
//   ② 该日在 `recon_break` 里也没有行（有行的是 `ledger_stale`，归 `data.recon_ledger_guard`）；
//   ③ 平台侧该日**有营业**（`fct_retail_sale` 有行）——两侧全空是闭店，不该有台账（`nobiz`）。
//
// 退出码：0 = 无缺口，或全部 pass/skip；1 = 有缺口没能补上；2 = 缺 env。
// 用法：DATA_WAREHOUSE_URL=… DUCKLE_TOKEN=… node scripts/lemeng/recon-gap-restate.mjs [--dry-run]

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { dateLiteral, shanghaiDaysAgo } from '../lib/time-semantics.mjs'

const TOKEN = process.env.DUCKLE_TOKEN ?? ''
const PIPELINE = 'pipelines/lemeng.recon.preagg.backfill.json'
const CONSOLES = [
  { book: '3120', base: process.env.CONSOLE_3120_URL ?? 'http://lemeng-console-3120:18080' },
  { book: '64188', base: process.env.CONSOLE_64188_URL ?? 'http://lemeng-console-64188:18081' },
]
const POLL_MS = 3000
const PER_RUN_TIMEOUT_MS = Number(process.env.RECON_GAP_RUN_TIMEOUT_MS ?? 240_000)
const SETTLE_DAYS = 3
const WINDOW_DAYS = 7

/** @param {any} root */
function loadPg(root) {
  // 从 scripts/lemeng/ 直接 createRequire(...)('pg') 会 MODULE_NOT_FOUND（pnpm 布局），按包回退。
  for (const base of [
    import.meta.url,
    pathToFileURL(`${root}/apps/server/package.json`).href,
    pathToFileURL(`${root}/modules/data/package.json`).href,
  ]) {
    try { return createRequire(base)('pg') } catch { /* next */ }
  }
  throw new Error('找不到 pg 模块（试过 scripts/、apps/server、modules/data）')
}

/**
 * 选日 SQL：与 `lemeng-recon-restate.sh` 的 `kind=gap` 同源（① 无台账 ② 无 break ③ 平台侧有营业）。
 * 抽成纯函数便于机检这**三个条件都在**——去掉任一条都会把 `ledger_stale` / `nobiz` 误当 gap。
 * @param {string} lo `YYYY-MM-DD`（窗口下界）
 * @param {string} hi `YYYY-MM-DD`（窗口上界）
 * @returns {string}
 */
export function gapSql(lo, hi) {
  return `
with w as (select ${dateLiteral(lo)} as lo, ${dateLiteral(hi)} as hi),
books as (select distinct system_book from staging.recon_run where bizday > current_date - 30),
d as (select b.system_book, g::date as bizday
        from books b, w, generate_series(w.lo::timestamp, w.hi::timestamp, interval '1 day') g),
pd as (select cast(f.system_book as varchar) as system_book, f.bizday
         from staging.fct_retail_sale f, w
        where f.bizday between w.lo and w.hi
        group by 1, 2)
select d.system_book, to_char(d.bizday, 'YYYY-MM-DD') as bizday
  from d
 where exists (select 1 from pd where pd.system_book = d.system_book and pd.bizday = d.bizday)
   and not exists (select 1 from staging.recon_run r where r.system_book = d.system_book and r.bizday = d.bizday)
   and not exists (select 1 from staging.recon_break b where b.system_book = d.system_book and b.bizday = d.bizday)
 order by 2, 1`
}

/** console `run/async` 的请求体（与 `recon-monthly.mjs` 同形）。 @param {string} day @returns {any} */
export function triggerBody(day) {
  return { file: PIPELINE, params: { BIZDAY: day } }
}

/**
 * 把一次 run 的结果归类：pass / skip（依赖不可用=合法空窗）/ fail。
 * ⚠️ 与 `recon-monthly.mjs` 同一判据：`lake_unavailable` 是「该日零销或天文件未封版」，不判红。
 * @param {any} result console 返回的 `result` 对象
 * @returns {'pass'|'skip'|'fail'}
 */
export function classifyRun(result) {
  if (result && result.status === 'ok') return 'pass'
  const err = String(result?.error ?? '')
  if (/lake_unavailable|query returned 0 records|依赖不可用/i.test(err)) return 'skip'
  return 'fail'
}

/** @param {string} url @param {unknown} body @returns {Promise<any>} */
async function postJson(url, body) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

/** @param {string} url @returns {Promise<any>} */
async function getJson(url) {
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/**
 * 触发一天的回填并等它跑完。
 * @param {string} base console 基址
 * @param {string} day
 * @returns {Promise<{verdict: 'pass'|'skip'|'fail'|'unavailable', detail: string}>}
 */
async function runOneDay(base, day) {
  const started = Date.now()
  /** @type {string|undefined} */
  let runId
  try {
    const j = await postJson(`${base}/api/run/async`, triggerBody(day))
    runId = j.runId
    if (!runId) return { verdict: 'fail', detail: `trigger 未返回 runId：${JSON.stringify(j).slice(0, 160)}` }
  } catch (e) {
    return { verdict: 'unavailable', detail: `trigger 失败：${String(e).slice(0, 160)}` }
  }
  /** @type {any} */
  let st = {}
  while (Date.now() - started < PER_RUN_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    try {
      st = await getJson(`${base}/api/run/status?runId=${encodeURIComponent(runId)}`)
    } catch (e) {
      return { verdict: 'unavailable', detail: `轮询失败：${String(e).slice(0, 160)}` }
    }
    if (st.state === 'finished') break
  }
  if (st.state !== 'finished') return { verdict: 'unavailable', detail: `超时 ${PER_RUN_TIMEOUT_MS}ms run=${runId}` }
  const v = classifyRun(st.result ?? {})
  return { verdict: v, detail: v === 'pass' ? `run=${runId}` : String(st.result?.error ?? '').slice(0, 200) }
}

async function main() {
  if (!TOKEN) {
    console.error('RECON_GAP_RESTATE_FAILED: DUCKLE_TOKEN 未注入（worker 容器应自带）')
    process.exit(2)
  }
  const warehouse = process.env.DATA_WAREHOUSE_URL
  if (!warehouse) {
    console.error('RECON_GAP_RESTATE_FAILED: DATA_WAREHOUSE_URL 未注入')
    process.exit(2)
  }
  const dry = process.argv.includes('--dry-run')
  const root = new URL('../..', import.meta.url).pathname
  const hi = shanghaiDaysAgo(SETTLE_DAYS)
  const lo = shanghaiDaysAgo(SETTLE_DAYS + WINDOW_DAYS - 1)

  const { Pool } = loadPg(root)
  const pool = new Pool({ connectionString: warehouse, statement_timeout: 120_000 })
  /** @type {Array<{system_book: string, bizday: string}>} */
  let gaps = []
  try {
    const r = await pool.query(gapSql(lo, hi))
    gaps = r.rows
  } finally {
    await pool.end().catch(() => {})
  }

  console.log(`RECON_GAP_RESTATE_PLAN window=${lo}..${hi} gaps=${gaps.length}`
    + (gaps.length ? ` days=${gaps.map((g) => `${g.system_book}/${g.bizday}`).join(',')}` : ''))
  if (gaps.length === 0) {
    console.log('RECON_GAP_RESTATE_OK gaps=0')
    return 0
  }
  if (dry) {
    console.log(`RECON_GAP_RESTATE_DRY gaps=${gaps.length}（未触发）`)
    return 0
  }

  /** @type {{pass: number, skip: number, fail: number, unavailable: number}} */
  const sum = { pass: 0, skip: 0, fail: 0, unavailable: 0 }
  for (const g of gaps) {
    const console_ = CONSOLES.find((c) => c.book === String(g.system_book))
    if (!console_) {
      console.log(`RECON_GAP_RESTATE_DAY book=${g.system_book} day=${g.bizday} verdict=unavailable reason=no_console`)
      sum.unavailable += 1
      continue
    }
    const { verdict, detail } = await runOneDay(console_.base, g.bizday)
    console.log(`RECON_GAP_RESTATE_DAY book=${g.system_book} day=${g.bizday} verdict=${verdict} ${detail}`)
    sum[verdict] += 1
  }

  const bad = sum.fail + sum.unavailable
  console.log(`RECON_GAP_RESTATE_${bad === 0 ? 'OK' : 'PARTIAL'} gaps=${gaps.length} pass=${sum.pass} skip=${sum.skip} fail=${sum.fail} unavailable=${sum.unavailable}`)
  if (bad > 0) return 1
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code))
}
