# AI 原生 OA：事项平台设计（spec）

> 状态：设计定稿，待评审（2026-11-16）
> 范围：platform-core（公开仓 / 多租户）+ case-engine（私有仓 / 每客户实例）+ 企微
> 上游：explore `docs/adr/0005-collection-form-layer.md` §15/§17/§19；platform-core `docs/architecture.md` §2.4/§2.6
> 本文取代 ADR-0005 §15.2 中「回写方式待定」与 §15.4 中「带审批表单延后」两处未决内容；职责切分（收集 vs 审批）不变。

---

## 0. 摘要

把现有「表单模块 + 事项编排引擎」重新组织成一套 AI 原生 OA：

- **三类事项**：审批（标准 / 非标准）、收集（含轮次）、协作（一次性事件）。
- **模板在平台、执行分 provider**：事项模板与审批模板都定义在 platform-core；标准审批交给**企微审批应用**原生执行，非标准审批与协作交给 **case-engine** 执行，收集不涉及审批。
- **标准审批不复制表单**：平台只做「选对模板 + 深链 + 镜像」，表单/附件/审批 UI 都在企微。
- **非标准审批在应用内**：平台表单 + 引擎审批链 + 企微模板消息通知（深链回应用内），链的推进由引擎负责。
- **AI 只起草、人发布**：AI 生成字段与审批链草案，部门管理员发布；标准模板的企微绑定只能由平台管理员配置。
- **提交即快照**：审批链在提交时编译成确定性计划，在途单不受模板改版影响。

一句话边界：**平台管定义与治理，企微管标准审批，引擎管非标准审批与协作的执行。**

---

## 1. 背景与现状（实测，不是推演）

### 1.1 已有资产

| 资产 | 现状 | 位置 |
|---|---|---|
| 受管数据集内核 | 表单定义生命周期（draft→publish 人 gate→retired）、版本不可变、字典双档、提交 append-only、AI 起草、出湖导出 | `modules/forms`（约 4.6k 行，6 表 + 3 触发器 + 8 函数） |
| 事项编排引擎 | `Case`（payload JSONB + `case_events` 追加审计）、决策门（企微审批/模板卡片/mock）、Mastra durable workflows、SLA 扫描、对账 | case-engine `core/` |
| 通知底座 | 事件声明 / 规则 / 模板 / 通道 / 收件箱 / 外部 emit | `modules/notify` |
| 组织原语 | `platform.org_node` / `org_membership`（企微同步） | `apps/server/src/migrations/012_org_tables.sql` |
| 企微直连 | 应用消息、审批回调、身份映射、模板卡片 | case-engine `core/decision-gate` + platform-core `modules/notify` |

### 1.2 关键缺口（本次设计要解决的）

1. **审批链两侧从未接通**：forms 零 `approval` 代码；case-engine 无表单来源的建单调用；ADR-0005 §15.3 只在原型（mock 决策门）验证过接缝。
2. **企微审批端点有限制**（用户 2026-11-16 实测结论）：只有**标准审批流程**走企微审批；其余走「企微模板通知 + 应用内审批」。
3. **组织原语缺部门负责人**：`org_node` 只有 id/name/parent/path/status；`org-sync.ts` 拉部门时只取 `{id,name,parentid}`，未请求 `leader`。审批链的「直属主管」无数据源。
4. **组织原语缺部门管理员绑定**：现有只有租户级 `tenant:admin`，没有「部门管理员」这一授权主体。
5. **附件能力不存在**：forms 的 `SUPPORTED_WIDGETS` 明确不含 `file`，无上传/存储/权限/保留；引擎决策只有 `comment?`，无附件。
6. **事件目录只认模块 manifest**：`buildCatalog` 只从已加载模块的 `notifications.events` 构建，`source:'external'` 无写入路径；外部生产者事件未声明 ⇒ `/emit` 400 `EVENT_NOT_DECLARED`，生产者 fail-open ⇒ 静默不投递。
7. **引擎契约缺入口幂等键与查询面**：`cases` 无 `external_ref`（`provider_ref` 是建单后回填的外部单号）；`GET /cases` 只支持 `attention=1`。
8. **统一待办不存在**：forms 指派、引擎待审批、协作任务三处各说各话。

### 1.3 引擎真实能力边界（避免再次误判）

**Mastra 1.78 原生已够编排**（case-engine 已逐项实证，ADR-0005 §9.5）：`.parallel` / `.foreach` / `.dountil` / `suspend`+`resume` / `sleepUntil` / workflow cron / durable 快照 + run fencing。

**case-engine 当前抽象没暴露的**（薄扩展，不是重造）：

- `ApproverNode` 只有 `users[]`，无 quorum；企微 adapter 写死 `apv_rel: 1`（全签）。企微 `apv_rel` 合法值 1 全签 / 2 或签 / 3 依次审批。
- `case-intake` 单 gate 步承载整条链；无按节点循环。
- SLA 是 **case 级**（`cases.sla_due_at` + `sla-sweep`），无节点级。
- `cases.status` 闭集 = `pending/routing/gate/approved/closed`，无 `rejected/in_progress/cancelled`。
- 无 `external_ref`、无按外部引用/待办人查询、无 capabilities 端点。

**结论**：引擎改造是 S–M；真正的大件在平台（应用内审批面、组织原语、事件协议、标准模板镜像）。

---

## 2. 目标与非目标

### 2.1 目标

1. 员工在企微里用自然语言发起事项；agent 选模板、补齐上下文、必要时起草新模板。
2. 标准审批（公司级、固定链、预置企微模板）在企微审批应用内完成；平台只镜像与做数据。
3. 非标准审批在应用内完成；企微只发模板消息 + 深链，不在卡片里做决策。
4. 收集支持**轮次**：同一模板按周期收集、按人跟踪进度与催办。
5. 一次性协作事件由 agent 现场生成字段/参与人/任务；可另存为模板。
6. 所有事项可审计、可分析；模板发布永远是人 gate。

### 2.2 非目标（v1 不做）

- 加签 / 转办 / 委托 / 并行分支复杂编排。
- AI 在运行时动态改审批链。
- 匿名开放链接（guest 收集）。
- BPMN 导入导出、原生 App。
- 应用内审批、收集、协作的附件（附件原语独立排期；标准审批用企微原生附件）。
- 收集的字段级分片填（多人各填不同字段）。
- 跨租户全局模板（模板一律租户内）。

---

## 3. 术语

| 术语 | 含义 |
|---|---|
| **事项模板（ItemTemplate）** | 一类可复用事项的定义：字段 + 模式 + 策略。`mode = approval \| collection \| collaboration`。存在 `forms` 的资产内核。 |
| **审批模板（ApprovalTemplate）** | 审批链/绑定的独立资产。两种形态：`inapp`（链 DSL，平台执行）与 `wecom_native`（企微审批模板绑定，企微执行）。 |
| **提交（Submission）** | 一次填报。审批类提交带状态与计划快照；收集类 append-only。 |
| **事项实例（Case）** | case-engine 的 `cases` 行：非标准审批实例、协作实例。payload 可带 `display_schema`。 |
| **计划快照（PlanSnapshot）** | 提交时编译出的确定性审批计划：节点顺序、具体审批人、quorum、SLA、升级对象。引擎只按它执行。 |
| **Provider** | 审批执行方：`wecom_native`（企微审批应用）或 `inapp`（平台 + 引擎）。 |
| **收集轮次（CollectionRound）** | 「模板 × 周期 × 目标名单」的一次收集活动，带进度与催办。 |
| **镜像（Mirror）** | 标准审批在平台侧的只读记录：状态、审批人、时间、可得的表单摘要。 |

---

## 4. 核心决策

| # | 决策 | 理由 |
|---|---|---|
| **D1** | 模板与治理在 platform-core；非标准审批/协作的执行在 case-engine | 多租户管理面、发布 gate、AI 起草、console、落湖都在平台；引擎保持通用、不带租户模板库 |
| **D2** | 三类事项：审批、收集、协作；协作**实例优先**，可另存为模板 | 一次性事件不为模板生命周期付成本；沉淀是显式动作 |
| **D3** | 审批模板是独立资产，事项模板只引用 `id + 版本` | 同一标准链可被多个表单复用；改一次全员生效（新提交） |
| **D4** | 审批 provider 双路线：标准 → `wecom_native`；其余 → `inapp` | 企微审批端点有限制；把「企微能稳定跑的」与「必须自控的」分开 |
| **D5** | 标准审批**不复制表单**：深链进企微审批应用，平台只镜像 | 规避端点/字段映射/附件上传的全部复杂度；标准流程以企微为准 |
| **D6** | 非标准审批链由**引擎执行**（节点循环 + suspend/resume） | 守 ADR-0005 §15「审批调度全交 case-engine」；单一审计源 |
| **D7** | 编译在平台、提交即快照 | 审批人是组织/业务语义，平台有 org/Casdoor；在途单可解释、不受改版影响 |
| **D8** | AI 只起草、人发布；标准模板绑定只能平台管理员配置 | 与现有「AI 起草 + 人 gate」纪律一致；企微绑定是外部事实，AI 不得伪造 |
| **D9** | 发布权：部门管理员发本部门模板；跨部门标准/`wecom_native` 由平台管理员 | 部门自助与公司标准分层 |
| **D10** | 统一待办 = 事件投影，不同步轮询引擎 | 复用 notify 收件箱；避免 UI 依赖跨服务同步读 |
| **D11** | 附件分档：标准审批用企微原生；应用内 v1 无附件；附件原语独立排期 | 不把「附件」与「审批接缝」压进同一个里程碑 |
| **D12** | 组织原语补 `org_node_leader` 与 `org_role_binding(dept_admin)` | 「直属主管」「部门管理员发布」的前置 |
| **D13** | 事件目录支持 external 生产者；先声明后接线 | 已实测的静默失败形态，必须先修协议 |
| **D14** | 公开契约 + 版本化 + capabilities；per-customer 版本差异显式化 | 引擎私有仓、每客户实例，不能假设同版本 |
| **D15** | 引擎状态词表扩展只随协作阶段走 expand-contract | P1–P3 用现有闭集映射；P4 才需要 `in_progress` 等 |

---

## 5. 总体架构

```
platform-core（公开仓 / 多租户）
┌─────────────────────────────────────────────────────────────┐
│ forms 内核（事项平台）                                        │
│  ├─ 事项模板 item_def（3 模式，版本化，发布 gate）             │
│  ├─ 审批模板 approval_def                                    │
│  │    ├─ inapp：链 DSL（平台编译 → 引擎执行）                 │
│  │    └─ wecom_native：企微审批模板绑定（深链 + 镜像）         │
│  ├─ 提交 submission（状态 + 计划快照 + case 引用）              │
│  ├─ 收集轮次 collection_round / target                        │
│  ├─ 标准审批镜像 external_approval                             │
│  └─ 审批 UI（console + 移动端）+ 统一待办投影                  │
│                                                              │
│ notify（事件 / 规则 / 模板 / 通道 / 收件箱）                    │
│ org 原语（+ leader / dept_admin）                              │
└───────────────┬──────────────────────────────┬──────────────┘
                │ ① inapp：POST /cases + 回调    │ ② wecom_native：深链 + 回调/同步
                ▼                              ▼
case-engine（私有仓 / 每客户实例）            企微审批应用（原生表单/附件/审批）
┌──────────────────────────────┐
│ Case + case_events           │
│ 审批链执行（节点循环 + 决策门）│
│ 协作任务 / 参与人              │
│ provider 路由（inapp）         │
└──────────────────────────────┘
```

**标准审批不进引擎**（v1）：企微是执行方与事实源；平台镜像仅用于待办提示与分析。这样同时绕开引擎两个未关闭问题（#56 建单幂等、#117 卡片内存登记表）。

---

## 6. 领域模型

### 6.1 模板层（platform-core / `forms` schema）

复用现有资产内核（`forms.kind` / `asset_version` / `asset_head`）：

| 表 | 变更 |
|---|---|
| `forms.kind` | 新增 `approval_def`（`publish_policy = human_gate`） |
| `forms.asset_version` / `asset_head` | 无结构变更；新增 kind 复用同一生命周期与不可变触发器 |
| 事项模板 body（`kind = form_def`） | 新增 `mode`、`approvalRef`、`provider`、`collectionPolicy`、`collaborationDefaults` |

**事项模板 body v1**

```json
{
  "mode": "approval",
  "schema": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {} },
  "uiSchema": {},
  "approvalRef": { "id": "leave", "version": 3 },
  "provider": "inapp",
  "assignees": { "dictRef": "dict:xxx" },
  "due": { "afterDays": 7 },
  "collectionPolicy": { "rounds": "manual", "allowSupersede": true },
  "collaborationDefaults": { "roleSlots": [], "taskTemplates": [] }
}
```

约束：

- `mode = approval` 必须有合法的 `approvalRef`（published）；`mode = collection` 不得有 `approvalRef`。
- `provider` 必须与所引用审批模板的 provider 一致；不一致 ⇒ 发布失败。
- `provider = wecom_native` 时 `schema` 可为 `null`（纯路由绑定，表单在企微）；`provider = inapp` 时 `schema` 必填。
- `mode = collaboration` 的模板是「沉淀态」：只存字段 schema + 角色槽 + 任务模板，**不存实例值**。
- 现有表单定义一律按 `mode = collection` 读取（缺省值，不迁移数据）。

**审批模板 body v1**

`inapp`：

```json
{
  "provider": "inapp",
  "nodes": [
    {
      "key": "leader",
      "title": "直属主管",
      "approvers": [{ "source": "dept_leader" }],
      "quorum": "all",
      "slaHours": 24,
      "onTimeout": "escalate",
      "escalateTo": [{ "source": "dept_admin" }]
    },
    {
      "key": "finance",
      "title": "财务",
      "approvers": [{ "source": "role", "role": "finance-approver" }],
      "quorum": "any",
      "slaHours": 48,
      "onTimeout": "notify"
    }
  ],
  "conditions": [
    {
      "when": { "field": "amount", "op": "gt", "value": 5000 },
      "addNode": {
        "key": "cfo",
        "title": "财务负责人",
        "approvers": [{ "source": "role", "role": "cfo" }],
        "quorum": "all"
      }
    }
  ],
  "rejectionPolicy": "first_reject_ends",
  "selfApproval": "skip",
  "dedupe": "first_occurrence",
  "emptyNode": "block_publish"
}
```

`wecom_native`：

```json
{
  "provider": "wecom_native",
  "processCode": "<企微审批模板唯一标识>",
  "name": "差旅报销（标准）",
  "deepLink": "https://open.work.weixin.qq.com/...",
  "verifiedChain": [{ "title": "直属主管" }, { "title": "财务" }],
  "verifiedAt": "2026-11-16T10:00:00+08:00",
  "note": "链以企微模板为准；本快照只用于展示与变更核对"
}
```

> `wecom_native` 的 body **不是链 DSL**：不在平台重复定义审批人。平台只存绑定与验证快照。企微模板变更后必须重新核对并更新 `verifiedChain` / `verifiedAt`（审计行）。

**模板归属与可见性（两类模板共用）**

| 键 | 取值 | 语义 |
|---|---|---|
| `ownerDeptExtId` | 部门 `ext_id` 或 null | 归属部门；null = 平台级 |
| `visibility` | `dept`（仅 org_node 子树可见）或 `org`（全租户可见） | 默认 `dept`；`org` 需平台管理员发布 |
| `provider` | `inapp` / `wecom_native` | 见 §9 |

- 发布/编辑时做**部门级数据校验**：部门管理员只能操作 `ownerDeptExtId` 在自己子树内的模板；平台管理员不受限。
- `wecom_native` 的 `visibility` 只能是 `org`（标准流程全员可见）。

### 6.2 实例层（platform-core / `forms` schema）

**`forms.submission` 加法（幂等迁移）**

| 列 | 类型 | 语义 |
|---|---|---|
| `status` | text not null default `submitted` | `submitted / pending_approval / approved / rejected / withdrawn` |
| `provider` | text | `inapp`（标准审批不走此表；镜像在 `external_approval`） |
| `root_submission_id` | bigint | 驳回重提的根提交（首轮 = null） |
| `supersedes_id` | bigint | 收集类更正指向被替代提交 |
| `case_ref` | text | 引擎 case id（inapp） |
| `approval_plan` | jsonb | 提交时编译的计划快照 |
| `decided_at` | timestamptz | 最终结论时间 |
| `decision_action` | text | `approved / rejected / withdrawn` |
| `decision_comment` | text | 最终意见（节点级意见在引擎事件里） |
| `withdrawn_at` | timestamptz | 撤回时间 |

现有行回填：`status = 'submitted'`，其余 null。分析面按 `supersedes_id is null` 取当前有效收集行。

**收集轮次**

```sql
forms.collection_round(
  id bigserial pk, org text, asset_id text, version int,
  round_key text,            -- 如 2026-11
  name text, starts_at timestamptz, ends_at timestamptz,
  status text check (status in ('draft','open','closed')),
  created_by text, created_at timestamptz default now(),
  unique (org, asset_id, round_key)
)

forms.collection_target(
  round_id bigint, org text, user_name text,
  status text check (status in ('pending','submitted','waived')),
  submission_id bigint, updated_at timestamptz,
  primary key (round_id, user_name)
)
```

**标准审批镜像**

```sql
forms.external_approval(
  id bigserial pk, org text, provider text default 'wecom',
  process_code text, provider_ref text unique,   -- 企微 sp_no
  title text, requester text, status text,
  started_at timestamptz, finished_at timestamptz,
  detail jsonb,        -- 可得则存；不可得只存状态/人/时间
  synced_at timestamptz default now()
)
```

**审计**：为模板起草/发布/退役、计划编译、发布 dry-run、审批动作、镜像同步、另存为模板新增 `forms.audit` 行（`org, actor, action, target, detail, at`）。

### 6.3 执行层（case-engine）

| 变更 | 说明 |
|---|---|
| `cases.external_ref text unique` | 入口幂等键（`forms:submission:<id>`） |
| `cases.plan jsonb` | 平台编译的计划快照（inapp） |
| `case_task` / `case_participant` | 协作模式（P4） |
| 节点决策事件 | `case_events` 追加：`gate.node.decided`（nodeKey、approver、action、comment） |
| provider 路由 | `CompositeDecisionGate`：`inapp` 走本地门；不再依赖外部 provider |
| 状态映射 | P1–P3：`gate`（待审批）/ `approved`（通过）/ `closed`（驳回、撤回、结案）；P4 按需 expand-contract 加 `in_progress/cancelled` |

### 6.4 投影层

- **统一待办**：平台 notify 收件箱聚合 `approval.awaiting`（inapp）、`task.assigned`（协作）、`collection.assigned/due`（收集）。
- **标准审批**：企微原生通知；平台镜像只用于「我的标准审批」只读列表与数据面，不产生应用内待办。
- **数据湖**：收集提交沿用现有 forms 日批；inapp 审批与协作走 case 事件导出；标准审批镜像按 detail 可得性导出。

---

## 7. 三类事项与状态机

| | **审批（标准）** | **审批（非标准）** | **收集** | **协作** |
|---|---|---|---|---|
| 资产 | 审批模板 `wecom_native` 绑定 | 事项模板 `mode=approval` + 审批模板 `inapp` | 事项模板 `mode=collection` + 轮次 | Case 实例（可另存模板） |
| 创建 | agent/console 选模板 + 深链 | agent/console 发起 | 指派 / 轮次目标 / 开放链接（v1 不做匿名） | agent 现场生成 |
| 字段 | 企微模板内 | 平台 schema（draft-07） | 平台 schema | agent 生成，执行中可加 |
| 执行 | 企微审批应用 | 平台编译 → 引擎节点循环 | 无审批 | 引擎 case + 任务 |
| 状态 | 企微状态（镜像） | `pending_approval → approved / rejected / withdrawn` | `submitted`（`supersedes_id` 更正） | `open → in_progress → done / cancelled` |
| 通知 | 企微原生 | 企微模板消息 + 应用内待办 | 企微模板消息 + 待办 | 企微模板消息 + 待办 |

### 7.1 模板生命周期

`draft → published → retired`；published 不可变（DB 触发器）。同一资产改版 = 新 draft 版本。退役不物理删。

### 7.2 审批提交状态机（inapp）

```
submitted ──▶ pending_approval ──▶ approved
                    │
                    ├──▶ rejected ──▶ (重提: 新 submission + root_submission_id)
                    └──▶ withdrawn（提交人撤回；仅在任何节点产生决策前）
```

规则：

- **驳回不是终态**：修改后重提 = 新 submission，`root_submission_id` 指向首轮；旧单保留可解释。
- **撤回**：仅当引擎 case 尚未产生任何决策事件；撤回后引擎 case 标记 `closed`（事件 `withdrawn`）。
- **重提**：重提时按**当时**审批模板的最新 published 版本重新编译计划快照（不是首轮快照复用）。
- 最终结论回写只发生一次（幂等键 `caseId + final`）。

### 7.3 收集轮次状态机

```
draft ──▶ open ──▶ closed
```

- `open` 时目标名单快照生效；快照后**不增删目标**——要改名单就关旧轮次、开新轮次（审计可解释）。提交按 `(round_id, user_name)` 记目标状态。
- 更正：新提交 + `supersedes_id`；目标状态仍为 `submitted`，分析面取最新有效行。
- 催办：按目标 `pending` 逐人 emit `collection.due`（事件 id 含日期，幂等）。

### 7.4 协作状态机（P4）

```
open ──▶ in_progress ──▶ done
  └──────────────▶ cancelled
```

- 任务只是 case 上的子对象；任务完成不自动结案，结案是显式动作（可走一次决策门）。
- 「另存为模板」可在任意终态发起；实例值/附件/参与人**不进模板**。

---

## 8. 审批模板 DSL v1（仅 `inapp`）

### 8.1 结构

| 字段 | 取值 | 语义 |
|---|---|---|
| `nodes[]` | 1..n | 有序节点 |
| `nodes[].key` | 唯一字符串 | 节点标识（事件与 UI 用） |
| `nodes[].approvers[]` | `ApproverSource` | 审批人来源 |
| `nodes[].quorum` | `all` \| `any` \| `{ "n": int }` | 节点内通过条件 |
| `nodes[].slaHours` | 正整数（可选） | 节点 SLA |
| `nodes[].onTimeout` | `escalate` \| `notify` \| `auto_approve` | 超时动作；`auto_approve` 默认禁用，需平台管理员显式开 |
| `nodes[].escalateTo[]` | `ApproverSource` | 超时/失效升级对象 |
| `conditions[]` | 条件加节点 | 提交时求值；声明顺序；可多条 |
| `rejectionPolicy` | `first_reject_ends` \| `all_must_decide` | 默认 `first_reject_ends` |
| `selfApproval` | `skip` \| `allow` \| `forbid` | 默认 `skip` |
| `dedupe` | `first_occurrence` \| `allow_repeat` | 默认 `first_occurrence` |
| `emptyNode` | `block_publish` \| `block_runtime` | 默认 `block_publish` |

`ApproverSource`：

| source | 参数 | 解析 |
|---|---|---|
| `user` | `users: string[]` | Casdoor 用户名 |
| `role` | `role: string` | Casdoor 角色成员（`listRoles`） |
| `dept_members` | `deptExtId`（可选，缺省=发起人主部门） | `org_node` 子树成员，`status = 1`，排除禁用用户 |
| `dept_leader` | `deptExtId`（可选，缺省=发起人主部门） | `org_node_leader` |
| `dept_admin` | `deptExtId`（可选，缺省=发起人主部门） | `org_role_binding.role = dept_admin` |
| `field` | `field: string` | payload 中该字段的值（字符串或字符串数组） |

### 8.2 判定表（写死，防实现期争议）

| 场景 | 规则 |
|---|---|
| 任一审批人驳回 | 默认立即终止全链 → `rejected`；`all_must_decide` 时等全部节点表态后按「任一驳回即驳回」 |
| `veto` | 立即终止 → `rejected`，优先级高于任何 approve |
| 并发 approve/reject | 以**先落库**为准；后到者返回 409，不覆盖 |
| requester 在审批人列表 | `skip`：从该节点名单剔除；剔空则跳过该节点并记事件 |
| 同一人出现在多个节点 | `first_occurrence`：只在第一个节点出现；后续节点剔除 |
| 解析后名单为空 | `block_publish`：发布 dry-run 失败，不允许发布；`block_runtime`：进 attention，不自动通过 |
| 审批人已离职/禁用 | 节点进入时校验；失效 ⇒ 用 `escalateTo` 重新解析；仍空 ⇒ 卡住 + attention + 通知部门管理员 |
| quorum = any | 首个 approve 即节点通过；其余待办关闭（事件 `gate.node.closed`） |
| quorum = n | 第 n 个 approve 通过；n > 解析人数 ⇒ 发布 dry-run 失败 |
| 条件求值 | 提交时、按声明顺序；命中的 `addNode` 追加在 `anchor` 之后（缺省追加在末尾）；可多条 |
| 节点 SLA | 引擎 `sleepUntil(slaDueAt)` + 超时事件；`escalate` 触发升级，`notify` 只提醒，`auto_approve` 需显式开启 |
| 审批意见 | approve 可选；reject/veto 必填（产品约束，服务端强制） |

### 8.3 发布门

发布前必须跑一次 **dry-run**：给定样例 payload + 发起人，返回解析后的完整计划。dry-run 不通过 ⇒ 禁止发布。发布时把 dry-run 结果存审计（`forms.audit`）。

---

## 9. Provider 路由

### 9.1 路由规则

| 条件 | provider |
|---|---|
| 平台管理员发布、链完全静态、已绑定企微审批模板（`processCode` + `verifiedChain`） | `wecom_native` |
| 其他一切审批（部门自建、动态条件、动态审批人、跨部门临时链） | `inapp` |

**不做静默降级**：`wecom_native` 绑定缺失/失效 ⇒ 发布失败；运行期企微不可用 ⇒ 镜像同步进 attention，**不自动切 inapp**。

### 9.2 `wecom_native` 流程

```
agent/console 选标准模板
  → platform 返回 deepLink（可带上下文说明）
  → 用户在企微审批应用内填写/提交/审批
  → 企微回调 / 定时同步 → forms.external_approval 镜像
  → 平台只读展示 + 数据面
```

v1 平台**不调企微建单/预填**；不存标准表单与附件。

### 9.3 `inapp` 流程

```
agent/console 发起 → 取事项模板 + 审批模板
  → 平台服务端编译计划（解析人/条件/quorum）
  → 写 submission(pending_approval) + POST /cases(provider=inapp, plan)
  → 引擎逐节点挂起；每个节点进入时 emit approval.awaiting（逐审批人）
  → 企微模板消息（含深链）→ 审批人打开应用内审批页
  → 平台鉴权后调 POST /cases/:id/decision
  → 引擎推进/终结；final 回调平台 → 写 submission.status + emit approval.decided
```

---

## 10. 接缝契约 v1（公开面）

> 位置：platform-core `docs/oa-engine-contract.md`（公开仓）；引擎在私有仓实现。契约 JSON Schema 同仓维护，引擎按它校验。

### 10.1 能力协商

```http
GET {engine}/capabilities
→ 200 {
  "planVersion": 1,
  "engineVersion": "x.y.z",
  "providers": ["inapp"],
  "features": ["nodeLoop", "quorum", "nodeSla", "collab"]
}
```

映射表里记录 `engineVersion`；平台按 `features` 决定可用能力，缺能力时**拒绝**相应模板发布（不猜）。

### 10.2 创建实例

```http
POST {engine}/cases
{
  "org": "<org>",
  "externalRef": "forms:submission:<id>",
  "planVersion": 1,
  "provider": "inapp",
  "type": "approval" | "collab",
  "title": "请假 - 张三",
  "requesterId": "<casdoor name>",
  "payload": { "...": "字段值 / 协作上下文" },
  "plan": { "...": "编译后的节点计划（approval）" },
  "participants": ["..."],          // collab
  "tasks": [{ "title": "...", "assignee": "..." }]  // collab
}
→ 201 { "caseId": "...", "runId": "..." }
```

- **幂等**：`externalRef` 唯一；重放返回同一 `caseId`。
- **org 校验**：引擎单租户实例校验 `org == ENGINE_ORG`，不一致 403。
- **plan 校验**：引擎按 `planVersion` 的 JSON Schema 校验；不合法 400。
- **type 落库**：引擎把顶层 `type` 写入 `payload.type`（现有 `case_type` 是 `payload->>'type'` 生成列），避免契约与生成列口径分叉。

### 10.3 决策

```http
POST {engine}/cases/:id/decision
{ "nodeKey": "leader", "action": "approve|reject|reassign|veto",
  "decidedBy": "<casdoor name>", "comment": "...", "targetAssignee": "..." }
```

- 平台代理调用；**授权在平台**（只有计划快照中当前节点的审批人能通过）。
- 引擎校验：`nodeKey` 必须是当前节点；已终结 409；`reject/veto` 无 comment 400；`reassign` 无 target 400。
- 重放/并发：引擎的 resume CAS 保证不双落（现有机制）。

### 10.4 撤回

```http
POST {engine}/cases/:id/withdraw
{ "org": "<org>", "actor": "<casdoor name>", "reason": "..." }
→ 200 { "ok": true }
```

- 仅允许「尚无任何节点决策事件」时撤回；否则 409。
- 撤回后 case 标 `closed`，事件 `withdrawn`；平台写 `submission.status = withdrawn`。
- 权限：平台鉴权（仅提交人）后以服务 PAT 调用。

### 10.5 查询

```http
GET {engine}/cases/:id          # 现有：case + events
GET {engine}/cases?externalRef=forms:submission:123
GET {engine}/cases?assignee=<user>&status=gate
GET {engine}/cases?status=all&updatedSince=<ts>&limit=200   # 对账/管理面
```

### 10.6 回调

```http
POST {platform}/api/modules/forms/approval-callback
{ "org", "caseId", "externalRef", "final": true,
  "action": "approved|rejected|withdrawn",
  "decidedBy", "decidedAt", "comment" }
```

- 平台幂等：`(caseId, final)` 唯一；重复回调返回 200 不重复写。
- 平台写 `submission.status` / `decided_at` / `decision_*`，emit `approval.decided`。
- 回调失败：引擎重试（指数退避）；平台另有**小时级对账 job** 扫 `pending_approval` 超 N 分钟的单，按 `externalRef` 查询引擎补齐。

### 10.7 标准审批镜像

- 回调/定时同步按 `processCode` 拉企微审批实例 → upsert `forms.external_approval`（`provider_ref` 唯一）。org 由**绑定资产的 `org`** 决定（一个绑定属于一个租户），不靠猜。
- 同步幂等：`provider_ref` 唯一 + upsert；重复同步不改已存在的 `detail` 以外字段。
- detail 不可得时只存状态/审批人/时间；字段值不进湖（显式降级，不假装有数据）。

---

## 11. 引擎改造清单

| # | 变更 | 量级 | 说明 |
|---|---|---|---|
| E1 | `cases.external_ref` + unique、`cases.plan` | S | 幂等与审计快照 |
| E2 | `GET /capabilities` | S | 契约版本/能力协商 |
| E3 | `GET /cases?externalRef/assignee/status` | S | 对账、待办、管理面 |
| E4 | `CompositeDecisionGate` + `inapp` provider | S | 平台不建外部单；挂起/恢复走现有端点 |
| E5 | `case-intake` 节点循环（`dountil` + `suspend`） | M | 逐节点推进；与现有单 gate 兼容迁移 |
| E6 | quorum / 驳回短路 / self-approval / dedupe | M | 纯函数 + 事件；DSL 判定表落地 |
| E7 | 节点 SLA（`sleepUntil` + 超时事件 + 升级） | S–M | 用 Mastra 原生定时，不新增扫描 |
| E8 | 逐审批人事件 → 平台 notify | S | 事件必须先在 manifest 声明（D13） |
| E9 | 协作 `case_task` / `case_participant` + 任务流 | M | P4；Mastra 原生原语 |
| E10 | 状态词表扩展（P4） | S | CHECK + 常量两处同步，expand-contract |
| E11 | `POST /cases/:id/withdraw` | S | 提交人撤回；无决策事件才允许 |
| E12 | 契约 JSON Schema 仓内维护 + CI 校验 | S | 公开契约不放私有仓 |

**不需要**：外部企微审批建单（标准走深链镜像）、卡片决策（#117 绕开）、外部 provider 幂等（#56 绕开）。

---

## 12. 平台改造清单

### 12.1 数据与后端

| # | 变更 |
|---|---|
| P1 | `forms.kind` 加 `approval_def`；事项模板 body 加 mode/provider/approvalRef 等（迁移幂等） |
| P2 | `forms.submission` 加状态/快照/引用列；存量回填 |
| P3 | `forms.collection_round` / `collection_target` |
| P4 | `forms.external_approval` 镜像表 |
| P5 | `forms.audit` 审计行 |
| P6 | 路由：事项模板 CRUD、审批模板 CRUD、dry-run、发布、提交、审批代理（mine/detail/decision）、收集轮次、标准绑定、镜像同步 |
| P7 | 权限码（见附录 B）+ 部门级数据校验（发布/编辑按 owner dept） |
| P8 | org 扩展：`org_node_leader`、`org_role_binding`；企微同步取 leader |
| P9 | 事件声明扩展 external 生产者；声明全部 OA 事件 |
| P10 | per-tenant feature flag `OA_ENABLED`；未启用租户行为逐字不变 |
| P11 | `platform.oa_engine(org, base_url, pat_secret_ref, engine_version, enabled)`：org→引擎映射，平台唯一登记点；PAT 走 secret，不落明文 |

### 12.2 UI

| 面 | 页面 |
|---|---|
| Console | 事项模板库（草稿/发布/版本 diff）、审批模板（DSL 编辑 + dry-run 预览）、标准审批绑定、收集轮次与进度、应用内待审批、审批详情、数据看板 |
| 移动端 | 我的待办、应用内审批详情与动作、填写表单、协作任务板、case 详情 |
| 企微 | 模板消息 + 深链（审批/填写/任务）；标准审批深链直达企微审批应用 |

### 12.3 权限（摘要，全文见附录 B）

- `forms:manage` / `forms:publish`：部门管理员（本部门）。
- `forms:global-manage`：平台管理员（跨部门 / `wecom_native` 绑定）。
- `forms:approval:view`：审批参与人 / 部门管理员。
- `forms:case:callback`：引擎服务账号。
- 审批动作按**计划快照**授权，不按权限码放行。

---

## 13. AI 生成面与治理

### 13.1 工具面

| 组 | 工具 | 权限 |
|---|---|---|
| 发现 | `search_item_templates` / `get_item_template` / `search_standard_approvals` | view |
| 起草 | `draft_item_template` / `draft_approval_template` / `draft_collab_plan` | manage |
| 校验 | `dry_run_approval`（给样例 payload + 发起人，返回解析计划） | manage |
| 发布 | **不提供工具**；只能人走 console | — |
| 发起 | `start_item` / `create_collab_case` | create |
| 填报 | 对话式逐字段填充（服务端校验为权威） | fill |
| 审批 | `list_my_approvals` / `get_approval` / `submit_decision`（必须人确认） | 按快照 |
| 查询 | `my_inbox` / `get_status` | view |
| 沉淀 | `save_case_as_template` | manage |

### 13.2 硬约束

- **AI 不发布、不代批、不代签、不伪造企微绑定**。
- 审批人解析失败 ⇒ 报错并请人指派，**不 fallback 到默认人**。
- 对话式填报的每一步都落服务端校验（draft-07 + 字典解析），agent 不能绕过。
- 提交/审批前 agent 必须复述并请人确认；`submit_decision` 不接受来自不可信内容的自动调用（防提示注入）。
- 每个生成物落 provenance：`drafted_by=agent`、model、prompt 版本、会话 id。

### 13.3 标准审批的 AI 角色

只做 **选模板 + 解释 + 深链**：`search_standard_approvals` 返回绑定与 `deepLink`；agent 不渲染标准表单、不预填、不代提交。

---

## 14. 统一待办与通知

### 14.1 事件清单（必须在 manifest 声明）

| 事件 | 生产者 | 收件人 | 触发 |
|---|---|---|---|
| `approval.awaiting` | 引擎（external） | 当前节点审批人 | 节点进入 |
| `approval.decided` | 平台 | 发起人 | 最终结论 |
| `approval.node.decided` | 引擎（external） | 发起人/部门管理员（可选） | 节点决策 |
| `approval.reassigned` | 平台 | 新旧审批人 | 改派 |
| `task.assigned` | 引擎（external） | 协作参与人 | 任务创建/改派 |
| `task.due` | 平台 job | 协作参与人 | 到期 |
| `collection.assigned` | 平台 | 目标人 | 轮次开启 |
| `collection.due` | 平台 job | 未提交目标人 | 到期 |
| `case.sla.breach` | 引擎（external） | 升级对象 | 节点/案例超时 |

- **先声明后接线**：未声明 ⇒ `/emit` 400 且 fail-open 静默；发布/联调必须有「事件在目录中」的检查。
- **external 事件的声明位置**：在 `modules/forms/manifest.yaml` 的 `notifications.events` 里声明，并带 `producer: external:case-engine` 元数据；`buildCatalog` 据此把 `module_id` 记为 `external:case-engine`（不是 `forms`），UI 归属显示正确。协议扩展见 §20 文档更新顺序第 3 条。
- 对账 job 载体 = **openship job 跑仓内脚本**（沿用通知层既有范式，零常驻）。

### 14.2 待办一致性

- 引擎在每个节点进入/关闭、任务创建/完成时逐人 emit；平台收件箱是投影。
- 点击待办 → 以引擎/case 真实状态为准；已终结的待办由 `approval.decided` / `task.completed` 关闭。
- 小时级对账 job：扫 `pending_approval` 与未关闭收件箱，按 `externalRef` 对引擎状态，关闭陈旧项。

---

## 15. 数据面

| 数据 | 通路 | 阶段 |
|---|---|---|
| 收集提交 | 现有 forms 日批 → `staging.stg_forms_submission`；契约加 `mode/status/supersedes_id` | P3 |
| 应用内审批 | 引擎 `GET /cases?updatedSince=` 导出 case_events → `staging.stg_oa_case_event` | P5 |
| 标准审批镜像 | `forms.external_approval` → 日批导出（detail 可得才导字段） | P5 |
| 协作 | case_events（同一导出） | P5 |
| 指标 | 审批时长、节点瓶颈、驳回率、模板使用排行、收集完成率、任务按时率 | P5 |

纪律：

- 数据落湖前不声明 L1 指标（沿用现有纪律）。
- `org` 由部署常量注入，不进湖（沿用 forms 出湖契约）。
- **PII**：审批意见/金额/票据是高敏数据；case 事件出湖前先定掩码/分级，未定不导自由文本与附件。

---

## 16. 安全与审计

| 面 | 约束 |
|---|---|
| 跨服务 | 每次调用携 org；引擎校验实例 org；不一致 403。平台/引擎之间只用服务 PAT（最小 scope） |
| 回调 | `forms:case:callback` 专用；幂等键；不接受匿名/无 PAT |
| 应用内审批 | 平台按计划快照授权当前节点审批人；引擎端点不暴露给浏览器 |
| 模板发布 | 人 gate；部门管理员只能发本部门；`wecom_native` 只平台管理员 |
| AI | 不发布/不代批；审批动作必须人确认；生成物 provenance |
| 审计 | 模板发布、dry-run、提交、节点决策、改派、撤回、镜像同步、另存模板全部留痕 |
| 附件 | 标准审批在企微；应用内 v1 不收附件；附件原语上线前不放开入口 |
| 数据 | PII 分级/掩码；不把自由文本与附件直接出湖 |

---

## 17. 迁移与开关

1. **迁移幂等**：所有 DDL `if not exists` / `drop ... if exists`；DML `on conflict`；重复执行不报错。
2. **存量兼容**：现有 form_def 读取时缺省 `mode = collection`；现有 submission 回填 `status = submitted`；现有出湖管线在契约加列前保持原样。
3. **feature flag**：`OA_ENABLED` 按租户；未启用时 OA 路由/入口 404 或缺席，存量行为逐字不变。
4. **引擎迁移**：`external_ref` / `plan` 加列；节点循环上线前保留单 gate 兼容路径（按 `planVersion` / `features` 分流）。
5. **契约门禁**：`docs/oa-engine-contract.md` 的 JSON Schema 纳入 CI（生成物 == committed）。
6. **回滚**：模板回滚用现有 `rollback_to`；已在途的 submission 按快照执行，不回滚。

---

## 18. 分期与验收

| 期 | 内容 | 验收（可机检） | 负对照 |
|---|---|---|---|
| **P0**（3–5 天） | org leader/dept_admin 同步；事件 external 声明协议；引擎 `external_ref`/查询/capabilities；契约文档；feature flag | 负责人与企微逐节点一致；未声明事件发布被拦；契约 schema CI 绿 | 映射缺失 fail-closed；事件未声明 ⇒ 可见告警 |
| **P1 请假（2–3 周）** | inapp 事项模板 + 审批模板；编译 + dry-run；引擎节点循环；应用内审批 UI；企微消息深链；回调 + 对账 | 企微发起→两级全签→通过；驳回重提；撤回；回调重放不双写；在途单不受模板 v2 影响 | AI 发布被拒；无负责人发布被拦；并发决策 409；空名单发布被拦 |
| **P2 报销（2 周）** | `wecom_native` 绑定 + dry-run 核对；深链；镜像回调/同步；标准审批只读列表 | 企微审批全流程可走；镜像状态/审批人/时间与企微一致；重复同步幂等 | 绑定失效发布被拒；企微不可用进 attention 不自动切 provider |
| **P3 收集（1–2 周）** | 轮次/目标/进度/催办；更正 supersedes；现有管线零影响 | 同模板按两轮收集；进度与未交名单准确；新表单零改动落湖 | 轮次重复开启被拒；名单外提交被拒 |
| **P4 协作（2 周）** | 实例 + 参与人 + 任务；任务通知；另存为模板；状态 expand-contract | 一次性事件无需模板即可协作；任务完成/改派；另存模板不含实例值 | 无权限参与人被拒；模板含附件/实例值发布被拒 |
| **P5 数据（1–2 周）** | case 事件导出、审批指标、审计看板；PII 掩码 | 指标与引擎导出一致；无声明指标不上线 | 未掩码自由文本出湖被拦 |

---

## 19. 不做清单（写死）

| 反模式 | 为什么不做 |
|---|---|
| 标准审批在平台复制表单/附件 | 企微是执行方与事实源；复制会引入字段映射、附件上传、双真相 |
| 非标准审批走卡片内批 | 卡片无意见/附件/详情；且 #117 内存登记表不可靠 |
| 平台自行实现审批链执行器（与引擎并行） | 两套链执行器、审计分裂；D6 已定引擎执行 |
| AI 运行时改审批链 | 发布后确定性是审计前提 |
| 通用 BPMN/工作流引擎 | 当前需求是审批 + 轻协作，Mastra 原生足够 |
| 一次做齐加签/转办/委托/并行分支 | 无真实案例；先证明接缝 |
| 应用内审批 v1 带附件 | 附件原语是独立大件；先把接缝跑通 |

---

## 20. 文档更新顺序（架构先行）

代码之前，按序更新：

1. **explore ADR-0005 修订**
   - §15：职责切分保留；新增「provider 路由」与「标准审批不进引擎」；
   - §15.2：接缝改为「inapp 编译计划 + 回调/对账」；
   - §15.4：带审批表单的延后结论作废（由本文取代）。
2. **platform-core `docs/architecture.md`**
   - §2.4：forms 的域扩展为「事项平台」；provider 路由与模板形态；
   - §2.6：新增 OA 事件与收件箱投影。
3. **platform-core `docs/module-protocol.md`**
   - 事件声明支持 external 生产者（schema + 校验 + UI 归属）。
4. **本 spec**（本文）。
5. **实施计划**（writing-plans 产出）。

---

## 21. 附录

### A. 默认值 / 判定速查

| 项 | 默认 |
|---|---|
| `rejectionPolicy` | `first_reject_ends` |
| `selfApproval` | `skip` |
| `dedupe` | `first_occurrence` |
| `emptyNode` | `block_publish` |
| `quorum` | `all` |
| `onTimeout` | `escalate` |
| `slaHours`（未声明） | 不设节点 SLA（仅 case 级兜底） |
| 撤回窗口 | 首个节点决策前 |
| 回调重试 | 指数退避，由引擎重试；平台对账兜底 |

### B. 权限码

| 码 | 语义 | 授予 |
|---|---|---|
| `forms:view` | 查看模板/提交 | 租户成员 |
| `forms:fill` | 填报/发起 | 租户成员 |
| `forms:manage` | 起草/编辑模板与审批模板 | 部门管理员 |
| `forms:publish` | 发布（人 gate） | 部门管理员（仅本部门） |
| `forms:global-manage` | 跨部门模板、`wecom_native` 绑定、全局字典 | 平台管理员 |
| `forms:approval:view` | 查看审批实例/轨迹 | 参与人、部门管理员 |
| `forms:collab:create` | 发起协作实例 | 租户成员（按部门策略） |
| `forms:case:callback` | 引擎回调（服务） | 服务账号 |

### C. 事件 payload 最小形状

| 事件 | payload |
|---|---|
| `approval.awaiting` | `submissionId, caseId, nodeKey, title, assignee, link, dueAt?` |
| `approval.decided` | `submissionId, caseId, action, decidedBy, decidedAt, link` |
| `task.assigned` | `caseId, taskId, title, assignee, link, dueAt?` |
| `collection.assigned` | `roundId, submissionTarget, assetId, dueAt, link` |
| `collection.due` | `roundId, userName, assetId, dueAt, link` |
| `case.sla.breach` | `caseId, nodeKey?, slaDueAt, escalateTo, link` |

### D. 评审记录

| 日期 | 决定 |
|---|---|
| 2026-11-16 | 审批模板独立资产；协作实例优先；部门管理员发布；企微为主入口 |
| 2026-11-16 | 路线 A：平台定义 + 引擎执行 |
| 2026-11-16 | provider 双路线：标准→企微审批（深链+镜像）；其余→应用内（引擎执行链） |
| 2026-11-16 | 应用内审批链由引擎执行（守 ADR-0005 §15） |
