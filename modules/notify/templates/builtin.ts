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
]
