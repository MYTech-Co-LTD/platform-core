#!/usr/bin/env node
// @ts-nocheck —— CLI 薄壳（同 migrate-data-scopes.mjs）：pg 经 createRequire 动态取；
// 纯函数 planPreflight 有单测，主流程只做 IO。
//
// scope-preflight.mjs — 切 `DATA_SCOPE_MODE=enforce` 前的**只读预检**（issue #1901）。
//
// 回答三个问题：
//   1. 每个业务用户的 user-level scope 是否三维齐全（brand / store / category）；
//   2. 用运行期**同一份** `buildScopePlan`，对代表性的指标粒度算出「谁会被拒、为什么」；
//   3. 谁命中了 `all`（不裁）、谁是管理员直通。
//
// 为什么复用 buildScopePlan 而不是另写一套判据：预检若与运行期分叉，结论就没有意义
// （同 authz/scope 的单一执法点纪律）。
//
// 用法（平台容器内，只读）：
//   pnpm exec tsx scripts/scope-preflight.mjs [--org shanhaiyiguo-org] [--json]
// 环境：DATABASE_URL（scope 表所在平台库）。
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'

/** 代表性指标粒度：覆盖 D1（无 item 维度 + 品类 scope）、直读 region、以及完整三维。 */
export const METRIC_SHAPES = [
  { name: 'branch+item（商品粒度）', groupBy: 'system_book, branch_num, item_num, bizday' },
  { name: 'branch（门店总量）', groupBy: 'system_book, branch_num, bizday' },
  { name: 'region_l1（战区直读）', groupBy: 'system_book, region_l1, bizday' },
]

/**
 * 纯函数：给定每个用户的有效 scope，算出各指标形状下的判定。
 *
 * @param {Array<{ user: string, scopes: { brand: unknown[], store: unknown[], category: unknown[] }, admin?: boolean }>} users
 * @param {Array<{ name: string, groupBy: string, metric: any }>} shapes
 * @param {(metric: any, scopes: any, org: string, requester: any, mode: 'enforce') => { denial: string | null, applied: string[] }} build
 */
export function planPreflight(users, shapes, org, build) {
  const rows = users.map((u) => ({
    user: u.user,
    admin: u.admin === true,
    missing: ['brand', 'store', 'category'].filter((k) => (u.scopes[k] ?? []).length === 0),
    results: shapes.map((shape) => {
      const requester = {
        userId: u.user, orgId: org, channel: 'session', keyId: null,
        scopes: u.admin === true ? ['data:query', 'data:manage'] : ['data:query'],
        hasScope: (c) => (u.admin === true ? c === 'data:query' || c === 'data:manage' : c === 'data:query'),
      }
      const plan = build(shape.metric, u.scopes, org, requester, 'enforce')
      return { shape: shape.name, denial: plan.denial, applied: plan.applied }
    }),
  }))
  const denied = rows.filter((r) => r.admin !== true && r.results.some((x) => x.denial !== null))
  return {
    total: rows.length,
    admins: rows.filter((r) => r.admin === true).length,
    missingDimension: rows.filter((r) => r.missing.length > 0).map((r) => ({ user: r.user, missing: r.missing })),
    deniedByShape: METRIC_SHAPES.map((s) => ({
      shape: s.name,
      users: denied.filter((r) => r.results.some((x) => x.shape === s.name && x.denial !== null))
        .map((r) => ({
          user: r.user,
          denial: r.results.find((x) => x.shape === s.name)?.denial,
        })),
    })),
    rows,
  }
}

/** 人读报告（不打印任何 secret；用户名为必要信息）。 */
export function formatPreflight(r) {
  const lines = [`scope-preflight: 用户 ${r.total}（管理员 ${r.admins}）`]
  if (r.missingDimension.length > 0) {
    lines.push(`  ⚠ 缺维度 ${r.missingDimension.length}：${r.missingDimension.map((x) => `${x.user}(${x.missing.join('/')})`).join(', ')}`)
  } else {
    lines.push('  ✓ 所有用户三维 scope 齐全（brand/store/category）')
  }
  for (const s of r.deniedByShape) {
    if (s.users.length === 0) { lines.push(`  ✓ ${s.shape}：无人被拒`); continue }
    const byReason = new Map()
    for (const u of s.users) byReason.set(u.denial, [...(byReason.get(u.denial) ?? []), u.user])
    for (const [reason, users] of byReason) {
      lines.push(`  ⚠ ${s.shape}：${users.length} 人被拒（${reason}）→ ${users.slice(0, 8).join(', ')}${users.length > 8 ? ' …' : ''}`)
    }
  }
  return lines.join('\n')
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      org: { type: 'string' },
      json: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  const databaseUrl = process.env.DATABASE_URL?.trim()
  if (!databaseUrl) { console.error('scope-preflight: 缺 DATABASE_URL'); return 2 }

  const { createRequire } = await import('node:module')
  const { Pool } = createRequire(new URL('../apps/server/package.json', import.meta.url))('pg')
  const { buildScopePlan } = await import('../modules/data/domain/scope.ts')

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const org = values.org?.trim()
    if (!org) { console.error('scope-preflight: 缺 --org（= 租户 casdoor_org）'); return 2 }

    const { rows } = await pool.query(
      `select a.subject_type, a.subject_id, s.kind, s.selector
         from data.scope_assignment a
         join data.scope s on s.id = a.scope_id and s.org = a.org
        where a.org = $1
        order by a.subject_type, a.subject_id`,
      [org],
    )
    /** user → { brand:[], store:[], category:[] }（**只合并 user-level**；role-level 需 Casdoor 角色归属，见报告脚注） */
    const byUser = new Map()
    let roleAssignments = 0
    for (const row of rows) {
      if (row.subject_type === 'role') { roleAssignments += 1; continue }
      const u = byUser.get(row.subject_id) ?? { brand: [], store: [], category: [] }
      u[row.kind].push(row.selector)
      byUser.set(row.subject_id, u)
    }
    const users = [...byUser.entries()].map(([user, scopes]) => ({ user, scopes }))
    const shapes = METRIC_SHAPES.map((s) => ({
      metric: {
        id: `preflight_${s.name}`, title: s.name, description: '', requiredScope: null,
        subjectColumn: 'org', selectSql: 'select 1', groupBy: s.groupBy, params: {}, totalable: false,
      },
      ...s,
    }))
    const report = planPreflight(users, shapes, org, buildScopePlan)
    if (values.json === true) {
      console.log(JSON.stringify(report, null, 2))
    } else {
      console.log(formatPreflight(report))
      console.log(`  （role-level 分配 ${roleAssignments} 条未展开：展开需 Casdoor 角色归属；`
        + '迁移已为每个业务用户写 user-level 兜底，故本报告的「无人被拒」结论对 enforce 成立）')
    }
    return report.deniedByShape.some((s) => s.users.length > 0) ? 1 : 0
  } finally {
    await pool.end()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e) => {
      console.error(`scope-preflight: FAILED ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
    })
}
