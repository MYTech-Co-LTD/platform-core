// migrate-tenant-module-to-subs.mjs — tenant_module → Casdoor 订阅迁移（spec D6；#41）
// 用法：node scripts/migrate-tenant-module-to-subs.mjs [--apply]（默认 dry-run 只打印计划）
// 语义：对每租户的「有效启用集」（loaded ∩ (显式行 ?? true)）产出 锚用户→plan→订阅 三步；幂等。

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export function planMigration(rows) {
  const out = []
  for (const r of rows) {
    if (!r.enabled.length) continue
    for (const moduleId of r.enabled) out.push({ org: r.casdoorOrg, moduleId, steps: ['anchor', 'plan', 'subscribe'] })
  }
  return out
}

async function main() {
  const apply = process.argv.includes('--apply')
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  const { Pool } = await import('pg')
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
  const pool = new Pool({ connectionString: dbUrl })
  // 已装载模块 id（与装载器同源：扫 modules/*/manifest.yaml）
  const modulesDir = path.join(import.meta.dirname, '..', 'modules')
  const loadedIds = []
  for (const d of await readdir(modulesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    try {
      const m = parseYaml(await readFile(path.join(modulesDir, d.name, 'manifest.yaml'), 'utf8'))
      if (m?.id) loadedIds.push(m.id)
    } catch { /* 无 manifest 的目录跳过 */ }
  }
  // 每租户有效启用集（无行=启用默认，与 enabledForImpl 同语义）
  const { rows: tenants } = await pool.query('select id, casdoor_org from platform.tenant order by id')
  const plan = []
  for (const t of tenants) {
    const { rows: mods } = await pool.query('select module_id, enabled from platform.tenant_module where tenant_id = $1', [t.id])
    const explicit = new Map(mods.map((m) => [m.module_id, m.enabled]))
    const enabled = loadedIds.filter((id) => explicit.get(id) ?? true)
    plan.push({ casdoorOrg: t.casdoor_org, enabled })
  }
  const steps = planMigration(plan)
  console.log(`[migrate] ${tenants.length} 租户 × 有效启用 → ${steps.length} 条订阅计划${apply ? '' : '（dry-run，--apply 才写）'}`)
  if (!apply) { for (const s of steps) console.log(`  ${s.org}: mod-${s.moduleId}`); await pool.end(); return }
  const c = new CasdoorClient({
    origin: process.env.CASDOOR_URL, clientId: process.env.CASDOOR_CLIENT_ID ?? 'x', clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? 'x',
    org: 'built-in', adminUser: process.env.CASDOOR_ADMIN_USER, adminPwd: process.env.CASDOOR_ADMIN_PWD,
  })
  for (const s of steps) {
    await c.ensureAnchorUser(s.org)
    await c.ensureModulePlan(s.org, s.moduleId)
    await c.upsertSubscription(s.org, s.moduleId, { state: 'Active' })
    console.log(`  ✓ ${s.org}: mod-${s.moduleId}`)
  }
  await pool.end()
}

if (process.argv[1]?.endsWith('migrate-tenant-module-to-subs.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
