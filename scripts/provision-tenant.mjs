// @ts-nocheck —— CLI 薄壳：纯核（planMigration/tenantProvisionSteps/planAllTenantGrants）有 vitest 兜底；
// tsc 根工程解析不到 apps/server 的 pg 类型，不为此给根加依赖
// provision-tenant.mjs — 租户开通 CLI（spec D7；#41）：org→租户行→锚用户→权限扇出→初始订阅
// 用法：npx tsx scripts/provision-tenant.mjs <slug> [--org <casdoorOrg>] [--module <id>]...
//       [--product-name <名>] [--login-methods password,wecom-qr] [--domain <host>]
//       [--source <源>]...（租户已接入源，可重复；平台侧登记表 platform.tenant_source）
//       [--wechat-oa-app-id <id> --wechat-oa-secret <secret>]
//       [--wecom-corp-id <id> [--wecom-agent-id <id>] --wecom-secret <secret>]（org 缺省 <slug>-org）
//       npx tsx scripts/provision-tenant.mjs --all-tenants --module <id>...（批量发放：遍历 platform.tenant 各 org）
// 必须 tsx：TS barrel（public.ts/loader.ts）导入裸 node 解析不了；且 pg 经 createRequire
// 锚到 apps/server 解析（scripts/ 不属于任何 workspace 包，裸 import 'pg' 处处解析不到——
// 与 migrate-tenant-module-to-subs.mjs 同坑同修，b346e8e）。
import { createRequire } from 'node:module'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
// tenant_source 的 SQL 单一事实源（与 admin PUT /sources 共用）——改列名/冲突目标只需改那一处
import { SOURCES_UPSERT_SQL } from '../apps/server/src/tenant-source.ts'

export function tenantProvisionSteps(slug, opts = {}) {
  const org = opts.org ?? `${slug}-org`
  const steps = ['org:' + org, 'tenant-row:' + slug]
  // 公众号两参/企微三参写的就是 tenant-row 那张表的列（同一句 upsert），所以紧跟 tenant-row——
  // 与下方 main() 的执行序一致（domain 在 anchor 之后，因为它是独立一条 insert）。
  if (opts.wechatOaAppId) steps.push('wechat-oa ' + maskWechatOaAppId(opts.wechatOaAppId))
  if (opts.wecomCorpId) steps.push('wecom ' + maskWecomCorpId(opts.wecomCorpId))
  // 已接入源与 wechat-oa/wecom 同簇：都要先有 tenantId 才能写 ⇒ 紧跟 tenant-row，与 main() 执行序一致。
  for (const s of opts.sources ?? []) steps.push('source:' + s)
  steps.push('anchor')
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

/** 公众号两参（租户行 wechat_oa_app_id/secret，005 迁移）——**可选**，但**必须成对**。
 *  为什么成对：两列是「配置存在即启用」的启用判定（auth-wechat-oa.ts:148/110，
 *  `!appId || !secret` ⇒ 未配置），只给一个写进去 = 一个**看起来配了其实不启用**的
 *  半途态（访客登录 404，而开通日志全绿）⇒ 在入口响亮报错，不进 IO。
 *  返回 null = 两个都没给：调用方**不得**因此清空既有两列（幂等重跑语义，见 tenantRowUpsert）。 */
export function parseWechatOaArgs(appId, secret) {
  const given = (v) => typeof v === 'string' && v.length > 0
  if (given(appId) !== given(secret)) {
    // 文案里绝不回显任何一方的值（secret 口径：本 CLI 从不打印敏感值）
    throw new Error('--wechat-oa-app-id 与 --wechat-oa-secret 必须同时提供（只给一个 = 参数错误；本项可选，都不给则租户行两列保持不动）')
  }
  return given(appId) ? { appId, secret } : null
}

/** 计划/✓ 打印用的遮蔽：只留前 6 位。secret 没有任何遮蔽形态——它根本不出现在任何打印里。 */
export function maskWechatOaAppId(appId, keep = 6) {
  const s = String(appId ?? '')
  return s.length <= keep ? s : `${s.slice(0, keep)}…`
}

/** 企微三参（租户行 wecom_corp_id/agent_id/secret，001 迁移）——**可选**，语义照 parseWechatOaArgs
 *  同族先例，但有一处不同：**成对的是 corp+secret**（消费方 auth-wecom.ts:159/255 的启用判定
 *  就是这两列 `!corp_id || !secret` ⇒ 404），**agent_id 可选且仅能与两者同给**（判定不看它，
 *  单写 agent = 半配置，且库里 corp/secret 为空时它毫无作用）⇒ 入口拦下，不进 IO。
 *  返回 null = 三个都没给：调用方**不得**因此清空既有三列（幂等重跑语义，见 tenantRowUpsert）。 */
export function parseWecomArgs(corpId, agentId, secret) {
  const given = (v) => typeof v === 'string' && v.length > 0
  const hasPair = given(corpId) || given(secret)
  if (given(corpId) !== given(secret)) {
    throw new Error('--wecom-corp-id 与 --wecom-secret 必须同时提供（只给一个 = 参数错误；本项可选，都不给则租户行三列保持不动）')
  }
  if (!hasPair && given(agentId)) {
    throw new Error('--wecom-agent-id 仅能与 --wecom-corp-id/--wecom-secret 同时提供（启用判定只看后两者，单给 agent = 半配置）')
  }
  if (!hasPair) return null
  return given(agentId) ? { corpId, agentId, secret } : { corpId, secret }
}

/** corp_id 遮蔽与 appId 同口径：corp_id 是企业标识不是凭证（secret 才是），打印只留前 6 位。 */
export function maskWecomCorpId(corpId, keep = 6) {
  return maskWechatOaAppId(corpId, keep)
}

/** 租户行 upsert 的 SQL + 参数（纯核，便于不起库就钉住「给了才写」这条语义）。
 *  关键在 `on conflict do update set` **只改列出的列**：没带公众号两参/企微三参时 SQL 里根本
 *  不出现那些列 ⇒ 重跑一次光秃秃的开通命令**不会**把已经配好的配置清成 null。
 *  @param {{ slug: string, org: string, productName?: string, loginMethods: string[],
 *            wechatOa?: { appId: string, secret: string } | null,
 *            wecom?: { corpId: string, agentId?: string, secret: string } | null }} opts */
export function tenantRowUpsert(opts) {
  const { slug, org, productName, loginMethods, wechatOa = null, wecom = null } = opts
  const cols = ['slug', 'casdoor_org', 'product_name', 'login_methods']
  const values = [slug, org, productName ?? slug, loginMethods]
  const updates = [
    'casdoor_org = excluded.casdoor_org',
    'product_name = excluded.product_name',
    'login_methods = excluded.login_methods',
  ]
  if (wechatOa) {
    cols.push('wechat_oa_app_id', 'wechat_oa_secret')
    values.push(wechatOa.appId, wechatOa.secret)
    updates.push('wechat_oa_app_id = excluded.wechat_oa_app_id', 'wechat_oa_secret = excluded.wechat_oa_secret')
  }
  if (wecom) {
    // agentId 给了才列进列清单（对齐 parseWecomArgs：不给 = 不写不清，不是写 null）
    cols.push('wecom_corp_id', ...(wecom.agentId ? ['wecom_agent_id'] : []), 'wecom_secret')
    values.push(wecom.corpId, ...(wecom.agentId ? [wecom.agentId] : []), wecom.secret)
    updates.push(
      'wecom_corp_id = excluded.wecom_corp_id',
      ...(wecom.agentId ? ['wecom_agent_id = excluded.wecom_agent_id'] : []),
      'wecom_secret = excluded.wecom_secret',
    )
  }
  const text = `insert into platform.tenant(${cols.join(', ')})
     values (${cols.map((_, i) => `$${i + 1}`).join(', ')})
     on conflict (slug) do update set
       ${updates.join(',\n       ')}
     returning id`
  return { text, values }
}

/** 已接入源写入（platform.tenant_source，007 迁移）的 SQL + 参数（纯核，便于不起库钉住语义）。
 *  `--source` 是**开通动作**：只置 enabled=true，**绝不**因某个源这次没传就把它关掉 ——
 *  关/换源是管理端点（PUT /sources 整体替换）的事，开通流程不该具备「顺手禁用」的破坏力。
 *  `unnest` 展开源清单，`on conflict do update set enabled = true` 让重跑幂等。
 *  SQL 文本来自 tenant-source.ts（**单一事实源**，与 admin PUT 共用；本函数只做「配参数」）。 */
export function tenantSourceUpsert(tenantId, sources) {
  return { text: SOURCES_UPSERT_SQL, values: [tenantId, sources] }
}

/** `--source` 可重复；返回**去重且保序**的清单（先出现者在前）。
 *  为什么必须去重：同一键在同一条 upsert（`unnest` 展开）里出现两次，Postgres 报
 *  21000 `ON CONFLICT DO UPDATE command cannot affect row a second time` ⇒ **CLI 直接崩**。
 *  重复项本身不是错误（与路由侧同口径：启用集是集合语义），故去重放行、不报错。
 *  取法沿用 `--module` 的 flatMap（末尾裸 `--source` 取到 undefined ⇒ filter 掉）。 */
export function parseSources(args) {
  const raw = args.flatMap((a, i) => (a === '--source' ? [args[i + 1]] : [])).filter(Boolean)
  return [...new Set(raw)] // Set 保插入序 ⇒ 去重不改变先出现者优先
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
  const sources = parseSources(args) // 去重在解析处（同一键重复会让写库 upsert 撞 21000，见该函数）
  const productName = (() => { const i = args.indexOf('--product-name'); return i > 0 ? args[i + 1] : undefined })()
  const loginMethodsRaw = (() => { const i = args.indexOf('--login-methods'); return i > 0 ? args[i + 1] : undefined })()
  const loginMethods = parseLoginMethods(loginMethodsRaw) // 入口拦：坏值在任何 IO（Casdoor/DB）之前退出
  const domain = (() => { const i = args.indexOf('--domain'); return i > 0 ? args[i + 1] : undefined })()
  const wechatOa = parseWechatOaArgs( // 同上：成对性也在任何 IO 之前拦下
    (() => { const i = args.indexOf('--wechat-oa-app-id'); return i > 0 ? args[i + 1] : undefined })(),
    (() => { const i = args.indexOf('--wechat-oa-secret'); return i > 0 ? args[i + 1] : undefined })(),
  )
  const wecom = parseWecomArgs( // 同上（#115）：corp+secret 成对、agent 仅随行，均在 IO 之前拦下
    (() => { const i = args.indexOf('--wecom-corp-id'); return i > 0 ? args[i + 1] : undefined })(),
    (() => { const i = args.indexOf('--wecom-agent-id'); return i > 0 ? args[i + 1] : undefined })(),
    (() => { const i = args.indexOf('--wecom-secret'); return i > 0 ? args[i + 1] : undefined })(),
  )
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
    // 公众号两参是**单租户项**（每租户自己的公众号，spec §1.3），批量路没有对应写点；
    // 静默忽略会让「我明明传了」这件事在日志里看不出来 ⇒ 响亮报错（同 login-methods 的入口拦口径）。
    // 企微三参同族同口径（#115）。
    if (wechatOa) throw new Error('--all-tenants 不支持 --wechat-oa-*（公众号配置按租户各配，请逐租户跑本 CLI）')
    if (wecom) throw new Error('--all-tenants 不支持 --wecom-*（企微配置按租户各配，请逐租户跑本 CLI）')
    if (sources.length > 0) throw new Error('--all-tenants 不支持 --source（已接入源按租户各配，请逐租户跑本 CLI）')
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

  if (!slug) throw new Error('用法: npx tsx scripts/provision-tenant.mjs <slug> [--org <org>] [--module <id>]... [--product-name <名>] [--login-methods password,wecom-qr] [--domain <host>] [--source <源>]... [--wechat-oa-app-id <id> --wechat-oa-secret <secret>] [--wecom-corp-id <id> [--wecom-agent-id <id>] --wecom-secret <secret>] | --all-tenants --module <id>...')
  console.log('[provision] 计划：', tenantProvisionSteps(slug, { org, modules, domain, sources, wechatOaAppId: wechatOa?.appId, wecomCorpId: wecom?.corpId }).join(' → '))
  const { provisionModulePermissions, PLATFORM_BUILTIN_PERMISSIONS } = await import('../apps/server/src/loader.ts')
  const c = makeClient(org)
  await c.ensureOrg(org); console.log('  ✓ org')
  const upsert = tenantRowUpsert({ slug, org, productName, loginMethods, wechatOa, wecom })
  const { rows } = await pool.query(upsert.text, upsert.values)
  const tenantId = rows[0].id; console.log('  ✓ tenant-row #' + tenantId)
  if (wechatOa) console.log('  ✓ wechat-oa ' + maskWechatOaAppId(wechatOa.appId))
  if (wecom) console.log('  ✓ wecom ' + maskWecomCorpId(wecom.corpId))
  if (sources.length > 0) {
    const srcUpsert = tenantSourceUpsert(tenantId, sources)
    await pool.query(srcUpsert.text, srcUpsert.values)
    console.log('  ✓ source ×' + sources.length + ' ' + sources.join(','))
  }
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
