import { describe, expect, it } from 'vitest'
import { effectiveScopes } from './effective-scopes'

// 语义移植自旧仓 gateway/sso-shell.js:198-226 fetchUserScopes（生产验证版）。
// 历史坑：fetchUserScopes 曾因角色比较恒 false 踩坑——短名/全形两种匹配都必须钉死。
describe('effectiveScopes', () => {
  it('直挂命中：perms.users 含 userName → 该权限 resources 计入', () => {
    expect(effectiveScopes('admin1', ['roleA'], [
      { users: ['acme/admin1'], roles: ['acme/none'], resources: ['ticket:dispatch'] },
      { users: ['other'], resources: ['ticket:admin'] },
    ])).toEqual(['ticket:dispatch'])
  })

  it('角色交集命中：perms.roles 与用户 roles 有交集 → 计入', () => {
    expect(effectiveScopes('nobody', ['acme/ops', 'roleB'], [
      { roles: ['acme/ops'], resources: ['ticket:view'] },
      { roles: ['acme/roleB', 'acme/other'], resources: ['ticket:other'] },
    ])).toEqual(['ticket:other', 'ticket:view'])
  })

  it('两者都无 → 空数组（无 users/roles 的条目也不命中）', () => {
    expect(effectiveScopes('nobody', ['roleX'], [
      { users: ['acme/admin1'], resources: ['a:b'] },
      { roles: ['acme/roleY'], resources: ['c:d'] },
      { resources: ['e:f'] },
    ])).toEqual([])
  })

  it('全形 vs 短名：perms.users 是 acme/admin1 全形，userName 传短名 admin1 也命中', () => {
    expect(effectiveScopes('admin1', [], [
      { users: ['acme/admin1'], resources: ['ticket:admin'] },
    ])).toEqual(['ticket:admin'])
  })

  it('角色侧同理：perms.roles 全形 acme/ops，用户 roles 传短名 ops 命中', () => {
    expect(effectiveScopes('nobody', ['ops'], [
      { roles: ['acme/ops'], resources: ['ticket:view'] },
    ])).toEqual(['ticket:view'])
  })

  it('角色侧反向：用户 roles 全形 acme/ops，perms.roles 短名 ops 也命中', () => {
    expect(effectiveScopes('nobody', ['acme/ops'], [
      { roles: ['ops'], resources: ['ticket:view'] },
    ])).toEqual(['ticket:view'])
  })

  it('直挂 ∪ 角色交集，复用 normalizeScopes 去重排序', () => {
    expect(effectiveScopes('admin1', ['ops'], [
      { users: ['acme/admin1'], resources: ['b:2', 'a:1'] },
      { roles: ['acme/ops'], resources: ['a:1', 'c:3'] },
      { users: ['other'], resources: ['z:9'] },
    ])).toEqual(['a:1', 'b:2', 'c:3'])
  })
})
