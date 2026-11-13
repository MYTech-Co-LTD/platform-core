#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（同 scope-preflight.mjs / org-sync-all.mjs）：pg 经 createRequire
// 动态取，仓内 TS 域模块经动态 import（tsx 下可解析）；判据全在
// modules/data/domain/org-tree-check.ts 的 judgeOrgTree（纯函数，有单测），本壳只做取数与打印。
//
// check-org-tree.mjs — 组织树一致性检查（P2 Task 1，spec 2026-11-12 §17.1 前置门）。
//
// 只读：只 select platform.v_org_node / v_org_membership，零写入。
// 判据：环 / 悬挂父 / 重复 ext_id / 死节点挂人（四类 error）+ 深度>10 / 空支（仅告警）。
// 契约：errors 非空 ⇒ exit 1（P2 计划：errors=0 才允许后续任务合并；非 0 ⇒ 停波上报）；
//       只有告警 ⇒ exit 0（空分支合法）。
//
// 用法：
//   pnpm exec tsx scripts/check-org-tree.mjs                 # 全租户（--tenant all，默认）
//   pnpm exec tsx scripts/check-org-tree.mjs --tenant 3      # 只看一个租户（数字 id）
// 环境：DATABASE_URL（platform 库）。
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

const SCRIPT_NAME = 'check-org-tree'

/** 解析 --tenant；'all' 或正整数，非法返回 null（让 main 报用法错）。 */
export function parseTenant(raw) {
  const v = String(raw ?? 'all').trim()
  if (v === '' || v.toLowerCase() === 'all') return 'all'
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** 人读输出（不打印任何敏感值；org 数据本身非敏感）。错误/告警合一便于 CI 直接读 stdout。 */
export function formatReport(r) {
  const lines = []
  for (const w of r.warnings) lines.push(`  ⚠ ${w}`)
  for (const e of r.errors) lines.push(`  ✗ [${e.kind}] tenant ${e.tenantId}: ${e.detail}`)
  const head = r.errors.length > 0 ? 'FAIL' : 'OK'
  lines.push(
    `${SCRIPT_NAME}: ${head}（tenant ${r.tenantId} / nodes ${r.nodes} / `
    + `errors ${r.errors.length} / warnings ${r.warnings.length}）`,
  )
  return lines.join('\n')
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { tenant: { type: 'string', default: 'all' } },
    allowPositionals: false,
  })
  const tenant = parseTenant(values.tenant)
  if (tenant === null) {
    console.error(`${SCRIPT_NAME}: --tenant 只接受 all 或正整数，收到 ${JSON.stringify(values.tenant)}`)
    return 2
  }

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) {
    console.error(`${SCRIPT_NAME}: 缺 DATABASE_URL`)
    return 2
  }

  const { createRequire } = await import('node:module')
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const { checkOrgTree } = await import('../modules/data/domain/org-tree-check.ts')

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const report = await checkOrgTree(pool, tenant === 'all' ? undefined : tenant)
    console.log(formatReport(report))
    return report.errors.length > 0 ? 1 : 0
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`${SCRIPT_NAME} 不可执行:`, e instanceof Error ? e.message : e)
      process.exitCode = 2
    })
}
