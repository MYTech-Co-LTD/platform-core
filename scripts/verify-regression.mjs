#!/usr/bin/env node
// scripts/verify-regression.mjs — 已验问答回归 CLI（W1 Task 3 的薄壳）。
//
// 逻辑全在 modules/data/domain/verified-regression.ts（纯函数 + 重放编排）；本文件只做：
// 参数解析 → 建池 → 装配 adoptedSources → 跑 → 逐条打印 + 汇总 → 退出码。
//
// 用法（**必须在有仓库 env 的运行环境**跑：平台容器 / openship job。重放走 runQuery 的
// 缺省执行器 = 真仓库，惰性连接）：
//   DATABASE_URL=postgres://… npx tsx scripts/verify-regression.mjs --org <casdoor_org> [--limit N] [--ids 1,2,3]
//
// 退出码：0 全部 pass；1 有 fail / error；2 环境或账本问题（缺 DATABASE_URL、未知租户、
//         回归集为空、查询异常）。**空回归集不判绿**——没有基线就没有可信度，假绿比红危险。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { runRegression } from '../modules/data/domain/verified-regression.ts'
// 平台侧装配（读 platform.tenant / tenant_source）：B1 不许 modules/** 读 platform 物理表，
// 故这段 SQL 在 scripts/tenant-sources.ts，由本脚本解析后把值注入 runRegression。
import { loadAdoptedSources } from './tenant-sources.ts'

/**
 * 解析 `--key value` / `--key=value`。只认本 CLI 的三个键，未知键直接报错（拼错参数不该静默忽略）。
 * @param {string[]} argv
 * @returns {{ org: string, limit?: number, ids?: number[] }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const raw = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === undefined) continue
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`)
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      raw[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`参数 ${arg} 缺值`)
    raw[arg.slice(2)] = value
    i += 1
  }

  const allowed = new Set(['org', 'limit', 'ids'])
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) throw new Error(`未知参数 --${key}（只支持 --org / --limit / --ids）`)
  }
  const org = (raw.org ?? '').trim()
  if (org === '') throw new Error('缺 --org（必填：platform.tenant.casdoor_org）')

  /** @type {{ org: string, limit?: number, ids?: number[] }} */
  const out = { org }
  if (raw.limit !== undefined) {
    const limit = Number(raw.limit)
    if (!Number.isInteger(limit) || limit < 0) throw new Error(`--limit 必须是非负整数，收到 '${raw.limit}'`)
    out.limit = limit
  }
  if (raw.ids !== undefined) {
    const ids = raw.ids.split(',').map((s) => s.trim()).filter((s) => s !== '').map(Number)
    if (ids.length === 0 || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
      throw new Error(`--ids 必须是逗号分隔的正整数，收到 '${raw.ids}'`)
    }
    out.ids = ids
  }
  return out
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('verify-regression: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }

  /** @type {{ org: string, limit?: number, ids?: number[] }} */
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(`verify-regression: ${e instanceof Error ? e.message : e}`)
    process.exit(2)
  }

  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  try {
    // QueryDeps.adoptedSources 必填：不装配就会把本租户所有源都裁掉（全量假红），故先解析。
    const adoptedSources = await loadAdoptedSources(pool, args.org)
    const results = await runRegression({ pool, adoptedSources }, args.org, {
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
      ...(args.ids !== undefined ? { ids: args.ids } : {}),
    })

    for (const r of results) {
      const tail = r.diffs.length === 0 ? '' : `  — ${r.diffs.join('; ')}`
      console.log(`${r.result.padEnd(5)} #${r.id} ${r.metricId}  ${r.question}${tail}`)
    }
    const count = (/** @type {'pass'|'fail'|'error'} */ result) =>
      results.filter((r) => r.result === result).length
    console.log(
      `verify-regression: total=${results.length} pass=${count('pass')} `
      + `fail=${count('fail')} error=${count('error')}`)

    if (results.length === 0) {
      console.error('verify-regression: 回归集为空——没有基线就没有可信度，不判绿')
      process.exit(2)
    }
    process.exit(count('pass') === results.length ? 0 : 1)
  } catch (e) {
    console.error('verify-regression 跑不成:', e instanceof Error ? e.message : e)
    process.exit(2)
  } finally {
    await pool.end()
  }
}
