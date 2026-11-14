# 通知底座开发地图（Agent 自助 + 调度器接缝）

> **本文件是这条线的唯一导航面 + 进度台账。** 开工前先读 §2 台账；台账说「已完成」的，
> 回去看证据再决定要不要动。新想法先写 §9 候选池，不进当前波次。
>
> 正典：`docs/architecture.md` §2.6。调度器正典：`docs/superpowers/specs/2026-11-14-business-scheduler-design.md`
> （v2）+ `docs/superpowers/plans/2026-11-14-scheduler-p1.md`。
> 接缝记录：`.orca/drops/2026-11-14-notify-scheduler-integration.md`（已被 spec v2 采纳，以 spec 为准）。
>
> 目标：把 notify 从「模块级通知实现」升级为**系统级通知底座**——任何模块/脚本/agent/外部系统
> 都能发；agent 可在租户 + 命名空间内自助声明事件、写模板、建规则；通道由平台预备；定时由
> `platform.scheduler` 统一。

---

## 1. 基线诊断（2026-11-09 架构审视）

### 1.1 已经做对的

1. **四层分离**：事件声明/目录 → 规则 → 模板 → 投递；每层有单一落点。
2. **可送达性只有一个实现**：`modules/notify/domain/deliverability.ts` 同时服务 worker、HTTP 预检、
   MCP、preflight job——「预检说能发、实际发不出」被收敛到一个函数。
3. **outbox 语义正确**：确定性 `event_id` + `(event_id, rule_id, recipient, channel)` 联合主键 +
   `FOR UPDATE SKIP LOCKED` 租约，至少一次投递的基础成立。
4. **失败不假装成功**：地址解析不到、凭据缺失、部门解析器缺失都落显式状态，不静默发 0 人。
5. **凭据与判据分离**：DB 密文 + KEK、桥/直连 `transport` 开关、`probeDirect` 恒 `noCache`。

### 1.2 评分（当时判断）

| 维度 | 评分 | 一句话 |
|---|---|---|
| 领域建模 | **A-** | 四层清晰；失败被建模成状态 |
| 契约与边界 | **B** | manifest 目录很好；worker 组合根反向依赖 apps/server |
| 可靠性 | **B-** | outbox 对；限流/重试/超时/批处理异常有硬伤 |
| 安全 | **B-** | 凭据/SSRF/HMAC 在；审计不全、SSRF 边界未封死 |
| 可运维性 | **B-** | health/preflight/registry 是亮点；event/audit 无保留期 |
| 自助产品面 | **C+** | console 六区可用；通道/凭据/收件箱权限仍未自助 |

### 1.3 生产快照（2026-11-14）

- `notify-health`：绿。`dead=0 stale=0 workers=1 oldestPending=0s failedLastHour=0 channelErrors=0`。
- `notify-preflight`：每日红，3 条 `no_recipient`（aftersales / integration.stale / data.metric）。
  **这是配置缺口，不是代码故障**；但 `notify.integration.stale` 自己没有收件人，元告警发不出去。
- forms 通知链已由 #1980 补上，但仍是**硬编码规则**；`defaults` 派生机制尚未落地。
- `notify.event` / `notify.audit` 无保留期；`delivery.rendered` 保留 365 天。
- 调度器：spec v2 + P1 plan 已合并（#2164/#2173）；P1 实现未开工；P1 **不开放 agent 面**。

---

## 2. 完成度台账（每完成一项必须更新）

| 项 | 状态 | 证据 | 备注 |
|---|---|---|---|
| 通知基础设施 P1（事件目录 + outbox + worker + 企微/in-app） | ✅ | #1119 | 2026-10-27 |
| P2 产品面（模板/通道/console 六区/MCP） | ✅ | #1123 | 2026-10-27 |
| P3 收口（webhook/限流/健康/保留期） | ✅ | #1125 | 2026-10-28；webhook 有地址判定缺陷，见 N0.1 |
| 可送达性 D1–D4 | ✅ | #1145/#1147 | 单一 `resolveDeliverability` |
| 收件人身份映射 Phase 1/2 | ✅ | #1227/#1231 | 显式地址 → identity_link → 兜底 |
| 企微直连（凭据密文 + token 判据） | ✅ | #1219 | 山海生产形态 |
| 集成健康（registry + STALE） | ✅ | #1209/#1212 | 判据读 `channel_probe` |
| forms 指派/催办接通 | ✅ | #1980 | **硬编码**，非 `defaults` 派生 |
| 一次性延迟 + `notify.emit` handler | 🟡 | PR #2169 | 已 rebase 到合并版 spec/plan；`JOB_PARAMS` 走 stdin |
| 调度器 spec v2 + P1 plan | ✅ | #2164/#2173 | 调度器板块；P1 不开 agent 面 |
| 双平面事件目录（agent 事件声明） | ⬜ | — | N1 |
| 模板/规则 namespace 归属 + 通用消息 | ⬜ | — | N2 |
| 爆炸半径策略 + 审批 + 配额 | ⬜ | — | N3 |
| `SchedulerPort` 消费 + 排班工具 | ⬜ | — | N4；等 W6-P3 |
| job 生命周期事件接通知 | ⬜ | — | N5；等 W6-P4 |
| N0 基线加固（9 项） | ⬜ | — | 见 §5.1 |

---

## 3. 定案（不要再翻）

| # | 定案 | 理由 |
|---|---|---|
| D1 | agent 可自助 **事件 + 模板 + 规则**；通道仍由平台预备 | 最贴近“挂到任何地方”的最小完整形态 |
| D2 | 两类 agent：**运行时业务 agent**（发事件）+ **平台管理 agent**（改配置） | 能力分开，token/权限分开 |
| D3 | 发布按**爆炸半径分级**：in-app 可自动；企微等外发需策略/人审；webhook 默认人审 | 自由与安全兼得 |
| D4 | **事件为主 + 通用消息兜底**：`ext.<ns>.message` 一次调用 | 不让一次性通知逼人先建事件 |
| D5 | 租户内**按 agent 命名空间隔离**：`ext.<namespace>.<event>` | 防冲突、可审计、可授权 |
| D6 | **单调度者**：周期排班归 `platform.scheduler`；一次性延迟归 notify outbox `available_at` | 不造第二个 cron；两者语义不同 |
| D7 | `notify.emit` handler：job 成功 = 事件已入队；投递失败仍归 notify 重试 | 两层重试语义不打架 |
| D8 | P1 不开放 agent 面；agent 排班在 **W6-P3** | 调度器先稳定，再开能力 |

---

## 4. 目标架构

```
                        ┌──────────────────────────────────────────────┐
模块 ctx.notify.emit ──┐ │  事件目录：平台(manifest) + 租户(agent DB)  │
外部 /emit (PAT) ──────┼▶│  resolveEventDecl(org, key)                  │
MCP emit/send ─────────┘ │  ext.<namespace>.<event> 归属校验           │
                        └──────────────────┬───────────────────────────┘
                                           ▼
                                  notify.event (outbox)
                                  ├─ available_at：一次性延迟
                                  └─ status='new' → notify-worker dispatch
                                           │
                          rules → templates → channels → delivery
                                           │
                                  provider（in_app / wecom_chat / webhook）

周期排班：
  agent/console/MCP → SchedulerPort.createSchedule(key='notify.emit', params, cron, owner…)
    → platform.job_schedule → platform.scheduler loop（notify-worker 内）
    → spawn(scripts/notify-emit-job.mjs, JOB_PARAMS via stdin)
    → enqueueEvent → 同上
```

**边界**：

| 层 | 负责 | 不负责 |
|---|---|---|
| 调度器 | cron、排班表、运行台账、子进程、超时/重试/misfire、心跳与 healthz、并发、registry | 事件/模板/规则/收件人/通道/投递 |
| 通知 | 事件目录、模板、规则、收件人解析、outbox、provider、回执、收件箱 | cron、排班表、运行台账、worker 生命周期 |

---

## 5. 开发地图

| 波次 | 主题 | 依赖 | 归属 | 出口判据 |
|---|---|---|---|---|
| **N0** | 基线加固（安全/可靠性/治理） | 无 | 通知 | 9 项 P0/P1 收口；preflight 绿 |
| **N1** | 双平面事件目录（agent 事件声明） | 无 | 通知 | agent 声明 `ext.*` → `/emit` → worker 可投递；跨 namespace 拒绝 |
| **N2** | 模板/规则归属 + 通用消息 | N1；N0.5 | 通知 | agent 写模板/规则并投递；`ext.<ns>.message` 一次调用 |
| **N3** | 爆炸半径策略 + 审批 + 配额 | N2 | 通知 | in-app 自动；外发未审批不生效；配额可拒 |
| **N4** | 调度器接缝（排班工具） | W6-P3；N1/N2 | 通知 + 调度器 | agent 建 `notify.emit` 排班，按 cron 到达；重复 occurrence 不双发 |
| **N5** | 运营/规模化收口 | N3/N4；W6-P4 | 通知 + 调度器 | job 事件可投递；per-namespace 可观测；保留期生效 |

### 5.1 N0 — 基线加固（先做，避免自助面放大缺陷）

| # | 项 | 证据/问题 | 验收 |
|---|---|---|---|
| N0.1 | **webhook 地址判定** | worker 把 webhook 投递判 `missing_channel_address → dead` | webhook test-send 202；mock 端点收到；worker 产生 `sent` |
| N0.2 | **限流/重试语义** | 限流顺延消耗 `attempts`；窗口用 `created_at` 非发送时间 | 连续 6 个限流窗口不 dead；窗口按 `sent_at` 计数 |
| N0.3 | **provider 超时 + 批处理异常隔离** | 企微/bridge 无 `AbortSignal.timeout`；一条坏投递可拖垮整批 | 挂起请求超时；单条异常落 failed/dead，后续继续 |
| N0.4 | **HTTP 写审计 + rule id 命名空间** | POST/PUT/DELETE rules、PATCH channel 无 audit；客户端可覆盖 `derived:*` | 所有写落 `notify.audit`；`derived:`/`manual:` 不可被客户端覆盖 |
| N0.5 | **模板 fork 语义** | 租户编辑 builtin 后 `origin` 不变；seed 可覆盖 | 首次编辑 fork 成 `origin='tenant'`；seed 只维护 builtin |
| N0.6 | **event/audit 保留期** | 两表无清理；payload/PII 永久保留 | 终态 event/audit 按天清理；文档写窗口 |
| N0.7 | **MCP `check_rule` 与 HTTP/worker 同源** | 缺 `resolveDeptMembers` / `configured` | 同一规则三入口结论一致；回归测试 |
| N0.8 | **直连通道健康假红** | `/channels/:id/health` 只查桥 env | direct 读 probe/凭据；不再写 error health |
| N0.9 | **生产 preflight 3 条 no_recipient** | aftersales / integration.stale / data.metric | 补持有者 / literal 兜底 / 停用，三者选一；preflight exit 0 |

### 5.2 N1 — 双平面事件目录

- 迁移：`notify.agent_namespace`（org, namespace, display_name, owner_user_id, status, policy）
  + `notify.event_decl`（org, namespace, key, version, title, scope_key, payload_schema, recipients, defaults, status）。
- 解析：`resolveEventDecl(org, key)` = 平台目录（manifest，内存）→ 租户声明（DB）；
  `ext.` 前缀保留，模块 manifest 不得使用。
- 触达：worker `getEventDecl(org, key)`；HTTP `/emit`；MCP `get_event`/`list_events`；preflight。
- 声明面：`POST/GET /agent/namespaces`、`POST/PUT/GET /agent/events`，`notify:manage` + owner 校验。
- 版本：payload 只增不改；删字段/改类型 = 新 key；`version` 递增。
- 验收：agent 声明 `ext.ns.event` → `/emit` → in-app 投递；跨 namespace 拒绝；平台事件零变化。

### 5.3 N2 — 模板/规则归属 + 通用消息

- `notify.template` / `notify.rule` 增加 `owner_namespace`；builtin/system 为 null。
- N0.5 的 fork 语义复用到 agent；agent 只能改自己 namespace 的模板/规则。
- 通用事件 `ext.<ns>.message`（保留，无需声明行）+ 内置模板 + 默认 in-app 规则。
- `send_message`（to/title/body/link）一次调用；默认 in-app，外发走 N3。
- 验收：agent 事件 → 自建模板 → 自建规则 → 投递；`send_message` 一条命令到收件箱。

### 5.4 N3 — 爆炸半径策略 + 审批 + 配额

- `notify.agent_policy`：allowed_channels、auto_publish_external、max_recipients、max_active_rules。
- `notify.approval`：pending/approved/rejected；模板/规则/排班三类。
- 判据：in-app + 本租户成员 ⇒ 自动；企微/外发 ⇒ 预授权或人审；webhook ⇒ 默认人审。
- 配额：事件/分钟、收件人/事件、排班数、每日 occurrence、payload ≤16KB。
- 验收：未审批外发不生效；审批后生效；超配额 429；审批请求本身走 in-app。

### 5.5 N4 — 调度器接缝

- 消费宿主注入的 `SchedulerPort`（P3）；通知**不直连 `platform.job_*`**。
- 工具：`create_schedule / list_schedules / pause_schedule / delete_schedule / list_job_runs / run_schedule_now`。
- `notify.emit` handler 已在 PR #2169；一次性延迟已在同 PR。
- 依赖：W6-P3 的 agent 排班面 + `SchedulerPort`。
- 验收：agent 建 `notify.emit` 排班；cron 到点入队；重复 occurrence 不双发；pause/delete 生效。

### 5.6 N5 — 运营/规模化收口

- job 生命周期事件（`jobs.job.failed/timeout/dead`）经 notify 投递（依赖 W6-P4 的声明归属）。
- per-namespace 指标：事件量、投递成功率、dead、延迟积压；console 过滤/分页。
- 保留期：event/audit/delivery.rendered 的窗口与脱敏。
- 单 worker 公平性：按 org 轮询、每批规则缓存、probe 并发/拆 job。
- 收件箱权限模型：任意已认证用户读自己的行，或 `notify:view` 默认授予成员。
- 验收：per-namespace 可观测；无静默积压；规模压测达标。

---

## 6. 调度器板块（并行线）

| 期 | 内容 | 对通知的影响 |
|---|---|---|
| **W6-P1** | 三表 + cron + registry + scheduler loop + 台账 + healthz；迁 `notify.reconcile` / `metric-candidates` / `report-scope-scan` | 我们只需保证 `notify-reconcile` 退出码 0/1/2 兼容；**不开 agent 面** |
| **W6-P2** | 迁 `preflight/retention`；`seed` 启动期化、`health` 并入 loop | 我们的 `eventsDueStale` 判据要一并带过去 |
| **W6-P3** | agent 排班面 + `SchedulerPort` | N4 的入口 |
| **W6-P4** | job 生命周期事件 | N5 的入口；声明归属待裁决（倾向最小 `jobs` 模块） |

---

## 7. 防漂移规则（评审红线）

1. **单调度者**：通知不再有独立 scheduler；不建 `notify.schedule`。
2. **平台事件 manifest 是事实源**；租户/agent 事件在 `notify.event_decl`，不得写进 `platform.event_catalog`。
3. **agent 不能注册 handler**：只能排已注册 key（v1 仅 `notify.emit`）。
4. **通道平台预备**：v1 不做 agent 自助接通道/录凭据；飞书/钉钉不在 N0–N3。
5. **payload 只增不改**：删字段/改类型 = 新 key；`version` 递增。
6. **所有写操作落 `notify.audit`**；org 只来自 identity；namespace owner 校验。
7. **不做条件/延迟规则/DAG/回填/偏好中心**；调度器只做 cron + 台账。
8. **不把 job 参数拼 shell**：`JOB_PARAMS` 走 stdin；argv 数组 spawn。

---

## 8. 验收指标

| 指标 | 目标 |
|---|---|
| 新通知接入是否需要改代码/发版 | 0（事件 + 模板 + 规则自助即可） |
| “声明了但没 seed/没规则”的静默事件 | 0（`defaults` 派生 + preflight 红） |
| 写操作审计覆盖率 | 100% |
| 静默失败（no_rules/no_recipients/no_channel/eventsDueStale） | 全部可见并可判红 |
| 外发未审批 | 0 |
| 周期排班走通知自带 scheduler | 0（全部 `platform.scheduler`） |
| 生产 preflight | exit 0 |
| agent 周期通知端到端 | 1 条实证（声明 → 模板 → 规则 → 排班 → 投递） |

---

## 9. 候选池 / 开放问题

- 收件箱权限模型：`notify:view` 是否默认授予所有成员？
- job 生命周期事件归属：最小 `jobs` 模块 vs 宿主层事件声明面。
- 通道自助：`POST /channels` + 凭据录入 UI 是否进 v1？
- 事件/audit 保留窗口：30/90/180/365 的最终口径。
- 规则版本化/回滚：是否做 rule revision，还是只靠 audit？
- 事件 replay：`no_rules` 的事件在配置规则后是否可补发？
- 多 worker 公平性：按 org 轮询的阈值与实现。

---

## 10. 变更记录（append-only）

| 日期 | 变更 | 理由 |
|---|---|---|
| 2026-11-14 | 建图：汇总 2026-11-09 架构审视、产品目标、D1–D8 定案、合并版调度器 spec/plan、PR #2169 状态 | 用户要求“整体创建开发地图，结合最早分析做开发计划” |
