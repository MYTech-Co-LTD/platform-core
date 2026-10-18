// derive.ts — 声明派生默认规则（纯函数，幂等）。正典 §2.6 取舍②：常路径零配置默认就通。
//
// 幂等靠**确定性 id**：同声明派生同 id ⇒ storage 层 upsert（on conflict (org,id)）是 no-op，
// 不重复生效、不产生重复行。createdAt 由调用方注入（存储层在 conflict 时**不覆盖** created_at，
// 保住「首次派生时间」语义）。

import type { Channel, NotificationRule } from './rules'

/** `approval: single <审批人[]>` 声明。approvers 本层不消费——assignee 由 case routing 解析（§15 已定）。 */
export type ApprovalDeclaration = {
  mount: string // case_type_id
  approvers: string[]
  templateId?: string
}

/** 表单催办声明（表单声明了催办策略即派生 form.due_reminder）。 */
export type ReminderDeclaration = {
  mount: string // form_def_id
  templateId?: string
}

const DEFAULT_CHANNELS: Channel[] = ['wechat_work', 'in_app']

export function deriveApprovalRule(org: string, decl: ApprovalDeclaration, now: string): NotificationRule {
  return {
    id: `derived:case:${decl.mount}:case.awaiting_approval`,
    org,
    enabled: true,
    eventType: 'case.awaiting_approval',
    mount: decl.mount,
    templateId: decl.templateId ?? 'case_awaiting_approval',
    recipient: 'assignee',
    recipientArg: null,
    channels: [...DEFAULT_CHANNELS],
    cooldownMinutes: null,
    origin: 'derived',
    createdAt: now,
  }
}

export function deriveReminderRule(org: string, decl: ReminderDeclaration, now: string): NotificationRule {
  return {
    id: `derived:form:${decl.mount}:form.due_reminder`,
    org,
    enabled: true,
    eventType: 'form.due_reminder',
    mount: decl.mount,
    templateId: decl.templateId ?? 'form_due_reminder',
    recipient: 'submitter',
    recipientArg: null,
    channels: [...DEFAULT_CHANNELS],
    cooldownMinutes: null,
    origin: 'derived',
    createdAt: now,
  }
}
