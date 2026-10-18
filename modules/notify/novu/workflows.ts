// workflows.ts — notify 通知层的 Novu 文案**正典**（单一事实源；Novu 侧是它的投影）。
//
// 归属（2026-10-18 人拍板，架构决策「B」）：**文案随事件语义走，由生产者自持**——
//   不做跨产品共享注册表（共享注册表 = 跨产品爆炸半径 + 测试耦合：`ticket-dispatch` 的测试断言
//   「所有文案必须含 {{ticketId}}」，让 platform-core 的条目挤进同一张表就得削弱别人产品的守卫）。
//   机制重复（播种 60 行）是这里较小的恶；抽公共工具记为演进项，触发条件：出现第三个生产者。
//
// 纪律（与既有 12 条同款，且是本目录测试的断言对象）：
//   · 变量一律**摊平**（Novu 3.19 的 getCompilePayload 会摊平 payload，写 {{payload.X}} 渲染为空）；
//   · **markdown 链接必须闭合**——`]({{link}})` 不能漏右括号（issue #44 实测：存量 9 条漏括号，
//     企微把它渲染成字面文本）；
//   · 改文案 = 改本文件 → 重跑播种 → **人审** → sync 生产（§2.6 门禁分层：低频 × 大，不可撤回）。

export interface WorkflowCopy {
  /** Novu workflow identifier，与 notify.rule.template_id 对应（derive.ts 的默认值即取自这里） */
  name: string
  /** chat 模板正文（Handlebars）。Novu 的 chat step content **必须是字符串**（块数组是 in-app 富文本形状，
   *  3.19 能存进去但执行期抛 "Message content could not be generated"）。 */
  text: string
}

export const WORKFLOW_COPIES: WorkflowCopy[] = [
  // ── case 系（触发源：case-engine，§2.6 事件清单）──
  {
    name: 'case_awaiting_approval',
    text: '【待审批】{{title}}\n提交人：{{submitter}}\n👉 [去审批]({{link}})',
  },
  {
    name: 'case_status_changed',
    text: '【状态更新】{{title}}\n当前：{{status}}\n操作人：{{actor}}\n👉 [查看详情]({{link}})',
  },
  {
    name: 'case_reassigned',
    text: '【已改派给你】{{title}}\n原负责人：{{from}}\n现负责人：{{to}}\n👉 [查看详情]({{link}})',
  },
  // ── form 系（触发源：forms / scheduler）──
  {
    name: 'form_assigned',
    text: '【待填写】{{title}}\n填写人：{{target}}\n👉 [去填写]({{link}})',
  },
  {
    name: 'form_due_reminder',
    text: '【填写提醒】{{title}}\n截止：{{due}}\n👉 [去填写]({{link}})',
  },
  // ── SLA（触发源：scheduler）──
  {
    name: 'sla_breach_warning',
    text: '【SLA 超期】{{title}}\n已超期：{{overdueBy}}\n👉 [查看详情]({{link}})',
  },
]
