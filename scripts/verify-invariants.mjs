#!/usr/bin/env node
// verify-invariants.mjs —— 在**仓库库**上验证 `dbt/semantics/invariants.yml`（W4 Task 4，#1447）。
//
// 为什么要单独验证：LLM/人写的规则未必成立。先把每条 `check_sql` 真跑一遍，算出
// 「违反行数 / 总行数」，再由人把达标的改 `status: verified`（只有 verified 才生成 dbt test）。
//
// 用法：
//   DATA_WAREHOUSE_URL=postgres://… pnpm exec tsx scripts/verify-invariants.mjs [rootDir] [--json]
// 退出码：0 = 全部跑完（**不代表全部成立**，看输出）；1 = 连接/解析失败。
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { parse } from 'yaml'

/** @param {unknown} doc @returns {Array<{name:string,relation:string,check_sql:string,status:string}>} */
export function invariantsOf(doc) {
  const list = Array.isArray(/** @type {any} */ (doc)?.invariants) ? /** @type {any} */ (doc).invariants : []
  return list
    .filter((/** @type {any} */ i) => i !== null && typeof i === 'object')
    .map((/** @type {any} */ i) => ({
      name: String(i.name ?? ''), relation: String(i.relation ?? ''),
      check_sql: String(i.check_sql ?? ''), status: String(i.status ?? 'candidate'),
    }))
}

/**
 * @param {{ query(sql: string): Promise<{ rows: any[] }> }} client
 * @param {ReturnType<typeof invariantsOf>[number]} inv
 * @returns {Promise<{ name: string, violations: number, total: number, rate: number, error?: string }>}
 */
export async function verifyOne(client, inv) {
  try {
    const v = await client.query(inv.check_sql)
    const violations = Number(v.rows[0]?.count ?? 0)
    const t = await client.query(`select count(*)::bigint as c from ${inv.relation}`)
    const total = Number(t.rows[0]?.c ?? 0)
    return { name: inv.name, violations, total, rate: total === 0 ? 0 : violations / total }
  } catch (e) {
    return { name: inv.name, violations: 0, total: 0, rate: 0, error: e instanceof Error ? e.message : String(e) }
  }
}

async function main() {
  const args = process.argv.filter((a) => !a.startsWith('--'))
  const rootDir = args[2] ?? fileURLToPath(new URL('..', import.meta.url))
  const dsn = String(process.env.DATA_WAREHOUSE_URL ?? '').trim()
  if (dsn === '') { console.error('verify-invariants: 缺 DATA_WAREHOUSE_URL'); process.exit(1) }
  const doc = parse(readFileSync(join(rootDir, 'dbt', 'semantics', 'invariants.yml'), 'utf8'))
  const invs = invariantsOf(doc)
  // pg 在 modules/data 的 workspace 依赖里；scripts/ 自身解析不到（仓内既有写法见 notify-health.mjs）
  const require = createRequire(join(rootDir, 'modules', 'data', 'package.json'))
  const req = /** @type {any} */ (require)   // 非字面量调用：避免 TS 在 scripts/ 解析 pg 的类型
  const pg = req('pg')
  const Pool = pg.Pool
  const pool = new Pool({ connectionString: dsn })
  const out = []
  try {
    for (const inv of invs) out.push(await verifyOne(pool, inv))
  } finally {
    await pool.end().catch(() => {})
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(out, null, 2)); return }
  console.log('不变量验证（违反行数/总行数）：')
  for (const r of out) {
    const pct = (r.rate * 100).toFixed(4)
    const verdict = r.error !== undefined ? `ERROR ${r.error}` : r.violations === 0 ? 'OK' : `违反 ${pct}%`
    console.log(`  ${r.name.padEnd(38)} ${String(r.violations).padStart(10)}/${String(r.total).padEnd(10)} ${verdict}`)
  }
  const bad = out.filter((r) => r.error !== undefined || r.violations > 0)
  if (bad.length > 0) console.log(`\n注意：${bad.length} 条未成立——按 ≥99% 期间成立（违反 <1%）判定，不达标者留 observing。`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('verify-invariants.mjs')) main()
