#!/usr/bin/env node
// gen-store-map.mjs — 生成 `--store-map` 的输入 CSV（门店 id → dim_branch.code）。
//
// 用法：
//   DATABASE_URL=postgres://… WUJI_APPID=… WUJI_KEY_STORE_INFO=… \
//     npx tsx scripts/gen-store-map.mjs --org <casdoor_org> [--out /path/store-map.csv]
//
// 链路（2026-11-23 实测：拆逗号后 206/206 命中）：
//   employee.store_info（可能是逗号分隔多门店串）→ store_info._id → store_info.store_name
//   → data.dim_branch.name → data.dim_branch.code
//
// 默认 dry-run：只打印统计 + 未匹配/歧义清单（前 20 条），不写文件；--out 才落 CSV。
// 名称精确匹配是保守的：dim 侧同名多 code ⇒ ambiguous（绝不猜）、源侧名字在 dim 侧没有 ⇒ unmatched。
// **未匹配/歧义必须人工裁决后补进 CSV**——一份缺口的映射会让员工门店归属错乱（B14 抓不到语义错，
// 只抓「没有 org」）。
//
// 安全：门店编码清单属业务数据，CSV **不进仓**（运维拿走后即用即弃）；凭据只在 env。
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { wujiFetchAll } from '../modules/aftersales/migration/wuji-source.ts'
import { cleanStore } from '../modules/aftersales/migration/clean.ts'
import { buildStoreMapCsv, matchStores } from '../modules/aftersales/migration/store-map.ts'

/** @param {string} name */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

async function main() {
  const org = arg('org')
  if (!org) throw new Error('需要 --org <casdoor_org>（dim_branch 是租户数据）')
  const appid = process.env.WUJI_APPID
  const schemakey = process.env.WUJI_KEY_STORE_INFO
  if (!appid || !schemakey) {
    throw new Error('需要 env WUJI_APPID + WUJI_KEY_STORE_INFO（键值只在 env，不落盘/不落仓）')
  }
  if (!process.env.DATABASE_URL) throw new Error('需要 DATABASE_URL（读 data.dim_branch）')

  const cfg = {
    origin: process.env.WUJI_DATA_ORIGIN ?? 'https://data.wujisite.com',
    appid,
    schemaid: 'store_info',
    schemakey,
    apiPath: process.env.WUJI_API_PATH ?? '/api/private/object',
  }

  const rows = await wujiFetchAll(fetch, cfg)
  const stores = rows
    .map((r) => cleanStore(r))
    .filter((s) => s.sourceId !== '' && s.name.trim() !== '')
  console.log(`[gen-store-map] 源门店 ${stores.length} 家（拉取 ${rows.length} 行）`)

  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    const { rows: dims } = await pool.query(
      'select code, name from data.dim_branch where org = $1',
      [org],
    )
    console.log(`[gen-store-map] dim_branch(${org}) ${dims.length} 家`)
    const result = matchStores(
      stores.map((s) => ({ sourceId: s.sourceId, name: s.name })),
      dims.map((/** @type {{ code: unknown, name: unknown }} */ d) => ({ code: String(d.code), name: String(d.name) })),
    )
    const total = result.matched.length + result.ambiguous.length + result.unmatched.length
    console.log(
      `[gen-store-map] 匹配 ${result.matched.length}/${total}`
      + `（歧义 ${result.ambiguous.length} / 未匹配 ${result.unmatched.length}）`,
    )
    for (const a of result.ambiguous.slice(0, 20)) {
      console.error(`  [歧义] ${a.sourceId} "${a.name}" → 候选 ${a.candidates.join(' / ')}`)
    }
    for (const u of result.unmatched.slice(0, 20)) {
      console.error(`  [未匹配] ${u.sourceId} "${u.name}"（dim 侧无同名门店）`)
    }
    if (result.matched.length !== total) {
      console.error('[gen-store-map] ⚠️ 有未闭合条目：人工裁决后手工补进 CSV，**覆盖率为 100% 前不要导入员工**')
    }

    const out = arg('out')
    if (out) {
      await writeFile(out, buildStoreMapCsv(result), 'utf8')
      console.log(`[gen-store-map] 已写 ${out}（${result.matched.length} 条；文件不进仓）`)
    } else {
      console.log('[gen-store-map] dry-run：未写文件（加 --out <path> 落 CSV）')
    }
  } finally {
    await pool.end()
  }
}

await main().catch((e) => {
  console.error(`gen-store-map: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
})
