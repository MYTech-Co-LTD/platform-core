// wire-check-crosshost.mjs — 跨机拆分后的「平台 → 仓库」接线复查（在**应用容器内**跑）
//
// 为什么单独一个：`scripts/lemeng/wire-warehouse.sh` 假设平台容器与 pg_duckdb 容器**同机**
// （它的 ①DNS ②TCP 两条断言靠 docker 网络的 `pg_duckdb` 服务名，重做模式还要
// `docker network connect`）。2026-11-19 W4 把应用单元迁到 10.0.0.3 之后，这个前提不成立了：
// 连接改走数据机发布的 TCP 端口，`DATA_WAREHOUSE_URL` 里有真实地址。
//
// 本脚本只保留**跨机仍然成立、且真正有判别力**的断言：
//   ① 能连上 DATA_WAREHOUSE_URL
//   ② 仓库角色的 search_path 折叠了 `staging`（掉了的报错是 `relation "<模型名>" does not exist`，
//      看着像「表不存在」，其实是解析不到 schema —— 2026-09-28 实测踩过）
//   ③ 不带 schema 的真查询能出数
//
// 用法（在应用容器内）：
//   node scripts/lemeng/wire-check-crosshost.mjs
//   node scripts/lemeng/wire-check-crosshost.mjs --table fct_retail_sale --schema staging
// 退出码：0 = 全过；1 = 断言不过；2 = 用法/环境错。
import { createRequire } from 'node:module'

// `pg` 在 pnpm workspace 下装在**各包**里（`/app/apps/server/node_modules`），从仓根的
// `scripts/` 目录做 ESM 解析找不到它。用 createRequire 从宿主包里解析；环境变量可覆盖。
const APP_DIR = process.env.WIRE_APP_DIR || '/app/apps/server'
const { Client } = createRequire(`${APP_DIR}/package.json`)('pg')

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const TABLE = opt('table', 'fct_retail_sale')
const SCHEMA = opt('schema', 'staging')

if (args.includes('--help')) {
  console.log('用法: node scripts/lemeng/wire-check-crosshost.mjs [--table <t>] [--schema <s>]')
  process.exit(0)
}

const url = process.env.DATA_WAREHOUSE_URL
if (!url) {
  console.error('WIRE_FAILED: 缺 DATA_WAREHOUSE_URL（本检查必须在应用容器内跑）')
  process.exit(2)
}

let failed = 0
const ok = (m) => console.log(`OK   ${m}`)
const bad = (m) => { console.log(`FAIL ${m}`); failed += 1 }

const c = new Client({ connectionString: url })
try {
  await c.connect()
  ok('① 连接 DATA_WAREHOUSE_URL')
} catch (e) {
  bad(`① 连接失败：${e.message}`)
  console.log('WIRE_FAILED: 平台连不到仓库 —— 问数会全挂')
  process.exit(1)
}

try {
  const sp = (await c.query('show search_path')).rows[0].search_path
  if (sp.split(',').map((s) => s.trim()).includes(SCHEMA)) ok(`② search_path=${sp}`)
  else bad(`② search_path 不含 ${SCHEMA}：${sp}（掉了的表现是 relation "…" does not exist）`)
} catch (e) {
  bad(`② 读 search_path 失败：${e.message}`)
}

try {
  // 故意**不带 schema**：这正是消费方编译出来的形状，能出数才说明 ② 真的生效
  const r = await c.query(`select count(*)::int as n from ${TABLE}`)
  ok(`③ 不带 schema 的查询 ${TABLE} → rows=${r.rows[0].n}`)
} catch (e) {
  bad(`③ 查询 ${TABLE} 失败：${e.message}`)
}

await c.end()

if (failed > 0) {
  console.log(`WIRE_FAILED: ${failed} 条断言不过`)
  process.exit(1)
}
console.log('WIRE_OK: 平台 → 仓库接线完好（跨机口径）')
