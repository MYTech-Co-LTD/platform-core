#!/usr/bin/env node
// apply-eval-set.mjs —— W6 Task 4：把**人已确认的**评估集条目写进 `data.verified_questions`。
//
// 纪律（这是本脚本存在的理由）：
//   · 只接受 `--items <file.json>` 里 `confirmed: true` 的条目；没确认的一条都不写。
//   · 先**重放**一次 `runQuery` 生成基线；重放失败 ⇒ 该条不写（`--dry-run` 里会点名）。
//   · 写入两步：`upsertCandidate`（恒落 candidate）→ `setStatus(verified, by=<确认人>)`，
//     确认人必填（`--by`），审计要能回答「谁确认的」。
//   · `--dry-run` 只重放、不落库；默认也是 dry-run，必须显式 `--write` 才写。
//
// 用法：
//   DATABASE_URL=… DATA_WAREHOUSE_URL=… pnpm exec tsx scripts/apply-eval-set.mjs \
//     --org shanhaiyiguo-org --items docs/superpowers/notes/2026-11-06-w6-eval-set.items.json \
//     --by <确认人> [--write]
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { runQuery } from '../modules/data/domain/query-service.ts'
import { loadMergedCatalog } from '../modules/data/domain/metric-store.ts'
import { regressionRequester, summarize } from '../modules/data/domain/verified-regression.ts'
import { setStatus, upsertCandidate } from '../modules/data/domain/verified-questions.ts'
import { runWarehouseSql, warehousePool } from '../modules/data/domain/warehouse.ts'
import { loadAdoptedSources } from './tenant-sources.ts'

const { Pool } = createRequire(import.meta.url)('pg')

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{org: string, items: string, by: string, write: boolean}} */
  const out = { org: '', items: '', by: '', write: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') out.org = argv[i + 1] ?? ''
    else if (argv[i] === '--items') out.items = argv[i + 1] ?? ''
    else if (argv[i] === '--by') out.by = argv[i + 1] ?? ''
    else if (argv[i] === '--write') out.write = true
  }
  return out
}

/** 北京「昨天」（业务日基准与 query-service 的 en-CA 上海格式器同源）。 */
export function beijingYesterday(now = new Date()) {
  return new Date(now.getTime() - 86_400_000).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })
}

/** @param {string} date @param {number} days */
function shift(date, days) {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 区间是否**已封板**（右端 < 今天）。评估集的基线必须落在封闭期上：
 * 2026-11-06 真机实测——「近 7 天」含当天，30 分钟里行数从 633 涨到 868，基线必然分叉。
 * @param {{from:string,to:string}|null} range @param {string} today
 */
export function isClosedRange(range, today) {
  if (range === null) return true
  return range.to < today
}

/**
 * window → bizday 区间；`default` 不带日期参数（用指标自己的缺省参数面）。
 * `fixed` 用条目自带的 `from`/`to`（评估集只收**已封板**的固定历史区间）。
 */
/** @param {string} window @param {string} asOf @param {{from?:string,to?:string}} [item] @returns {{from:string,to:string}|null} */
export function windowArgs(window, asOf, item) {
  if (window === 'fixed') {
    const from = typeof item?.from === 'string' ? item.from : ''
    const to = typeof item?.to === 'string' ? item.to : ''
    return from !== '' && to !== '' ? { from, to } : null
  }
  if (window === 'yesterday') return { from: asOf, to: asOf }
  if (window === 'last7') return { from: shift(asOf, -6), to: asOf }
  if (window === 'mtd') return { from: `${asOf.slice(0, 7)}-01`, to: asOf }
  return null
}

/**
 * 评估集条目的**窗口卫生**（2026-11-07，#1583 的设计 §3.2）。
 *
 * 唯一不稳定的形态是 `default`：它不钉日期，直接用指标自身的缺省参数面——若缺省是
 * 「近 7 天/昨天」这类相对窗口，基线在**重放那天**必然分叉（真机 #3 连续 3 天红）。
 * `yesterday` / `last7` / `mtd` 在摄入时已由 `windowArgs` 解析成**绝对区间**，是稳定的。
 *
 * 返回 null = 可摄入；否则返回原因码（调用方逐条记进 report，不静默跳过）。
 * @param {string} window @param {{from?:string,to?:string}} item @param {string} today
 * @returns {null|'window_required'|'unknown_window'|'fixed_range_missing'|'open_period_not_stable'}
 */
export function windowErrorOf(window, item, today) {
  if (window === 'default') return 'window_required'
  if (!['fixed', 'yesterday', 'last7', 'mtd'].includes(window)) return 'unknown_window'
  if (window === 'fixed') {
    const range = windowArgs('fixed', today, item)
    if (range === null) return 'fixed_range_missing'
    if (!isClosedRange(range, today)) return 'open_period_not_stable'
  }
  return null
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.org === '' || args.items === '') {
    console.error('用法：--org <org> --items <file.json> [--by <确认人>] [--write]')
    process.exit(2)
  }
  const dsn = process.env.DATABASE_URL?.trim()
  if (!dsn) {
    console.error('缺 DATABASE_URL')
    process.exit(2)
  }
  const doc = JSON.parse(readFileSync(args.items, 'utf8'))
  /** @type {Array<{id:string,metricId:string,question:string,window:string,confirmed?:boolean,from?:string,to?:string}>} */
  const all = Array.isArray(doc.items) ? doc.items : []
  const confirmed = all.filter((i) => i.confirmed === true)
  const skippedUnconfirmed = all.length - confirmed.length
  const today = beijingYesterday()

  const pool = new Pool({ connectionString: dsn })
  try {
    // 源未接入 ⇒ runQuery 会以 `metric_not_declared` 拒掉每一条（真机踩过：空集合会让 33 条全拒）
    const adoptedSources = await loadAdoptedSources(pool, args.org)
    const catalog = await loadMergedCatalog(pool, args.org)
    const byId = new Map(catalog.map((m) => [m.id, m]))
    /** @type {Array<{id:string,metricId:string,question:string,ok:boolean,reason?:string,baseline?:unknown}>} */
    const report = []
    let written = 0

    for (const item of confirmed) {
      const metric = byId.get(item.metricId)
      if (metric === undefined) {
        report.push({ id: item.id, metricId: item.metricId, question: item.question, ok: false, reason: 'metric_not_found' })
        continue
      }
      // 窗口卫生（在重放前判）：`default`（无日期）会让相对窗口固化成滚动基线。
      const windowError = windowErrorOf(item.window, item, today)
      if (windowError !== null) {
        report.push({ id: item.id, metricId: item.metricId, question: item.question, ok: false, reason: windowError })
        continue
      }
      const range = windowArgs(item.window, today, item)
      const queryArgs = range === null ? {} : { bizday: range }
      // params 是 jsonb 反序列化后的**对象**（键 = 参数名），不是数组
      const paramsFace = metric.params !== null && typeof metric.params === 'object' ? metric.params : {}
      if (range !== null && !Object.prototype.hasOwnProperty.call(paramsFace, 'bizday')) {
        report.push({ id: item.id, metricId: item.metricId, question: item.question, ok: false, reason: 'metric_has_no_bizday_param' })
        continue
      }
      const requester = regressionRequester(args.org)
      const r = await runQuery(
        {
          pool,
          adoptedSources,
          tool: 'apply_eval_set',
          /** @param {string} sql */
          execute: (sql) => runWarehouseSql(warehousePool(), sql),
        },
        args.org, requester, item.metricId, queryArgs, {},
      ).catch((e) => /** @type {import('../modules/data/domain/query-service.ts').QueryError} */ ({
        status: 'error', metricId: item.metricId, reason: 'warehouse_error', detail: String(e?.message ?? e),
      }))
      if (r.status !== 'ok') {
        const reason = 'reason' in r ? String(r.reason) : 'query_failed'
        report.push({ id: item.id, metricId: item.metricId, question: item.question, ok: false, reason: `query_failed: ${reason}`.slice(0, 120) })
        continue
      }
      const baseline = summarize(r)
      if (args.write) {
        const id = await upsertCandidate(pool, args.org, {
          question: item.question,
          metricId: item.metricId,
          params: queryArgs,
          slicing: {},
          baseline,
          source: 'human',
          strength: 'strong',
        })
        await setStatus(pool, args.org, id, 'verified', args.by)
        written += 1
      }
      report.push({ id: item.id, metricId: item.metricId, question: item.question, ok: true, baseline: baseline.summary?.value ?? null })
    }

    console.log(JSON.stringify({
      mode: args.write ? 'WRITE' : 'DRY-RUN',
      org: args.org,
      confirmed: confirmed.length,
      skippedUnconfirmed,
      written,
      ok: report.filter((r) => r.ok).length,
      failed: report.filter((r) => !r.ok).length,
      report,
    }, null, 1))
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`apply-eval-set: FAIL ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 1
  })
}
