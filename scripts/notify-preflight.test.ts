// notify-preflight.test.ts — 纯核：哪些规则可体检（field 类必须跳过）
import { describe, it, expect } from 'vitest'
import { pickCheckable } from './notify-preflight.mjs'

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
