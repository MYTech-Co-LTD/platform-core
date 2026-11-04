#!/usr/bin/env node
// scripts/archive-private-measures.mjs — 私有测度 30 天热度淘汰的薄 CLI（供 openship job 调用）。
// 判定与 SQL 在 modules/data/domain/private-measure-lifecycle.ts；本文件只做参数/连接/输出。
//
// 用法：
//   DATABASE_URL=postgresql://… npx tsx scripts/archive-private-measures.mjs --org <casdoor-org> [--days 30]
//
// --org 必填：淘汰是租户级动作（所有 SQL 都带 org）；别用「不传 = 全租户」的静默默认。
// 退出码：0 成功；2 参数/连库/执行失败。
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  PRIVATE_MEASURE_ARCHIVE_DAYS,
  archiveStalePrivateMeasures,
} from '../modules/data/domain/private-measure-lifecycle.ts'

/**
 * 解析 CLI 参数。
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {{ org: string, days: number } | null} 非法/缺 --org ⇒ null
 */
function parseArgs(argv) {
  let org = ''
  let days = PRIVATE_MEASURE_ARCHIVE_DAYS
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    const value = argv[i + 1]
    if (key === '--org') {
      if (value === undefined || value === '' || value.startsWith('--')) return null
      org = value
      i += 1
    } else if (key === '--days') {
      const n = Number(value)
      if (!Number.isInteger(n) || n < 1) return null
      days = n
      i += 1
    } else {
      return null
    }
  }
  return org === '' ? null : { org, days }
}

const usage = '用法: DATABASE_URL=… npx tsx scripts/archive-private-measures.mjs --org <casdoor-org> [--days 30]'

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2))
  if (args === null) {
    console.error(`archive-private-measures: 参数不合法\n${usage}`)
    process.exit(2)
  }
  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('archive-private-measures: 缺 DATABASE_URL（从 openship 项目 env 取，勿 SSH 读机器状态）')
    process.exit(2)
  }
  const { Pool } = createRequire(import.meta.url)('pg')
  const pool = new Pool({ connectionString: url })
  /** @type {number} */
  let exitCode = 0
  try {
    const archived = await archiveStalePrivateMeasures(pool, args.org, args.days)
    console.log(`archive-private-measures: org=${args.org} days=${args.days} archived=${archived.length}`)
    for (const id of archived) console.log(`  ${id}`)
  } catch (e) {
    console.error('archive-private-measures 执行失败:', e instanceof Error ? e.message : e)
    exitCode = 2
  } finally {
    // 先 end 再 exit：在 try/finally 里直接 process.exit 会跳过 finally（连接池不关）
    await pool.end()
  }
  process.exit(exitCode)
}
