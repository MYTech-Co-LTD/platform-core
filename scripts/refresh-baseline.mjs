#!/usr/bin/env node
// refresh-baseline.mjs —— W6 Task 4：刷新回归基线（带操作人 + 原因，写 `baseline_refreshed_*`）。
//
// 什么时候用：数据回填/退货冲减/补采之后，老基线与当前值分叉，回归报红——那是**基线过期**，
// 不是口径错。刷新 = 用当前数据重放一次，把基线换成新的，并把「谁、何时、为什么」写进表。
//
// 用法（必须显式 --ids；不做「全量刷新」，那会把真正的口径漂移也一起刷掉）：
//   DATABASE_URL=… DATA_WAREHOUSE_URL=… pnpm exec tsx scripts/refresh-baseline.mjs \
//     --org shanhaiyiguo-org --ids 3 --by ylwzzs --reason "10 月数据回填后基线过期" [--write]
//
// 默认 dry-run（只重放、打印漂移）；`--write` 才落库。
import { createRequire } from 'node:module'
import { runQuery } from '../modules/data/domain/query-service.ts'
import { regressionRequester, summarize } from '../modules/data/domain/verified-regression.ts'
import { driftPctOf, primaryValueOf, refreshBaseline } from '../modules/data/domain/verified-baseline-refresh.ts'
import { runWarehouseSql, warehousePool } from '../modules/data/domain/warehouse.ts'
import { loadAdoptedSources } from './tenant-sources.ts'

const { Pool } = createRequire(import.meta.url)('pg')

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{org:string, ids:string, by:string, reason:string, write:boolean}} */
  const out = { org: '', ids: '', by: '', reason: '', write: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--org') out.org = argv[i + 1] ?? ''
    else if (argv[i] === '--ids') out.ids = argv[i + 1] ?? ''
    else if (argv[i] === '--by') out.by = argv[i + 1] ?? ''
    else if (argv[i] === '--reason') out.reason = argv[i + 1] ?? ''
    else if (argv[i] === '--write') out.write = true
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const ids = args.ids.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
if (args.org === '' || ids.length === 0 || args.by === '' || args.reason === '') {
  console.error('用法：--org <org> --ids 3,12 --by <操作人> --reason "<原因>" [--write]')
  process.exit(2)
}
const dsn = process.env.DATABASE_URL?.trim()
if (!dsn) {
  console.error('缺 DATABASE_URL')
  process.exit(2)
}

const pool = new Pool({ connectionString: dsn })
try {
  const adoptedSources = await loadAdoptedSources(pool, args.org)
  /** @type {Array<Record<string, unknown>>} */
  const report = []
  for (const id of ids) {
    const out = await refreshBaseline(
      pool, args.org, id,
      { by: args.by, reason: args.reason },
      {
        compute: async (row) => {
          const queryArgs = (row.params !== null && typeof row.params === 'object') ? /** @type {Record<string, unknown>} */ (row.params) : {}
          const slicing = (row.slicing !== null && typeof row.slicing === 'object') ? /** @type {Record<string, unknown>} */ (row.slicing) : {}
          const res = await runQuery(
            {
              pool,
              adoptedSources,
              tool: 'refresh_baseline',
              /** @param {string} sql */
              execute: (sql) => runWarehouseSql(warehousePool(), sql),
            },
            args.org, regressionRequester(args.org), row.metricId, queryArgs, slicing,
          )
          if (res.status !== 'ok') throw new Error(`replay ${res.status}: ${res.reason ?? ''}`)
          return summarize(res)
        },
        ...(args.write ? {} : {}),
      },
    )
    report.push({
      id,
      ok: out.ok,
      reason: out.reason ?? null,
      before: primaryValueOf(out.before),
      after: primaryValueOf(out.after),
      driftPct: out.driftPct ?? driftPctOf(out.before, out.after),
      wrote: args.write && out.ok,
    })
  }
  console.log(JSON.stringify({ mode: args.write ? 'WRITE' : 'DRY-RUN', org: args.org, by: args.by, report }, null, 1))
} finally {
  await pool.end()
}
