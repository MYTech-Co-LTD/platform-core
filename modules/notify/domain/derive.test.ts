// derive.test.ts — 声明派生默认规则（纯函数，无 DB）。计划 Task 4。
import { describe, it, expect } from 'vitest'
import { deriveApprovalRule, deriveFormAssignedRule, deriveReminderRule } from './derive'

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
  it('派生 form.due_reminder 默认规则（recipient=assignee——催办对象＝名单里的人）', () => {
    const r = deriveReminderRule('o1', { mount: 'fd1' }, '2026-10-18T00:00:00Z')
    expect(r).toMatchObject({
      eventType: 'form.due_reminder',
      mount: 'fd1',
      // §2.4：催办对象＝名单里的人（assignee）。原 shipped 的 'submitter' 语义错位——
      // 被催的人**恰恰是还没提交的人**，不可能是 submitter；且与 form.assigned 同键。
      recipient: 'assignee',
      origin: 'derived',
      templateId: 'form_due_reminder',
    })
  })
})

describe('deriveFormAssignedRule（契约含 assignees → form.assigned 默认规则）', () => {
  it('派生 form.assigned 规则（id 确定性，recipient=assignee）', () => {
    const r = deriveFormAssignedRule('o1', { mount: 'fd1' }, '2026-10-19T00:00:00Z')
    expect(r).toMatchObject({
      org: 'o1',
      eventType: 'form.assigned',
      mount: 'fd1',
      recipient: 'assignee',
      origin: 'derived',
      enabled: true,
      channels: ['wechat_work', 'in_app'],
      templateId: 'form_assigned',
    })
    expect(r.id).toBe('derived:form:fd1:form.assigned')
  })

  it('id 确定性——同声明两次派生 id 相同', () => {
    expect(deriveFormAssignedRule('o1', { mount: 'fd1' }, 'x').id).toBe(
      deriveFormAssignedRule('o1', { mount: 'fd1' }, 'y').id,
    )
  })
})
