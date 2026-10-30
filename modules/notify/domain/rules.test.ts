// rules-v2.test.ts — 规则匹配与校验（纯函数；2026-10-27 通知基础设施 §4）
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import { matchRules, validateRule, type NotificationRule } from './rules'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  scope: { key: 'id' },
  payload: { id: { type: 'string' }, u: { type: 'user' } },
  recipients: {
    approver: { kind: 'field', field: 'u' },
    managers: { kind: 'scope_holders', scope: 'm:manage' },
    manualList: { kind: 'literal' },
    dept: { kind: 'dept' },
  },
}

const rule = (over: Partial<NotificationRule> = {}): NotificationRule => ({
  org: 'o', id: 'r1', enabled: true, eventKey: 'm.a.b', scope: '*',
  recipientKey: 'approver', recipientLiteral: null, recipientDepts: null, templateKey: 't1',
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

// ── 部门档的写入侧校验（组织架构 Phase C；spec 2026-10-30 §3.5）────────────────────
describe('validateRule: 部门收件人', () => {
  const ok = new Set(['c1'])
  const tpl = new Set(['t1'])
  const v = (over: Partial<NotificationRule>) => validateRule(rule(over), decl, ok, tpl)

  it('★ 声明了 dept 档 + 选了部门 ⇒ 通过', () => {
    expect(v({ recipientKey: 'dept', recipientDepts: ['D1', 'D2'] })).toBeNull()
  })

  it('★ 声明了 dept 档但一个部门都没选 ⇒ RULE_DEPTS_REQUIRED（不许「配一半」上线）', () => {
    expect(v({ recipientKey: 'dept', recipientDepts: null })).toBe('RULE_DEPTS_REQUIRED')
    expect(v({ recipientKey: 'dept', recipientDepts: [] })).toBe('RULE_DEPTS_REQUIRED')
  })

  it('★ 非 dept 档带部门选择 ⇒ RULE_DEPTS_NOT_ALLOWED（拒绝优于静默丢弃）', () => {
    expect(v({ recipientKey: 'approver', recipientDepts: ['D1'] })).toBe('RULE_DEPTS_NOT_ALLOWED')
    // 反证：不带选择就正常
    expect(v({ recipientKey: 'approver' })).toBeNull()
  })

  it('dept 档 + 字面名单并存 ⇒ 拒（两档互斥）', () => {
    expect(v({ recipientKey: 'dept', recipientDepts: ['D1'], recipientLiteral: ['x'] }))
      .toBe('RULE_DEPTS_NOT_ALLOWED')
  })

  it('事件没声明 dept 档 ⇒ RULE_RECIPIENT_UNKNOWN（声明即授权：消费方不能自选）', () => {
    const noDept = { ...decl, recipients: { approver: decl.recipients.approver! } }
    expect(validateRule(rule({ recipientKey: 'dept', recipientDepts: ['D1'] }), noDept, ok, tpl))
      .toBe('RULE_RECIPIENT_UNKNOWN')
  })
})
