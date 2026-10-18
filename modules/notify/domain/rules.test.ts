// rules.test.ts — 匹配与解析器校验（纯函数，无 DB）。计划 Task 3。
import { describe, it, expect } from 'vitest'
import { matchRules, validateRule, mountKindOf, type NotificationRule } from './rules'

function rule(
  p: Partial<NotificationRule> & Pick<NotificationRule, 'id' | 'eventType' | 'mount' | 'origin'>,
): NotificationRule {
  return {
    org: 'o1',
    enabled: true,
    templateId: 'case_awaiting_approval',
    recipient: 'assignee',
    recipientArg: null,
    channels: ['wechat_work', 'in_app'],
    cooldownMinutes: null,
    createdAt: '2026-10-18T00:00:00Z',
    ...p,
  }
}

describe('matchRules', () => {
  it('manual 覆盖 derived（同 event+mount，derived 不重复生效）', () => {
    const rules = [
      rule({ id: 'd1', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'derived' }),
      rule({ id: 'm1', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'manual' }),
    ]
    const got = matchRules(rules, { eventType: 'case.awaiting_approval', mount: 'ct1' })
    expect(got.map((r) => r.id)).toEqual(['m1'])
  })

  it("'*' 兜底：无精确 mount 时回通配", () => {
    const rules = [
      rule({ id: 'w1', eventType: 'case.awaiting_approval', mount: '*', origin: 'manual' }),
      rule({ id: 'x1', eventType: 'case.awaiting_approval', mount: 'other', origin: 'manual' }),
    ]
    const got = matchRules(rules, { eventType: 'case.awaiting_approval', mount: 'ct1' })
    expect(got.map((r) => r.id)).toEqual(['w1'])
  })

  it('有精确 mount 时不回通配（通配只是兜底）', () => {
    const rules = [
      rule({ id: 'w1', eventType: 'case.awaiting_approval', mount: '*', origin: 'manual' }),
      rule({ id: 'e1', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'manual' }),
    ]
    const got = matchRules(rules, { eventType: 'case.awaiting_approval', mount: 'ct1' })
    expect(got.map((r) => r.id)).toEqual(['e1'])
  })

  it('disabled 规则不参与', () => {
    const rules = [
      rule({ id: 'off', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'manual', enabled: false }),
    ]
    expect(matchRules(rules, { eventType: 'case.awaiting_approval', mount: 'ct1' })).toEqual([])
  })

  it('同优先级按 createdAt 稳定序', () => {
    const rules = [
      rule({ id: 'b', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'manual', createdAt: '2026-10-18T02:00:00Z' }),
      rule({ id: 'a', eventType: 'case.awaiting_approval', mount: 'ct1', origin: 'manual', createdAt: '2026-10-18T01:00:00Z' }),
    ]
    expect(matchRules(rules, { eventType: 'case.awaiting_approval', mount: 'ct1' }).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('eventType 不同不参与', () => {
    const rules = [rule({ id: 'z', eventType: 'case.status_changed', mount: 'ct1', origin: 'manual' })]
    expect(matchRules(rules, { eventType: 'case.awaiting_approval', mount: 'ct1' })).toEqual([])
  })
})

describe('validateRule', () => {
  const base = {
    eventType: 'case.awaiting_approval',
    mount: 'ct1',
    recipient: 'assignee' as const,
    recipientArg: null as string | null,
  }

  it('case 挂载用 assignee ⇒ 通过', () => {
    expect(validateRule(base)).toBeNull()
  })

  it('form 挂载用 assignee ⇒ 拒（fail-closed 机检码）', () => {
    expect(validateRule({ ...base, eventType: 'form.due_reminder', mount: 'fd1' })).toEqual({
      code: 'RULE_RECIPIENT_MOUNT_MISMATCH',
    })
  })

  it('user_list 缺参数 ⇒ 拒', () => {
    expect(validateRule({ ...base, recipient: 'user_list', recipientArg: null })).toEqual({
      code: 'RULE_RECIPIENT_ARG_REQUIRED',
    })
  })

  it('未知事件类型 ⇒ 拒', () => {
    expect(validateRule({ ...base, eventType: 'weird.event' })).toEqual({ code: 'RULE_EVENT_TYPE_UNKNOWN' })
  })
})

describe('mountKindOf', () => {
  it('case./sla. ⇒ case；form. ⇒ form；其余 null', () => {
    expect(mountKindOf('case.awaiting_approval')).toBe('case')
    expect(mountKindOf('sla.breach_warning')).toBe('case')
    expect(mountKindOf('form.due_reminder')).toBe('form')
    expect(mountKindOf('nope')).toBeNull()
  })
})
