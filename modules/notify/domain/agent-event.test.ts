// agent-event.test.ts — 租户/agent 事件声明：复用 manifest 校验 + 只增不改 diff
import { describe, it, expect } from 'vitest'
import type { NotificationEventDecl } from '@platform/sdk'
import { diffAgentEventDecl, isAgentEventKey, validateAgentEventDecl } from './agent-event'

const base: NotificationEventDecl = {
  key: 'ext.agent_a.daily',
  title: '每日提醒',
  scope: { key: 'day', label: '日期' },
  payload: {
    user: { type: 'user', required: true },
    day: { type: 'string', required: true },
    n: { type: 'number' },
  },
  recipients: { assignee: { kind: 'field', field: 'user' } },
}

describe('validateAgentEventDecl（与 manifest 同源）', () => {
  it('合法 ext 事件通过', () => {
    expect(validateAgentEventDecl(base)).toEqual([])
  })

  it('namespace 不支持 kebab-case（复用事件 key 的段字符集）', () => {
    const issues = validateAgentEventDecl({ ...base, key: 'ext.agent-a.daily' })
    expect(issues.join('\n')).toContain('事件 key')
  })

  it('field 收件人必须指向 user/user_list；scope.key 必须是 string 字段；payload ≤20', () => {
    expect(validateAgentEventDecl({
      ...base, recipients: { assignee: { kind: 'field', field: 'n' } },
    }).join('\n')).toContain('user/user_list')
    expect(validateAgentEventDecl({
      ...base, scope: { key: 'n' },
    }).join('\n')).toContain('string 字段')

    const many: Record<string, { type: 'string' }> = {}
    for (let i = 0; i < 21; i++) many[`f${i}`] = { type: 'string' }
    expect(validateAgentEventDecl({
      ...base, payload: many, scope: undefined,
      recipients: { assignee: { kind: 'literal' } },
    }).join('\n')).toContain('最多 20 个字段')
  })

  it('非 ext 前缀不接受（agent 事件必须落在 ext.*）', () => {
    expect(isAgentEventKey('m.a.b')).toBe(false)
    expect(validateAgentEventDecl({ ...base, key: 'm.a.b' }).length).toBeGreaterThan(0)
  })
})

describe('diffAgentEventDecl（只增不改）', () => {
  it('新增 optional 字段 / 新增 recipient 档 ⇒ 允许', () => {
    expect(diffAgentEventDecl(base, {
      ...base,
      payload: { ...base.payload, extra: { type: 'string' } },
      recipients: { ...base.recipients, ops: { kind: 'literal' } },
    })).toEqual([])
  })

  it('删字段 / 改 type / 改 required / 新增 required ⇒ 拒绝', () => {
    const withoutN = { ...base, payload: { user: base.payload.user!, day: base.payload.day! } }
    expect(diffAgentEventDecl(base, withoutN).join('\n')).toContain('payload.n: removed')

    expect(diffAgentEventDecl(base, {
      ...base, payload: { ...base.payload, n: { type: 'string' } },
    }).join('\n')).toContain('payload.n.type: changed')

    expect(diffAgentEventDecl(base, {
      ...base, payload: { ...base.payload, user: { type: 'user' } },
    }).join('\n')).toContain('payload.user.required: changed')

    expect(diffAgentEventDecl(base, {
      ...base, payload: { ...base.payload, must: { type: 'string', required: true } },
    }).join('\n')).toContain('payload.must: new required field')
  })

  it('改 scope / 改已有 recipient ⇒ 拒绝', () => {
    expect(diffAgentEventDecl(base, { ...base, scope: { key: 'other' } }).join('\n'))
      .toContain('scope: changed')
    expect(diffAgentEventDecl(base, {
      ...base, recipients: { assignee: { kind: 'literal' } },
    }).join('\n')).toContain('recipients.assignee.kind: changed')
  })
})
