// scope.test.ts — 数据范围 scope 的纯函数与加载（spec 2026-11-10）。
import { describe, it, expect } from 'vitest'
import type { Pool } from 'pg'
import type { MetricDef, Requester } from './authz'
import {
  buildScopePlan, loadEffectiveScopes, normalizeSelector, scopeModeOf,
  type EffectiveScopes,
} from './scope'

const metric = (groupBy: string): MetricDef => ({
  id: 'm', title: 'm', description: '', requiredScope: null, subjectColumn: 'org',
  selectSql: 'select 1', groupBy, params: {}, totalable: false,
})
const requester = (over: Partial<Requester> = {}): Requester => ({
  userId: 'u', orgId: 'org', channel: 'session', keyId: null,
  scopes: [], hasScope: () => false, ...over,
})
const scopes = (over: Partial<EffectiveScopes> = {}): EffectiveScopes => ({
  brand: [{ system_book: ['3120'] }],
  store: [{ region_name: ['东部一区'] }],
  category: [{ category_group: ['水果'] }],
  ...over,
})

describe('scopeModeOf', () => {
  it('显式三态；未知/缺省 = off', () => {
    expect(scopeModeOf({ DATA_SCOPE_MODE: 'shadow' })).toBe('shadow')
    expect(scopeModeOf({ DATA_SCOPE_MODE: 'enforce' })).toBe('enforce')
    expect(scopeModeOf({ DATA_SCOPE_MODE: 'nope' })).toBe('off')
    expect(scopeModeOf({})).toBe('off')
  })
})

describe('normalizeSelector', () => {
  it('合法 selector；坏键/空数组/未知 all 值 ⇒ null', () => {
    expect(normalizeSelector({ system_book: ['3120'] })).toEqual({ system_book: ['3120'] })
    expect(normalizeSelector({ all: true })).toEqual({ all: true })
    expect(normalizeSelector({ region_name: [] })).toBeNull()
    expect(normalizeSelector({ region_name: [''] })).toBeNull()
    expect(normalizeSelector({ nope: ['x'] })).toBeNull()
    expect(normalizeSelector({ all: false })).toBeNull()
    expect(normalizeSelector(null)).toBeNull()
  })
})

describe('loadEffectiveScopes', () => {
  it('用户 + 角色 assignment 合并；全形角色名归一后参与匹配；坏 selector ⇒ 抛错（fail-closed）', async () => {
    let seenParams: unknown[] = []
    const pool = {
      query: async (_sql: string, params: unknown[]) => {
        seenParams = params
        return { rows: [
          { kind: 'brand', selector: { system_book: ['3120'] } },
          { kind: 'store', selector: { region_l1: ['东部战区'] } },
          { kind: 'store', selector: { all: true } },
        ] }
      },
    } as unknown as Pool
    const r = await loadEffectiveScopes(pool, 'org', requester({ roles: ['shanhai/小区经理'] }))
    expect(r.brand).toHaveLength(1)
    expect(r.store).toHaveLength(2)
    expect(seenParams[2]).toEqual(['小区经理'])
    const bad = { query: async () => ({ rows: [{ kind: 'store', selector: { nope: ['x'] } }] }) } as unknown as Pool
    await expect(loadEffectiveScopes(bad, 'org', requester())).rejects.toThrow(/INVALID_SCOPE_SELECTOR/)
  })
})

describe('buildScopePlan', () => {
  it('off / 管理员不裁', () => {
    expect(buildScopePlan(metric('system_book, branch_num'), scopes(), 'org', requester(), 'off').filters).toEqual([])
    expect(buildScopePlan(metric('system_book, branch_num'), scopes(), 'org',
      requester({ hasScope: (c) => c === 'data:manage' }), 'enforce').filters).toEqual([])
    expect(buildScopePlan(metric('system_book, branch_num'), scopes(), 'org',
      requester({ hasScope: (c) => c === 'tenant:admin' }), 'enforce').filters).toEqual([])
  })

  it('brand + store + category 全维度：复合键子查询', () => {
    const p = buildScopePlan(metric('system_book, branch_num, item_num'), scopes(), 'org', requester(), 'enforce')
    expect(p.denial).toBeNull()
    expect(p.filters.join('\n')).toContain("system_book IN ('3120')")
    expect(p.filters.join('\n')).toContain('(system_book, branch_num) IN')
    expect(p.filters.join('\n')).toContain('dim_lemeng_branch')
    expect(p.filters.join('\n')).toContain("region_name IN ('东部一区')")
    expect(p.filters.join('\n')).toContain('(system_book, item_num) IN')
    expect(p.filters.join('\n')).toContain("category_group IN ('水果')")
    expect(p.applied).toEqual(['brand', 'store', 'category'])
  })

  it('store=all ⇒ 不加门店谓词；category=all ⇒ 不加品类谓词', () => {
    const p = buildScopePlan(metric('system_book, branch_num'), scopes({
      store: [{ all: true }], category: [{ all: true }],
    }), 'org', requester(), 'enforce')
    expect(p.denial).toBeNull()
    expect(p.filters.join('\n')).not.toContain('dim_lemeng_branch')
    expect(p.filters.join('\n')).not.toContain('category_group')
  })

  it('指标直接暴露 region_l1 时用直接谓词', () => {
    const p = buildScopePlan(metric('system_book, region_l1'), scopes({
      store: [{ region_l1: ['东部战区'] }],
      category: [{ all: true }],
    }), 'org', requester(), 'enforce')
    expect(p.filters.join('\n')).toContain("region_l1 IN ('东部战区')")
    expect(p.filters.join('\n')).not.toContain('dim_lemeng_branch')
  })

  it('无 store scope ⇒ no_store_scope', () => {
    const p = buildScopePlan(metric('system_book, branch_num'), scopes({ store: [] }), 'org', requester(), 'enforce')
    expect(p.denial).toBe('no_store_scope')
  })

  it('D1：门店总量指标（无 item 维度）带 category scope ⇒ range_dimension_missing:category', () => {
    const p = buildScopePlan(metric('system_book, branch_num'), scopes({
      category: [{ category_group: ['水果'] }],
    }), 'org', requester(), 'enforce')
    expect(p.denial).toBe('range_dimension_missing:category')
  })

  it('缺 brand / category scope 也拒绝（与 D2 同一最小权限口径）', () => {
    expect(buildScopePlan(metric('system_book, branch_num'), scopes({ brand: [] }), 'org', requester(), 'enforce').denial)
      .toBe('no_brand_scope')
    expect(buildScopePlan(metric('system_book, branch_num, item_num'), scopes({ category: [] }), 'org', requester(), 'enforce').denial)
      .toBe('no_category_scope')
  })
})
