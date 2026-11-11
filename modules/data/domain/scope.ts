// scope.ts — 数据范围 scope 的加载、合并与 SQL 片段（spec 2026-11-10 §3–§5）。
//
// 单一执法点：本文件只产出 filters / denial，真正拼进 WHERE 的仍是 authz.ts 的
// `authorizeCore()`——数据面没有任何第二处 scope 判定。
//
// 维度可用性以 `metric.groupBy`（grainDimsOf）为准：
//   · brand 需要 system_book
//   · store 需要 (system_book, branch_num)，或直接 region_l1/region_name
//   · category 需要 (system_book, item_num)，或直接 category_group
// 缺维度 ⇒ 拒绝（fail-closed），不是“没维度就不裁”。
//
// 两账套门店号/商品号会重复 ⇒ store/category 子查询一律复合键
// `(system_book, branch_num)` / `(system_book, item_num)`，禁止裸 branch_num/item_num。
import type { Pool } from 'pg'
import { sqlQuote, type MetricDef, type Requester, type ScopePlan } from './authz'

export type ScopeKind = 'brand' | 'store' | 'category'
export type ScopeMode = 'off' | 'shadow' | 'enforce'

export interface ScopeSelector {
  system_book?: string[]
  region_l1?: string[]
  region_name?: string[]
  category_group?: string[]
  all?: boolean
}

export interface EffectiveScopes {
  brand: ScopeSelector[]
  store: ScopeSelector[]
  category: ScopeSelector[]
}

export interface DataScopePlan extends ScopePlan {
  /** 实际生效的 kind（审计/排障用；shadow 也写）。 */
  applied: ScopeKind[]
}

/** 显式三态：未知值按 off（不裁），生产必须显式设 shadow/enforce。 */
export function scopeModeOf(env: NodeJS.ProcessEnv): ScopeMode {
  const raw = env.DATA_SCOPE_MODE
  if (raw === 'shadow') return 'shadow'
  if (raw === 'enforce') return 'enforce'
  return 'off'
}

/**
 * 启动期一次性告警：`DATA_SCOPE_MODE` **设了值但不认识**（`enfore` / `Shadow` 之类）。
 *
 * 为什么单独一个函数而不是塞进 `scopeModeOf`：后者是**纯函数**（每次请求都调），
 * 在里面打日志会按请求刷屏；而且「配置拼错」是**启动期**问题，只在装配时喊一次就够。
 * 静默回落 off 是最危险的形态——运营以为切了 enforce，实际一条都没裁。
 */
export function warnIfScopeModeUnrecognized(
  env: NodeJS.ProcessEnv,
  warn: (msg: string) => void = console.warn,
): void {
  const raw = env.DATA_SCOPE_MODE
  if (raw === undefined || raw === '') return
  if (raw === 'off' || raw === 'shadow' || raw === 'enforce') return
  warn(JSON.stringify({
    event: 'data_scope_mode_unrecognized',
    value: raw,
    effect: 'treated as off（不裁）—— 拼写错误会让 enforce 静默失效',
  }))
}

const emptyScopes = (): EffectiveScopes => ({ brand: [], store: [], category: [] })

/** selector 闭集校验：只接受已知键与字符串数组 / all:true；坏形状 fail-closed。 */
export function normalizeSelector(raw: unknown): ScopeSelector | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.some((k) => !['system_book', 'region_l1', 'region_name', 'category_group', 'all'].includes(k))) return null
  if (o.all !== undefined && o.all !== true) return null
  const out: ScopeSelector = {}
  for (const key of ['system_book', 'region_l1', 'region_name', 'category_group'] as const) {
    const v = o[key]
    if (v === undefined) continue
    if (!Array.isArray(v) || v.length === 0 || v.some((x) => typeof x !== 'string' || x === '')) return null
    out[key] = [...new Set(v as string[])]
  }
  if (o.all === true) out.all = true
  return Object.keys(out).length > 0 ? out : null
}

/**
 * 加载用户的有效 scope：用户直接 assignment ∪ 用户角色 assignment。
 *
 * `roles` 目前只在 PAT/渠道 C 的 Identity 上；会话通道 Phase 2 补。迁移会给每个业务用户写
 * user-level assignment 兜底，因此会话用户不会因缺 roles 而失权。
 */
export async function loadEffectiveScopes(
  pool: Pool,
  org: string,
  requester: Requester,
): Promise<EffectiveScopes> {
  const users = [...new Set([requester.accountName, requester.userId]
    .filter((x): x is string => typeof x === 'string' && x !== ''))]
  // Casdoor 的 `user.roles` 可能是短名，也可能是全形 `org/role`（与 effectiveScopes.matchRoles
  // 的「短名/全形双认」同源）；assignment 的 subject_id 一律存短名 ⇒ 这里归一再比。
  const roles = [...new Set((requester.roles ?? [])
    .map((r) => r.split('/').pop()?.trim() ?? '')
    .filter((r) => r !== ''))]
  const out = emptyScopes()
  if (users.length === 0 && roles.length === 0) return out
  const r = await pool.query(
    `select s.kind, s.selector
       from data.scope_assignment a
       join data.scope s on s.id = a.scope_id and s.org = a.org
      where a.org = $1
        and ((a.subject_type = 'user' and a.subject_id = any($2::text[]))
          or (a.subject_type = 'role' and a.subject_id = any($3::text[])))`,
    [org, users, roles],
  )
  for (const row of r.rows as Array<{ kind: ScopeKind; selector: unknown }>) {
    const kind = row.kind
    if (kind !== 'brand' && kind !== 'store' && kind !== 'category') continue
    const selector = normalizeSelector(row.selector)
    if (selector === null) throw new Error(`INVALID_SCOPE_SELECTOR:${kind}`)
    out[kind].push(selector)
  }
  return out
}

const valuesOf = (selectors: readonly ScopeSelector[], key: keyof ScopeSelector): string[] => {
  const set = new Set<string>()
  for (const s of selectors) {
    const v = s[key]
    if (Array.isArray(v)) for (const x of v) set.add(x)
  }
  return [...set]
}

const placeholders = (values: readonly string[]): string => values.map((v) => sqlQuote(v)).join(', ')

/**
 * 把有效 scope 编译成 metric 可用的 filters / denial。
 *
 * `off` / 管理员（data:manage / tenant:admin）⇒ 不裁。
 * 同 kind 并集；不同 kind AND；任一 all ⇒ 该 kind 不裁。
 */
export function buildScopePlan(
  metric: MetricDef,
  scopes: EffectiveScopes,
  org: string,
  requester: Requester,
  mode: ScopeMode,
): DataScopePlan {
  if (mode === 'off' || requester.hasScope('data:manage') || requester.hasScope('tenant:admin')) {
    return { filters: [], denial: null, applied: [] }
  }
  const dims = new Set(metric.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== ''))
  const filters: string[] = []
  const applied: ScopeKind[] = []
  const deny = (detail: string): DataScopePlan => ({ filters: [], denial: detail, applied })

  // ── brand = system_book ───────────────────────────────────────────────────
  const systemBooks = valuesOf(scopes.brand, 'system_book')
  if (systemBooks.length === 0) return deny('no_brand_scope')
  if (!dims.has('system_book')) return deny('range_dimension_missing:brand')
  filters.push(` AND system_book IN (${placeholders(systemBooks)})`)
  applied.push('brand')

  // ── store = region_l1 / region_name → branch_num（复合键）─────────────────
  if (scopes.store.some((s) => s.all === true)) {
    applied.push('store')
  } else if (scopes.store.length === 0) {
    return deny('no_store_scope')
  } else {
    const l1 = valuesOf(scopes.store, 'region_l1')
    const l2 = valuesOf(scopes.store, 'region_name')
    if (l1.length === 0 && l2.length === 0) return deny('store_selector_empty')
    if (!dims.has('system_book')) return deny('range_dimension_missing:system_book')
    if (dims.has('branch_num')) {
      const regionParts = [
        ...(l1.length > 0 ? [`region_l1 IN (${placeholders(l1)})`] : []),
        ...(l2.length > 0 ? [`region_name IN (${placeholders(l2)})`] : []),
      ]
      filters.push(
        ` AND (system_book, branch_num) IN (`
        + `SELECT system_book, branch_num FROM dim_lemeng_branch`
        + ` WHERE org = ${sqlQuote(org)} AND (${regionParts.join(' OR ')}))`,
      )
      applied.push('store')
    } else if (dims.has('region_l1') || dims.has('region_name')) {
      const regionParts = [
        ...(l1.length > 0 && dims.has('region_l1') ? [`region_l1 IN (${placeholders(l1)})`] : []),
        ...(l2.length > 0 && dims.has('region_name') ? [`region_name IN (${placeholders(l2)})`] : []),
      ]
      if (regionParts.length === 0) return deny('range_dimension_missing:store')
      filters.push(` AND (${regionParts.join(' OR ')})`)
      applied.push('store')
    } else {
      return deny('range_dimension_missing:store')
    }
  }

  // ── category = category_group → item_num（复合键）─────────────────────────
  if (scopes.category.some((s) => s.all === true)) {
    applied.push('category')
  } else if (scopes.category.length === 0) {
    return deny('no_category_scope')
  } else {
    const groups = valuesOf(scopes.category, 'category_group')
    if (groups.length === 0) return deny('category_selector_empty')
    if (!dims.has('system_book')) return deny('range_dimension_missing:system_book')
    if (dims.has('item_num')) {
      filters.push(
        ` AND (system_book, item_num) IN (`
        + `SELECT system_book, item_num FROM dim_item_latest`
        + ` WHERE org = ${sqlQuote(org)} AND category_group IN (${placeholders(groups)}))`,
      )
      applied.push('category')
    } else if (dims.has('category_group')) {
      filters.push(` AND category_group IN (${placeholders(groups)})`)
      applied.push('category')
    } else {
      // D1：门店总量指标没有商品维度 ⇒ 拒绝，不静默放行。
      return deny('range_dimension_missing:category')
    }
  }

  return { filters, denial: null, applied }
}
