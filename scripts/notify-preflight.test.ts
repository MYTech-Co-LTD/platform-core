// notify-preflight.test.ts — 纯核：哪些规则可体检（field 类必须跳过）+ 收件人档取权限码
import { describe, it, expect } from 'vitest'
import { pickCheckable, scopeCodeOf } from './notify-preflight.mjs'

type Rule = { id: string; eventKey: string; recipientKey: string }

const rule = (id: string, recipientKey: string): Rule => ({ id, eventKey: 'e1', recipientKey })

describe('pickCheckable', () => {
  it('field 类被跳过并单独列出（不是「通过」）', () => {
    const rules = [rule('a', 'k1'), rule('b', 'k2')]
    const declOf = () => ({
      recipients: {
        k1: { kind: 'scope_holders' },
        k2: { kind: 'field' },
      },
    })
    const r = pickCheckable(rules, declOf)
    expect(r.checkable.map((x) => x.rule.id)).toEqual(['a'])
    expect(r.skipped).toEqual(['b'])
  })

  it('scope_holders / literal 都纳入；decl 缺失**仍纳入**（事件声明没了本身就是阻塞）', () => {
    const rules = [rule('s', 'k1'), rule('l', 'k2'), rule('n', 'k3')]
    const withDecl = { recipients: { k1: { kind: 'scope_holders' }, k2: { kind: 'literal' } } }
    // 只有 'n' 的声明缺失 —— declOf 按 rules 的 eventKey 给，这里统一给同一份
    const declOf = (eventKey: string) => (eventKey === 'e1' ? withDecl : null)
    const r = pickCheckable(rules, declOf)
    expect(r.checkable.map((x) => x.rule.id)).toEqual(['s', 'l', 'n'])
    expect(r.skipped).toEqual([])
  })

  it('decl 缺失的规则被纳入 checkable（由调用方报 event_missing）', () => {
    const r = pickCheckable([rule('n', 'k1')], () => null)
    expect(r.checkable.map((x) => x.rule.id)).toEqual(['n'])
    expect(r.skipped).toEqual([])
  })

  it('空规则集 ⇒ 两侧都空', () => {
    expect(pickCheckable([], () => null)).toEqual({ checkable: [], skipped: [] })
  })
})

describe('scopeCodeOf', () => {
  const decl = {
    recipients: {
      approvers: { kind: 'scope_holders', scope: 'aftersales:manage' },
      admins: { kind: 'scope_holders', scope: 'tenant:admin' },
      broken: { kind: 'scope_holders' },
      literal: { kind: 'literal' },
      dept: { kind: 'dept' },
      field: { kind: 'field' },
    },
  }

  it('scope_holders ⇒ 返回声明里的权限码，不是 recipientKey（issue #2263）', () => {
    expect(scopeCodeOf(decl, 'approvers')).toBe('aftersales:manage')
    expect(scopeCodeOf(decl, 'admins')).toBe('tenant:admin')
  })

  it('非 scope_holders / 缺 scope / 缺档 ⇒ null', () => {
    expect(scopeCodeOf(decl, 'literal')).toBeNull()
    expect(scopeCodeOf(decl, 'dept')).toBeNull()
    expect(scopeCodeOf(decl, 'field')).toBeNull()
    expect(scopeCodeOf(decl, 'broken')).toBeNull()
    expect(scopeCodeOf(decl, 'nope')).toBeNull()
    expect(scopeCodeOf(null, 'approvers')).toBeNull()
  })
})
