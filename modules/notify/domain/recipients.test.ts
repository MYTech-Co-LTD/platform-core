// recipients.test.ts — 收件人解析（纯函数部分；scope_holders 由 worker 注入解析器）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import { resolveRecipientNames } from './recipients'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: { u: { type: 'user' }, us: { type: 'user_list' } },
  recipients: {
    one: { kind: 'field', field: 'u' },
    many: { kind: 'field', field: 'us' },
    mgrs: { kind: 'scope_holders', scope: 'x' },
    lit: { kind: 'literal' },
  },
}

describe('resolveRecipientNames', () => {
  it('field 单值 / user_list / literal', () => {
    expect(resolveRecipientNames({ recipientKey: 'one', recipientLiteral: null }, decl, { u: 'a' }))
      .toEqual(['a'])
    expect(resolveRecipientNames({ recipientKey: 'many', recipientLiteral: null }, decl, { us: ['a', 'b'] }))
      .toEqual(['a', 'b'])
    expect(resolveRecipientNames({ recipientKey: 'lit', recipientLiteral: ['c'] }, decl, {}))
      .toEqual(['c'])
  })

  it('scope_holders 不在纯函数层解析（返回空，交给 worker）', () => {
    expect(resolveRecipientNames({ recipientKey: 'mgrs', recipientLiteral: null }, decl, {}))
      .toEqual([])
  })

  it('未知键 / 空值 ⇒ 空', () => {
    expect(resolveRecipientNames({ recipientKey: 'nope', recipientLiteral: null }, decl, {})).toEqual([])
    expect(resolveRecipientNames({ recipientKey: 'one', recipientLiteral: null }, decl, {})).toEqual([])
  })
})
