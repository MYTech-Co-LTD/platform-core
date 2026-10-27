import { describe, expect, it } from 'vitest'
import { collectHolders, isServiceAccount, SERVICE_ACCOUNTS, shortName } from './audit-permission-holders-lib.mjs'

describe('shortName', () => {
  it('全形取最后一段，短名原样', () => {
    expect(shortName('org/alice')).toBe('alice')
    expect(shortName('alice')).toBe('alice')
  })
})

describe('服务账号名单', () => {
  it('tenantsub / casdoor-user-1 是机器身份；普通同步账号不是', () => {
    expect(isServiceAccount('tenantsub')).toBe(true)
    expect(isServiceAccount('mytech/tenantsub')).toBe(true)
    expect(isServiceAccount('casdoor-user-1')).toBe(true)
    expect(isServiceAccount('mytech/casdoor-user-1')).toBe(true)
    expect(isServiceAccount('ZhangDuo')).toBe(false)
    expect(isServiceAccount('SunPing01')).toBe(false)
  })

  it('名单是显式常量（新增机器身份必须改这里，不靠命名规律猜）', () => {
    expect([...SERVICE_ACCOUNTS].sort()).toEqual(['casdoor-user-1', 'tenantsub'])
  })
})

describe('collectHolders（direct ∪ role）', () => {
  it('直接用户 + 角色成员；全形/短名归一，保留角色来源', () => {
    const perms = [
      { resources: ['tenant:admin'], users: ['org/alice'], roles: ['ops'] },
      { resources: ['tenant:admin'], users: ['org/bob'], roles: ['org/auditors'] },
    ]
    const roles = [
      { name: 'ops', users: ['org/carol'] },
      { name: 'org/auditors', users: ['dave'] },
    ]
    expect(collectHolders(perms, roles, 'tenant:admin')).toEqual({
      direct: ['alice', 'bob'],
      viaRole: [
        { user: 'carol', roles: ['ops'] },
        { user: 'dave', roles: ['org/auditors'] },
      ],
    })
  })

  it('直挂优先：同时直挂 + 角色只记 direct', () => {
    const perms = [{ resources: ['x'], users: ['alice'], roles: ['ops'] }]
    const roles = [{ name: 'ops', users: ['alice', 'bob'] }]
    expect(collectHolders(perms, roles, 'x')).toEqual({
      direct: ['alice'],
      viaRole: [{ user: 'bob', roles: ['ops'] }],
    })
  })

  it('同一用户经多个角色命中：roles 全列', () => {
    const perms = [{ resources: ['x'], roles: ['ops', 'auditors'] }]
    const roles = [
      { name: 'ops', users: ['alice'] },
      { name: 'auditors', users: ['alice'] },
    ]
    expect(collectHolders(perms, roles, 'x')).toEqual({
      direct: [],
      viaRole: [{ user: 'alice', roles: ['auditors', 'ops'] }],
    })
  })

  it('无命中 / 角色不存在 ⇒ 空结果（不抛错）', () => {
    expect(collectHolders([], [], 'x')).toEqual({ direct: [], viaRole: [] })
    expect(collectHolders([{ resources: ['x'], roles: ['ghost'] }], [], 'x')).toEqual({
      direct: [],
      viaRole: [],
    })
  })
})
