# 通知可送达性（deliverability）作为一等公民（设计）

> 2026-10-28 brainstorming 定稿。**状态：设计稿，待评审**。
> 上游正典：`docs/architecture.md` §2.6（通知基础设施）、`docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md`。
> 触发案例：**2026-10-27 生产验证**——`aftersales:manage` 在 mytech org 无持有者，
> 事件入队后零投递，而 `notify.event.status='matched'`、`notify.delivery` 零行、
> `notify-health` 全绿（`dead=0 stale=0 workers=1 failedLastHour=0`）。
> **失败没有被建模成状态，所以不可观测**——与 #948（bridge 502 记 sent）、
> 探活假阳性同族。

---

## 0. 问题陈述

### 0.1 实测的静默路径

`modules/notify/worker.ts`（2026-10-28 代码实测）：

```ts
const recipients = [...new Set([...names, ...holders])].filter(Boolean)
if (recipients.length === 0) continue          // ← 静默跳过，无状态、无回执、无日志
...
await deps.markEvent(ev, 'matched')            // ← 事件仍标 matched
```

同类静默还有两处：

| 位置 | 行为 |
|---|---|
| `channelRows.length === 0`（通道全部停用/不存在） | `continue`，事件仍标 `matched` |
| `tpl` 找不到（模板未发布/被归档） | 标 `invalid`，**不告警、不回执** |

### 0.2 为什么它不是「一个权限配错」

「配置合法但运行时解析为空」是一个**结构位**，能被多种原因触发：

| 原因 | 例子 |
|---|---|
| 权限码无人持有 | `aftersales:manage` 在 mytech 空 |
| 收件人在别的 org | 跨租户引用（应由解析期拦截，但 v1 推给触发源） |
| payload 里 `field` 缺失 | 生产者漏填 `assignee` |
| literal 名单全是被删用户 | `NOTIFY_APPROVERS` 配了离职员工 |
| 通道全部停用 | 运维把 `wecom_default` 关了 |

**每一种都表现为同一件事：零投递 + 全绿。** 所以修法必须在「解析」这一层统一收口，
而不是给每个原因单独打补丁。

### 0.3 现状分层缺哪一层

| 层 | 现状 | 能拦住的 | 拦不住的 |
|---|---|---|---|
| 写时校验 | ✅ `validateRule`（事件/模板/通道引用存在、literal 仅 manual） | 引用不存在的对象 | 对象存在但「解得空」 |
| 运行时解析 | ✅ 刚补（`scope_holders` 真解析） | —— | 解析成功但结果为空 |
| **观测面** | ❌ **缺** | —— | **全部** |

---

## 1. 结论与范围

| 项 | 决定 |
|---|---|
| 核心 | 把「收件人解析」抽成**单一纯函数 + 单一调用点**，三个消费方共用 |
| 运行期 | 零收件人 ⇒ 新状态 `no_recipients`；零通道 ⇒ `no_channel`；模板缺失 ⇒ `invalid`（保留，但加告警） |
| 观测 | `notify-health` 增加 `eventsNoRecipients` / `eventsNoChannel`，**>0 判红** |
| 配置期 | 新端点 `GET /rules/:id/resolve` + console 规则列表显示「可解析 N 人」 |
| 工具面 | MCP 加 `check_rule`（只读 dry-run），让 agent 建完就能自证 |
| 定期体检 | `scripts/notify-preflight.mjs`（job），输出「0 人规则清单」 |
| 明确不做 | 兜底收件人（会掩盖配置错误）、条件规则、跨租户自动纠正 |

### 反转条件

- 若 `no_recipients` 在生产长期高频出现且原因单一（如总是权限没配），
  说明缺的是**开通流程**而不是观测——转去做开通阶段引导。
- 若 preflight 的解析结果与投递期实际不一致（两条代码路径），
  **立即回退到单一实现**（本设计的前提就是「同一函数」）。

---

## 2. 核心设计：收件人解析的唯一入口

### 2.1 现状的问题

解析逻辑现在**散在 `worker.ts` 的循环体里**（`names + holders + filter(Boolean)`），
console/MCP/脚本想「问一下这条规则能发给谁」无路可走——只能复刻一份，必然漂移。

### 2.2 目标形状

```ts
// modules/notify/domain/deliverability.ts（纯编排，依赖注入）
export type ResolveInput = {
  org: string
  rule: NotificationRule
  payload: Record<string, unknown>   // 真实 payload 或 sample
}

export type ResolvedRecipient = {
  name: string                        // Casdoor 用户名
  source: 'field' | 'literal' | 'scope_holders'
}

export type ResolveResult = {
  recipients: ResolvedRecipient[]
  /** 非空 = 该规则当前发不出去；值是可机检的原因码 */
  blocked: null | 'no_recipient' | 'no_channel' | 'template_missing'
  /** 每个通道的可解析情况（通道停用/地址解析不到） */
  channels: Array<{ id: string; provider: string; enabled: boolean }>
}

export async function resolveDeliverability(
  input: ResolveInput,
  deps: {
    getEventDecl(key: string): Promise<NotificationEventDecl | null>
    getPublishedTemplate(org: string, key: string): Promise<{ revision: number } | null>
    getChannel(org: string, id: string): Promise<ChannelRow | null>
    resolveScopeHolders(org: string, key: string, decl: NotificationEventDecl): Promise<string[]>
    resolveAddress(org: string, provider: string, casdoorName: string): Promise<string | null>
  },
): Promise<ResolveResult>
```

**唯一实现纪律**：

- `worker.runOnce` 改为**调用它**，不再自己拼 `names + holders`；
- `GET /rules/:id/resolve` 调用它（sample payload 或真实 payload）；
- MCP `check_rule` 调用它；
- `notify-preflight.mjs` 调用它。

四个消费方吃同一个函数 ⇒ 不会出现「preflight 说能发、实际发不出去」。

### 2.3 sample payload

`domain/template.ts` 已有 `samplePayload(decl)`（按字段类型造值）。
dry-run 时用它，让「配置期」就能算出结果。**局限**：`samplePayload` 给的 `user` 字段是 `'sample'`，
必然解析不到真实用户 ⇒ dry-run 对 `field` 类收件人只能验「字段存在」，
对 `scope_holders` 才是真值（不依赖 payload）。这条要写进响应里（见 §3.2 的 `mode`）。

---

## 3. 运行期：零结果成为状态

### 3.1 `notify.event.status` 扩枚举

```sql
-- 003 之后的迁移（新文件，不动已上线的 002/003）
alter table notify.event drop constraint if exists event_status_check;
alter table notify.event add constraint event_status_check
  check (status in ('new','matched','no_rules','no_recipients','no_channel','invalid'));
```

| 状态 | 含义 | 与旧行为的关系 |
|---|---|---|
| `new` | 待处理 | 不变 |
| `matched` | 至少产生了一条 delivery 或明确的终态投递 | 语义收窄：**必须有 delivery 行或所有目标都落了终态** |
| `no_rules` | 无规则命中 | 不变 |
| **`no_recipients`** | 有规则，但所有规则都解析出 0 人 | **新增**（旧行为是静默 `continue` + 标 `matched`） |
| **`no_channel`** | 有规则、有人，但通道全停用/缺失 | **新增**（同上） |
| `invalid` | 事件声明或模板缺失 | 不变（但见 §4 告警） |

**多规则聚合语义**（重要，避免歧义）：一个事件命中多条规则时，逐条算，
**取最「靠后」的终态**作为事件状态：

```
invalid > no_channel > no_recipients > no_rules > matched
```

即：只要有一条规则真的产出了 delivery，事件就是 `matched`；
全部规则都卡在同一层，才落到那个状态。这样「两条规则，一条通一条不通」不会被误判。

### 3.2 worker 的改动点（伪代码）

```ts
for (const ev of events) {
  const rules = matchRules(...)
  if (rules.length === 0) { markEvent(ev, 'no_rules'); continue }

  const outcomes: ResolveResult['blocked'][] = []
  for (const rule of rules) {
    const r = await resolveDeliverability({ org: ev.org, rule, payload: ev.payload }, deps)
    if (r.blocked) { outcomes.push(r.blocked); continue }
    // …正常投递（不变）
  }
  await deps.markEvent(ev, aggregateStatus(outcomes, producedDeliveries))
}
```

`aggregateStatus` 是**纯函数**，单测可穷举。

---

## 4. 观测面

### 4.1 `notify-health` 新指标

```ts
export type Health = {
  dead: number; stale: number; workers: number
  oldestPendingSeconds: number; failedLastHour: number; channelErrors: number
  eventsNoRecipients: number   // 新增：最近 1 小时
  eventsNoChannel: number      // 新增
  eventsInvalid: number        // 新增
}
```

判红规则（`healthVerdict`）：

| 条件 | 判定 |
|---|---|
| `eventsNoRecipients > 0` | **红**（配了规则却发不出去 = 配置错误，必须吵） |
| `eventsNoChannel > 0` | **红** |
| `eventsInvalid > 5` | 红（阈值，因为模板轮换期可能短暂出现） |

> 为什么 `no_recipients > 0` 直接红而不是给阈值：**它是配置错误，不是流量波动**。
> 唯一例外是「刚配好规则、权限还没授予」的短暂窗口——这个窗口应该由配置期
> preflight 提前暴露（§5），而不是让运行时容忍。

### 4.2 回执语义

`no_recipients` / `no_channel` **不产生 `notify.delivery` 行**（没人可发，没有「投递」这件事）。
审计靠 `notify.event` 的状态 + 时间 + 事件 key。这与「回执 = 投递事实」的既有语义一致。

---

## 5. 配置期：preflight

### 5.1 HTTP 端点

```
GET /api/modules/notify/rules/:id/resolve?mode=sample|payload   （scope: notify:view）

200 {
  ruleId, eventKey, scope,
  mode: 'sample' | 'payload',
  recipients: [{ name, source }],
  blocked: null | 'no_recipient' | 'no_channel' | 'template_missing',
  channels: [{ id, provider, enabled, addressResolvable: true|false|null }],
  warnings: string[]      // 如 "mode=sample 时 user_list 字段无法解析真实用户"
}
```

- `mode=sample`（缺省）：用 `samplePayload(decl)`，能验 `scope_holders` / `literal`；
- `mode=payload`：body 传真实 payload（POST 变体），能验 `field` 类；
- **只读**：不写任何表、不外发。

### 5.2 console 规则列表

规则行增加一列 **「可解析」**：`1 人` / `0 人（点此查看原因）`。
数据来自批量端点 `GET /rules/deliverability`（一次算全部规则，避免 N+1）。

### 5.3 MCP 工具

```ts
t('check_rule', '只读：给定规则（或事件+收件人）跑一次投递可行性，回答「会发给谁 / 为什么发不出去」。',
  { id: { type: 'string' }, mode: { type: 'string' } }, ['id'], false, null)
```

- 只读（`readOnlyHint: true`），无副作用；
- 让 agent **建完规则立刻自证**，不必等真实事件；
- 工具总数 12 → 13（`NOTIFY_MAX_TOOLS` 同步；`check-mcp-toolface.mjs` 常量跟随）。

### 5.4 定期体检 job

`scripts/notify-preflight.mjs`：

```
遍历全部租户 org 的全部 enabled 规则
  → resolveDeliverability(mode=sample)
  → 输出「blocked != null」的清单（ruleId / event / 原因）
退出码：0 全部可送达；1 存在阻塞规则；2 查不成账
```

- **只有声明了 `scope_holders` 或 `literal` 的规则才纳入**（`field` 类必须真实 payload，sample 无意义）；
- 建议每日一次，接 openship job（同 `notify-jobs.md` 范式）。

---

## 6. 数据模型改动汇总

只有一处迁移，且是**加枚举值**（不新增表、不改列）：

`modules/notify/migrations/005_notify_event_status.sql`

```sql
-- 幂等（约束名已实测：生产 pg_constraint 为 event_status_check，非 notify_event_status_check）
alter table notify.event drop constraint if exists event_status_check;
alter table notify.event add constraint event_status_check
  check (status in ('new','matched','no_rules','no_recipients','no_channel','invalid'));
```

> ✅ **已实测（2026-10-28 生产库 `pg_constraint`）**：`notify.event` 只有两个约束
> —— `event_pkey` 与 **`event_status_check`**，后者定义为
> `CHECK (status = ANY (ARRAY['new','matched','no_rules','invalid']))`。
> 照抄 `notify_event_status_check` 会静默 no-op（`drop constraint if exists` 不报错，
> 随后 `add` 撞旧约束 ⇒ 迁移失败）。**这是本文档最容易踩的坑。**

---

## 7. 与既有不变量的关系

| 不变量 | 影响 |
|---|---|
| fail-open（通知失败不阻塞业务） | **不变**。状态是「事后记账」，emit 仍恒 202 |
| 声明即授权 | 不变（收件人解析不涉及权限授予） |
| org 只来自 identity | 不变；preflight 端点的 org 仍取自 identity |
| 不做兜底收件人 | **明确保留**：兜底会掩盖本节要暴露的问题，自相矛盾 |
| B1 模块边界 | 解析器仍在模块内；Casdoor 持有者查询仍由宿主注入 |

---

## 8. 验收

### 8.1 单测

1. `aggregateStatus` 穷举（多规则 × 各终态组合）；
2. `resolveDeliverability` 四类 `blocked` 各一例 + 正常一例；
3. **同一函数**：worker 与端点对同一输入返回相同结果（用同一 fake deps 断言）。

### 8.2 负对照（必须全部有）

| # | 场景 | 期望 |
|---|---|---|
| 1 | `scope_holders` 无人持有 | event=`no_recipients`；health 红 |
| 2 | 通道全部停用 | event=`no_channel`；health 红 |
| 3 | 模板被归档 | event=`invalid`；health 红（超阈值） |
| 4 | 两条规则一好一坏 | event=`matched`（有 delivery 即算通） |
| 5 | 契约面 | preflight 结果与真实投递一致（不得「说能发却发不出」） |

### 8.3 真机验收（生产）

1. 复现本次事故：临时把 `aftersales:manage` 的 literal 兜底规则停用 →
   真实审批事件 → `event.status='no_recipients'` → `notify-health` **红**；
2. 恢复兜底 → 再来一条 → `matched` + 双通道 `sent` → health 绿。

---

## 9. 分期

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| **D1** | `resolveDeliverability` 抽取 + worker 改调用 + `aggregateStatus` | 单测全绿；行为与现状逐字等价（日志对比） |
| **D2** | 迁移 005 + 三种新状态 + health 新指标与判红 | 负对照 1/2/3/4 通过 |
| **D3** | `GET /rules/:id/resolve` + 批量 deliverability + console 列 | 真机：0 人规则在 UI 可见 |
| **D4** | MCP `check_rule` + `notify-preflight.mjs` job | agent 能自证；job 手动触发通过 |

---

## 10. 风险

| 风险 | 缓解 |
|---|---|
| 状态语义变更让既有看板/查询失配 | ✅ **已实测（2026-10-28 `grep`）**：`matched` 在全仓只有**一个生产者**（`modules/notify/worker.ts:170` 的 `markEvent`），**零消费方**（无测试/脚本/UI 按它断言）⇒ 语义收窄安全。落地时仍要跑一次 grep 复核 |
| preflight 与真实投递漂移 | **单一函数**是硬约束，D1 就有「同一函数」单测 |
| `no_recipients` 判红造成告警疲劳 | 它是配置错误，理应吵；配置期 preflight（D3）把它提前到部署前 |
| 迁移的约束名猜错 | 落地前查 `pg_constraint`，不照抄文档 |

## 11. 待实测（不得据以声称可用）

- `samplePayload` 对 `field` 类收件人的 dry-run 价值边界（目前只能验「字段存在」）；
- preflight 全量规则耗时（规则数 × Casdoor 查询；`scope_holders` 有 60s 缓存）；
- ~~生产是否已有按 `status='matched'` 的消费方~~ → ✅ 已查：零消费方（见 §10）。
