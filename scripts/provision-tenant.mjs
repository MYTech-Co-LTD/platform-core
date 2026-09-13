// @ts-nocheck —— CLI 薄壳：纯核（planMigration/tenantProvisionSteps）有 vitest 兜底；
// tsc 根工程解析不到 apps/server 的 pg 类型，不为此给根加依赖
// provision-tenant.mjs — 租户开通 CLI（spec D7；#41）：org→租户行→锚用户→权限扇出→初始订阅
// 用法：node scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...（org 缺省 <slug>-org）
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

export function tenantProvisionSteps(slug, opts = {}) {
  const org = opts.org ?? `${slug}-org`
  const steps = ['org:' + org, 'tenant-row:' + slug, 'anchor', 'permissions']
  for (const m of opts.modules ?? []) steps.push('plan:' + m, 'subscribe:' + m)
  return steps
}

async function main() {
  const slug = process.argv[2]
  if (!slug) throw new Error('用法: node scripts/provision-tenant.mjs <slug> [--org <org>] [--module <id>]...')
  const org = (() => { const i = process.argv.indexOf('--org'); return i > 0 ? process.argv[i + 1] : `${slug}-org` })()
  const modules = process.argv.flatMap((a, i) => (a === '--module' ? [process.argv[i + 1]] : []))
  console.log('[provision] 计划：', tenantProvisionSteps(slug, { org, modules }).join(' → '))
  const dbUrl = process.env.DATABASE_URL
  if (!dbUrl) throw new Error('需要 DATABASE_URL')
  const { Pool: P } = await import('pg')
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')
  const { provisionModulePermissions } = await import('../apps/server/src/loader.ts')
  const pool = new P({ connectionString: dbUrl })
  const c = new CasdoorClient({
    origin: process.env.CASDOOR_URL, clientId: process.env.CASDOOR_CLIENT_ID ?? 'x', clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? 'x',
    org, adminUser: process.env.CASDOOR_ADMIN_USER, adminPwd: process.env.CASDOOR_ADMIN_PWD,
  })
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
