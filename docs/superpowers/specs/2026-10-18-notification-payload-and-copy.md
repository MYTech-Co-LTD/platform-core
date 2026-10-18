# 通知事件 payload 契约 + v1 五模板文案（草案，待人审）

> 状态：**草案，待审**。上游：正典 §2.6（通知规则层）、spec `2026-10-16-notification-rules-design.md` §9（事件契约 v1）、
> 计划 `2026-10-18-notification-rules-layer.md` Task 12。
> §2.6 明写「payload schema 版本化、**进本文**、测试锚定，改 payload 必过 PR」——本文件就是那个「本文」的草案。
> **文案是人审门禁的对象**（§2.6 门禁分层：低频 × 大，不可撤回），请逐条改到你要的话术。

## 1. 事件 → 模板映射（先暴露一个缺口）

| # | event_type | 触发源 | v1 模板 | 收件人典型 |
|---|---|---|---|---|
| 1 | `case.awaiting_approval` | emit | `case_awaiting_approval` | assignee（**原始痛点主路径**） |
| 2 | `case.status_changed` | emit | `case_status_changed` | submitter / 显式规则 |
| 3 | `case.reassigned` | emit | **⚠️ 无**（见下） | 新旧 assignee |
| 4 | `form.assigned` | emit | `form_assigned` | user_list / field |
| 5 | `form.due_reminder` | scheduler | `form_due_reminder` | submitter |
| 6 | `sla.breach_warning` | scheduler | `sla_breach_warning` | assignee + 升级名单 |

> ⚠️ **缺口**：§18.5 的 v1 模板集是**五条**，而事件清单是**六条**——`case.reassigned` **没有默认模板**。
> 两条路，请选一条：(a) 补第六个模板 `case_reassigned`（本文件给文案）；(b) v1 不给默认模板，
> 该事件**只认人工规则**（没规则就不发）。**倾向 (a)**：reassign 恰恰是「旧收件人要知道」的场景，静默不发最伤。

## 2. payload 契约（每事件的字段）

**通则**：payload 由**触发源**填（case-engine 填 case 系，forms 填 form 系，scheduler 填定时系）；
`link` 一律是**带 caseId/formId 的详情页 URL**（点通知跳详情）；**不含 PII 之外的敏感值**；
字段只增不改（改 = 走 PR + 版本号，照 forms-seam 纪律）。

| event_type | 字段 | 说明 |
|---|---|---|
| `case.awaiting_approval` | `caseId` `title` `link` `assignee` `submitter?` `caseType?` | `assignee` 即收件人（subscriberId = Casdoor 用户 id） |
| `case.status_changed` | `caseId` `title` `link` `status` `actor` | `status` 用**人话**（「已通过」而非 `approved`） |
| `case.reassigned` | `caseId` `title` `link` `from` `to` | `to` 为新 assignee（新收件人） |
| `form.assigned` | `formId` `title` `link` `target` `due?` | `target` = 被指派人（显示名） |
| `form.due_reminder` | `formId` `title` `link` `due` | `due` = 到期时刻（人话格式） |
| `sla.breach_warning` | `caseId` `title` `link` `sla` `overdueBy` | `overdueBy` = 已超期时长 |

## 3. v1 五模板文案（企微 chat / Handlebars；**请逐条改**）

> 形状照既有 12 条（`ticket-dispatch/src/integrations/novu-seed.mjs` 的 `WORKFLOW_COPIES`）：
> 标题方括号、要点分行、末尾 `👉 [查看详情]({{link}})`。**markdown 链接必须闭合**（#44 的教训：
> 存量 9 条缺右括号 ⇒ 企微渲染成字面文本）。

```js
// 1) case_awaiting_approval —— 原始痛点主路径
{ name: 'case_awaiting_approval', text:
  '【待审批】{{title}}\n提交人：{{submitter}}\n👉 [去审批]({{link}})' },

// 2) case_status_changed
{ name: 'case_status_changed', text:
  '【状态更新】{{title}}\n当前：{{status}}\n操作人：{{actor}}\n👉 [查看详情]({{link}})' },

// 3) case_reassigned —— 仅当 §1 选 (a) 才落
{ name: 'case_reassigned', text:
  '【已改派给你】{{title}}\n原负责人：{{from}}\n现负责人：{{to}}\n👉 [查看详情]({{link}})' },

// 4) form_assigned
{ name: 'form_assigned', text:
  '【待填写】{{title}}\n填写人：{{target}}\n👉 [去填写]({{link}})' },

// 5) form_due_reminder —— 填催（入口 B 定时驱动）
{ name: 'form_due_reminder', text:
  '【填写提醒】{{title}}\n截止：{{due}}\n👉 [去填写]({{link}})' },

// 6) sla_breach_warning —— SLA 超期
{ name: 'sla_breach_warning', text:
  '【SLA 超期】{{title}}\n已超期：{{overdueBy}}\n👉 [查看详情]({{link}})' },
```

## 4. 交付路径与归属（**一处待你拍**）

**交付路径**（照既有纪律，不手敲）：

```
① repo 加文案（单一事实源） → ② seed 到 Dev → ③ 人审文案 → ④ sync 到 Prod
```

**归属待定**：这 5（或 6）条是 **platform-core 通知层**的模板，而现在唯一的 `WORKFLOW_COPIES`
住在 **`data-platform-scaffold/modules/ticket-dispatch`** 里。

| 选项 | 优 | 劣 |
|---|---|---|
| **A** 加进现有 `WORKFLOW_COPIES` | 一处管所有出站文案（**人审面集中**）；不重复播种机制 | 与 PAT 同款错位：platform-core 的资产寄住在 ticket-dispatch 模块 |
| **B** platform-core 建自己的文案正典 + 播种 | 归属正确（谁消费谁持有）；两个产品解耦 | 播种机制要抄一份（create-if-absent 逻辑） |
| **C** 把 Novu 文案正典上移到平台级（如 team-harness） | 归属最正（Novu 是公司基建） | 最大的动作，且跨仓交付链要重接 |

**我的推荐：A（现在）+ 记 C 为演进项。** 理由：文案是**人审**对象，**审查面集中**的价值此刻大于归属洁癖；
而 B 会立刻产生第二份播种机制（与「能消失的重复就让它消失」相悖）。**但这条我拿不准，请你定。**

> ⚠️ **无论选哪条**，都要注意 issue **#44 仍 OPEN**：seed 是 create-if-absent，**存量条目不会收敛**。
> 我们这 5 条是**新名字** ⇒ create 路径可用；但若将来改文案，同样会漂移——**T12 交付时应顺带把 #44 的
> `--deliver`（漂移即 PUT）落实或至少在交付记录里标注该风险**。
