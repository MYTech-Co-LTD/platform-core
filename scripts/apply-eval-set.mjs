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

/** window → bizday 区间；`default` 不带日期参数（用指标自己的缺省参数面）。 */
/** @param {string} window @param {string} asOf @returns {{from:string,to:string}|null} */
export function windowArgs(window, asOf) {
  if (window === 'yesterday') return { from: asOf, to: asOf }
  if (window === 'last7') return { from: shift(asOf, -6), to: asOf }
  if (window === 'mtd') return { from: `${asOf.slice(0, 7)}-01`, to: asOf }
  return null
}

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
/** @type {Array<{id:string,metricId:string,question:string,window:string,confirmed?:boolean}>} */
const all = Array.isArray(doc.items) ? doc.items : []
const confirmed = all.filter((i) => i.confirmed === true)
const skippedUnconfirmed = all.length - confirmed.length

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
    const range = windowArgs(item.window, beijingYesterday())
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
