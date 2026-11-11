// scope-preflight.test.ts — enforce 前预检的纯函数（issue #1901）。
// 判定必须复用运行期 buildScopePlan（单一执法点）——这里用真实的 buildScopePlan 跑夹具。
import { describe, it, expect } from 'vitest'
import { buildScopePlan } from '../modules/data/domain/scope'
import type { MetricDef } from '../modules/data/domain/authz'
import { METRIC_SHAPES, formatPreflight, planPreflight } from './scope-preflight.mjs'

const ORG = 'org_a'
const shapes = METRIC_SHAPES.map((s) => ({
  ...s,
  metric: {
    id: s.name, title: s.name, description: '', requiredScope: null,
    subjectColumn: 'org', selectSql: 'select 1', groupBy: s.groupBy, params: {}, totalable: false,
  } as MetricDef,
}))

const full = { brand: [{ system_book: ['3120'] }], store: [{ all: true }], category: [{ all: true }] }

describe('planPreflight', () => {
  it('三维齐全 + 全店 ⇒ 三种粒度都不拒', () => {
    const r = planPreflight([{ user: 'alice', scopes: full }], shapes, ORG, buildScopePlan)
    expect(r.missingDimension).toEqual([])
    expect(r.deniedByShape.every((s) => s.users.length === 0)).toBe(true)
  })

  it('★ 缺 store ⇒ 三种粒度全被拒（no_store_scope）', () => {
    const r = planPreflight(
      [{ user: 'bob', scopes: { brand: [{ system_book: ['3120'] }], store: [], category: [{ all: true }] } }],
      shapes, ORG, buildScopePlan,
    )
    expect(r.missingDimension).toEqual([{ user: 'bob', missing: ['store'] }])
    for (const s of r.deniedByShape) {
      expect(s.users).toEqual([{ user: 'bob', denial: 'no_store_scope' }])
    }
  })

  it('★ 有品类 scope 但指标无 item 维度（D1）⇒ 只在门店总量粒度被拒', () => {
    const r = planPreflight(
      [{ user: 'carol', scopes: {
        brand: [{ system_book: ['3120'] }], store: [{ all: true }], category: [{ category_group: ['水果'] }],
      } }],
      shapes, ORG, buildScopePlan,
    )
    const byShape = new Map(r.deniedByShape.map((s) => [s.shape, s.users]))
    expect(byShape.get('branch+item（商品粒度）')).toEqual([])
    expect(byShape.get('branch（门店总量）')).toEqual([{ user: 'carol', denial: 'range_dimension_missing:category' }])
    expect(byShape.get('region_l1（战区直读）')).toEqual([{ user: 'carol', denial: 'range_dimension_missing:category' }])
  })

  it('管理员不裁、不计入被拒', () => {
    const r = planPreflight([{ user: 'root', scopes: { brand: [], store: [], category: [] }, admin: true }], shapes, ORG, buildScopePlan)
    expect(r.admins).toBe(1)
    expect(r.deniedByShape.every((s) => s.users.length === 0)).toBe(true)
  })

  it('formatPreflight：缺维度与逐粒度原因都点名', () => {
    const text = formatPreflight(planPreflight(
      [{ user: 'bob', scopes: { brand: [{ system_book: ['3120'] }], store: [], category: [] } }],
      shapes, ORG, buildScopePlan,
    ))
    expect(text).toContain('缺维度 1')
    expect(text).toContain('no_store_scope')
    expect(text).not.toMatch(/password|secret/i)
  })
})
