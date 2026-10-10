// @ts-nocheck —— CLI 薄壳：纯核（analyzePhones/normalizePhone/maskPhone）有同名 .test.ts 兜底；
// tsc 根工程解析不到 apps/server 的 pg 类型，不为此给根加依赖（provision-tenant.mjs 同款头注）
// audit-employee-phones.mjs — 存量手机号摸底（账户统一 Phase 1 · Task 11；【只读】零写入）
// 用法：DATABASE_URL=postgresql://… npx tsx scripts/audit-employee-phones.mjs
//
// 读 aftersales.employee 全量（org/open_id/phone/approve_status），打印 汇总计数 + 同 org 同号
// dup 明细；结果决定 Phase 1 自动匹配置信基线（设计稿 §5.1）。跑一次本地库，生产经 openship
// custom job 跑（唯一通道法则；本脚本不内置任何远端连接逻辑）。
//
// ⚠️ B1 边界：宿主【运行时】绝不读 aftersales schema（apps/server 零触碰）；本脚本读它属
//   一次性迁移盘点性质（与 M2b 数据迁移同先例），只 SELECT、零写入。
// 敏感值口径：手机号输出一律掩码（前 3 后 2、中间 ****）；无效号只计数、不回显原文。
import { createRequire } from 'node:module'

// —— 归一/掩码：与 apps/server/src/identity-links.ts 的 normalizePhone/maskPhone 逐字同口径。
// Task 11 约束本脚本不 import 仓 src（脚本自带实现，避免脚本依赖仓内编译/装载面），故独立
// 放一份；双侧改动需同步（identity-links.ts 是语义正典，此处是迁移脚本的随行副本）。

/** 手机号归一：取数字；「86 + 11 位」共 13 位时去国家码；恰好 11 位才返回（其余不匹配）。 */
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2)
  return d.length === 11 ? d : null
}

/** 掩码：前 3 后 2、中间 `****`。短于 6 位时「前3后2」会把整串露出来 ⇒ 全遮；null 透传。 */
export function maskPhone(phone) {
  if (phone === null) return null
  const s = String(phone)
  if (s.length < 6) return '****'
  return `${s.slice(0, 3)}****${s.slice(-2)}`
}

/**
 * 摸底纯核（只读、不筛 approve_status——摸底 = 全量事实）：
 *   total    = 行数
 *   empty    = 手机号空白（''/纯空白）行数
 *   invalid  = 非空但归一失败（非 11 位等）行数（原文不进任何输出）
 *   dupGroups= 同 org 内同一「归一后」号码被 ≥2 个不同 open_id 共享的组（86 前缀先归一再比；
 *              跨 org 同号不算——绑定与置信池都按 org 圈死）；openids 去重保出现序，
 *              组间按 (org, phone) 排序，输出确定性。
 * @param {{org: string, openId: string, phone: string, approveStatus: string}[]} rows
 * @returns {{total: number, empty: number, invalid: number,
 *            dupGroups: {org: string, phoneMasked: string, openids: string[]}[]}}
 */
export function analyzePhones(rows) {
  let empty = 0
  let invalid = 0
  const groups = new Map() // key: org\0归一phone → { org, phone, openids[] }
  for (const r of rows) {
    const raw = String(r.phone ?? '')
    if (raw.trim() === '') { empty++; continue }
    const phone = normalizePhone(raw)
    if (phone === null) { invalid++; continue }
    const key = `${r.org}\u0000${phone}`
    let g = groups.get(key)
    if (!g) { g = { org: r.org, phone, openids: [] }; groups.set(key, g) }
    const openId = String(r.openId ?? '')
    if (!g.openids.includes(openId)) g.openids.push(openId)
  }
  const dupGroups = [...groups.values()]
    .filter((g) => g.openids.length > 1)
    .sort((a, b) => `${a.org}\u0000${a.phone}`.localeCompare(`${b.org}\u0000${b.phone}`))
    .map((g) => ({ org: g.org, phoneMasked: maskPhone(g.phone), openids: g.openids }))
  return { total: rows.length, empty, invalid, dupGroups }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  // pg 经 createRequire 锚到 apps/server 解析（scripts/ 不属于任何 workspace 包，裸 import
  // 'pg' 处处解析不到——与 provision-tenant.mjs 同坑同修）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool: P } = requireFromServer('pg')
  const pool = new P({ connectionString: dbUrl })
  try {
    const { rows } = await pool.query(
      'select org, open_id, phone, approve_status from aftersales.employee order by id',
    )
    const records = rows.map((r) => ({
      org: r.org, openId: r.open_id, phone: r.phone, approveStatus: r.approve_status,
    }))
    const summary = analyzePhones(records)
    const byStatus = {}
    for (const r of records) byStatus[r.approveStatus] = (byStatus[r.approveStatus] ?? 0) + 1
    console.log('[audit] aftersales.employee 摸底：共', summary.total, '行；按 approve_status:', JSON.stringify(byStatus))
    console.log('[audit] 无手机号：', summary.empty, '；无效手机号（非 11 位等，原文不回显）：', summary.invalid)
    console.log('[audit] 同 org 同号 dup 组：', summary.dupGroups.length)
    for (const g of summary.dupGroups) {
      console.log(`  dup org=${g.org} phone=${g.phoneMasked} openids=[${g.openids.join(', ')}] (${g.openids.length} 个身份)`)
    }
    if (summary.dupGroups.length === 0) console.log('  （无 dup：同 org 内没有共享手机号的多个身份）')
    console.log('[audit] 完成（只读零写入）。dup 组 = Phase 1 自动匹配置信基线的风险面（设计稿 §5.1）。')
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('audit-employee-phones.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
