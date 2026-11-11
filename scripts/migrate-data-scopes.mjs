#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（同 org-sync-all.mjs）：pg 经 createRequire 动态取；纯函数有单测，
// 主流程靠 --apply 前的 dry-run 真机验。
//
// migrate-data-scopes.mjs — 数据范围 scope 的一次性迁移（spec 2026-11-10 §6）。
//
// 源：Casdoor `shanhai` org（data-analysis 的正式授权，**只读**）——
//   · 27 个角色 = 5 职能（总经理/财务总/战区总/小区经理/采购负责人）+ 22 范围（`范围|X`，含全店）；
//   · `Role.Users` 成员；permission 记录的 `resources`（品牌/品类/成本/门禁）。
// 目标：`shanhaiyiguo-org`——DB 的 `data.scope` / `data.scope_assignment` + Casdoor 5 职能角色。
//
// 映射（spec §6.2/§6.3）：
//   · `范围|全店` → `{all:true}`；其余 `范围|X` → 按 `dim_region` 的 region_name / region_l1 命中；
//   · `品牌|*` → 全部 `system_book`（`dim_brand`）；`品类|*` → 水果/标品/耗材；
//   · `字段|成本可见` → 平台码 `data:cost`；`门禁|报表中心` → `data:query`；
//   · `门禁|管理台` / `看板|*` 不映射（逐条列进 dry-run 差异清单）。
//
// 语义：
//   · 默认 dry-run（零写入）；`--apply` 才写 DB 与 Casdoor；
//   · 幂等：scope 按 (org,name) upsert；assignment `on conflict do nothing`；
//     Casdoor 角色先 createRole 再整组 setRoleMembers；
//   · 兜底（spec §6.4）：每个业务用户同时写 user-level assignment，`roles` 未进会话也不空窗；
//   · 每个用户必须有 brand/store scope，否则 enforce 后会被拒绝——dry-run 逐类列出，**不猜**。
//
// 用法：
//   pnpm exec tsx scripts/migrate-data-scopes.mjs                  # dry-run（默认源/目标 org）
//   pnpm exec tsx scripts/migrate-data-scopes.mjs --apply          # 写入
//   pnpm exec tsx scripts/migrate-data-scopes.mjs --skip-casdoor   # 只写 DB（Casdoor 角色后做）
// 环境：DATABASE_URL（scope 表所在平台库）/ DATA_WAREHOUSE_URL（数据面库，读 dim_region /
//      dim_brand / dim_item_latest；缺省回落 DATABASE_URL——单库私有化部署）
//      / CASDOOR_URL / CASDOOR_ADMIN_USER / CASDOOR_ADMIN_PWD
//      （可选 DIM_SCHEMA，缺省 staging；CASDOOR_APPLICATION 透传给写侧）。
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** 5 个职能角色（spec §1.1；顺序仅用于打印）。 */
export const FUNCTIONAL_ROLES = ['总经理', '财务总', '战区总', '小区经理', '采购负责人']

/** D4：旧账号别名（同一人；旧账号均 isForbidden）——不别名 = 同一人拿到两份/零份授权。 */
export const USER_ALIASES = new Map([
  ['DongJiJuan_1', 'DongJiJuan'],
  ['Dongjijuan', 'DongJiJuan'],
])

/**
 * 用户拍板的补充 scope（spec §7.1 Phase 0 结论，2026-11-10）：源 Casdoor 里没有、但业务确认要给。
 * 陈超（总经理，`ccccccccccccctv`）没有任何范围角色 ⇒ D2 会拒绝 ⇒ 拍板给全店。
 * **只在这里补数据**——不要回写旧 org（全程只读）。
 */
export const EXTRA_USER_SCOPES = [
  { user: 'ccccccccccccctv', kind: 'store', selector: { all: true }, legacyLabel: '拍板|全店' },
]

/** `品类|*` 展开为三分类（spec §6.3；`其他` 是兜底组，不授予）。 */
export const CATEGORY_ALL = ['水果', '标品', '耗材']

/** Casdoor users 可能是全形 `org/name`，也可能是短名。 */
export function shortName(u) {
  return String(u ?? '').split('/').pop().trim()
}

export function normalizeUser(u) {
  const s = shortName(u)
  return USER_ALIASES.get(s) ?? s
}

/** 一个 permission 记录的角色引用 → 短名集合。 */
export function rolesOf(record) {
  return Array.isArray(record?.roles) ? record.roles.map(shortName).filter(Boolean) : []
}

/** 角色 → resources 并集（permission.roles 反查；同 org 内短名/全形双认）。 */
export function resourcesByRole(permissions) {
  const out = new Map()
  for (const p of permissions ?? []) {
    const resources = Array.isArray(p?.resources) ? p.resources.filter((r) => typeof r === 'string') : []
    for (const role of rolesOf(p)) {
      const set = out.get(role) ?? new Set()
      for (const r of resources) set.add(r)
      out.set(role, set)
    }
  }
  return out
}

/**
 * `范围|X` → selector。X 命中二级名（region_name）或一级名（region_l1）。
 * 未命中返回 null（dry-run 报错，不猜——spec §6.3）。
 */
export function selectorForRange(name, regions) {
  if (name === '全店') return { selector: { all: true }, matchedBy: 'all' }
  const byName = (regions ?? []).some((r) => r.region_name === name)
  if (byName) return { selector: { region_name: [name] }, matchedBy: 'region_name' }
  const byL1 = (regions ?? []).some((r) => r.region_l1 === name)
  if (byL1) return { selector: { region_l1: [name] }, matchedBy: 'region_l1' }
  return null
}

/** `品牌|X` → system_book 列表；`*` = 全部品牌。未命中返回 null。 */
export function brandsForResource(name, brands) {
  if (name === '*') return (brands ?? []).map((b) => String(b.system_book))
  const hit = (brands ?? []).filter((b) => b.brand_name === name)
  return hit.length > 0 ? hit.map((b) => String(b.system_book)) : null
}

/** scope 的稳定名字（`(org,name)` 唯一）。 */
export function scopeNameOf(kind, selector) {
  if (kind === 'brand') {
    return selector.all === true || (selector.system_book ?? []).length === 0
      ? '品牌|全品牌'
      : `品牌|${selector.system_book.join('+')}`
  }
  if (kind === 'store') {
    if (selector.all === true) return '门店|全店'
    const key = Object.keys(selector)[0]
    return `门店|${selector[key][0]}`
  }
  if (selector.all === true) return '品类|全品类'
  return `品类|${(selector.category_group ?? []).join('+')}`
}

/**
 * 干跑计划（纯函数：不碰 DB/Casdoor）。
 *
 * @param {{
 *   sourceRoles: Array<{ name: string, users?: string[] }>,
 *   permissions: Array<{ roles?: string[], resources?: string[] }>,
 *   brands: Array<{ system_book: string|number, brand_name: string }>,
 *   regions: Array<{ system_book: string|number, region_name: string|null, region_l1: string|null, level: number }>,
 *   categoryGroups: string[],
 *   targetUsers: string[],
 *   targetOrg: string,
 *   sourceOrg: string,
 * }} input
 */
export function planMigration(input) {
  const {
    sourceRoles, permissions, brands, regions, categoryGroups, targetUsers, targetOrg, sourceOrg,
  } = input
  const resources = resourcesByRole(permissions)
  const targetSet = new Set((targetUsers ?? []).map(shortName))
  const scopes = new Map()          // name → { name, kind, selector, legacyLabel }
  const assignments = []            // { subjectType, subjectId, scopeName }
  const unmappedResources = []      // { role, resource }
  const unmappedRanges = []         // { role }
  const aliasedUsers = []           // { from, to }
  const noResources = []            // role
  const functional = []
  const rangeScopes = []
  const userStoreScope = new Map()  // user → Set(scopeName)
  const userBrandScope = new Map()  // user → Set(scopeName)
  const userCategoryScope = new Map()
  const addUserScope = (m, user, scopeName) => {
    const s = m.get(user) ?? new Set()
    s.add(scopeName)
    m.set(user, s)
  }
  const addScope = (kind, selector, legacyLabel) => {
    const name = scopeNameOf(kind, selector)
    if (!scopes.has(name)) scopes.set(name, { name, kind, selector, legacyLabel })
    return name
  }

  const recordInputAliases = (users) => {
    for (const raw of users ?? []) {
      const from = shortName(raw)
      const to = USER_ALIASES.get(from)
      if (to !== undefined) aliasedUsers.push({ from: `${sourceOrg}/${from}`, to })
    }
  }

  // ── 5 职能角色：品牌 / 品类（role-level + user-level 兜底）─────────────────────
  for (const role of FUNCTIONAL_ROLES) {
    const src = sourceRoles.find((r) => r.name === role)
    if (!src) {
      functional.push({ role, present: false, users: [] })
      continue
    }
    const users = [...new Set((src.users ?? []).map(normalizeUser).filter(Boolean))]
    recordInputAliases(src.users)
    const res = [...(resources.get(role) ?? [])]
    if (res.length === 0) noResources.push(role)

    // brand
    const brandBooks = new Set()
    let brandAll = false
    for (const resource of res) {
      const [head, ...rest] = resource.split('|')
      const value = rest.join('|')
      if (head === '品牌') {
        const books = brandsForResource(value, brands)
        if (books === null) unmappedResources.push({ role, resource })
        else if (value === '*') brandAll = true
        else for (const b of books) brandBooks.add(b)
      } else if (head === '品类') {
        // handled below
      } else if (head === '字段' && value === '成本可见') {
        // cost：Casdoor 码，DB 侧无字段
      } else if (head === '门禁') {
        if (value !== '报表中心') unmappedResources.push({ role, resource })
      } else if (head === '看板') {
        unmappedResources.push({ role, resource })  // 二期：报表可见性
      } else {
        unmappedResources.push({ role, resource })
      }
    }
    const brandSelector = brandAll || brandBooks.size > 0
      ? (brandAll ? { system_book: (brands ?? []).map((b) => String(b.system_book)) } : { system_book: [...brandBooks] })
      : null
    let brandScope = null
    if (brandSelector !== null && brandSelector.system_book.length > 0) {
      brandScope = addScope('brand', brandSelector, brandAll ? '品牌|*' : `品牌|${[...brandBooks].join('+')}`)
      assignments.push({ subjectType: 'role', subjectId: role, scopeName: brandScope })
      for (const u of users) addUserScope(userBrandScope, u, brandScope)
    }

    // category
    const groups = new Set()
    let catAll = false
    for (const resource of res) {
      const [head, ...rest] = resource.split('|')
      const value = rest.join('|')
      if (head !== '品类') continue
      if (value === '*') { catAll = true; continue }
      if (!['水果', '标品', '耗材', '其他'].includes(value)) {
        unmappedResources.push({ role, resource })
        continue
      }
      groups.add(value)
    }
    const categorySelector = catAll
      ? { category_group: CATEGORY_ALL.filter((g) => categoryGroups.length === 0 || categoryGroups.includes(g)) }
      : (groups.size > 0 ? { category_group: [...groups] } : null)
    let categoryScope = null
    if (categorySelector !== null && categorySelector.category_group.length > 0) {
      categoryScope = addScope('category', categorySelector, catAll ? '品类|*' : `品类|${[...groups].join('+')}`)
      assignments.push({ subjectType: 'role', subjectId: role, scopeName: categoryScope })
      for (const u of users) addUserScope(userCategoryScope, u, categoryScope)
    }

    functional.push({
      role, present: true, users,
      resources: res,
      codes: {
        query: res.includes('门禁|报表中心'),
        cost: res.includes('字段|成本可见'),
      },
      brandScope, categoryScope,
    })
  }

  // ── 22 范围角色：转成 store scope + user-level assignment ─────────────────────
  for (const src of sourceRoles) {
    if (!String(src.name).startsWith('范围|')) continue
    const rangeName = String(src.name).slice('范围|'.length)
    const hit = selectorForRange(rangeName, regions)
    const users = [...new Set((src.users ?? []).map(normalizeUser).filter(Boolean))]
    recordInputAliases(src.users)
    if (hit === null) {
      unmappedRanges.push({ role: src.name, rangeName })
      continue
    }
    const scopeName = addScope('store', hit.selector, `范围|${rangeName}`)
    for (const u of users) addUserScope(userStoreScope, u, scopeName)
    rangeScopes.push({ role: src.name, selector: hit.selector, matchedBy: hit.matchedBy, users, scopeName })
  }

  // ── 用户拍板的补充 scope（EXTRA_USER_SCOPES）：只补、不覆盖源数据 ────────────────
  for (const extra of EXTRA_USER_SCOPES) {
    const scopeName = addScope(extra.kind, extra.selector, extra.legacyLabel)
    const m = extra.kind === 'brand' ? userBrandScope
      : extra.kind === 'store' ? userStoreScope : userCategoryScope
    addUserScope(m, extra.user, scopeName)
  }

  // 每个 store / 品牌 / 品类 scope 的 user-level 兜底 assignment
  for (const [user, set] of userStoreScope) {
    for (const scopeName of set) assignments.push({ subjectType: 'user', subjectId: user, scopeName })
  }
  for (const [user, set] of userBrandScope) {
    for (const scopeName of set) assignments.push({ subjectType: 'user', subjectId: user, scopeName })
  }
  for (const [user, set] of userCategoryScope) {
    for (const scopeName of set) assignments.push({ subjectType: 'user', subjectId: user, scopeName })
  }

  // 业务用户全集 = 5 职能角色成员 ∪ 范围角色成员
  const businessUsers = new Set([
    ...[...userStoreScope.keys()],
    ...[...userBrandScope.keys()],
    ...[...userCategoryScope.keys()],
    ...functional.flatMap((f) => f.users),
  ])
  const usersWithoutStore = [...businessUsers].filter((u) => !(userStoreScope.get(u)?.size > 0)).sort()
  const usersWithoutBrand = [...businessUsers].filter((u) => !(userBrandScope.get(u)?.size > 0)).sort()
  const usersWithoutCategory = [...businessUsers].filter((u) => !(userCategoryScope.get(u)?.size > 0)).sort()
  const usersMissingInTarget = [...businessUsers].filter((u) => !targetSet.has(u)).sort()

  return {
    sourceOrg, targetOrg,
    functional,
    rangeScopes,
    scopes: [...scopes.values()],
    assignments,
    unmappedResources,
    unmappedRanges,
    noResources,
    aliasedUsers,
    businessUsers: [...businessUsers].sort(),
    usersWithoutStore,
    usersWithoutBrand,
    usersWithoutCategory,
    usersMissingInTarget,
  }
}

/** 干跑报告（不打印任何 secret；行数足够长时截断示例）。 */
export function formatPlan(plan) {
  const lines = []
  lines.push(`migrate-data-scopes: ${plan.sourceOrg}（只读）→ ${plan.targetOrg}`)
  lines.push(`  业务用户 ${plan.businessUsers.length}；scope ${plan.scopes.length}；assignment ${plan.assignments.length}`)
  for (const f of plan.functional) {
    if (!f.present) { lines.push(`  职能角色 ${f.role}: 源中不存在（跳过）`); continue }
    lines.push(`  职能角色 ${f.role}: users=${f.users.length} brand=${f.brandScope ?? '-'} category=${f.categoryScope ?? '-'}`
      + ` query=${f.codes.query} cost=${f.codes.cost}`)
  }
  lines.push(`  范围 scope ${plan.rangeScopes.length} 个：${plan.rangeScopes.map((r) => `${r.role}=${r.users.length}`).join(' ')}`)
  if (plan.aliasedUsers.length > 0) {
    lines.push(`  别名归一 ${plan.aliasedUsers.length}：${plan.aliasedUsers.map((a) => `${a.from}→${a.to}`).join(' ')}`)
  }
  for (const [label, list] of [
    ['未映射的资源', plan.unmappedResources.map((x) => `${x.role}:${x.resource}`)],
    ['未映射的范围角色', plan.unmappedRanges.map((x) => x.role)],
    ['无 resources 的职能角色', plan.noResources],
    ['无 store scope 的用户', plan.usersWithoutStore],
    ['无品牌 scope 的用户', plan.usersWithoutBrand],
    ['无品类 scope 的用户', plan.usersWithoutCategory],
    ['目标 org 不存在的用户', plan.usersMissingInTarget],
  ]) {
    if (list.length === 0) continue
    const shown = list.slice(0, 12).join(', ')
    lines.push(`  ⚠ ${label} ${list.length}：${shown}${list.length > 12 ? ' …' : ''}`)
  }
  return lines.join('\n')
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      apply: { type: 'boolean', default: false },
      'skip-casdoor': { type: 'boolean', default: false },
      'source-org': { type: 'string', default: 'shanhai' },
      'target-org': { type: 'string', default: 'shanhaiyiguo-org' },
      'dim-schema': { type: 'string', default: process.env.DIM_SCHEMA ?? 'staging' },
    },
    allowPositionals: false,
  })
  const apply = values.apply === true
  const skipCasdoor = values['skip-casdoor'] === true
  const sourceOrg = values['source-org']
  const targetOrg = values['target-org']
  const dimSchema = values['dim-schema']

  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) { console.error('migrate-data-scopes: 缺 DATABASE_URL'); return 2 }
  // 维度表在**数据面**库（pg_duckdb 物化）；单库私有化部署可缺省回落平台库。
  const warehouseUrl = process.env.DATA_WAREHOUSE_URL?.trim() || databaseUrl
  const missing = ['CASDOOR_URL', 'CASDOOR_ADMIN_USER', 'CASDOOR_ADMIN_PWD'].filter((k) => !process.env[k])
  if (missing.length > 0) { console.error(`migrate-data-scopes: 缺 ${missing.join(' / ')}`); return 2 }

  const { createRequire } = await import('node:module')
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const { CasdoorClient } = await import('../packages/auth-core/src/public.ts')

  const clientFor = (org) => new CasdoorClient({
    origin: process.env.CASDOOR_URL,
    clientId: process.env.CASDOOR_CLIENT_ID ?? '',
    clientSecret: process.env.CASDOOR_CLIENT_SECRET ?? '',
    org,
    application: process.env.CASDOOR_APPLICATION,
    adminUser: process.env.CASDOOR_ADMIN_USER,
    adminPwd: process.env.CASDOOR_ADMIN_PWD,
  })

  const pool = new Pool({ connectionString: databaseUrl })
  const whPool = new Pool({ connectionString: warehouseUrl })
  try {
    const source = clientFor(sourceOrg)
    const target = clientFor(targetOrg)

    const [sourceRoles, permissions] = await Promise.all([source.listRoles(), source.getPermissions()])
    const targetUsers = (await target.listUsers()).map((u) => u.name)

    const { rows: brands } = await whPool.query(
      `select system_book, brand_name from ${dimSchema}.dim_brand order by system_book`,
    )
    const { rows: regions } = await whPool.query(
      `select system_book, region_name, region_l1, level from ${dimSchema}.dim_region`,
    )
    let categoryGroups = []
    try {
      const r = await whPool.query(
        `select distinct category_group from ${dimSchema}.dim_item_latest where category_group is not null order by 1`,
      )
      categoryGroups = r.rows.map((x) => x.category_group)
    } catch (e) {
      // 数据面未部署（新实例常见）⇒ 不阻断 dry-run，但必须让运营看见。
      console.warn(`migrate-data-scopes: ${dimSchema}.dim_item_latest 不可读（${e instanceof Error ? e.message : e}）；`
        + '品类 selector 按三分类发出，未做存在性核验')
    }

    const plan = planMigration({
      sourceRoles, permissions, brands, regions, categoryGroups, targetUsers, targetOrg, sourceOrg,
    })
    console.log(formatPlan(plan))

    const blocking = plan.unmappedRanges.length > 0
    if (blocking) {
      console.error('migrate-data-scopes: 有范围角色未映射到 dim_region ⇒ 不写入（先人工确认，别猜）')
      return 1
    }
    if (!apply) {
      console.log('migrate-data-scopes: dry-run（零写入）；确认后加 --apply')
      return 0
    }

    // ── 写入 DB（单事务：scope 先 upsert，assignment 再按 name 解析 id）──────────
    const client = await pool.connect()
    try {
      await client.query('begin')
      const idByName = new Map()
      for (const s of plan.scopes) {
        const r = await client.query(
          `insert into data.scope(org, name, kind, selector, legacy_label)
           values ($1, $2, $3, $4::jsonb, $5)
           on conflict (org, name) do update
             set kind = excluded.kind, selector = excluded.selector,
                 legacy_label = excluded.legacy_label, updated_at = now()
           returning id`,
          [targetOrg, s.name, s.kind, JSON.stringify(s.selector), s.legacyLabel],
        )
        idByName.set(s.name, r.rows[0].id)
      }
      for (const a of plan.assignments) {
        const id = idByName.get(a.scopeName)
        if (id === undefined) throw new Error(`scope id 未解析: ${a.scopeName}`)
        await client.query(
          `insert into data.scope_assignment(org, subject_type, subject_id, scope_id)
           values ($1, $2, $3, $4) on conflict do nothing`,
          [targetOrg, a.subjectType, a.subjectId, id],
        )
      }
      await client.query(
        `insert into data.scope_audit(org, actor, action, detail)
         values ($1, $2, $3, $4::jsonb)`,
        [targetOrg, 'system:migrate-data-scopes', 'migrate.data-scopes', JSON.stringify({
          sourceOrg,
          scopes: plan.scopes.length,
          assignments: plan.assignments.length,
          usersWithoutStore: plan.usersWithoutStore,
          unmappedResources: plan.unmappedResources,
        })],
      )
      await client.query('commit')
    } catch (e) {
      await client.query('rollback').catch(() => {})
      throw e
    } finally {
      client.release()
    }

    // ── 写入 Casdoor（5 职能角色：成员 + data:query / data:cost）─────────────────
    if (!skipCasdoor) {
      const existingRoles = new Set((await target.listRoles()).map((r) => r.name))
      for (const f of plan.functional) {
        if (!f.present) continue
        if (!existingRoles.has(f.role)) await target.createRole({ name: f.role, displayName: f.role })
        await target.setRoleMembers(f.role, f.users)
        if (f.codes.query) await target.grantPermissionToRole('data:query', f.role)
        if (f.codes.cost) await target.grantPermissionToRole('data:cost', f.role)
      }
      // 写后回读（铁律③）：角色成员逐个与计划一致
      const back = new Map((await target.listRoles()).map((r) => [r.name, r.users.map(shortName)]))
      for (const f of plan.functional) {
        if (!f.present) continue
        const got = new Set(back.get(f.role) ?? [])
        const want = new Set(f.users)
        if (got.size !== want.size || ![...want].every((u) => got.has(u))) {
          throw new Error(`回读未命中：${targetOrg}/${f.role} 成员数 ${got.size} ≠ ${want.size}`)
        }
      }
    } else {
      console.log('migrate-data-scopes: --skip-casdoor ⇒ 未创建/未授权 Casdoor 角色（稍后补跑）')
    }

    console.log(`migrate-data-scopes: applied org=${targetOrg} scopes=${plan.scopes.length} assignments=${plan.assignments.length}`)
    return 0
  } finally {
    await pool.end()
    await whPool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`migrate-data-scopes: FAILED ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    })
}
