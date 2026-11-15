// notify-inbox-role-sync.test.ts — 纯核：角色成员对齐（不连 Casdoor）
import { describe, expect, it } from 'vitest'
import { desiredRoleMembers, sameMembers } from './notify-inbox-role-sync.mjs'

describe('desiredRoleMembers', () => {
  it('去 org 前缀、去禁用、去重并排序', () => {
    const users = [
      { name: 'o/alice' },
      { name: 'bob' },
      { name: 'o/bob' },
      { name: 'o/carol', isForbidden: true },
      { name: 'o/alice' },
    ]
    expect(desiredRoleMembers(users, 'o')).toEqual(['alice', 'bob'])
  })

  it('空列表 ⇒ 空成员（不会把全员误挂）', () => {
    expect(desiredRoleMembers([], 'o')).toEqual([])
  })
})

describe('sameMembers', () => {
  it('短名/全形混写视为同一人，顺序无关', () => {
    expect(sameMembers(['o/alice', 'bob'], ['bob', 'alice'])).toBe(true)
    expect(sameMembers(['alice'], ['alice', 'bob'])).toBe(false)
    expect(sameMembers(['alice'], ['carol'])).toBe(false)
  })
})
