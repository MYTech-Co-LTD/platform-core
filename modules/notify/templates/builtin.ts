// builtin.ts — 平台内置通知文案（repo 是事实源；seed 进各租户 notify.template）。
// 变量 = 事件 payload 字段名（摊平）；企微 markdown 链接必须闭合（#44 教训）。
export interface BuiltinTemplate {
  key: string
  name: string
  eventKey: string
  contents: Record<string, Record<string, string>>
}

export const BUILTIN_TEMPLATES: BuiltinTemplate[] = [
  {
    key: 'aftersales_employee_approval_pending',
    name: '员工登记待审批',
    eventKey: 'aftersales.employee_approval.pending',
    contents: {
      wecom_chat: {
        text: '【待审批】员工登记\n申请人：{{applicantName}}\n类型：{{approveType}}\n👉 [去审批]({{link}})',
      },
      in_app: {
        title: '员工登记待审批',
        body: '{{applicantName}} 提交了{{approveType}}申请',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'notify_integration_stale',
    name: '集成活性超期',
    eventKey: 'notify.integration.stale',
    // 企微 markdown 的链接必须闭合（#44 教训）；这里没有外链，保持纯文本
    contents: {
      wecom_chat: {
        text: '【集成超期】{{integrationId}}\n类型：{{integrationKind}}\n依据：{{reason}}',
      },
      in_app: {
        title: '集成活性超期：{{integrationId}}',
        body: '{{reason}}',
      },
    },
  },
  {
    key: 'notify_approval_pending',
    name: '通知审批待处理',
    eventKey: 'notify.approval.pending',
    contents: {
      wecom_chat: {
        text: '【审批】{{namespace}} 的{{kind}}\n申请人：{{requestedBy}}\n{{summary}}',
      },
      in_app: {
        title: '通知审批待处理：{{namespace}}',
        body: '{{requestedBy}} 申请 {{summary}}',
      },
    },
  },
  {
    key: 'data_metric_definition_changed',
    name: '指标定义变更',
    eventKey: 'data.metric.definition.changed',
    // 指标口径变了，看数人得知道（spec 2026-11-01 §10.4 D6：生效必发通知）。
    // 链接闭合（#44 教训）——link 由 emit 侧拼 PLATFORM_CONSOLE_BASE_URL。
    contents: {
      wecom_chat: {
        text: '【指标变更】{{title}} 的定义已生效\n操作人：{{changedBy}}\n👉 [查看指标]({{link}})',
      },
      in_app: {
        title: '指标定义变更：{{title}}',
        body: '{{changedBy}} 确认生效了新定义',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'forms_form_assigned',
    name: '表单指派',
    eventKey: 'forms.form.assigned',
    // payload 只有 assetId/assignee/link（没有标题字段）——文案不硬编表单名，避免「表单 A」出现在
    // 表单 B 的通知里；细节走链接（#44 教训：链接必须闭合）。
    contents: {
      wecom_chat: {
        text: '【表单指派】你有一份新表单待填写\n👉 [去填写]({{link}})',
      },
      in_app: {
        title: '表单指派',
        body: '你有一份新表单待填写',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'forms_form_due_reminder',
    name: '表单催办',
    eventKey: 'forms.form.due_reminder',
    contents: {
      wecom_chat: {
        text: '【表单催办】这份表单还在等你填写\n👉 [去填写]({{link}})',
      },
      in_app: {
        title: '表单催办',
        body: '这份表单还在等你填写',
        link: '{{link}}',
      },
    },
  },
]
