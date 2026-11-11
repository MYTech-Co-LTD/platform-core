// scope-admin.test.ts — scope 管理面的判定链（spec 2026-11-10 §5.5；issue #1901）。
// 假池按**真机 SQL 形状**应答（同 drill.test.ts 的口径）：不认识的 SQL 响亮失败，
// 防「替身比真机宽松」把缺陷藏起来（#50/#51 的教训）。
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { EffectiveScopes } from './scope'
import {
  createScope, deleteScope, listScopes, previewEffective, replaceAssignments,
  updateScope, validateSelectorShape, type ScopeAdminDeps,
} from './scope-admin'

const ORG = 'org_a'

// ── 假池：内存库 + SQL 形状分派（写路径走 client，读路径走 pool.query，同一份 exec）──
interface DbState {
  scopes: Array<{ id: number; org: string; name: string; kind: string; selector: unknown; legacy_label: string | null }>
  grants: Array<{ org: string; subject_type: 'role' | 'user'; subject_id: string; scope_id: number }>
  audits: Array<{ org: string; actor: string; action: string; detail: Record<string, unknown> }>
  nextId: number
}

function makeDb(): DbState {
  return {
    scopes: [
      { id: 11, org: ORG, name: '门店|全店', kind: 'store', selector: { all: true }, legacy_label: '范围|全店' },
      { id: 12, org: ORG, name: '品牌|3120+64188', kind: 'brand', selector: { system_book: ['3120', '64188'] }, legacy_label: null },
    ],
    grants: [
      { org: ORG, subject_type: 'user', subject_id: 'alice', scope_id: 11 },
      { org: ORG, subject_type: 'role', subject_id: '总经理', scope_id: 12 },
      { org: ORG, subject_type: 'user', subject_id: 'alice', scope_id: 12 },
    ],
    audits: [],
    nextId: 100,
  }
}

function makePool(db: DbState): Pool {
  const exec = async (text: string, params: unknown[] = []) => {
    if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [] }
    // ── data.scope 读 ──
    if (/select id, name, kind, selector, legacy_label from data\.scope where org/.test(text)) {
      // order by kind, name（真机排序，替身同形——消费方别去赌插入序）
      return {
        rows: db.scopes.filter((s) => s.org === params[0])
          .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
          .map((s) => ({ ...s })),
      }
    }
    if (/select 1 from data\.scope where org = \$1 and name = \$2 and id <> \$3/.test(text)) {
      return { rows: db.scopes.filter((s) => s.org === params[0] && s.name === params[1] && s.id !== params[2]).length > 0 ? [{}] : [] }
    }
    if (/select 1 from data\.scope where org = \$1 and name = \$2/.test(text)) {
      return { rows: db.scopes.filter((s) => s.org === params[0] && s.name === params[1]).length > 0 ? [{}] : [] }
    }
    if (/select 1 from data\.scope where org = \$1 and id = \$2/.test(text)) {
      return { rows: db.scopes.filter((s) => s.org === params[0] && s.id === params[1]).length > 0 ? [{}] : [] }
    }
    if (/select name from data\.scope where org/.test(text)) {
      const hit = db.scopes.find((s) => s.org === params[0] && s.id === params[1])
      return { rows: hit === undefined ? [] : [{ name: hit.name }] }
    }
    // ── data.scope 写 ──
    if (/insert into data\.scope\(/.test(text)) {
      // 真机：jsonb 参数（字符串）进、对象出——替身同形（#50/#51：别比真机宽松）
      const row = { id: db.nextId++, org: params[0] as string, name: params[1] as string, kind: params[2] as string, selector: JSON.parse(params[3] as string), legacy_label: params[4] as string | null }
      db.scopes.push(row)
      return { rows: [{ ...row }] }
    }
    if (/update data\.scope set name/.test(text)) {
      const hit = db.scopes.find((s) => s.org === params[0] && s.id === params[5])
      if (hit === undefined) return { rows: [] }
      Object.assign(hit, { name: params[1], kind: params[2], selector: JSON.parse(params[3] as string), legacy_label: params[4] })
      return { rows: [{ ...hit }] }
    }
    if (/delete from data\.scope where/.test(text)) {
      const before = db.scopes.filter((s) => s.org === params[0] && s.id === params[1])
      db.scopes = db.scopes.filter((s) => !(s.org === params[0] && s.id === params[1]))
      // FK cascade：assignment 随之消失（真机行为，替身必须同形）
      db.grants = db.grants.filter((g) => !(g.org === params[0] && g.scope_id === params[1]))
      return { rows: [], rowCount: before.length }
    }
    // ── scope_assignment ──
    if (/select scope_id, subject_type, subject_id from data\.scope_assignment/.test(text)) {
      return { rows: db.grants.filter((g) => g.org === params[0]).map((g) => ({ ...g })) }
    }
    if (/select subject_type, subject_id from data\.scope_assignment/.test(text)) {
      return {
        rows: db.grants.filter((g) => g.org === params[0] && g.scope_id === params[1])
          .map((g) => ({ subject_type: g.subject_type, subject_id: g.subject_id })),
      }
    }
    if (/select count\(\*\)::int as n from data\.scope_assignment/.test(text)) {
      return { rows: [{ n: db.grants.filter((g) => g.org === params[0] && g.scope_id === params[1]).length }] }
    }
    if (/delete from data\.scope_assignment where/.test(text)) {
      db.grants = db.grants.filter((g) => !(g.org === params[0] && g.scope_id === params[1]))
      return { rows: [] }
    }
    if (/insert into data\.scope_assignment\(/.test(text)) {
      db.grants.push({ org: params[0] as string, subject_type: params[1] as 'role' | 'user', subject_id: params[2] as string, scope_id: params[3] as number })
      return { rows: [] }
    }
    // ── previewEffective：loadEffectiveScopes（select s.kind, s.selector …）与 granted 名单
    //    （select s.name, s.kind …）两条——两条都含 any($3)，按 select 列形区分 ──
    if (/select s\.name, s\.kind from data\.scope_assignment a\s+join data\.scope s/.test(text)) {
      const user = params[1] as string
      const roles = params[2] as string[]
      const hit = db.grants.filter((g) => g.org === params[0]
        && ((g.subject_type === 'user' && g.subject_id === user) || (g.subject_type === 'role' && roles.includes(g.subject_id))))
      return {
        rows: hit.map((g) => {
          const s = db.scopes.find((x) => x.id === g.scope_id)
          return { name: s?.name ?? '', kind: s?.kind ?? 'store' }
        }),
      }
    }
    if (/from data\.scope_assignment a\s+join data\.scope s/.test(text)) {
      const users = params[1] as string[]
      const roles = params[2] as string[]
      const hit = db.grants.filter((g) => g.org === params[0]
        && ((g.subject_type === 'user' && users.includes(g.subject_id)) || (g.subject_type === 'role' && roles.includes(g.subject_id))))
      return { rows: hit.map((g) => db.scopes.find((x) => x.id === g.scope_id)).filter((s) => s !== undefined).map((s) => ({ kind: s.kind, selector: s.selector })) }
    }
    // ── audit ──
    if (/insert into data\.scope_audit/.test(text)) {
      db.audits.push({ org: params[0] as string, actor: params[1] as string, action: params[2] as string, detail: JSON.parse(params[3] as string) })
      return { rows: [] }
    }
    throw new Error(`fake pool: unexpected sql: ${text}`)
  }
  const client = { query: exec, release: () => {} }
  return {
    query: exec,
    connect: async () => client,
  } as unknown as Pool
}

/** 假仓库：dim_brand/dim_region/dim_item_latest 三张受控维；throwWhen = 模拟仓库不可达。 */
function makeWarehouse(throwWhen = false): Pool {
  return {
    query: async (sql: string) => {
      if (throwWhen) throw new Error('warehouse down')
      if (/from dim_brand/.test(sql)) return { rows: [{ v: '3120' }, { v: '64188' }] }
      if (/region_l1/.test(sql)) return { rows: [{ v: '东部战区' }, { v: '西部战区' }] }
      if (/region_name/.test(sql)) return { rows: [{ v: '东部一区' }, { v: '西部二区' }] }
      if (/category_group/.test(sql)) return { rows: [{ v: '水果' }, { v: '标品' }, { v: '耗材' }] }
      throw new Error(`fake warehouse: unexpected sql: ${sql}`)
    },
  } as unknown as Pool
}

const depsOf = (db: DbState, wh?: Pool): ScopeAdminDeps => ({ pool: makePool(db), warehouse: wh ?? makeWarehouse() })

describe('validateSelectorShape（纯函数）', () => {
  it('kind 键集不符 / brand 带 all / 未知 kind ⇒ INVALID_SELECTOR', () => {
    expect(validateSelectorShape('brand', { region_name: ['东部一区'] }).ok).toBe(false)
    expect(validateSelectorShape('brand', { all: true }).ok).toBe(false)
    expect(validateSelectorShape('store', { system_book: ['3120'] }).ok).toBe(false)
    expect(validateSelectorShape('其他', { all: true }).ok).toBe(false)
  })
  it('合法形状照放（store 的 all 与 region 键；category 三类）', () => {
    expect(validateSelectorShape('store', { all: true })).toEqual({ ok: true, value: { all: true } })
    expect(validateSelectorShape('store', { region_l1: ['东部战区'], region_name: ['东部一区'] }).ok).toBe(true)
    expect(validateSelectorShape('category', { category_group: ['水果'] }).ok).toBe(true)
    expect(validateSelectorShape('category', { all: true }).ok).toBe(true)
  })
})

describe('createScope', () => {
  it('★ 维表校验：未知战区 ⇒ VALUE_NOT_IN_DIMS（点名未知值）；仓库不可达 ⇒ DIMS_UNAVAILABLE', async () => {
    const db = makeDb()
    const r1 = await createScope(depsOf(db), ORG, 'admin', {
      name: '门店|火星', kind: 'store', selector: { region_name: ['火星一区'] },
    })
    expect(r1).toMatchObject({ ok: false, code: 'VALUE_NOT_IN_DIMS', detail: '火星一区' })
    expect(db.scopes).toHaveLength(2) // 未落库

    const r2 = await createScope(depsOf(db, makeWarehouse(true)), ORG, 'admin', {
      name: '门店|东部一区', kind: 'store', selector: { region_name: ['东部一区'] },
    })
    expect(r2).toMatchObject({ ok: false, code: 'DIMS_UNAVAILABLE' })
  })

  it('★ 合法新建：回读目标行 + audit 同事务；重名 ⇒ DUP_NAME', async () => {
    const db = makeDb()
    const r = await createScope(depsOf(db), ORG, 'admin', {
      name: '门店|东部一区', kind: 'store', selector: { region_name: ['东部一区'] }, legacyLabel: '范围|东部一区',
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe('门店|东部一区')
    expect(r.value.selector).toEqual({ region_name: ['东部一区'] })
    expect(db.audits).toHaveLength(1)
    expect(db.audits[0]).toMatchObject({ org: ORG, actor: 'admin', action: 'scope.create' })

    const dup = await createScope(depsOf(db), ORG, 'admin', { name: '门店|全店', kind: 'store', selector: { all: true } })
    expect(dup).toMatchObject({ ok: false, code: 'DUP_NAME' })
  })
})

describe('updateScope / deleteScope', () => {
  it('更新：NOT_FOUND / 改名撞车 / 成功保留 assignment', async () => {
    const db = makeDb()
    expect(await updateScope(depsOf(db), ORG, 'admin', 999, { name: 'x', kind: 'store', selector: { all: true } })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const dup = await updateScope(depsOf(db), ORG, 'admin', 11, { name: '品牌|3120+64188', kind: 'brand', selector: { system_book: ['3120'] } })
    expect(dup).toMatchObject({ ok: false, code: 'DUP_NAME' })
    const r = await updateScope(depsOf(db), ORG, 'admin', 12, { name: '品牌|3120', kind: 'brand', selector: { system_book: ['3120'] } })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.name).toBe('品牌|3120')
    expect(r.value.assignments).toEqual([{ subjectType: 'role', subjectId: '总经理' }, { subjectType: 'user', subjectId: 'alice' }])
    expect(db.audits.at(-1)?.action).toBe('scope.update')
  })

  it('删除：cascade 掉 assignment，audit 记删除前数量；NOT_FOUND', async () => {
    const db = makeDb()
    const r = await deleteScope(makePool(db), ORG, 'admin', 11)
    expect(r).toEqual({ ok: true, value: { id: 11 } })
    expect(db.scopes.find((s) => s.id === 11)).toBeUndefined()
    expect(db.grants.filter((g) => g.scope_id === 11)).toEqual([])       // alice 的全店没了
    expect(db.grants.filter((g) => g.scope_id === 12)).toHaveLength(2)   // 别的 scope 不受牵连
    expect(db.audits.at(-1)).toMatchObject({ action: 'scope.delete', detail: { assignmentsRemoved: 1 } })
    expect(await deleteScope(makePool(db), ORG, 'admin', 11)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })
})

describe('replaceAssignments（整组替换）', () => {
  it('形状坏 ⇒ INVALID_ASSIGNMENTS；同主体重复幂等合并；回读后 audit 记 before/after', async () => {
    const db = makeDb()
    const pool = makePool(db)
    expect(await replaceAssignments(pool, ORG, 'admin', 11, 'not-array')).toMatchObject({ ok: false, code: 'INVALID_ASSIGNMENTS' })
    expect(await replaceAssignments(pool, ORG, 'admin', 11, [{ subjectType: 'god', subjectId: 'x' }])).toMatchObject({ ok: false, code: 'INVALID_ASSIGNMENTS' })
    expect(await replaceAssignments(pool, ORG, 'admin', 999, [])).toMatchObject({ ok: false, code: 'NOT_FOUND' })

    const r = await replaceAssignments(pool, ORG, 'admin', 11, [
      { subjectType: 'user', subjectId: 'alice' },
      { subjectType: 'user', subjectId: 'alice' },          // 重复 ⇒ 合并
      { subjectType: 'role', subjectId: '小区经理' },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.assignments).toEqual([
      { subjectType: 'user', subjectId: 'alice' },
      { subjectType: 'role', subjectId: '小区经理' },
    ])
    expect(db.grants.filter((g) => g.scope_id === 11)).toHaveLength(2)
    expect(db.audits.at(-1)).toMatchObject({ action: 'scope.assignments.replace', detail: { before: 1, after: r.value.assignments } })
  })
})

describe('listScopes / previewEffective（读面）', () => {
  it('list 按 scope 拼 assignment', async () => {
    const list = await listScopes(makePool(makeDb()), ORG)
    expect(list.map((s) => s.name)).toEqual(['品牌|3120+64188', '门店|全店'])
    expect(list.find((s) => s.id === 11)?.assignments).toEqual([{ subjectType: 'user', subjectId: 'alice' }])
  })

  it('★ preview：user 直接 ∪ roles，与 loadEffectiveScopes 同一语义', async () => {
    const p = await previewEffective(makePool(makeDb()), ORG, 'alice', ['总经理'])
    expect(p.granted.map((g) => g.name).sort()).toEqual(['品牌|3120+64188', '门店|全店'])
    const eff = p.effective as EffectiveScopes
    expect(eff.brand).toEqual([{ system_book: ['3120', '64188'] }])
    expect(eff.store).toEqual([{ all: true }])
    // bob：无 user 级、不在任何角色 ⇒ 空（enforce 会被拒——这正是预览要暴露的）
    const bob = await previewEffective(makePool(makeDb()), ORG, 'bob', [])
    expect(bob.granted).toEqual([])
    expect(bob.effective.brand).toEqual([])
  })
})
