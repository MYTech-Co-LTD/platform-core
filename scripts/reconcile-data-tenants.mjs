#!/usr/bin/env node
// reconcile-data-tenants.mjs — 对账②：平台租户启用集 ↔ 数据面已建 schema/role
// （issue #150 / 计划 Task 11；spec §7「对账（必须有，不是可选）」的②、spec §11.2 #6）。
//
// 用法：DATABASE_URL=<平台库> DATA_WAREHOUSE_URL=<数据面 pg_duckdb> \
//         pnpm exec tsx scripts/reconcile-data-tenants.mjs [--json]
// 契约：干净 → exit 0（stdout 一行结论 + 计数）；有差集 → exit 1，**逐条打印差集**；
//       无法对账（缺 env / 查询失败）→ exit 2（「对不成账」与「对账发现漂移」必须可区分 ——
//       前者是脚本/环境坏了，后者是被观测的系统漂移了，处置完全不同）。
//
// ── 为什么是一个 scripts/ 脚本，而不是模块的一个端点 ─────────────────────────────
// 它要**同时读两侧**：平台库（`platform.tenant` / `platform.tenant_module`）+ 数据面仓库库
// （`pg_namespace` / `pg_roles`）。模块**不许**读 `platform.tenant`（B1 三同纪律：模块只碰自己的
// schema）⇒ 这条对账结构性地落在模块之外。`scripts/` 不在 B1 扫描根内，先例是
// `scripts/check-tenant-isolation.mjs`（它也正是直连真库做对账）。**模块侧不得加此端点。**
//
// ── 为什么「差集必须显式输出」是硬要求 ───────────────────────────────────────────
// M3c 的教训（spec §7 原文：「配了但不对在请求路径上不可观测」）：对账失败若只体现为
// 「少了一个租户的数据」或者干脆静默通过，线上是**看不出来**的。所以：
//   · 两个方向的差集都逐条打印（谁的 org / 哪个 schema / 缺的是 schema 还是 role）；
//   · 有差集 ⇒ exit 1（openship 定时 job 靠退出码变红，不靠人去读日志）；
//   · 连「认不出的数据面对象」也单列（`unattributable`）—— 丢弃它们 = 漂移看不见。
//
// ── 对账的两侧各是什么（口径写死在这里，别在别处复述）────────────────────────────
// 平台侧「启用集」：`platform.tenant` 各租户 × **data 模块**的有效启用。
//   语义与 `enabledFor` 两个消费方同源（AGENTS.md 项目约束 5）：**`tenant_module` 无行 = 启用**。
//   本脚本读的是**表**（`platform.tenant_module`）；平台若跑在「订阅源 = Casdoor」
//   （灰度开关 `PLATFORM_SUBSCRIPTION_SOURCE=casdoor`）且两处已经分叉，本脚本看到的是**表侧**口径
//   —— **这是已知边界**，不是漏检（分叉本身就是该被肉眼看到的东西，而 Casdoor 侧订阅要以
//   管理员凭据读，不在本脚本的凭据面内）。见 deploy/data-tenants/README.md「已知边界」。
//   模块未装载（仓里没有 `modules/data`）⇒ 启用集为空，并**显式打印**这一条（否则「模块不在」
//   会被读成「所有租户都停用了」）。
// 数据面「已建」：仓库库里 `tenant_%` 的 **schema** 与 **role**（两样都由
//   `deploy/data-tenants/provision-template.sql` 建，名字同名）。
//
// ── 与 macro 的**同源**纪律（唯一事实源在哪，这里说清楚）─────────────────────────
// 「租户键 → `tenant_<归一后>`」这条派生在**两个执行面**各有一份实现，物理上无法合并：
//   · 数据面侧 = `dbt/macros/generate_schema_name.sql`（Jinja，dbt 进程里跑）；
//   · 平台侧 = 本脚本的 `tenantSchemaName()`（Node，对账进程里跑）。
// 两份实现**共用一张用例表**：`scripts/check-data-models.test.ts` 的 T11 格②（`tenantSchemaName`
// 逐例断言）+ 格①（macro 必须含同一组归一原语：`var('tenant')` / `lower` / `replace('-','_')`）。
// 这是本仓对「两处实现」的既定答案（同 T9 的「zod schema 与编译器同源，fixtures 断言两边同拒」）：
// 不假装只有一个来源，而是**用 fixtures 把两份钉在同一张表上**。
// ⚠️ 诚实边界：macro 那份**无法在本机执行**（没有 dbt）⇒ 钉住它的是**结构断言**（含哪些归一原语），
// 不是逐例求值。真机核对归 T6/T13。
//
// 读法口径：本脚本自己**不建任何东西**（只读）⇒ 不需要幂等处理，也不会改到数据面。

import { readdir, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'

/** 租户资源名前缀（schema 与 role 同名同前缀）。 */
export const TENANT_PREFIX = 'tenant_'

/** 数据面归属的模块 id（本仓 `modules/data/manifest.yaml` 的 `id`）。 */
export const DATA_MODULE_ID = 'data'

/** 归一后合法标识符的字符集（与 macro 的 `modules.re` 判据同一句话）。 */
const IDENT_RE = /^[a-z0-9_]+$/

/**
 * 租户键 → 数据面资源名（schema 与 role **同名**）。
 *
 * 归一两条：折小写 + `-` → `_`（**与 `dbt/macros/generate_schema_name.sql` 逐字同构**）。
 * 归一后仍非法 ⇒ **抛**（fail-closed）：静默拼一个坏名字会让对账在**错误的名字**上做比较
 * （永远 clean 或永远脏），比直接失败危险得多。
 *
 * @param {string} key @returns {string}
 */
export function tenantSchemaName(key) {
  const raw = typeof key === 'string' ? key.trim() : ''
  if (raw === '') throw new Error('租户键为空：无法派生每租户资源名（空键会拼出 `tenant_`，那是所有租户共用名的形态）')
  const schema = `${TENANT_PREFIX}${raw.toLowerCase().replaceAll('-', '_')}`
  if (!IDENT_RE.test(schema.slice(TENANT_PREFIX.length))) {
    throw new Error(
      `租户键 ${JSON.stringify(raw)} 归一后不是合法标识符（${schema}）：只允许 [A-Za-z0-9_-]，`
      + '归一 = 折小写 + 连字符改下划线。带别的字符的键请先在平台侧改名，不要在这里放宽。',
    )
  }
  return schema
}

/**
 * 数据面对象名 → 租户键。**认不出的一律返回空串**（不猜）。
 *
 * 「认得出」= 去掉前缀后，**用 `tenantSchemaName()` 能原样拼回这个名字**（往返一致）。
 * 这样 `tenant_acme-org`（带连字符的名字，不是本约定产生的）不会被误算成键 `acme-org`
 * —— 那是一次静默的**张冠李戴**（把它当成某个租户的资源，于是真正的漂移看不见）。
 *
 * @param {string} name @returns {string} 认不出 = `''`
 */
export function tenantKeyOf(name) {
  if (typeof name !== 'string' || !name.startsWith(TENANT_PREFIX)) return ''
  const key = name.slice(TENANT_PREFIX.length)
  if (key === '') return ''
  try {
    return tenantSchemaName(key) === name ? key : ''
  } catch {
    return ''
  }
}

/**
 * 平台侧启用集：租户行 × data 模块的有效启用（`tenant_module` 无行 = 启用，与 `enabledFor` 同源）。
 *
 * `key` 与 `org` 同源（键 = casdoor org，取键理由见 macro 头注）。留成两个字段是给「将来改
 * 用 slug 做键」留的显式变量：**改键要改这张表，不要偷偷改 diff 的形状**。
 *
 * @param {Array<{ id: number, org: string }>} tenantRows
 * @param {Array<{ tenant_id: number, module_id: string, enabled: boolean }>} moduleRows
 * @param {string[]} loadedModuleIds 已装载模块 id（调用方扫 `modules/<模块目录>/manifest.yaml` 得到）
 * @returns {Array<{ org: string, key: string }>}
 */
export function platformTenantRefs(tenantRows, moduleRows, loadedModuleIds) {
  if (!loadedModuleIds.includes(DATA_MODULE_ID)) return []
  /** @type {Map<number, boolean>} */
  const explicit = new Map()
  for (const row of moduleRows) {
    if (row.module_id === DATA_MODULE_ID) explicit.set(row.tenant_id, row.enabled)
  }
  const out = []
  for (const t of tenantRows) {
    if ((explicit.get(t.id) ?? true) === false) continue
    out.push({ org: t.org, key: t.org })
  }
  return out
}

/**
 * 双向差集。三个方向都**显式**给出，谁都不静默：
 *   · `missingInData`     —— 平台有、数据面无（含「schema、role 只建了一半」）
 *   · `missingInPlatform` —— 数据面有、平台无（退租/改名漏回收的形态）
 *   · `unattributable`    —— 数据面里 `tenant_` 打头但**认不出键**的对象（不猜、不丢）
 *
 * 元素形状刻意**字段恒在**（`schemaPresent` / `rolePresent` 恒为布尔）：`scripts/` 是 checkJs，
 * JSDoc 字面量类型会被加宽 ⇒ 可辨识联合在这里会静默失效（`check-data-models.mjs` 头注判断③
 * 同因）。打印时按布尔值选词，不在类型上分叉。
 *
 * @param {Array<{ org: string, key: string }>} platformTenants
 * @param {string[]} dataSchemas `pg_namespace` 里 `tenant_%` 的名字
 * @param {string[]} dataRoles `pg_roles` 里 `tenant_%` 的名字
 * @returns {{
 *   missingInData: Array<{ org: string, key: string, schema: string, role: string, schemaPresent: boolean, rolePresent: boolean }>,
 *   missingInPlatform: Array<{ key: string, schema: string, role: string, schemaPresent: boolean, rolePresent: boolean }>,
 *   unattributable: string[],
 *   clean: boolean,
 * }}
 */
export function diffTenants(platformTenants, dataSchemas, dataRoles) {
  const schemaSet = new Set(dataSchemas)
  const roleSet = new Set(dataRoles)

  /** @type {Array<{ org: string, key: string, schema: string, role: string, schemaPresent: boolean, rolePresent: boolean }>} */
  const missingInData = []
  const claimed = new Set()
  for (const t of platformTenants) {
    const schema = tenantSchemaName(t.key)
    const role = schema // schema 与 role 同名（provision-template.sql 的约定）
    claimed.add(schema)
    const schemaPresent = schemaSet.has(schema)
    const rolePresent = roleSet.has(role)
    if (!schemaPresent || !rolePresent) {
      missingInData.push({ org: t.org, key: t.key, schema, role, schemaPresent, rolePresent })
    }
  }

  /** @type {Array<{ key: string, schema: string, role: string, schemaPresent: boolean, rolePresent: boolean }>} */
  const missingInPlatform = []
  /** @type {string[]} */
  const unattributable = []
  for (const name of [...new Set([...dataSchemas, ...dataRoles])].sort()) {
    if (claimed.has(name)) continue
    const key = tenantKeyOf(name)
    if (key === '') {
      unattributable.push(name)
      continue
    }
    missingInPlatform.push({
      key,
      schema: name,
      role: name,
      schemaPresent: schemaSet.has(name),
      rolePresent: roleSet.has(name),
    })
  }

  return {
    missingInData,
    missingInPlatform,
    unattributable,
    clean: missingInData.length === 0 && missingInPlatform.length === 0 && unattributable.length === 0,
  }
}

/** 已装载模块 id（与装载器同源：扫 `modules/<模块目录>/manifest.yaml`；读不到 = 不算装载）。 */
async function loadedModuleIds() {
  const dir = path.join(import.meta.dirname, '..', 'modules')
  /** @type {string[]} */
  const ids = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const raw = await readFile(path.join(dir, entry.name, 'manifest.yaml'), 'utf8')
      const m = /^id:\s*(\S+)\s*$/m.exec(raw)
      if (m?.[1]) ids.push(m[1])
    } catch {
      // 无 manifest 的目录跳过（与 migrate-tenant-module-to-subs.mjs 同一约定）
    }
  }
  return ids
}

/** 有/无 → 打印用词（字段恒在的类型上选词，不在类型上分叉）。 */
const has = (/** @type {boolean} */ b) => (b ? '有' : '缺')

async function main() {
  const asJson = process.argv.includes('--json')
  const platformUrl = process.env.DATABASE_URL
  const warehouseUrl = process.env.DATA_WAREHOUSE_URL
  if (!platformUrl) throw new Error('需要 DATABASE_URL（平台库）—— 口令只经 env 传，不进 argv')
  if (!warehouseUrl) throw new Error('需要 DATA_WAREHOUSE_URL（数据面 pg_duckdb）—— 同上')

  // pg 解析锚到 apps/server（pnpm workspace：pg 是 apps/server 的依赖；scripts/ 不属于任何包，
  // 裸 import 'pg' 在仓库根/容器里都解析不到 —— 与 migrate-tenant-module-to-subs.mjs 同坑同修）
  const requireFromServer = createRequire(new URL('../apps/server/package.json', import.meta.url))
  const { Pool } = requireFromServer('pg')

  const platform = new Pool({ connectionString: platformUrl })
  const warehouse = new Pool({ connectionString: warehouseUrl })
  try {
    const { rows: tenantRows } = await platform.query('select id, casdoor_org as org from platform.tenant order by id')
    const { rows: moduleRows } = await platform.query('select tenant_id, module_id, enabled from platform.tenant_module')
    const loaded = await loadedModuleIds()
    const refs = platformTenantRefs(tenantRows, moduleRows, loaded)

    const { rows: schemaRows } = await warehouse.query("select nspname as name from pg_namespace where nspname like 'tenant\\_%'")
    const { rows: roleRows } = await warehouse.query("select rolname as name from pg_roles where rolname like 'tenant\\_%'")
    const schemas = schemaRows.map((/** @type {{ name: string }} */ r) => r.name)
    const roles = roleRows.map((/** @type {{ name: string }} */ r) => r.name)

    const diff = diffTenants(refs, schemas, roles)

    if (asJson) {
      console.log(JSON.stringify({
        loadedModules: loaded,
        platformTenants: refs,
        dataSchemas: schemas,
        dataRoles: roles,
        ...diff,
      }, null, 2))
    } else {
      console.log(`[reconcile] 平台侧：启用 data 模块的租户 ${refs.length} 个（已装载模块：${loaded.join(', ') || '（无）'}；租户行 ${tenantRows.length}）`)
      if (!loaded.includes(DATA_MODULE_ID)) {
        console.log(`[reconcile] ⚠️ 本仓没有 ${DATA_MODULE_ID} 模块 ⇒ 平台侧启用集**恒为空**，「数据面有、平台无」会把数据面全部对象都报成差集 —— 这不是漂移，是模块不在`)
      }
      console.log(`[reconcile] 数据面：tenant_* schema ${schemas.length} 个 / role ${roles.length} 个`)
      console.log(`[reconcile] ${diff.clean ? '✓' : '✗'} 平台有、数据面无：${diff.missingInData.length} 条`)
      for (const m of diff.missingInData) {
        console.log(`  - org=${m.org} key=${m.key} schema=${m.schema}(${has(m.schemaPresent)}) role=${m.role}(${has(m.rolePresent)})`)
      }
      console.log(`[reconcile] ${diff.clean ? '✓' : '✗'} 数据面有、平台无：${diff.missingInPlatform.length} 条`)
      for (const m of diff.missingInPlatform) {
        console.log(`  - key=${m.key} schema=${m.schema}(${has(m.schemaPresent)}) role=${m.role}(${has(m.rolePresent)})`)
      }
      console.log(`[reconcile] ${diff.clean ? '✓' : '✗'} 认不出的 tenant_* 对象：${diff.unattributable.length} 条`)
      for (const name of diff.unattributable) {
        console.log(`  - ${name}（不是本约定产生的名字：既不报成租户资源，也不静默丢弃 —— 请人工确认它的归属）`)
      }
      if (diff.clean) {
        console.log('[reconcile] OK：平台启用集与数据面已建 schema/role 一致（两个差集都空）')
      } else {
        console.log('[reconcile] 差集非空 ⇒ exit 1（对账失败必须显式可见：openship job 靠退出码变红，不靠人读日志）')
      }
    }
    // 出口码就是 job 的信号面（干净 0 / 漂移 1）；连接池在 finally 里关
    process.exitCode = diff.clean ? 0 : 1
  } finally {
    await platform.end().catch(() => {})
    await warehouse.end().catch(() => {})
  }
}

if (process.argv[1]?.endsWith('reconcile-data-tenants.mjs')) {
  main().catch((e) => {
    console.error(`[reconcile] 无法对账（exit 2）：${/** @type {Error} */ (e).message}`)
    process.exit(2)
  })
}
