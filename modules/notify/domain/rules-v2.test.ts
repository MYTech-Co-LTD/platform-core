// rules-v2.test.ts — 规则匹配与校验（纯函数；2026-10-27 通知基础设施 §4）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import { matchRules, validateRule, type NotificationRule } from './rules-v2'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  scope: { key: 'id' },
  payload: { id: { type: 'string' }, u: { type: 'user' } },
  recipients: {
    approver: { kind: 'field', field: 'u' },
    managers: { kind: 'scope_holders', scope: 'm:manage' },
    manualList: { kind: 'literal' },
  },
}

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  org: 'o', id: 'r1', enabled: true, eventKey: 'm.a.b', scope: '*',
  recipientKey: 'approver', recipientLiteral: null, templateKey: 't1',
  channels: ['c1'], cooldownMinutes: null, origin: 'manual', createdAt: '2026-01-01',
  ...over,
})

describe('matchRules', () => {
  it('精确 scope 命中时不回退通配', () => {
    const out = matchRules([
      rule({ id: 'a', scope: '*', origin: 'manual' }),
      rule({ id: 'b', scope: 's1', origin: 'derived' }),
    ], { eventKey: 'm.a.b', scope: 's1' })
    expect(out.map((r) => r.id)).toEqual(['b'])
  })

  it('manual 覆盖 derived（同 scope 档）', () => {
    const out = matchRules([
      rule({ id: 'a', scope: 's1', origin: 'derived' }),
      rule({ id: 'b', scope: 's1', origin: 'manual' }),
    ], { eventKey: 'm.a.b', scope: 's1' })
    expect(out.map((r) => r.id)).toEqual(['b'])
  })

  it('无精确命中才回退 *；停用规则不参与', () => {
    const out = matchRules([
      rule({ id: 'a', scope: '*', origin: 'manual' }),
      rule({ id: 'b', scope: 's1', origin: 'manual', enabled: false }),
    ], { eventKey: 'm.a.b', scope: 's1' })
    expect(out.map((r) => r.id)).toEqual(['a'])
  })
})

describe('validateRule', () => {
  const enabled = new Set(['c1'])
  const published = new Set(['t1'])
  const base = {
    eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
    recipientLiteral: null, templateKey: 't1', channels: ['c1'], origin: 'manual' as const,
  }

  it('合法规则通过', () => {
    expect(validateRule(base, decl, enabled, published)).toBeNull()
  })

  it('未知收件人键', () => {
    expect(validateRule({ ...base, recipientKey: 'nope' }, decl, enabled, published))
      .toBe('RULE_RECIPIENT_UNKNOWN')
  })

  it('literal 名单只能配 manual + literal 收件人', () => {
    expect(validateRule({ ...base, recipientKey: 'manualList', recipientLiteral: ['u'] },
      decl, enabled, published)).toBeNull()
    expect(validateRule({ ...base, recipientKey: 'manualList', recipientLiteral: ['u'], origin: 'derived' },
      decl, enabled, published)).toBe('RULE_LITERAL_MANUAL_ONLY')
    expect(validateRule({ ...base, recipientKey: 'approver', recipientLiteral: ['u'] },
      decl, enabled, published)).toBe('RULE_LITERAL_MANUAL_ONLY')
  })

  it('事件未声明 scope 时非 * 的作用域被拒', () => {
    const noScope = { ...decl, scope: undefined }
    expect(validateRule({ ...base, scope: 'x' }, noScope, enabled, published))
      .toBe('RULE_SCOPE_UNKNOWN')
    // 声明了 scope 时任意实例值都合法（实例由生产者负责）
    expect(validateRule({ ...base, scope: 'x' }, decl, enabled, published)).toBeNull()
  })

  it('通道/模板必须存在且已发布', () => {
    expect(validateRule({ ...base, channels: ['nope'] }, decl, enabled, published))
      .toBe('RULE_CHANNEL_UNKNOWN')
    expect(validateRule({ ...base, templateKey: 'nope' }, decl, enabled, published))
      .toBe('RULE_TEMPLATE_UNKNOWN')
  })
})
