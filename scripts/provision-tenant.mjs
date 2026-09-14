// @ts-nocheck —— CLI 薄壳：纯核（planMigration/tenantProvisionSteps/planAllTenantGrants）有 vitest 兜底；
// tsc 根工程解析不到 apps/server 的 pg 类型，不为此给根加依赖
// provision-tenant.mjs — 租户开通 CLI（spec D7；#41）：org→租户行→锚用户→权限扇出→初始订阅
// 用法：npx tsx scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...（org 缺省 <slug>-org）
//       npx tsx scripts/provision-tenant.mjs --all-tenants --module <id>...（批量发放：遍历 platform.tenant 各 org）
// 必须 tsx：TS barrel（public.ts/loader.ts）导入裸 node 解析不了；且 pg 经 createRequire
// 锚到 apps/server 解析（scripts/ 不属于任何 workspace 包，裸 import 'pg' 处处解析不到——
// 与 migrate-tenant-module-to-subs.mjs 同坑同修，b346e8e）。
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export function tenantProvisionSteps(slug, opts = {}) {
  const org = opts.org ?? `${slug}-org`
  const steps = ['org:' + org, 'tenant-row:' + slug, 'anchor', 'permissions']
  for (const m of opts.modules ?? []) steps.push('plan:' + m, 'subscribe:' + m)
  return steps
}

/** 批量发放计划（spec-1 §4）：每 org × 每 module 两条（plan+subscribe），纯核可测 */
export function planAllTenantGrants(orgs, modules = []) {
  const steps = []
  for (const org of orgs) for (const m of modules) steps.push(`plan:${org}:${m}`, `subscribe:${org}:${m}`)
  return steps
}

async function main() {
  const args = process.argv.slice(2)
  const allTenants = args.includes('--all-tenants')
  const slug = allTenants ? undefined : args[0]
  const org = (() => { const i = args.indexOf('--org'); return i > 0 ? args[i + 1] : (slug ? `${slug}-org` : '') })()
  const modules = args.flatMap((a, i) => (a === '--module' ? [args[i + 1]] : []))
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool: P } = requireFromServer('pg')
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
  const pool = new P({ connectionString: dbUrl })
  const makeClient = (orgName) => new CasdoorClient({
    origin: process.env.CASDOOR_URL, clientId: process.env.CASDOOR_CLIENT_ID ?? 'x', clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? 'x',
    org: orgName, adminUser: process.env.CASDOOR_ADMIN_USER, adminPwd: process.env.CASDOOR_ADMIN_PWD,
  })

  if (allTenants) {
    // 批量发放（spec-1 §4）：新模块 → 存量租户。orgs 来自 platform.tenant（权威清单，
    // 与装载器同源），每 org 一套 plan+订阅（SaaS spec D2：plan 按租户 org 各建一份）。
    if (modules.length === 0) throw new Error('--all-tenants 需要至少一个 --module <id>')
    const { rows } = await pool.query('select distinct casdoor_org from platform.tenant order by casdoor_org')
    const orgs = rows.map((r) => r.casdoor_org)
    console.log('[provision] 批量发放计划：', planAllTenantGrants(orgs, modules).join(' → '))
    for (const orgName of orgs) {
      const c = makeClient(orgName)
      for (const m of modules) {
        await c.ensureModulePlan(orgName, m)
        await c.upsertSubscription(orgName, m, { state: 'Active' })
        console.log(`  ✓ ${orgName} mod-${m}`)
      }
    }
    await pool.end()
    return
  }

  if (!slug) throw new Error('用法: node scripts/provision-tenant.mjs <slug> [--org <org>] [--module <id>]... | --all-tenants --module <id>...')
  console.log('[provision] 计划：', tenantProvisionSteps(slug, { org, modules }).join(' → '))
  const { provisionModulePermissions } = await import('../apps/server/src/loader.ts')
  const c = makeClient(org)
  await c.ensureOrg(org); console.log('  ✓ org')
  const { rows } = await pool.query(
    `insert into platform.tenant(slug, casdoor_org) values ($1, $2)
     on conflict (slug) do update set casdoor_org = excluded.casdoor_org returning id`,
    [slug, org],
  )
  const tenantId = rows[0].id; console.log('  ✓ tenant-row #' + tenantId)
  await c.ensureAnchorUser(org); console.log('  ✓ anchor')
  // 权限码扇出：modules/*/manifest 的 permissions（与装载器同源）
  const modulesDir = path.join(import.meta.dirname, '..', 'modules')
  const perms = []
  for (const d of await readdir(modulesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const m = parseYaml(await readFile(path.join(modulesDir, d.name, 'manifest.yaml'), 'utf8'))
    for (const p of m?.permissions ?? []) perms.push({ code: p.code, name: p.name })
  }
  await provisionModulePermissions(pool, (o) => (o === org ? c : c), perms); console.log('  ✓ permissions ×' + perms.length)
  for (const m of modules) {
    await c.ensureModulePlan(org, m)
    await c.upsertSubscription(org, m, { state: 'Active' })
    console.log('  ✓ subscribe mod-' + m)
  }
  await pool.end()
}

if (process.argv[1]?.endsWith('provision-tenant.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
