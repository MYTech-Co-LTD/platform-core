// migrate-data-scopes.test.ts — 迁移脚本的纯函数（spec 2026-11-10 §6）。
// 主流程（DB/Casdoor）靠真机 dry-run 验；这里钉映射语义与「不猜」的失败面。
import { describe, it, expect } from 'vitest'
import {
  CATEGORY_ALL, formatPlan, normalizeUser, planMigration, resourcesByRole,
  selectorForRange, shortName,
} from './migrate-data-scopes.mjs'

const brands = [
  { system_book: '3120', brand_name: '熊喵鲜生' },
  { system_book: '64188', brand_name: '品品甜' },
]
const regions = [
  { system_book: '3120', region_name: '东部一区', region_l1: '东部战区', level: 2 },
  { system_book: '64188', region_name: '东部一区', region_l1: '东部战区', level: 2 },
  { system_book: '3120', region_name: '广西大区', region_l1: '广西大区', level: 1 },
]

describe('shortName / normalizeUser', () => {
  it('全形取短名；D4 旧账号别名到本人', () => {
    expect(shortName('shanhai/张三')).toBe('张三')
    expect(normalizeUser('shanhai/Dongjijuan')).toBe('DongJiJuan')
    expect(normalizeUser('DongJiJuan_1')).toBe('DongJiJuan')
    expect(normalizeUser('shanhai/alice')).toBe('alice')
  })
})

describe('selectorForRange', () => {
  it('全店 ⇒ all；二级名优先；一级名次之；未命中 = null（不猜）', () => {
    expect(selectorForRange('全店', regions)).toEqual({ selector: { all: true }, matchedBy: 'all' })
    expect(selectorForRange('东部一区', regions)).toEqual({ selector: { region_name: ['东部一区'] }, matchedBy: 'region_name' })
    expect(selectorForRange('东部战区', regions)).toEqual({ selector: { region_l1: ['东部战区'] }, matchedBy: 'region_l1' })
    expect(selectorForRange('火星战区', regions)).toBeNull()
  })
})

describe('resourcesByRole', () => {
  it('permission.roles 短名/全形双认，resources 并集', () => {
    const m = resourcesByRole([
      { roles: ['shanhai/总经理'], resources: ['品牌|*'] },
      { roles: ['总经理'], resources: ['品类|*'] },
      { roles: ['其他人'], resources: ['门禁|管理台'] },
    ])
    expect([...m.get('总经理')].sort()).toEqual(['品牌|*', '品类|*'])
    expect(m.has('其他人')).toBe(true)
  })
})

describe('planMigration', () => {
  const base = () => ({
    sourceRoles: [
      { name: '总经理', users: ['shanhai/alice', 'shanhai/Dongjijuan', 'shanhai/ccccccccccccctv'] },
      { name: '战区总', users: ['shanhai/bob'] },
      { name: '小区经理', users: ['shanhai/carol'] },
      { name: '采购负责人', users: [] },
      { name: '范围|全店', users: ['shanhai/alice'] },
      { name: '范围|东部一区', users: ['shanhai/bob', 'shanhai/carol'] },
      { name: '范围|东部战区', users: ['shanhai/dave'] },
      { name: '范围|火星战区', users: ['shanhai/eve'] },
    ],
    permissions: [
      { roles: ['shanhai/总经理'], resources: ['品牌|*', '品类|*', '字段|成本可见', '门禁|报表中心', '门禁|管理台', '看板|*'] },
      { roles: ['shanhai/战区总'], resources: ['品牌|*', '品类|*', '字段|成本可见', '门禁|报表中心'] },
      { roles: ['shanhai/小区经理'], resources: ['品牌|*', '品类|水果', '门禁|报表中心'] },
      { roles: ['shanhai/采购负责人'], resources: ['品牌|*', '品类|*', '字段|成本可见', '门禁|报表中心'] },
    ],
    brands,
    regions,
    categoryGroups: CATEGORY_ALL,
    targetUsers: ['alice', 'bob', 'carol', 'dave', 'DongJiJuan', 'ccccccccccccctv'],
    targetOrg: 'shanhaiyiguo-org',
    sourceOrg: 'shanhai',
  })

  it('★ 职能角色：品牌/品类 role-level + user-level 兜底；成本按实际 resources（小区经理无）', () => {
    const p = planMigration(base())
    const gm = p.functional.find((f) => f.role === '总经理')!
    expect(gm.users.sort()).toEqual(['DongJiJuan', 'alice', 'ccccccccccccctv'])
    expect(gm.brandScope).toBe('品牌|3120+64188')
    expect(gm.categoryScope).toBe('品类|全品类')   // 品类|* ⇒ all（三组会触发 D1）
    expect(gm.codes).toEqual({ query: true, cost: true })
    expect(p.functional.find((f) => f.role === '小区经理')!.codes?.cost).toBe(false)
    // 门店层级「对品类不关注」：源写 品类|水果 也强制 all（否则 D1 把门店总量全拒）
    expect(p.functional.find((f) => f.role === '小区经理')!.categoryScope).toBe('品类|全品类')
    expect(p.functional.find((f) => f.role === '采购负责人')!.present).toBe(true)

    // role-level assignment（后续维护面）
    expect(p.assignments).toContainEqual({ subjectType: 'role', subjectId: '总经理', scopeName: '品牌|3120+64188' })
    // user-level 兜底（spec §6.4）
    expect(p.assignments).toContainEqual({ subjectType: 'user', subjectId: 'alice', scopeName: '品牌|3120+64188' })
    expect(p.assignments).toContainEqual({ subjectType: 'user', subjectId: 'carol', scopeName: '品类|全品类' })
  })

  it('★ 22 范围角色 → store scope；全店 = all；别名归一；未命中不猜', () => {
    const p = planMigration(base())
    expect(p.scopes).toContainEqual({ name: '门店|全店', kind: 'store', selector: { all: true }, legacyLabel: '范围|全店' })
    expect(p.scopes).toContainEqual({
      name: '门店|东部一区', kind: 'store', selector: { region_name: ['东部一区'] }, legacyLabel: '范围|东部一区',
    })
    expect(p.scopes).toContainEqual({
      name: '门店|东部战区', kind: 'store', selector: { region_l1: ['东部战区'] }, legacyLabel: '范围|东部战区',
    })
    expect(p.assignments).toContainEqual({ subjectType: 'user', subjectId: 'alice', scopeName: '门店|全店' })
    expect(p.aliasedUsers).toEqual([{ from: 'shanhai/Dongjijuan', to: 'DongJiJuan' }])
    expect(p.unmappedRanges).toEqual([{ role: '范围|火星战区', rangeName: '火星战区' }])
    // 未映射的范围角色成员不进业务用户集（不猜）
    expect(p.businessUsers).not.toContain('eve')
  })

  it('★ 差异清单：门禁|管理台 / 看板|* 不映射，报表中心不算未映射', () => {
    const p = planMigration(base())
    const res = p.unmappedResources.map((x) => `${x.role}:${x.resource}`)
    expect(res).toContain('总经理:门禁|管理台')
    expect(res).toContain('总经理:看板|*')
    expect(res).not.toContain('总经理:门禁|报表中心')
  })

  it('★ 无 store scope 的用户逐类列出（enforce 后会被拒，dry-run 必须先看见）', () => {
    const p = planMigration(base())
    expect(p.usersWithoutStore).toContain('DongJiJuan')   // 总经理但无范围角色
    expect(p.usersWithoutStore).not.toContain('alice')     // 全店
    // 陈超：源无范围角色，但用户拍板给全店（EXTRA_USER_SCOPES）⇒ 不再缺 store
    expect(p.usersWithoutStore).not.toContain('ccccccccccccctv')
    expect(p.assignments).toContainEqual({
      subjectType: 'user', subjectId: 'ccccccccccccctv', scopeName: '门店|全店',
    })
    expect(p.usersMissingInTarget).toEqual([])
  })

  it('目标 org 缺人 ⇒ 列进 usersMissingInTarget（不阻断，但可见）', () => {
    const input = base()
    input.targetUsers = ['alice', 'bob']
    const p = planMigration(input)
    expect(p.usersMissingInTarget).toContain('carol')
    expect(p.usersMissingInTarget).toContain('dave')
  })

  it('formatPlan 打印计数与差异，不打印任何 secret', () => {
    const text = formatPlan(planMigration(base()))
    expect(text).toContain('shanhai（只读）→ shanhaiyiguo-org')
    expect(text).toContain('未映射的范围角色 1')
    expect(text).not.toMatch(/password|secret|pwd/i)
  })
})
