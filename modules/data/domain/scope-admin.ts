// scope-admin.ts — 数据范围 scope 的管理面（CRUD / assignment 整组替换 / 有效 scope 预览）。
//
// 正典：spec 2026-11-10 §5.5。运行期解析（loadEffectiveScopes/buildScopePlan）在 scope.ts，
// 本文件只有**写路径**；两边共用 normalizeSelector——配置面放行的形状必须与运行期消费的形状
// 逐字同一份（这里另写一份校验 = 将来漂开的那份就是静默绕过口）。
//
// 纪律（与 dept-gate / metric-write 同一把尺）：
//   · 配置期校验 selector 值存在于受控维表（dim_brand / dim_region / dim_item_latest）——
//     绝不建「永远没人能满足」的门（validateDept_gate 同款 fail-closed）；
//   · 写后回读（Casdoor 三铁律在模块侧的同构）：create/update 回读目标行，assignment
//     整组替换回读后做**集合相等**比对，不一致即抛（不静默）；
//   · 全部写操作与 audit 同事务落 data.scope_audit（actor = 会话 identity）。
//
// ⚠️ subject_id 不做存在性校验：模块拿不到 Casdoor 用户/角色清单（B1），配一个不存在的
//    主体是**惰性**的（解析时自然空匹配），无越权面——登记在案，不做假校验。
import type { Pool } from 'pg'
import { loadEffectiveScopes, normalizeSelector, type EffectiveScopes, type ScopeKind, type ScopeSelector } from './scope'
import { deptNamesOf, userDeptClosure, userDirectDepts } from './dept-gate'
import { warehousePool } from './warehouse'

/** kind 允许的 selector 键集（闭集；混用 ⇒ INVALID_SELECTOR）。brand 不允许 all——
 *  buildScopePlan 对 brand 只读 system_book，`all` 会让有效 brand 集为空 ⇒ 恒 no_brand_scope，
 *  正是「看起来配了、其实全拒」的坏门，配置面直接拦。 */
const KEYS_BY_KIND: Record<ScopeKind, readonly string[]> = {
  brand: ['system_book'],
  store: ['region_l1', 'region_name', 'all'],
  category: ['category_group', 'all'],
}

export interface ScopeAdminDeps {
  /** 写池（data.scope / scope_assignment / scope_audit）。 */
  pool: Pool
  /** 仓库池（受控维表只读）。缺省 = `warehousePool()`（生产是另一张库）；测试注入替身。 */
  warehouse?: Pool
}

/**
 * 分配主体（2026-11-12 扩 dept）：
 * - dept：组织节点 ext_id（含祖先闭包）——**主路径**，人调岗自动跟随；
 * - role：岗位包（跨部门职能岗）；
 * - user：例外（临时补漏），保留但不鼓励。
 */
export interface AssignmentItem {
  subjectType: 'dept' | 'role' | 'user'
  subjectId: string
  /**
   * 仅 dept 有意义（045）：true（默认）= 含下级部门（按闭包匹配）；false = 只匹配直属成员。
   * 战区内分级的实现就靠它：战区范围挂 dept 且 false，区/店不继承。
   */
  includeChildren?: boolean
}

export interface ScopeView {
  id: number
  name: string
  kind: ScopeKind
  selector: ScopeSelector
  legacyLabel: string | null
  assignments: AssignmentItem[]
}

export interface ScopeWriteInput {
  name: string
  kind: ScopeKind
  selector: unknown
  legacyLabel?: string
}

export type AdminErr =
  | 'INVALID_NAME'        // 空/超长
  | 'INVALID_KIND'        // 非 brand/store/category
  | 'INVALID_SELECTOR'    // normalize 失败 / 键集与 kind 不符 / brand 带 all / store|category 空集
  | 'VALUE_NOT_IN_DIMS'   // 值不在受控维表（detail 列出未知值）
  | 'DIMS_UNAVAILABLE'    // 维表读不了 ⇒ 拒绝配置（fail-closed，不猜）
  | 'DUP_NAME'            // (org,name) 撞车
  | 'NOT_FOUND'           // id 不在本 org
  | 'INVALID_ASSIGNMENTS' // assignment 列表形状坏
  | 'UNKNOWN_DEPT'        // dept 主体不在本租户 org 表（活节点）⇒ 拒绝配置（detail 列未知 ext_id）
export type AdminResult<T> = { ok: true; value: T } | { ok: false; code: AdminErr; detail?: string }

const err = <T>(code: AdminErr, detail?: string): AdminResult<T> => ({ ok: false, code, ...(detail !== undefined ? { detail } : {}) })

/** selector 闭集 + kind 一致性（纯函数，配置面与测试共用）。 */
export function validateSelectorShape(kind: unknown, raw: unknown): AdminResult<ScopeSelector> {
  if (kind !== 'brand' && kind !== 'store' && kind !== 'category') return err('INVALID_KIND')
  const selector = normalizeSelector(raw)
  if (selector === null) return err('INVALID_SELECTOR')
  const keys = Object.keys(selector)
  if (keys.some((k) => !KEYS_BY_KIND[kind].includes(k))) return err('INVALID_SELECTOR')
  if (kind === 'brand' && selector.all === true) return err('INVALID_SELECTOR')
  if (kind !== 'brand' && selector.all !== true) {
    // all 之外的形态必须至少有一个非空键值（normalizeSelector 已保证非空数组，这里防御未来改动）
    const values = kind === 'store'
      ? [...(selector.region_l1 ?? []), ...(selector.region_name ?? [])]
      : [...(selector.category_group ?? [])]
    if (values.length === 0) return err('INVALID_SELECTOR')
  }
  return { ok: true, value: selector }
}

/** 受控维表存在性校验（仓库池，只读）。任何一个值不在 ⇒ 拒绝整条配置。 */
async function validateAgainstDims(
  warehouse: Pool, kind: ScopeKind, selector: ScopeSelector,
): Promise<AdminResult<true>> {
  const wanted: Array<{ sql: string; values: string[] }> = []
  if (kind === 'brand') {
    wanted.push({ sql: 'select system_book::varchar as v from dim_brand', values: selector.system_book ?? [] })
  } else if (kind === 'store') {
    if ((selector.region_l1 ?? []).length > 0) {
      wanted.push({
        sql: 'select distinct region_l1 as v from dim_region where region_l1 is not null',
        values: selector.region_l1 ?? [],
      })
    }
    if ((selector.region_name ?? []).length > 0) {
      wanted.push({
        sql: 'select distinct region_name as v from dim_region where region_name is not null',
        values: selector.region_name ?? [],
      })
    }
  } else if ((selector.category_group ?? []).length > 0) {
    wanted.push({
      sql: 'select distinct category_group as v from dim_item_latest where category_group is not null',
      values: selector.category_group ?? [],
    })
  }
  try {
    const unknown: string[] = []
    for (const w of wanted) {
      if (w.values.length === 0) continue
      const r = await warehouse.query(w.sql)
      const known = new Set((r.rows as Array<{ v: string | null }>).map((x) => x.v))
      for (const v of w.values) if (!known.has(v)) unknown.push(v)
    }
    if (unknown.length > 0) return err('VALUE_NOT_IN_DIMS', unknown.join(','))
    return { ok: true, value: true }
  } catch (e) {
    return err('DIMS_UNAVAILABLE', e instanceof Error ? e.message : String(e))
  }
}

async function writeAudit(
  client: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  org: string, actor: string, action: string, detail: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'insert into data.scope_audit(org, actor, action, detail) values ($1, $2, $3, $4::jsonb)',
    [org, actor, action, JSON.stringify(detail)],
  )
}

interface ScopeRow { id: number; name: string; kind: ScopeKind; selector: unknown; legacy_label: string | null }

const viewOf = (row: ScopeRow, assignments: AssignmentItem[]): ScopeView => ({
  id: row.id, name: row.name, kind: row.kind,
  selector: normalizeSelector(row.selector) ?? {}, legacyLabel: row.legacy_label, assignments,
})

/** 列出本 org 全部 scope（含各自的 assignment 清单；两次查询内存拼，管理面量级 << 千行）。 */
export async function listScopes(pool: Pool, org: string): Promise<ScopeView[]> {
  const scopes = await pool.query(
    'select id, name, kind, selector, legacy_label from data.scope where org = $1 order by kind, name', [org],
  )
  const grants = await pool.query(
    'select scope_id, subject_type, subject_id, include_children from data.scope_assignment where org = $1 order by subject_type, subject_id', [org],
  )
  const byScope = new Map<number, AssignmentItem[]>()
  for (const g of grants.rows as Array<{
    scope_id: number; subject_type: 'dept' | 'role' | 'user'; subject_id: string; include_children: boolean
  }>) {
    const list = byScope.get(g.scope_id) ?? []
    list.push({
      subjectType: g.subject_type,
      subjectId: g.subject_id,
      // 只给 dept 回传口径；user/role 恒 true，回传会让 UI 误以为可选择
      ...(g.subject_type === 'dept' ? { includeChildren: g.include_children } : {}),
    })
    byScope.set(g.scope_id, list)
  }
  return (scopes.rows as ScopeRow[]).map((r) => viewOf(r, byScope.get(r.id) ?? []))
}

/** 新建：形状校验 → 维表校验 → 唯一性预检 → 落库（事务含 audit）→ 回读。 */
export async function createScope(
  deps: ScopeAdminDeps, org: string, actor: string, input: ScopeWriteInput,
): Promise<AdminResult<ScopeView>> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '' || name.length > 100) return err('INVALID_NAME')
  const shape = validateSelectorShape(input.kind, input.selector)
  if (!shape.ok) return shape
  const selector = shape.value
  const dims = await validateAgainstDims(deps.warehouse ?? warehousePool(), input.kind, selector)
  if (!dims.ok) return dims
  const client = await deps.pool.connect()
  try {
    await client.query('begin')
    const dup = await client.query('select 1 from data.scope where org = $1 and name = $2', [org, name])
    if (dup.rows.length > 0) { await client.query('rollback'); return err('DUP_NAME') }
    const inserted = await client.query(
      `insert into data.scope(org, name, kind, selector, legacy_label)
       values ($1, $2, $3, $4::jsonb, $5) returning id, name, kind, selector, legacy_label`,
      [org, name, input.kind, JSON.stringify(selector), input.legacyLabel ?? null],
    )
    await writeAudit(client, org, actor, 'scope.create', { name, kind: input.kind, selector })
    await client.query('commit')
    return { ok: true, value: viewOf(inserted.rows[0] as ScopeRow, []) }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    if (e instanceof Error && /data_scope_name|duplicate key|unique/i.test(e.message)) return err('DUP_NAME')
    throw e
  } finally {
    client.release()
  }
}

/** 更新（整行替换语义；id 不动）。 */
export async function updateScope(
  deps: ScopeAdminDeps, org: string, actor: string, id: number, input: ScopeWriteInput,
): Promise<AdminResult<ScopeView>> {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '' || name.length > 100) return err('INVALID_NAME')
  const shape = validateSelectorShape(input.kind, input.selector)
  if (!shape.ok) return shape
  const selector = shape.value
  const dims = await validateAgainstDims(deps.warehouse ?? warehousePool(), input.kind, selector)
  if (!dims.ok) return dims
  const client = await deps.pool.connect()
  try {
    await client.query('begin')
    const before = await client.query(
      'select id, name, kind, selector, legacy_label from data.scope where org = $1 and id = $2', [org, id],
    )
    if (before.rows.length === 0) { await client.query('rollback'); return err('NOT_FOUND') }
    const dup = await client.query(
      'select 1 from data.scope where org = $1 and name = $2 and id <> $3', [org, name, id],
    )
    if (dup.rows.length > 0) { await client.query('rollback'); return err('DUP_NAME') }
    const updated = await client.query(
      `update data.scope set name = $2, kind = $3, selector = $4::jsonb, legacy_label = $5, updated_at = now()
       where org = $1 and id = $6 returning id, name, kind, selector, legacy_label`,
      [org, name, input.kind, JSON.stringify(selector), input.legacyLabel ?? null, id],
    )
    // 回读：update ... returning 即目标行；空行 = 并发删除 ⇒ NOT_FOUND（不静默）
    if (updated.rows.length === 0) { await client.query('rollback'); return err('NOT_FOUND') }
    const grants = await client.query(
      'select subject_type, subject_id, include_children from data.scope_assignment where org = $1 and scope_id = $2', [org, id],
    )
    await writeAudit(client, org, actor, 'scope.update', {
      id, before: viewOf(before.rows[0] as ScopeRow, []),
      after: { name, kind: input.kind, selector },
    })
    await client.query('commit')
    return {
      ok: true,
      value: viewOf(updated.rows[0] as ScopeRow,
        (grants.rows as Array<{ subject_type: 'dept' | 'role' | 'user'; subject_id: string; include_children: boolean }>)
          .map((g) => ({
            subjectType: g.subject_type,
            subjectId: g.subject_id,
            ...(g.subject_type === 'dept' ? { includeChildren: g.include_children } : {}),
          }))),
    }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 删除（assignment 随 FK cascade 消失；audit 记删除前的 assignment 数）。 */
export async function deleteScope(
  pool: Pool, org: string, actor: string, id: number,
): Promise<AdminResult<{ id: number }>> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const before = await client.query(
      'select name from data.scope where org = $1 and id = $2', [org, id],
    )
    if (before.rows.length === 0) { await client.query('rollback'); return err('NOT_FOUND') }
    const grants = await client.query(
      'select count(*)::int as n from data.scope_assignment where org = $1 and scope_id = $2', [org, id],
    )
    await client.query('delete from data.scope where org = $1 and id = $2', [org, id])
    // 回读：删后查无此行才算成（否则 cascade/权限异常会被 0 行影响骗过）
    const back = await client.query('select 1 from data.scope where org = $1 and id = $2', [org, id])
    if (back.rows.length > 0) throw new Error('SCOPE_DELETE_READBACK_MISMATCH')
    await writeAudit(client, org, actor, 'scope.delete', {
      id, name: (before.rows[0] as { name: string }).name, assignmentsRemoved: (grants.rows[0] as { n: number }).n,
    })
    await client.query('commit')
    return { ok: true, value: { id } }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** assignment **整组替换**：先删本 scope 全部、再插入清单，回读做集合相等比对。 */
/**
 * dept 主体的配置期校验：ext_id 必须存在于 `platform.v_org_node` 的**活节点**。
 *
 * 为什么在配置期拦：部门门（validateDeptGate）先例——组织没同步时配出来的门恒不成立，
 * 现场表现是「明明配了却看不见」，排障成本远高于当场拒绝。
 * org 表为空（未同步）时同样拒绝：此时任何 dept 主体都恒不生效。
 */
async function validateAssignableDepts(
  pool: Pool, deptIds: readonly string[],
): Promise<AdminResult<null>> {
  const r = await pool.query(
    'select ext_id from platform.v_org_node where status = 1 and ext_id = any($1::text[])',
    [[...new Set(deptIds)]],
  )
  const known = new Set((r.rows as Array<{ ext_id: string }>).map((x) => x.ext_id))
  const unknown = [...new Set(deptIds)].filter((d) => !known.has(d))
  if (unknown.length > 0) return { ok: false, code: 'UNKNOWN_DEPT', detail: unknown.join(',') }
  return { ok: true, value: null }
}

export async function replaceAssignments(
  pool: Pool, org: string, actor: string, scopeId: number, items: unknown,
): Promise<AdminResult<{ scopeId: number; assignments: AssignmentItem[] }>> {
  if (!Array.isArray(items)) return err('INVALID_ASSIGNMENTS')
  const seen = new Set<string>()
  const parsed: AssignmentItem[] = []
  for (const it of items) {
    const subjectType = (it as { subjectType?: unknown })?.subjectType
    const subjectId = typeof (it as { subjectId?: unknown })?.subjectId === 'string'
      ? (it as { subjectId: string }).subjectId.trim() : ''
    if ((subjectType !== 'dept' && subjectType !== 'role' && subjectType !== 'user')
      || subjectId === '' || subjectId.length > 200) {
      return err('INVALID_ASSIGNMENTS')
    }
    const includeChildren = subjectType === 'dept'
      ? (it as { includeChildren?: unknown }).includeChildren !== false  // 缺省 true（存量行为）
      : undefined
    const key = `${subjectType}:${subjectId}:${includeChildren ?? ''}`
    if (seen.has(key)) continue          // 同主体同口径重复 = 幂等合并，不是错
    seen.add(key)
    parsed.push({ subjectType, subjectId, ...(includeChildren !== undefined ? { includeChildren } : {}) })
  }
  // dept 主体必须能解析到活部门：否则就是「配了但永远没人满足」的静默门（与 validateDeptGate 同一 fail-closed 口径）
  const deptIds = parsed.filter((p) => p.subjectType === 'dept').map((p) => p.subjectId)
  if (deptIds.length > 0) {
    const deptCheck = await validateAssignableDepts(pool, deptIds)
    if (!deptCheck.ok) return deptCheck
  }
  const client = await pool.connect()
  try {
    await client.query('begin')
    const scope = await client.query('select name from data.scope where org = $1 and id = $2', [org, scopeId])
    if (scope.rows.length === 0) { await client.query('rollback'); return err('NOT_FOUND') }
    const before = await client.query(
      'select subject_type, subject_id, include_children from data.scope_assignment where org = $1 and scope_id = $2', [org, scopeId],
    )
    await client.query('delete from data.scope_assignment where org = $1 and scope_id = $2', [org, scopeId])
    for (const p of parsed) {
      await client.query(
        'insert into data.scope_assignment(org, subject_type, subject_id, scope_id, include_children) values ($1, $2, $3, $4, $5)',
        [org, p.subjectType, p.subjectId, scopeId, p.includeChildren ?? true],
      )
    }
    const back = await client.query(
      'select subject_type, subject_id, include_children from data.scope_assignment where org = $1 and scope_id = $2', [org, scopeId],
    )
    const got = new Set((back.rows as Array<{ subject_type: string; subject_id: string; include_children: boolean }>)
      .map((r) => `${r.subject_type}:${r.subject_id}:${r.subject_type === 'dept' ? String(r.include_children) : ''}`))
    const want = new Set(parsed.map((p) => `${p.subjectType}:${p.subjectId}:${p.subjectType === 'dept' ? String(p.includeChildren ?? true) : ''}`))
    if (got.size !== want.size || ![...want].every((k) => got.has(k))) {
      throw new Error('ASSIGNMENTS_READBACK_MISMATCH')
    }
    await writeAudit(client, org, actor, 'scope.assignments.replace', {
      scopeId, name: (scope.rows[0] as { name: string }).name,
      before: before.rows.length, after: parsed,
    })
    await client.query('commit')
    return { ok: true, value: { scopeId, assignments: parsed } }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export interface EffectivePreview {
  user: string
  roles: string[]
  effective: EffectiveScopes
  /** 命中的 scope 名单（user 直接 ∪ roles；与 loadEffectiveScopes 同一次语义）。 */
  granted: Array<{ name: string; kind: ScopeKind }>
}

/** 有效 scope 预览（dry-run）：给运营排查「为什么他看不见东部一区」。 */
export async function previewEffective(
  pool: Pool, org: string, user: string, roles: readonly string[], tenantId?: number,
): Promise<EffectivePreview> {
  const requester = {
    userId: user, orgId: org, channel: 'session' as const, keyId: null,
    scopes: [], hasScope: () => false, roles: [...roles],
    ...(tenantId !== undefined ? { tenantId } : {}),
  }
  const effective = await loadEffectiveScopes(pool, org, requester)
  // 部门两种口径：预览要如实反映「这条范围是通过哪个部门给他的」，否则排障时看不到来源
  const names2 = deptNamesOf({ userId: user })
  const depts = tenantId !== undefined ? [...await userDeptClosure(pool, tenantId, names2)] : []
  const directDepts = tenantId !== undefined ? [...await userDirectDepts(pool, tenantId, names2)] : []
  const names = await pool.query(
    `select s.name, s.kind from data.scope_assignment a
       join data.scope s on s.id = a.scope_id and s.org = a.org
      where a.org = $1
        and ((a.subject_type = 'user' and a.subject_id = $2)
          or (a.subject_type = 'role' and a.subject_id = any($3::text[]))
          or (a.subject_type = 'dept' and a.include_children and a.subject_id = any($4::text[]))
          or (a.subject_type = 'dept' and not a.include_children and a.subject_id = any($5::text[])))`,
    [org, user, [...roles], depts, directDepts],
  )
  // 同一 scope 经 user 与 role 两条路命中会产生多行（SQL 按 assignment 行返回）——
  // 名单语义是「命中了哪些 scope」，按 (name, kind) 去重。
  const seen = new Set<string>()
  const granted: Array<{ name: string; kind: ScopeKind }> = []
  for (const row of names.rows as Array<{ name: string; kind: ScopeKind }>) {
    const key = `${row.kind}:${row.name}`
    if (seen.has(key)) continue
    seen.add(key)
    granted.push({ name: row.name, kind: row.kind })
  }
  // loadEffectiveScopes 也按 assignment 行返回（user+role 双路命中同一 scope 会重复）——
  // 运行期 buildScopePlan 吃并集无所谓，预览面给人看 ⇒ 按 JSON 形状去重。
  const dedupe = (arr: ScopeSelector[]): ScopeSelector[] => {
    const seen = new Set<string>()
    return arr.filter((s) => {
      const key = JSON.stringify(s)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }
  return {
    user, roles: [...roles],
    effective: {
      brand: dedupe(effective.brand), store: dedupe(effective.store), category: dedupe(effective.category),
    },
    granted,
  }
}

export interface ScopeAuditRow {
  id: number
  actor: string
  action: string
  detail: Record<string, unknown>
  createdAt: string
}

/**
 * 变更历史（管理面读侧）。**只读**，按时间倒序、limit 夹在 1..200。
 * 写侧在每次 CRUD/assignment 替换时同事务落 `data.scope_audit`——这里不补写、不推断。
 */
export async function listScopeAudit(pool: Pool, org: string, limit: number): Promise<ScopeAuditRow[]> {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 200) : 50
  const r = await pool.query(
    `select id, actor, action, detail, created_at from data.scope_audit
      where org = $1 order by id desc limit $2`,
    [org, n],
  )
  return (r.rows as Array<{ id: number; actor: string; action: string; detail: Record<string, unknown>; created_at: Date | string }>)
    .map((x) => ({
      id: Number(x.id), actor: x.actor, action: x.action, detail: x.detail,
      createdAt: (x.created_at instanceof Date ? x.created_at : new Date(x.created_at)).toISOString(),
    }))
}
