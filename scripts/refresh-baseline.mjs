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
// ⚠️ 2026-11-07 修：此前 dry-run **仍然写库**（`refreshBaseline` 恒写）——现在把 `write` 透传给
//    domain，两种模式的守卫（not_found / not_verified / compute_failed）与漂移计算同源。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runQuery } from '../modules/data/domain/query-service.ts'
import { regressionRequester, summarize } from '../modules/data/domain/verified-regression.ts'
import { driftPctOf, primaryValueOf, refreshBaseline } from '../modules/data/domain/verified-baseline-refresh.ts'
import { runWarehouseSql, warehousePool } from '../modules/data/domain/warehouse.ts'
import { loadAdoptedSources } from './tenant-sources.ts'

const { Pool } = createRequire(import.meta.url)('pg')

/**
 * 解析 `--key value` / `--key=value`。只认本 CLI 的五个键，未知键直接报错（拼错不静默）。
 * @param {string[]} argv
 * @returns {{org:string, ids:number[], by:string, reason:string, write:boolean}}
 */
export function parseArgs(argv) {
  /** @type {Record<string,string>} */
  const raw = {}
  let write = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (arg === '--write') { write = true; continue }
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq !== -1) { raw[arg.slice(2, eq)] = arg.slice(eq + 1); continue }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 缺值`)
    raw[arg.slice(2)] = value
    i += 1
  }
  const allowed = new Set(['org', 'ids', 'by', 'reason'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`未知参数 --${key}（只支持 --org / --ids / --by / --reason / --write）`)
  }
  const org = (raw.org ?? '').trim()
  if (org === '') throw new Error('缺 --org（必填：platform.tenant.casdoor_org）')
  const parts = (raw.ids ?? '').split(',').map((s) => s.trim())
  const ids = parts.map(Number)
  if (parts.some((p) => p === '') || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new Error(`--ids 必须是逗号分隔的正整数，收到 '${raw.ids ?? ''}'`)
  }
  const by = (raw.by ?? '').trim()
  const reason = (raw.reason ?? '').trim()
  if (by === '' || reason === '') throw new Error('--by 与 --reason 必填（刷新必须有人与原因）')
  return { org, ids, by, reason, write }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dsn = process.env.DATABASE_URL?.trim()
  if (!dsn) {
    console.error('缺 DATABASE_URL')
    process.exit(2)
  }

  const pool = new Pool({ connectionString: dsn })
  let code = 0
  try {
    const adoptedSources = await loadAdoptedSources(pool, args.org)
    /** @type {Array<Record<string, unknown>>} */
    const report = []
    for (const id of args.ids) {
      const out = await refreshBaseline(
        pool, args.org, id,
        { by: args.by, reason: args.reason },
        {
          write: args.write,
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
      if (!out.ok) code = 2
    }
    console.log(JSON.stringify({ mode: args.write ? 'WRITE' : 'DRY-RUN', org: args.org, by: args.by, report }, null, 1))
  } catch (e) {
    console.error(`refresh-baseline 跑不成: ${e instanceof Error ? e.message : String(e)}`)
    code = 2
  } finally {
    await pool.end()
  }
  process.exit(code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
