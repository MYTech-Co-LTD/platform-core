// @ts-nocheck —— CLI 薄壳：纯核（planMigration/tenantProvisionSteps/planAllTenantGrants）有 vitest 兜底；
// tsc 根工程解析不到 apps/server 的 pg 类型，不为此给根加依赖
// provision-tenant.mjs — 租户开通 CLI（spec D7；#41）：org→租户行→锚用户→权限扇出→初始订阅
// 用法：npx tsx scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...
//       [--product-name <名>] [--login-methods password,wecom-qr] [--domain <host>]（org 缺省 <slug>-org）
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
  const steps = ['org:' + org, 'tenant-row:' + slug, 'anchor']
  if (opts.domain) steps.push('domain:' + opts.domain)
  steps.push('permissions')
  for (const m of opts.modules ?? []) steps.push('plan:' + m, 'subscribe:' + m)
  return steps
}

/** 批量发放计划（spec-1 §4）：每 org × 每 module 两条（plan+subscribe），纯核可测 */
export function planAllTenantGrants(orgs, modules = []) {
  const steps = []
  for (const org of orgs) for (const m of modules) steps.push(`plan:${org}:${m}`, `subscribe:${org}:${m}`)
  return steps
}

/** login_methods 白名单（合法值与 apps/web/src/pages/Login.tsx 的 METHOD_LABELS 一致）：
 *  坏值前端静默丢弃只留账密 tab（adopt runbook §6.1 坑），在 CLI 入口拦下。 */
export function parseLoginMethods(raw) {
  if (!raw) return ['password']
  const allowed = new Set(['password', 'wecom-qr'])
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean)
  const bad = parts.filter((p) => !allowed.has(p))
  if (bad.length > 0) throw new Error(`--login-methods 非法值：${bad.join(',')}（合法值：password, wecom-qr）`)
  return parts.length > 0 ? parts : ['password']
}

/** 权限扇出清单 = 内置码在前 + 模块码（spec-3 §2.1：开通即可挂 tenant:admin，不等宿主重启） */
export function provisionPerms(modulePerms, builtin = []) {
  return [...builtin, ...modulePerms]
}

async function main() {
  const args = process.argv.slice(2)
  const allTenants = args.includes('--all-tenants')
  const slug = allTenants ? undefined : args[0]
  const org = (() => { const i = args.indexOf('--org'); return i > 0 ? args[i + 1] : (slug ? `${slug}-org` : '') })()
  const modules = args.flatMap((a, i) => (a === '--module' ? [args[i + 1]] : []))
  const productName = (() => { const i = args.indexOf('--product-name'); return i > 0 ? args[i + 1] : undefined })()
  const loginMethodsRaw = (() => { const i = args.indexOf('--login-methods'); return i > 0 ? args[i + 1] : undefined })()
  const loginMethods = parseLoginMethods(loginMethodsRaw) // 入口拦：坏值在任何 IO（Casdoor/DB）之前退出
  const domain = (() => { const i = args.indexOf('--domain'); return i > 0 ? args[i + 1] : undefined })()
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

  if (!slug) throw new Error('用法: npx tsx scripts/provision-tenant.mjs <slug> [--org <org>] [--module <id>]... [--product-name <名>] [--login-methods password,wecom-qr] [--domain <host>] | --all-tenants --module <id>...')
  console.log('[provision] 计划：', tenantProvisionSteps(slug, { org, modules, domain }).join(' → '))
  const { provisionModulePermissions, PLATFORM_BUILTIN_PERMISSIONS } = await import('../apps/server/src/loader.ts')
  const c = makeClient(org)
  await c.ensureOrg(org); console.log('  ✓ org')
  const { rows } = await pool.query(
    `insert into platform.tenant(slug, casdoor_org, product_name, login_methods)
     values ($1, $2, $3, $4)
     on conflict (slug) do update set
       casdoor_org = excluded.casdoor_org,
       product_name = excluded.product_name,
       login_methods = excluded.login_methods
     returning id`,
    [slug, org, productName ?? slug, loginMethods],
  )
  const tenantId = rows[0].id; console.log('  ✓ tenant-row #' + tenantId)
  await c.ensureAnchorUser(org); console.log('  ✓ anchor')
  if (domain) {
    await pool.query('insert into platform.tenant_domain(tenant_id, domain) values ($1, $2) on conflict (domain) do nothing', [tenantId, domain])
    const { rows: occ } = await pool.query('select tenant_id from platform.tenant_domain where domain = $1', [domain])
    if (occ[0]?.tenant_id !== tenantId) throw new Error(`域名已被租户 #${occ[0].tenant_id} 占用：${domain}（on conflict 静默跳过，这里明确报错——spec-3 §2.3）`)
    console.log('  ✓ domain ' + domain)
  }
  // 权限码扇出：modules/*/manifest 的 permissions（与装载器同源）
  const modulesDir = path.join(import.meta.dirname, '..', 'modules')
  const perms = []
  for (const d of await readdir(modulesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue
    const m = parseYaml(await readFile(path.join(modulesDir, d.name, 'manifest.yaml'), 'utf8'))
    for (const p of m?.permissions ?? []) perms.push({ code: p.code, name: p.name })
  }
  const allPerms = provisionPerms(perms, PLATFORM_BUILTIN_PERMISSIONS.map((p) => ({ code: p.code, name: p.name })))
  await provisionModulePermissions(pool, (o) => (o === org ? c : c), allPerms); console.log('  ✓ permissions ×' + allPerms.length)
  for (const m of modules) {
    await c.ensureModulePlan(org, m)
    await c.upsertSubscription(org, m, { state: 'Active' })
    console.log('  ✓ subscribe mod-' + m)
  }
  await pool.end()
}

if (process.argv[1]?.endsWith('provision-tenant.mjs')) main().catch((e) => { console.error(e); process.exit(1) })
