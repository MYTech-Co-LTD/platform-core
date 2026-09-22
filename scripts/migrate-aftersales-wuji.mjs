// @ts-nocheck —— CLI 薄壳：纯核（wuji-source/clean/import/reconcile）在 modules/aftersales/migration/
// 有 vitest 兜底；scripts/ 不在 B1/B8/B9 扫描根内（apps/packages/modules 才是），故 env 键靠
// .env.example 的文档化条目自觉维护。
// migrate-aftersales-wuji.mjs — 售后 M2b：wuji 托管库 → aftersales.*（spec §3.3；issue #151）
// 用法：npx tsx scripts/migrate-aftersales-wuji.mjs --org <casdoor_org> [--tables t1,t2] [--apply]
//         [--sample N] [--sample-out DIR] [--groupbuy-unit fen|yuan]
// 默认 dry-run：拉取 + 清洗 + 打印报告，不写库（--apply 才写）。
// env：WUJI_APPID / WUJI_DATA_ORIGIN（默认 https://data.wujisite.com）/ WUJI_KEY_<大写表名>；
//      DATABASE_URL（--apply 必填）。键值只在 env，绝不进仓/日志/提交。
// 必须用 tsx：纯核是 .ts；pg 经 createRequire 锚到 apps/server 解析（scripts/ 不属于 workspace
// 包——与 migrate-tenant-module-to-subs.mjs 同一坑，D6 切换时实测踩过）。
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { wujiCount, wujiFetchAll, maxMtimeOf } from '../modules/aftersales/migration/wuji-source.ts'
import * as clean from '../modules/aftersales/migration/clean.ts'
import * as imp from '../modules/aftersales/migration/import.ts'
import { expectedTicketSums, reconcileCounts, reconcileTicketSums } from '../modules/aftersales/migration/reconcile.ts'

const ALL_TABLES = [
  'region_info', 'store_info', 'product_archive', 'employee_info', 'employee_info_approve',
  'after_sales_rule', 'after_sales_work_order', 'group_buying_order', 'group_buying_order_item',
]

function arg(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const ORG = arg('org')
const APPLY = process.argv.includes('--apply')
const TABLES = (arg('tables') ?? ALL_TABLES.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const SAMPLE = arg('sample') ? Number(arg('sample')) : undefined
const SAMPLE_OUT = arg('sample-out')
const GROUPBUY_UNIT = arg('groupbuy-unit')

async function main() {
  if (!ORG) throw new Error('需要 --org <casdoor_org>（迁移目标租户）')
  const appid = process.env.WUJI_APPID
  const origin = process.env.WUJI_DATA_ORIGIN ?? 'https://data.wujisite.com'
  if (!appid) throw new Error('需要 WUJI_APPID（取法见 .env.example；本地临跑用 export，不落盘）')

  if (SAMPLE_OUT) await mkdir(SAMPLE_OUT, { recursive: true })
  const raw = {}
  for (const t of TABLES) {
    const schemakey = process.env[`WUJI_KEY_${t.toUpperCase()}`]
    if (!schemakey) throw new Error(`缺 WUJI_KEY_${t.toUpperCase()}（wuji 后台「数据源管理」逐表可见）`)
    const cfg = { origin, appid, schemaid: t, schemakey }
    const count = await wujiCount(fetch, cfg)
    const rows = await wujiFetchAll(fetch, cfg, SAMPLE ? { maxRows: SAMPLE } : {})
    raw[t] = rows
    console.log(`[wuji] ${t}: count=${count} pulled=${rows.length} maxMtime=${maxMtimeOf(rows) ?? '-'}`)
    if (SAMPLE_OUT) {
      await writeFile(`${SAMPLE_OUT.replace(/\/$/, '')}/${t}.json`, JSON.stringify(rows, null, 2))
      console.log(`[sample] ${t} → ${SAMPLE_OUT}/${t}.json`)
    }
  }

  // 清洗（groupbuy 守门：接龙表在导入面出现但单位未证 ⇒ --apply 直接拒）
  if (APPLY) {
    if (TABLES.some((t) => t.startsWith('group_buying_'))) {
      if (GROUPBUY_UNIT !== 'fen' && GROUPBUY_UNIT !== 'yuan') {
        throw new Error('接龙表在导入面但 --groupbuy-unit 未给（fen|yuan）。单位只能来自 T3 拉样自证结论（SAMPLE-NOTES.md）或客户答复——禁猜。')
      }
      clean.setGroupbuyUnit(GROUPBUY_UNIT)
    }
    if (!process.env.DATABASE_URL) throw new Error('--apply 需要 DATABASE_URL')
  }

  const cleaned = {
    region: (raw.region_info ?? []).map(clean.cleanRegion),
    store: (raw.store_info ?? []).map(clean.cleanStore),
    product: (raw.product_archive ?? []).map(clean.cleanProduct),
    employee: (raw.employee_info ?? []).map(clean.cleanEmployee),
    approval: (raw.employee_info_approve ?? []).map(clean.cleanEmployeeApproval),
    rule: (raw.after_sales_rule ?? []).map(clean.cleanRule),
    ticket: (raw.after_sales_work_order ?? []).map(clean.cleanTicket),
  }

  if (!APPLY) {
    console.log(`[dry-run] 清洗完成（不写库）：${Object.entries(cleaned).map(([k, v]) => `${k}=${v.length}`).join(' ')}`)
    console.log('[dry-run] 工单金额和（对账期望，单位分）：', expectedTicketSums(cleaned.ticket))
    return
  }

  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  try {
    // 导入顺序 = FK 依赖序（T4 的 archive_* 接在 ticket 之后）
    const stats = []
    if (TABLES.includes('region_info')) stats.push(await imp.importRegion(pool, ORG, cleaned.region))
    if (TABLES.includes('store_info')) stats.push(await imp.importStore(pool, ORG, cleaned.store))
    if (TABLES.includes('product_archive')) stats.push(await imp.importProduct(pool, ORG, cleaned.product))
    if (TABLES.includes('employee_info')) stats.push(await imp.importEmployee(pool, ORG, cleaned.employee))
    if (TABLES.includes('after_sales_rule')) stats.push(await imp.importRule(pool, ORG, cleaned.rule))
    if (TABLES.includes('employee_info_approve')) stats.push(await imp.importEmployeeApproval(pool, ORG, cleaned.approval))
    if (TABLES.includes('after_sales_work_order')) stats.push(await imp.importTicket(pool, ORG, cleaned.ticket))
    for (const s of stats) {
      console.log(`[import] ${s.table}: fetched=${s.fetched} imported=${s.imported} skipped=${s.skipped} reasons=${JSON.stringify(s.reasons)}`)
    }
    const counts = await reconcileCounts(pool, ORG, [
      ...(TABLES.includes('region_info') ? [{ table: 'region', source: cleaned.region.length }] : []),
      ...(TABLES.includes('store_info') ? [{ table: 'store', source: cleaned.store.length }] : []),
      ...(TABLES.includes('product_archive') ? [{ table: 'product', source: cleaned.product.length }] : []),
      ...(TABLES.includes('employee_info') ? [{ table: 'employee', source: cleaned.employee.length }] : []),
      ...(TABLES.includes('after_sales_rule') ? [{ table: 'ticket_rule', source: cleaned.rule.length }] : []),
      ...(TABLES.includes('employee_info_approve') ? [{ table: 'employee_approval', source: cleaned.approval.length }] : []),
      ...(TABLES.includes('after_sales_work_order') ? [{ table: 'ticket', source: cleaned.ticket.length }] : []),
    ])
    for (const c of counts) console.log(`[reconcile] ${c.table}: source=${c.source} target=${c.target} ${c.ok ? 'OK' : '❌ DIFF'}`)
    if (TABLES.includes('after_sales_work_order')) {
      for (const s of await reconcileTicketSums(pool, ORG, expectedTicketSums(cleaned.ticket))) {
        console.log(`[reconcile] ${s.label}: expected=${s.expected} actual=${s.actual} ${s.ok ? 'OK' : '❌ DIFF'}`)
      }
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('migrate-aftersales-wuji.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
