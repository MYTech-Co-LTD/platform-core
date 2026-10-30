# 租户级通知基础设施（设计）

> 2026-10-27 brainstorming 定稿。**状态：设计稿，待评审后转实施计划**（writing-plans）。
> 上游正典：`docs/architecture.md` §2.4（指派与催办）、§2.6（通知规则层）。
> 本稿**重开** §2.6 的「不自研投递」取舍——理由不是口味变了，而是目标范围从「只补绑定层」
> 变成了「模板 + 通道 + 预览 + 发布 + 收件箱 + agent 配置」，原取舍的前提不成立。
> 竖切对象：**aftersales 员工审批**（真实业务、本仓内、今天完全无通知）。

---

## 0. 结论与范围

| 项 | 决定 |
|---|---|
| 投递底座 | **平台自持**：`notify.event` → outbox → `notify-worker` → provider；**Novu 退出关键路径** |
| 企微通道 | 保留公司 **bridge**（`push.hookflow.cn`），平台直发 `POST /wecom/:tenant?t=&to=` |
| 接入面 | 模块在 **manifest 声明事件目录**；宿主装载期登记，注入 `ctx.notify.emit(identity, event)` |
| 事件目录 | manifest 是唯一事实源；**内存注册表 + `platform.event_catalog` 快照** |
| 规则 | 五元组：`事件 × 作用域 × 收件人 × 模板 × 通道`，可选节流；**不做条件/延迟/摘要** |
| 作用域 | 现有 `mount` 泛化为 `scope`：事件声明一个 payload 字段作为实例键，规则可精确匹配或 `*` |
| 收件人 | 事件声明收件人种类（payload 字段 / scope 持有者 / 字面名单），**平台解析 + 渠道地址解析** |
| 文案 | **DB 草稿 + 租户管理员审批发布**；平台内置事件文案由 repo seed 导入 |
| 通道 | **内置 provider**（`wecom_chat` / `in_app` / `webhook`）+ 租户配置；**不做运行时插件/外部沙箱** |
| in-app | 自建 `notify.inbox` + console 收件箱；v1 轮询，不做实时 WS |
| 默认通知 | 事件声明可带 `defaults`，装载/开通时**幂等派生**默认规则（零配置就通） |
| 明确不做 | 邮件 / 短信 / digest / 条件规则 / 多级路由 / 偏好中心 / 外部插件沙箱 / 消息队列 |

### 反转条件（出现任一条 ⇒ 停，不硬做）

- bridge 直发无法稳定送达，或 `to=` 的收件人映射无法确定；
- scope 持有者（如 `aftersales:manage`）无法从 Casdoor 稳定枚举；
- N=500 名单的发送耗时 / 企微限流不可控；
- 竖切五条负对照任一失败。

---

## 1. 为什么重开「不自研投递」

### 1.1 原取舍的前提

§2.6 定「Novu 留任投递」的理由是：**本层只需要补绑定层**，投递/模板/收件箱都已有归属，
自研投递 = 重造更差的 Novu。这个判断在当时的范围里成立。

### 1.2 现在的事实（2026-10-27 代码实测）

| 事实 | 依据 |
|---|---|
| Novu 投递从未被真机证实 | §2.6 自己标注 PoC「待实测，不得据以声称可用」 |
| in-app 从未落地 | workflow 只播 `chat` step（`modules/notify/novu/seed.ts:65`）；无 feed 代理；console 收件箱标 follow-up |
| 投递状态不可信 | #948：bridge 返回 502，Novu 记 `completed/sent` |
| 模板发布链受限 | 生产建 workflow 一律 401；`sync-to-prod` 脚本写死 `woke` 组织 |
| 模板漂移无收敛 | `seed` 是 create-if-absent（issue #44 同型） |
| 租户配置只能走 API | Novu CE 无组织管理 UI |
| `to=` 映射缺失 | 参考实现 `ticket-dispatch/push.mjs:20-24` 明确：subscriber 可能是系统 UUID，必须反查企微 userid；本仓 `novu.ts` 直接把 Casdoor id 当 `to` |

### 1.3 结论

Novu 在今天实际只剩两项净收益：**worker 重试**与**现成 in-app 组件**。为此保留一个系统，
换来的是双事实源、401 发布链、不可信的送达状态、受限的通道扩展与租户配置面。
既然目标已经变成「租户级基础设施」，**用一个窄的、可审计的投递核心替代它**，比继续
在 Novu CE 的约束里做补丁更划算。

**注意**：这不是说 Novu 在公司范围内退役——其他项目仍在用；只是 platform-core 不再依赖它。

---

## 2. 架构总览

```
模块 A/B/C ── ctx.notify.emit(identity, event) ──┐
（manifest 声明事件）                              │
                                                  ▼
宿主（apps/server + @platform/sdk）
  ├─ 事件目录：内存注册表 + platform.event_catalog 快照
  ├─ 契约校验：事件 key / payload / scope / 收件人 / org
  └─ 注入：ctx.notify（emit）、ctx.events（只读目录）、ctx.addresses（地址解析）
                                                  │
                                                  ▼
modules/notify（租户级通知实现）
  ├─ 规则（五元组）/ 派生 / 收件人解析 / 节流
  ├─ 模板（草稿 / 版本 / 预览 / 发布）
  ├─ 通道配置（provider 实例 / 健康 / 密钥引用）
  └─ 写入 notify.event（outbox，不直接发送）
                                                  │
                                                  ▼
scripts/notify-worker.mjs（独立进程）
  ├─ 匹配事件 → 生成 delivery（含冻结的渲染结果）
  ├─ 领取到期 delivery → provider.send
  └─ 重试 / 退避 / 限流 / 死信 / 回执
                                                  │
                    ┌──────────────┬──────────────┴──────────────┐
                    ▼              ▼                             ▼
              wecom_chat       in_app                        webhook
          （bridge 直发）   （notify.inbox）              （平台直发 + HMAC）
```

**职责边界**：

| 层 | 负责 | 不负责 |
|---|---|---|
| 宿主 / SDK | 事件协议、装载期登记、契约校验、port 注入 | 规则、模板、投递 |
| notify 模块 | 规则、模板、通道配置、收件人解析、outbox 写入、UI、MCP | 发消息（交给 worker） |
| notify-worker | 匹配、渲染、发送、重试、限流、回执 | 业务规则解释 |
| provider | 单一通道的发送与错误映射 | 路由、节流、模板 |
| bridge | 企微 corp 凭据与 token、`touser` 发送 | 业务文案 |

---

## 3. 接入协议：manifest 声明 + 宿主注入

### 3.1 事件声明（manifest）

`packages/platform-sdk/src/manifest.ts` 现有 `notifications: { dir }` **无任何运行时消费方**
（2026-10-27 实测）。本设计把它替换为 `notifications.events`（协议变更，需同步
`docs/module-protocol.md` 与 `scripts/check-manifests.mjs`）。

```yaml
notifications:
  events:
    - key: aftersales.employee_approval.pending   # <module>.<entity>.<event>
      title: 员工登记待审批
      description: 访客提交员工登记/变更后，通知本租户售后管理员
      scope: { key: approvalId, label: 审批单 }    # 可选；值是 payload 字段名
      payload:
        approvalId:    { type: string, required: true, label: 审批单号 }
        approveType:   { type: string, required: true, label: 类型 }
        applicantName: { type: string, label: 申请人 }
        link:          { type: url, required: true, label: 详情链接 }
      recipients:
        approvers:        { kind: scope_holders, scope: aftersales:manage, label: 售后管理员 }
        # 兜底：scope 持有者无法枚举时的租户配置名单（仅 manual 规则可用）
        approvers_manual: { kind: literal, label: 手动指定审批人 }
      defaults:                                    # 可选：零配置默认规则
        recipient: approvers
        template: aftersales_employee_approval_pending
        channels: [wecom_default, inapp_default]
```

**字段约束（v1，fail-closed）**：

| 项 | 规则 |
|---|---|
| `key` | 小写蛇形 + 点号，**至少三段**，前缀必须 = `manifest.id`；全局唯一；发布后不复用 |
| `payload` | 最多 20 个字段；类型 ∈ `string / number / boolean / date / url / user / user_list`；**不支持嵌套对象**；总大小 ≤ 16KB |
| `scope.key` | 必须是 payload 中已声明的 `string` 字段；缺省 = 事件无实例级作用域 |
| `recipients` | `kind ∈ field / scope_holders / literal / dept`；`field` 必须指向 payload 的 `user`/`user_list` 字段；`scope_holders` 的 `scope` 必须是已供给的权限码；`literal` 只能由人工规则填充；`dept`（2026-10-30 增补，见 `2026-10-30-org-as-platform-primitive-design.md` §3.5）只能由人工规则填充部门 `ext_id`，发送时展开子树 |
| `defaults` | 可选；`recipient` 必须已在 `recipients` 声明；`template` 必须是内置模板；`channels` 必须是内置通道 id |

**事件 key 的语义版本**：`payload` 只增不改；改字段语义 = 新 key（如 `.v2`），旧 key 标 `active=false`
但保留历史规则与回执。禁止复用已下线的 key。

### 3.2 事件目录

- **内存注册表**：loader 从全部 manifest 构建，进程内只读。
- **DB 快照**：`platform.event_catalog`（平台 schema，host 独占写）：

| 列 | 说明 |
|---|---|
| `key` (PK) | 事件 key |
| `module_id` | 生产者模块 id；外部生产者为 `external:<name>` |
| `title` / `description` | 展示 |
| `scope_key` | 作用域字段名（可空） |
| `payload_schema` jsonb | 字段声明 |
| `recipients` jsonb | 收件人声明 |
| `defaults` jsonb | 默认规则声明 |
| `source` | `module` ｜ `external` |
| `active` | 下线标记（不删行） |
| `updated_at` | 快照时间 |

- 装载期**全量 upsert + 缺失标 inactive**：只对**本次已加载模块**的 `module_id` 做 inactive 标记
  （未加载的模块/外部生产者一律不动，避免部分部署把别人的事件误下线）；多实例并发写同一行以
  `updated_at` 新者为准。
- 快照的用途：UI / agent 查询、规则创建校验、外部生产者登记；**运行时派发不依赖快照**。
- **外部生产者**（如 case-engine）：由管理员 API 或 seed 脚本登记 `source=external` 的事件
  （scope `platform:admin`），payload schema 与收件人声明形状与 manifest 完全一致；v1 不作为
  竖切前置，P3 再接。

### 3.3 宿主注入与装载顺序

`ModuleContext` 新增三个只读依赖（`packages/platform-sdk/src/module.ts`）：

```ts
export interface ModuleContext {
  pool: Pool
  identityLinks?: IdentityLinks
  /** 宿主按 manifest 构建的只读事件目录（仅 notify / 管理面使用） */
  events?: EventCatalogReader
  /** 任意模块可用：发事件（异步入 outbox，fail-open） */
  notify?: NotifyPort
  /** 渠道地址解析（Casdoor 用户 → 企微 userid 等） */
  addresses?: ChannelAddressResolver
}

export interface NotifyPort {
  emit(identity: Identity, input: {
    eventKey: string
    eventId: string          // 确定性：业务转移一次一枚
    scope?: string           // 缺省 = '*'
    payload: Record<string, unknown>
  }): Promise<{ accepted: boolean; reason?: string }>
}

/** 宿主按 manifest / 快照构建的只读目录；模块不直接查 platform schema。 */
export interface EventCatalogReader {
  get(key: string): EventDecl | undefined
  list(filter?: { moduleId?: string; active?: boolean }): EventDecl[]
}

/** 渠道地址解析（与 worker 共用同一实现）：Casdoor 用户 → 通道地址。 */
export interface ChannelAddressResolver {
  resolve(input: { org: string; provider: string; casdoorName: string }): Promise<string | null>
}
```

**装载器改为三阶段**（`apps/server/src/loader.ts`）：

1. 扫描 manifest → 校验 → 跑迁移 → 动态 import → 收集 `def`（**不调 createRouter**）；
2. 构建事件目录 → upsert `platform.event_catalog` → 调各模块 `createPorts(ctx)`；
3. 用完整 `ModuleContext`（含 `events` / `notify` / `addresses`）调 `createRouter`。

`notify` 模块通过 `createPorts` 暴露 `enqueueEvent(input)`；宿主包装它：
校验事件与 payload → 从 `identity.orgId` 取 org → 写 `notify.event`。**其它模块不直接拿到
notify 的 port**，只拿宿主包装后的 `ctx.notify`——校验面只有一处。

### 3.4 契约违规的失败语义

| 情形 | 行为 |
|---|---|
| 模块发了未声明的 key / 不是自己的 key | **拒绝入队**，返回 `{accepted:false, reason:'event_not_declared'}`；不抛（不阻塞业务） |
| payload 类型/必填不符 | 拒绝入队，`reason:'payload_invalid'`；日志带字段名 |
| 收件人字段不是 user/user_list | 拒绝入队，`reason:'recipient_invalid'` |
| `eventId` 缺失/空 | 拒绝入队，`reason:'event_id_required'` |
| `identity.orgId` 为空 | 拒绝入队，`reason:'org_required'` |
| 入队成功但后续投递失败 | **不回传给调用方**（异步）；失败由回执与告警体现 |

> 模块侧约定：`ctx.notify.emit` 的返回**不参与业务分支**；测试里断言 `accepted` 与 `reason`。

---

## 4. 规则与收件人

### 4.1 规则模型（`notify.rule`）

| 列 | 说明 |
|---|---|
| `org` / `id` | 租户隔离；`(org,id)` 主键 |
| `enabled` | 启停 |
| `event_key` | 引用事件目录 |
| `scope` | 实例值或 `*` |
| `recipient_key` | 引用事件声明的收件人键 |
| `recipient_literal` | `text[]`，仅 `kind=literal` 的人工规则使用 |
| `template_key` | 引用 `notify.template`；**只引用，不内嵌文案** |
| `channels` | `text[]`，通道实例 id（如 `wecom_default`） |
| `cooldown_minutes` | 可选；**本版必须真正执行**（旧版只是存字段） |
| `origin` | `derived` ｜ `manual` |
| 审计列 | `created_by` / `created_at` |

**校验（创建/修改时，fail-closed）**：

- 事件 key 存在且 `active`；
- `recipient_key` 在该事件的 `recipients` 中；`literal` 只允许 `manual`；
- `scope` 为 `*`，或该事件声明了 `scope_key`（值不校验是否真实存在——实例由生产者负责）；
- 模板存在、`status=published`、且 `event_key` 一致；
- 通道实例存在且 `enabled`；
- `cooldown_minutes >= 0`。

### 4.2 匹配优先级

与现有语义一致并泛化：

1. `enabled ∧ event_key 相等`；
2. **精确 scope 命中时不用 `*`**；无精确命中才回退 `*`；
3. 命中集里若有 `manual`，`derived` 全部让位；
4. 同优先级按 `created_at` 稳定序。

### 4.3 收件人与地址解析

**两段解析，职责分开**：

1. **收件人 → Casdoor 用户**（平台层）
   - `field`：payload 的 `user` / `user_list` 值（Casdoor 用户名）。
   - `scope_holders`：本 org 持有该权限码的用户集合（Casdoor 权限记录）。
   - `literal`：规则上配置的用户列表（仅人工）。
   - 统一校验「属于本 org」；失败**丢弃该收件人**并记 `recipient_not_in_org`，不阻塞整个事件。
2. **Casdoor 用户 → 渠道地址**（provider 层）
   - `in_app`：地址 = Casdoor 用户名（落 `notify.inbox.recipient`）。
   - `wecom_chat`：地址 = 企微 userid。
     - 优先查 `platform.identity_link`（`provider='wecom'`，`casdoor_name=?`，`status='active'`）；
     - 无绑定时，**仅当通道配置 `address_fallback='casdoor_name'`** 才把 Casdoor 名当 userid
       （适用于「Casdoor 名 = 企微 userid」的租户，如 mytech 通讯录同步）；
     - 否则丢弃并记 `missing_wecom_userid`。
   - `webhook`：地址来自通道配置（固定端点）；可选按收件人字段拼参数。

> **这是与当前实现的实质差异**：现在 `ensureChannel` 直接把 Casdoor id 当 `to` 传给 bridge。
> 参考实现已注明这会产生企微 81013；本设计把映射显式化，映射不到就**不假装发成功**。

### 4.4 节流

- 键 = `(org, rule_id, recipient, channel)`；
- 窗口 = `cooldown_minutes`；
- 命中 ⇒ 写 `suppressed` 回执，不发送、不计失败；
- 实现：worker 在生成 delivery 时查最近一次 `sent`。

---

## 5. 模板与发布

### 5.1 数据模型

**`notify.template`**（租户级）

| 列 | 说明 |
|---|---|
| `org` / `key` | 主键；`key` 全局稳定（如 `aftersales_employee_approval_pending`） |
| `name` | 展示名 |
| `event_key` | 该模板服务的事件 |
| `status` | `draft` ｜ `published` ｜ `archived` |
| `origin` | `builtin`（repo seed）｜ `tenant`（租户自建/派生） |
| `published_revision` | 当前线上版本号 |
| 审计列 | `created_by` / `updated_at` |

**`notify.template_revision`**（不可变）

| 列 | 说明 |
|---|---|
| `org` / `key` / `revision` | 主键 |
| `contents` jsonb | 按通道的内容（见下） |
| `body_hash` | 渲染源摘要（审计/漂移检测） |
| `review_status` | `draft` ｜ `approved` ｜ `rejected` |
| 审计列 | `created_by` / `created_at` / `approved_by` / `approved_at` |

`contents` 形状：

```json
{
  "wecom_chat": { "text": "【待审批】员工登记\n申请人：{{applicantName}}\n👉 [去审批]({{link}})" },
  "in_app":     { "title": "员工登记待审批", "body": "{{applicantName}} 提交了{{approveType}}申请", "link": "{{link}}" }
}
```

- 变量 = payload 字段名，**摊平**（不用 `payload.X`）；未知变量 = 渲染错误。
- 只启用规则实际使用的通道时才校验对应内容；发布时校验**所有启用通道**。
- 长度限制：`wecom_chat.text` ≤ 3800 字节（企微 markdown 上限留余量）；`in_app.title` ≤ 64 字；
  `in_app.body` ≤ 500 字。
- `link` 若出现，必须是 `https:` URL 或 payload 的 `url` 字段引用。

### 5.2 预览

`POST /api/modules/notify/templates/:key/preview`

- 输入：`{ revision?, payload }`（sample payload，按事件声明校验）；
- 输出：逐通道渲染结果 + 变量清单 + 校验问题；
- **同一个渲染函数**同时用于预览与投递（单一实现，避免「预览好看、线上渲染不同」）；
- 纯函数、无外发、无副作用；AI 工具面可调用。

### 5.3 发布与回滚

`POST /api/modules/notify/templates/:key/publish`，`scope=notify:publish`。

1. 取指定 revision（缺省 = 最新 `draft` 或 `approved`）；
2. 用事件声明 + 每个启用通道渲染一遍；任一失败 ⇒ 400，不发布；
3. **发布动作即审批**：把该 revision 置 `review_status='approved'`、
   `approved_by=<发布人>`、`approved_at=now()`（`rejected` 只能由显式拒绝动作产生）；
4. 写 `published_revision` + `notify.template_publish` 审计行（谁、何时、哪版、hash）；
5. 回滚 = 发布旧 revision（**不重写历史**）。

**门禁**：AI 工具面**没有发布工具**；发布必须由持 `notify:publish` 的人触发。
默认租户管理员同时持有 `manage + publish`（权限即审批）；如需「四眼」，后续加
`approved_by != created_by` 约束，不在 v1。

### 5.4 内置模板

- repo 新增 `modules/notify/templates/builtin.ts`（从现 `novu/workflows.ts` 迁移并补 in-app 内容）；
- 开通/升级时**幂等 seed**：按 `(key, body_hash)` 创建 `origin=builtin` 的 revision，已存在则跳过；
- 租户要改内置文案 ⇒ **fork 成 `origin=tenant` 草稿**，改完走发布；不改原行。
- 旧 `novu/` 目录与 `WORKFLOW_COPIES` 在迁移完成后删除。

**开通 / 升级 seed（`scripts/notify-seed-builtin.mjs`，幂等）**：遍历 `platform.tenant`，为每个
租户写入——① 内置模板（`origin=builtin`，按 `(key, body_hash)` 去重）；② 默认通道实例
（`wecom_default` / `inapp_default`）；③ 事件声明里的 `defaults` → 确定性 id 的派生规则。
重复执行是 no-op；手工规则优先于派生规则。

---

## 6. 通道 provider

### 6.1 接口（代码级注册表）

```ts
export interface ChannelProvider {
  key: 'wecom_chat' | 'in_app' | 'webhook'
  /** 配置非敏感字段的校验（创建/启用通道时） */
  validateConfig(config: unknown): { ok: true } | { ok: false; reason: string }
  /** Casdoor 用户 → 该通道地址；解析不到返回 null（不假装成功） */
  resolveAddress(input: AddressInput): Promise<string | null>
  /** 发送；结果决定重试/死信 */
  send(input: SendInput): Promise<SendResult>
  /** 健康检查（配置/凭据是否可用） */
  health(config: ChannelRuntimeConfig): Promise<Health>
}

type SendResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

type AddressInput = { org: string; casdoorName: string; config: Record<string, unknown> }
type SendInput = { org: string; recipient: string; address: string; rendered: Rendered; config: Record<string, unknown> }
type ChannelRuntimeConfig = { provider: string; config: Record<string, unknown>; secrets: Record<string, string> }
type Health = { ok: boolean; detail?: string }
```

### 6.2 内置 provider

| provider | 发送 | 地址 | 错误映射 |
|---|---|---|---|
| `wecom_chat` | `POST {bridge}?t=..&to=<企微 userid>`，body `{content}` | 见 §4.3 | 204 = ok；401/400 = permanent；429/45009/5xx/网络 = retryable；其它企微 errcode 按表 |
| `in_app` | 写 `notify.inbox` 行 | Casdoor 用户名 | 无外部调用；DB 错误 = retryable |
| `webhook` | `POST <url>`，JSON + HMAC | 通道配置 | 2xx = ok；4xx（除 408/429）= permanent；5xx/网络 = retryable |

`webhook` 出站安全（v1 硬约束）：

- 只允许 `https:`；
- 解析目标 IP，拒绝私网/回环/链路本地/元数据地址（SSRF）；
- 不跟随重定向（`redirect: 'manual'`，3xx = permanent）；
- 超时 5s；body ≤ 32KB；
- 请求头 `X-Notify-Signature: sha256=<hmac(timestamp + body)>`，`X-Notify-Timestamp`。

### 6.3 租户通道配置与密钥

**`notify.channel`**（租户级）：

| 列 | 说明 |
|---|---|
| `org` / `id` | 主键；`id` 如 `wecom_default` / `inapp_default` / `webhook_ops` |
| `provider` | 三选一 |
| `enabled` | 启停 |
| `config` jsonb | **非敏感**配置（如 `address_fallback`、`rate_limit_per_min`、超时） |
| `secret_refs` jsonb | **逻辑键 → env 变量名**，例如 `{ "bridge_url": "WECOM_BRIDGE_URL__MYTECH" }` |
| `health` / `health_at` | 最近健康检查 |

**密钥纪律**：DB **只存 env 变量名，不存值**；值只出现在 openship 项目 env（isSecret）、
GitHub Secrets 或服务器 600 文件。UI 只显示「已配置 / 未配置 + 键名」，从不回显值。

**v1 的租户自服务边界（写死）**：通道凭据由**平台运维在 env 层**预备；租户只能
启用/停用已有实例、改非敏感配置、做健康检查。**不提供「租户在 UI 里新建密钥」**——
那会引入新的密钥存储面，与安全基线冲突。新增一个 webhook 目标 = 运维先落 env 键，
租户再在 UI 里启用。这条边界是「内置 provider + 租户配置」的准确含义。

密钥键命名：

- 企微：`WECOM_BRIDGE_URL__<ORG>`（新键；旧 `NOVU_CHAT_WEBHOOK_URL__<ORG>` 迁移后退役）；
- webhook：`NOTIFY_WEBHOOK_URL__<ORG>__<CHANNEL_ID>`、`NOTIFY_WEBHOOK_KEY__<ORG>__<CHANNEL_ID>`。

### 6.4 限流与健康

- `config.rate_limit_per_min`：默认企微 60/min/通道；
- v1 单 worker ⇒ 进程内令牌桶；多 worker 时改 DB 计数（登记为待实测）；
- 企微 45009 ⇒ 该通道进入 60s 惩罚窗，后续 delivery 顺延；
- 健康检查：`GET {bridge}/healthz`（企微）、webhook 用「签名 + 空 body」探测、
  in-app 恒 ok；结果写 `health` / `health_at`，UI 可见。

---

## 7. 投递：event → outbox → worker

### 7.1 表

**`notify.event`**（入队）

| 列 | 说明 |
|---|---|
| `org` / `event_id` | 主键；`(org,event_id)` 幂等 |
| `event_key` / `scope` / `payload` jsonb | 事件本体 |
| `producer` | 模块 id 或 `external:<name>` |
| `status` | `new` ｜ `matched` ｜ `no_rules` ｜ `invalid`（`invalid` = 入队后事件被下线/规则引用的模板失效，处理期置位；**emit 时被拒的不会入队**） |
| `processed_at` / `created_at` | |

**`notify.delivery`**（待发/已发）

| 列 | 说明 |
|---|---|
| `org` / `event_id` / `rule_id` / `recipient` / `channel` | **联合唯一**（修复旧版「多收件人被主键吞掉」的缺陷） |
| `template_key` / `revision` / `rendered` jsonb | 匹配时**冻结**渲染结果 |
| `status` | `pending` ｜ `sent` ｜ `failed` ｜ `dead` ｜ `suppressed` |
| `attempts` / `next_attempt_at` / `locked_until` / `last_error` | 重试与租约 |
| `is_test` | 测试发送标记（不进入业务统计） |
| `created_at` / `updated_at` | |

**`notify.delivery_attempt`**（审计）

- `id` / `org` / `delivery_id` / `attempt_no` / `provider` / `status` / `http_status` /
  `error_code` / `error_summary` / `duration_ms` / `created_at`；
- 只存错误摘要，**不存渲染正文**（正文在 `delivery.rendered`，按权限可见）。

### 7.2 状态机

```
event:   new ──匹配──> matched / no_rules
delivery: pending ──send ok──> sent
             │
             ├─ retryable ──> failed ──(到点)──> pending
             ├─ permanent ──> dead
             ├─ 超过最大次数 ──> dead
             └─ 节流命中 ──> suppressed
```

- 最大尝试次数：5（第 1 次首发 + 4 次重试）；退避：30s / 2m / 10m / 30m（±20% 抖动）；
  第 5 次仍失败 ⇒ `dead`；permanent 错误立即 `dead`，不占重试次数；
- `rendered` 在生成 delivery 时冻结：事件被规则接受时的模板版本就是收件人看到的版本；
- 投递失败**不回传业务**（fail-open）；`dead` 与积压由健康 job 报警。

### 7.3 幂等与投递语义

- **至少一次**：provider 成功但响应丢失时，会重发；企微无幂等键，接受极少数重复；
- `event_id` 由生产者确定性生成（业务转移一次一枚）⇒ 重复 emit 不重复入队；
- 联合唯一键 ⇒ 同一事件 × 规则 × 收件人 × 通道只发一次；
- 崩溃窗口：`locked_until` 租约 60s，worker 重启/多实例时回收超时租约。

### 7.4 worker 部署

- `scripts/notify-worker.mjs`（仓内脚本，`scripts/` 不在 B1 扫描根，可直接 import
  `modules/notify/**` 与 `apps/server/src/identity-links.ts`）；地址解析用
  `createIdentityLinks(pool)` 的**只读实例**（不传 Casdoor 客户端；只读方法不依赖它），
  避免 worker 启动期强依赖 Casdoor；
- `deploy/docker-compose.yml` 新增 `notify-worker` 服务：**同一镜像、不同 command、无端口**；
- 轮询间隔 2s；`FOR UPDATE SKIP LOCKED` 领取；单实例可跑多副本；
- 进程退出前释放租约（graceful）；崩溃 ⇒ 租约到期自动回收。

---

## 8. in-app 收件箱

**`notify.inbox`**：

| 列 | 说明 |
|---|---|
| `org` / `id` | 主键 |
| `recipient` | Casdoor 用户名 |
| `event_id` / `event_key` | 来源 |
| `template_key` / `revision` | 版本 |
| `title` / `body` / `link` | 渲染结果 |
| `read_at` / `created_at` | |

- 唯一键 `(org, event_id, recipient)`：同一事件对同一人只入一条；
- API：`GET /inbox?unread=1`、`POST /inbox/:id/read`、`POST /inbox/read-all`；
- 身份：`recipient = identity.userId`，org 来自 identity；**不接受查询参数指定他人**；
- console 顶栏铃铛 + 收件箱页；v1 轮询（30s），不做 WS；
- 保留 90 天（`scripts/notify-retention.mjs` 或 worker 内置清理）；
- **两态分离不回退**：待办仍查权威源，收件箱只是通知副本；已读 ≠ 已办。

---

## 9. UI（console `/console/notify`）

| 区域 | 内容 | 权限 |
|---|---|---|
| 事件目录 | 全部事件（来源模块 / payload / 收件人 / scope / 默认规则）、被哪些规则引用 | `notify:view` |
| 规则 | 列表、创建/编辑、启停、删除、来源标记（derived/manual）；表单限五元组，**无表达式编辑器** | `notify:manage` |
| 模板 | 列表、草稿编辑（按通道）、**用 sample payload 实时预览**、版本历史、发布/回滚 | 编辑 `manage`；发布 `publish` |
| 通道 | provider 实例、启停、非敏感配置、密钥「已配置/未配置」、健康检查、测试发送 | `notify:channel` |
| 投递 | 回执列表（状态/尝试/错误码/耗时）、按事件/收件人/通道筛选、手动重试（单条） | `notify:view` / 重试 `manage` |
| 收件箱 | 我的通知、未读、跳转、全部已读 | 登录用户 |

- 预览必须与投递共用同一渲染函数；
- 「测试发送」默认**只发给自己**（当前登录人），限 5 次/分钟，回执标 `test=true`；
- 规则编辑器只提供事件声明的收件人/作用域/模板/通道下拉，**不提供自由表达式**（守住五元组）。

---

## 10. Agent 工具面（MCP）

沿用 `POST /api/modules/notify/mcp-manage`，工具清单：

| 工具 | 作用 | 权限 | 约束 |
|---|---|---|---|
| `list_events` / `get_event` | 发现事件、payload、收件人、默认规则 | `notify:view` | 只读 |
| `list_rules` | 列规则 | `notify:view` | 只读 |
| `propose_rule` | 建规则 | `notify:manage` | 校验事件/收件人/模板/通道；即时生效 |
| `update_rule` / `set_rule_enabled` | 改/停规则 | `notify:manage` | 同上 |
| `list_templates` / `get_template` | 看模板与版本 | `notify:view` | 只读 |
| `draft_template` | 建/改草稿 revision | `notify:manage` | **只写 draft，不发布** |
| `preview_template` | 用 sample payload 渲染 | `notify:manage` | 纯函数，无外发 |
| `list_deliveries` / `get_delivery` | 看回执与错误 | `notify:view` | 只读 |
| `send_test` | 给自己试发 | `notify:manage` | **收件人只能是调用者本人**；限流 |

**硬边界**：

- **没有发布工具**；`publish` 只能由人触发（`notify:publish`）；
- **没有通道/密钥工具**；`notify:channel` 只给人；
- 所有写工具走审计（who / org / 参数摘要 / 结果），与既有 `/mcp-manage` 同口径；
- 工具数量变更需同步 `scripts/check-mcp-toolface.mjs` 的常量。

---

## 11. 权限与租户隔离

| 权限码 | 能力 | 默认授予 |
|---|---|---|
| `notify:view` | 看事件/规则/模板/投递/收件箱 | 租户管理员 + 只读角色 |
| `notify:manage` | 规则 CRUD、草稿、预览、测试发送、单条重试 | 租户管理员 |
| `notify:publish` | 发布/回滚模板 | 租户管理员 |
| `notify:channel` | 通道配置/启停/健康检查 | 租户管理员 |
| `notify:emit` | 外部生产者写事件 | **仅服务/ PAT**，不授予人 |

- 所有业务表 `org text not null` 首列，主键以 org 起头，进租户隔离扫描面；
- 身份主体**只来自 `identity.orgId`**，绝不读请求参数；
- 事件目录是平台级（无 org），规则/模板/通道/投递/收件箱全部 org-scoped；
- 收件人解析只在本 org 内查；跨租户引用 fail-closed；
- 密钥只存 env 键名，不存值；日志不写渲染正文与密钥。

---

## 12. 可观测与告警

- **回执**：`delivery` + `delivery_attempt` 是唯一事实源；UI 可按状态/错误码/通道筛。
- **健康 job**：`scripts/notify-health.mjs`，退出码：
  - `0` 干净；
  - `1` 有 `dead`、或最老 `pending` 超过 10 分钟、或 worker 心跳超过 2 分钟；
  - `2` 查不成账（DB/配置错误）。
- openship job 订阅失败通知（照 `deploy/notify-reconcile-job.md` 口径）；
- worker 每分钟输出一行 JSON 心跳（`processed_events / sent / failed / dead / backlog`）；
- OO 流与告警规则作为 P3（本版先保证 job 红 + 回执可查，不新增观测面）。

---

## 13. 竖切验收：aftersales 员工审批

### 13.1 事件与收件人

- 触发点：`POST /api/modules/aftersales/guest/employee-approvals` 成功插入
  `aftersales.employee_approval(status='pending')` 之后；
- 事件：`aftersales.employee_approval.pending`；
- 收件人：默认 `approvers`（`scope_holders`，`aftersales:manage`）——**待实测**能否从 Casdoor 枚举；
  不可枚举则人工规则改用事件已声明的 `approvers_manual`（`literal` 名单，租户管理员配置）；
- payload：`approvalId` / `approveType` / `applicantName` / `link`；
- 申请人（访客 openid）**不在本期收件人内**；申请人侧仍走 guest 页面，不做企微通知。

> ⚠️ `aftersales.employee_approval` 表当前**没有 approver 字段**（只有 `open_id` / `status` /
> `decided_*`）。因此「通知审批人」必须靠 scope 持有者或租户配置名单，不能从业务表直接取。

### 13.2 验收链（全部通过才算交付）

1. 访客提交员工登记 → `notify.event` 出现一行（`event_key` / `scope` / payload 正确）；
2. 事件目录 UI/agent 能看到该事件与 payload schema；
3. 默认规则被派生（或人工规则生效），匹配到 `approvers`；
4. 模板草稿在 UI 用 sample payload 预览通过；
5. 租户管理员发布模板；
6. 审批人**企微真机收到**；回执 `sent`；
7. 审批人不在企微绑定内 ⇒ 回执 `failed / missing_wecom_userid`，**不假装成功**。

### 13.3 五条负对照

| # | 场景 | 期望 |
|---|---|---|
| 1 | 规则停用 / 删除 | 事件入队，`no_rules`；零投递 |
| 2 | bridge 返回 502 | 回执 `failed` + 错误码；业务提交照常成功（fail-open） |
| 3 | 收件人不在本 org | 丢弃该收件人 + `recipient_not_in_org`；不影响其他收件人 |
| 4 | 同一事件重复 emit | `notify.event` 唯一键去重；不双发 |
| 5 | manual 覆盖 derived | 精确 scope 的 manual 规则生效，derived 不生效 |

---

## 14. 分期

| 阶段 | 内容 | 交付判据 |
|---|---|---|
| **P0 协议** | manifest 事件声明 + 目录快照 + 三阶段装载 + `ctx.notify` | 两个模块各声明一个事件；装载期校验/快照可查；单测 |
| **P1 竖切** | event/outbox + worker + wecom/in_app provider + 规则 + 模板（内置）+ 回执 | §13 全链 + 五负对照 |
| **P2 产品面** | 模板草稿/预览/发布、通道配置、UI 五区、agent 工具面 | 租户管理员可自助配置；agent 可发现/建规则/提草稿/预览/试发 |
| **P3 收口** | webhook provider、限流/健康、健康 job、Novu 代码/env/文档退役、`notify-reconcile` 迁移 | 全仓无 Novu 引用；forms 对账走新 worker；#948 由构造消除 |

---

## 15. 待实测 / 开放问题（不得据以声称可用）

1. **bridge `to=` 语义**：确认 `to` 是企微 userid；确认 Casdoor 用户 → 企微 userid 的映射
   （`platform.identity_link` 覆盖情况；mytech 通讯录同步户名 = userid）。
2. **Casdoor scope 持有者枚举**：能否按 `(org, scope)` 列出用户；性能与缓存策略。
3. **企微限流**：单租户 N=500 名单的发送节奏；45009 的惩罚与恢复。
4. **多 worker**：v1 单 worker；多副本时令牌桶/租约的正确性。
5. **webhook 出站**：SSRF 防护的实际网络环境（是否有内网目标误伤）。
6. **模板渲染边界**：企微 markdown 长度与特殊字符；in-app 链接白名单。

---

## 16. 迁移与收口

- **旧 `notify.rule` / `notify.delivery`**：pre-production，不保证向后兼容；新增迁移
  `002_notify_v2.sql` 建新表并迁移可识别的开发数据，旧列退役。
- **Novu 资产**：`modules/notify/domain/novu.ts`、`novu/`、`WORKFLOW_COPIES`、
  `NOVU_*` env、`notify-reconcile.mjs` 的 novu resolver、`deploy/notify-reconcile-job.md`
  的 Novu 段全部退役；`WECOM_BRIDGE_URL__<ORG>` 取而代之。
- **forms 对账**：`scripts/notify-reconcile.mjs` 改为写 `notify.event`（或直接走
  `emit` 的入队函数），不再依赖 Novu resolver；`form.assigned` / `form.due_reminder`
  的确定性 event_id 保持不变。
- **文档**：`docs/architecture.md` §2.6 重写为「通知基础设施（绑定 + 模板 + 通道 + 投递）」；
  `docs/module-protocol.md` 补事件声明；`AGENTS.md` 更新入口指针。
- **不动的**：bridge、企微 corp 凭据、`platform.identity_link`、Casdoor 权限体系。

---

## 17. 风险与反转

| 风险 | 影响 | 缓解 |
|---|---|---|
| 自建投递的可靠性不如预期 | 丢通知 / 重复通知 | outbox + 租约 + 回执 + 健康 job；竖切先跑 |
| 收件人映射缺失 | 企微 81013 / 静默失败 | 显式解析；映射不到就记 `failed`，不假装成功 |
| 范围膨胀成通用通知平台 | 工期失控 | §0 不做清单写死；只做三个 provider |
| 租户配置密钥引入新密钥面 | 安全基线冲突 | DB 只存 env 名；不引入租户自由密钥 |
| 旧规则语义迁移错误 | 漏发/错发 | pre-production；开发数据可重置；迁移脚本带对账 |
| 事件目录与代码漂移 | 规则引用不存在的事件 | manifest 唯一事实源 + 装载期校验 + 快照 active 标记 |
