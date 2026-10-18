// derive.test.ts — 声明派生默认规则（纯函数，无 DB）。计划 Task 4。
import { describe, it, expect } from 'vitest'
import { deriveApprovalRule, deriveReminderRule } from './derive'

describe('deriveApprovalRule（approval: single → 默认审批通知）', () => {
  const decl = { mount: 'ct1', approvers: ['u1', 'u2'] }

  it('派生 case.awaiting_approval 默认规则（origin=derived，assignee，企微+in_app）', () => {
    const r = deriveApprovalRule('o1', decl, '2026-10-18T00:00:00Z')
    expect(r).toMatchObject({
      org: 'o1',
      eventType: 'case.awaiting_approval',
      mount: 'ct1',
      recipient: 'assignee',
      origin: 'derived',
      enabled: true,
      channels: ['wechat_work', 'in_app'],
      templateId: 'case_awaiting_approval',
    })
  })

  it('id 确定性——同声明两次派生 id 相同（幂等 upsert 的前提）', () => {
    expect(deriveApprovalRule('o1', decl, '2026-10-18T00:00:00Z').id).toBe(
      deriveApprovalRule('o1', decl, '2026-10-18T09:00:00Z').id,
    )
  })

  it('不同 mount 派生不同 id', () => {
    expect(deriveApprovalRule('o1', decl, 'x').id).not.toBe(
      deriveApprovalRule('o1', { ...decl, mount: 'ct2' }, 'x').id,
    )
  })
})

describe('deriveReminderRule（表单催办声明 → form.due_reminder）', () => {
  it('派生 form.due_reminder 默认规则（submitter）', () => {
    const r = deriveReminderRule('o1', { mount: 'fd1' }, '2026-10-18T00:00:00Z')
    expect(r).toMatchObject({
      eventType: 'form.due_reminder',
      mount: 'fd1',
      recipient: 'submitter',
      origin: 'derived',
      templateId: 'form_due_reminder',
    })
  })
})
