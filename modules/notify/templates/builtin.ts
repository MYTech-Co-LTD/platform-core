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
      // 「成员申请待审核通知」（#2815）：thing1/thing13/phone_number5 + const9（**不可传**）
      wechat_oa: {
        template_id: '',
        thing1: '{{applicantName}}',
        thing13: '{{stores}}',
        phone_number5: '{{phone}}',
        url: '{{link}}',
      },
    },
  },
  // ── 售后回执/结果类（#2805）：收件人是**提交人本人**（公众号 openid） ────────────
  // `wechat_oa` 的 `template_id` 留空：服务号模板消息一事一模板，ID 只能在公众号后台创建后
  // 由运营填入（`notify.template` 的覆盖行）。空值 ⇒ sender 判 `template_id_missing` 永久失败，
  // 落 `notify.delivery.last_error`——**可见地缺配**，而不是静默发不出去。
  {
    key: 'aftersales_ticket_submitted',
    name: '工单已提交回执',
    eventKey: 'aftersales.ticket.submitted',
    contents: {
      in_app: {
        title: '工单已提交：{{ticketCode}}',
        body: '{{storeName}} · {{productName}} × {{damageQuantity}}，我们会尽快处理',
        link: '{{link}}',
      },
      // 服务号模板字段是**模板自定**的：山海的「售后订单审核结果通知」用
      // character_string1/thing2/amount3/time4 + 一个 const5（**const 不能传值**，2026-11-24 实测
      // 传了报 47003）。`template_id` 留在覆盖行里填（每租户公众号不同）。
      wechat_oa: {
        template_id: '',
        character_string1: '{{ticketCode}}',
        thing2: '{{productName}}',
        amount3: '0.00元',
        time4: '{{time}}',
        url: '{{link}}',
      },
    },
  },
  {
    key: 'aftersales_ticket_processed',
    name: '工单已处理',
    eventKey: 'aftersales.ticket.processed',
    contents: {
      in_app: {
        title: '工单已处理：{{ticketCode}}',
        body: '结果：{{result}}{{amountText}}',
        link: '{{link}}',
      },
      wechat_oa: {
        template_id: '',
        character_string1: '{{ticketCode}}',
        // thing 限 20 字：商品名 + 结果拼一起会超；结果进 const5 那种固定位不可传，
        // 所以这里用商品名（结果本身在站内信里有完整版）
        thing2: '{{productName}}',
        amount3: '{{amountText}}',
        time4: '{{time}}',
        url: '{{link}}',
      },
    },
  },
  {
    key: 'aftersales_employee_approval_decided',
    name: '员工登记审批结果',
    eventKey: 'aftersales.employee_approval.decided',
    contents: {
      in_app: {
        title: '登记申请{{decision}}',
        body: '{{approveType}}申请已{{decision}}',
        link: '{{link}}',
      },
      // ⚠️ 暂**不**接公众号：现有模板「售后订单审核结果通知」的字段是订单语义
      // （订单号/商品/金额/时间），套审批会传出误导内容。接它需要另建一个「审批结果通知」
      // 模板（用户侧动作），建成后在此加 wechat_oa 内容 + 覆盖行填 template_id。
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
  // 收集轮次（件③ / issue #2707）。三处同描：forms manifest events[].defaults ⇔ 本文件 ⇔
  // seed-builtin.ts 派生规则（recipient_key='assignee'）——漏一处 = dispatch `no_rules` 静默丢。
  // assigned 由开轮路由发；due 由 notify-reconcile job 发（eventId 含日期）。链接必须闭合（#44）。
  {
    key: 'oa_collection_assigned',
    name: '收集轮次开轮',
    eventKey: 'forms.collection.assigned',
    contents: {
      wecom_chat: {
        text: '【收集轮次】{{name}}（{{roundKey}}）开始收集\n👉 [去填写]({{link}})',
      },
      in_app: {
        title: '收集轮次：{{name}}（{{roundKey}}）',
        body: '本轮收集开始，等你提交',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'oa_collection_due',
    name: '收集轮次催办',
    eventKey: 'forms.collection.due',
    contents: {
      wecom_chat: {
        text: '【收集催办】{{name}}（{{roundKey}}）还没收到你的提交\n👉 [去填写]({{link}})',
      },
      in_app: {
        title: '收集催办：{{name}}（{{roundKey}}）',
        body: '轮次已到期仍未提交，请尽快填写',
        link: '{{link}}',
      },
    },
  },
  // 目标达成日报（件② #2708 / C3）。三处同描：forms manifest 的 events[].defaults ⇔ 本文件 ⇔ seed-builtin.ts。
  // 字段全是字符串（job 侧已格式化成「85.3%」），模板不解析数字——文案改版不需要动脚本。
  {
    key: 'oa_goal_daily',
    name: '目标达成日报',
    eventKey: 'forms.goal.daily',
    contents: {
      wecom_chat: {
        text: '【目标日报】{{goal}}（{{period}}）\n达成率 {{achievementRate}}｜时间进度 {{progressRate}}\n落后门店：{{topLaggards}}\n👉 [看目标看板]({{link}})',
      },
      in_app: {
        title: '目标日报：{{goal}}（{{period}}）',
        body: '达成率 {{achievementRate}}，时间进度 {{progressRate}}；落后门店：{{topLaggards}}',
        link: '{{link}}',
      },
    },
  },
  // OA 审批（P1 / #2363）。三处同描：forms manifest 的 events[].defaults ⇔ 本文件 ⇔ seed-builtin.ts。
  // awaiting 由 **case-engine（external 生产者）** 发；decided 由平台回调发。链接必须闭合（#44）。
  {
    key: 'oa_approval_awaiting',
    name: '待审批',
    eventKey: 'forms.approval.awaiting',
    contents: {
      wecom_chat: {
        text: '【待审批】{{title}}\n节点：{{nodeKey}}\n👉 [去审批]({{link}})',
      },
      in_app: {
        title: '待审批：{{title}}',
        body: '审批节点 {{nodeKey}} 等你处理',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'oa_approval_decided',
    name: '审批有结果',
    eventKey: 'forms.approval.decided',
    contents: {
      wecom_chat: {
        text: '【审批结果】{{action}}\n审批人：{{decidedBy}}\n👉 [查看详情]({{link}})',
      },
      in_app: {
        title: '审批有结果',
        body: '你的申请{{action}}（审批人：{{decidedBy}}）',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'jobs_job_failed',
    name: '定时任务失败',
    eventKey: 'jobs.job.failed',
    // 收件人是租户管理员：给「谁该修」看的，不是给业务用户。只走 in_app（通道本身可能就是坏的）。
    contents: {
      in_app: {
        title: '定时任务失败：{{key}}',
        body: '运行 {{runId}} 以退出码 {{exitCode}} 结束。错误：{{error}}',
      },
    },
  },
  {
    key: 'jobs_job_timeout',
    name: '定时任务超时',
    eventKey: 'jobs.job.timeout',
    contents: {
      in_app: {
        title: '定时任务超时：{{key}}',
        body: '运行 {{runId}} 超过声明超时被终止（耗时 {{durationMs}}ms）。',
      },
    },
  },
  {
    key: 'jobs_job_dead',
    name: '定时任务进入死信',
    eventKey: 'jobs.job.dead',
    contents: {
      in_app: {
        title: '定时任务进入死信：{{key}}',
        body: '已尝试 {{attempts}} 次仍未成功（最近错误：{{error}}）。需要人工介入。',
      },
    },
  },
  // ── 业务监控（Wave 7 V1）──────────────────────────────────────────────────────
  // 文案**不带数值、不带阈值**：reveal='report' 的指标数值一旦进通知就是数据泄露（spec §3.4/§9）。
  {
    key: 'data_monitor_fired',
    name: '业务监控触发',
    eventKey: 'data.monitor.fired',
    contents: {
      in_app: {
        title: '监控触发：{{name}}',
        body: '判据 {{verdict}}，窗口 {{windowDays}} 天。有异常，请登录查看。',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'data_monitor_resolved',
    name: '业务监控恢复',
    eventKey: 'data.monitor.resolved',
    contents: {
      in_app: {
        title: '监控恢复：{{name}}',
        body: '判据已恢复正常（窗口 {{windowDays}} 天）。',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'data_monitor_suppressed',
    name: '业务监控已限流',
    eventKey: 'data.monitor.suppressed',
    contents: {
      in_app: {
        title: '监控通知已限流',
        body: '本小时有 {{count}} 条监控通知被抑制（达到租户每小时上限）。请登录查看报表。',
        link: '{{link}}',
      },
    },
  },
  {
    key: 'data_monitor_disabled',
    name: '业务监控已自动停用',
    eventKey: 'data.monitor.disabled',
    contents: {
      in_app: {
        title: '监控已自动停用：{{name}}',
        body: '连续求值失败达到上限，已自动停用。请检查目标指标或数据源。',
        link: '{{link}}',
      },
    },
  },
]
