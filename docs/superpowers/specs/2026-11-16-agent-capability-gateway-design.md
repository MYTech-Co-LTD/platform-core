# Agent 能力网关：统一 MCP 入口 + 按权限加载能力

> 状态：**设计已确认（2026-11-16，用户逐项拍板）**。
> 范围：A 子项目——统一 MCP 网关、能力目录、openclaw C 侧元工具、forms 纳入、notify 草稿策略。
> 上游：`docs/architecture.md` §1.5（三通道身份模型）、`docs/superpowers/specs/2026-11-09-unified-skill-management-design.md`（能力正文单源）。
> **必须同时对读的既有正典**：
> - 通知底座/agent 自助：`docs/superpowers/plans/2026-11-14-notification-platform-roadmap.md`（N1–N5；`notify:publish`、`create_agent_rule` 外发审批已存在）
> - 业务调度器：`docs/superpowers/specs/2026-11-14-business-scheduler-design.md` + `2026-11-14-scheduler-p1.md`（`platform.scheduler` 是唯一周期调度者）
> - 业务监控：`docs/superpowers/specs/2026-11-14-business-monitor-design.md`（`data.monitor`、`dry_run`、`data.monitor_tick`）
>
> **A 只做统一入口/能力投影，不重造 notify/monitor 的对象与政策**；notify 的 agent 自助沿用 N3，监控沿用业务监控 spec。B/C/D/E 是其后的独立子项目。
> 后续：B（业务监控工具接入网关）、C（监控执行器/按人裁剪）、D（人启用 console）、E（playbook 收口）；本 spec 已包含 playbook 的最小落点。

## 1. 问题

外部 agent（通道 B，PAT）与 openclaw（通道 C，企微 userid）都需要自主创建指标、报表、报表监控、通知、表单。现状：

- **B**：data / notify / forms 各有独立 MCP 端点，agent 要配多个 server，自己知道“建指标找 data、建通知找 notify”；
- **C**：openclaw 走 native plugin + 平台 HTTP，拿不到 B 的 MCP 工具面；管理类能力（建指标/报表/通知/表单）基本没有入口；
- **权限**：`tools/list` 不按调用方 scopes 裁剪；data 的 `requiredScope` 只是声明面，`callTool` 不校验；`data:read` 用户进不了 `/mcp`（门是 `data:query`）；notify 的只读工具被 `notify:manage` 门挡住；
- **外发**：notify 规则即时生效，与表单/报表/监控的“草稿 + 人启用”不一致。

**结论**：需要一套**能力核心 + 多个协议/身份适配器**：B 走 MCP 网关，C 走 native 元工具；`tools/list` 按身份投影，`tools/call` 同一授权核心执法。

**与既有正典的关系**：

- notify 的 agent 自助（事件/模板/规则/namespace/外发审批/配额/排班）已由通知底座 N1–N5 定义；A **不新增** `draft_rule`/`notify:publish`，只把 N3 的 agent-safe 工具面接进网关，并给 C 加一个更严的 profile。
- 报表监控已由业务监控 spec 定义（`data.monitor`、`dry_run`、`data.monitor_tick`）；A **不定义**监控对象，只在 B 把工具接入后由网关自动发现。
- 周期执行统一走 `platform.scheduler`；A 不新增 job/调度器。

## 2. 目标与非目标

### 2.1 目标

1. **一个 agent 入口**：B 只配一个 MCP server；C 只加两个 native 元工具。
2. **按权限加载能力**：`tools/list` 只返回调用方能调的工具；没权限的工具不出现；缺权限回 `missing_scope`（step-up）。
3. **一套能力核心**：工具元数据、scope、`callTool` 执法、审计只有一份；B/C 只是适配器。
4. **保留三通道身份模型**：A 会话、B PAT、C 渠道凭证 + 企微 userid；能力统一，身份不合并。
5. **外发人 gate**：表单发布、报表发布、监控启用、notify 规则启用都必须人做。

### 2.2 非目标

- 不合并三通道身份；不做 token 联邦/跨通道 token。
- 不做 scope 层级（`data:query ⊃ data:read` 之类）；用 **face 门 + 工具级附加 scope**。
- 不做网关侧模块特例（data 的 legacy 工具策展归模块）。
- 不做网关自动重试（写工具非幂等）。
- 不做 tool search（工具量未到；先分页 + 策展面）。
- 不做 agent 发布/启用（表单、报表、监控、notify 规则）。
- 不改授权核心、HTTP 面业务行为（除 notify 草稿/启用 scope 与新增 face）。

## 3. 决定

| # | 决定 | 理由 |
|---|---|---|
| D1 | **能力核心在模块侧**：`tools/list` 投影 + `callTool` 执法；网关只聚合/路由 | 模块是唯一执法点；网关不做第二套授权 |
| D2 | **scope 模型 = face 门 + 工具级附加 scope** | face 是最低权限；工具级只表达“同 face 内更细的权限”；无层级、无回归 |
| D3 | **face 按 group + precedence 选最高可用面** | 避免同工具多 face 重复/去重/描述漂移；工具名只带模块前缀 |
| D4 | **模块自建 agent face**（data `/mcp-read`、`/mcp-curated`；notify `/mcp`；forms `/mcp`） | 策展归模块；网关零特例；现有端点保留给直连客户端 |
| D5 | **网关双身份适配 + 内部签名身份** | B= PAT/session；C= channel key+userid；网关解析一次，下游免二次 Casdoor |
| D6 | **C 只走 manage audience，数据查询仍走静态工具** | 查询面成熟、有 eval；管理面用元工具；边界是结构，不靠提示词 |
| D7 | **可写外发全部草稿 + 人 gate**：表单 `forms:publish`、报表发布、监控按业务监控 spec 的 `dry_run` 显式开启、notify 按 N3 审批 + `notify:publish` | 与团队“外发/不可撤回人审”原则一致 |
| D8 | **notify 复用 N3，不另造政策**：C 的 manage profile 只暴露 agent-safe 工具（`create_agent_rule`/`create_agent_template`/`send_message`/排班/只读）；`propose_rule`/`update_rule`/`set_rule_enabled`/`draft_template` 不暴露给 C；C 规则落 pending/disabled，人用 `notify:publish` 审批/启用 | 与通知底座 N1–N5 正典一致；不重复造 `draft_rule`/新权限 |
| D9 | **能力目录机械**：`agent__capabilities` 只回 faces/tools/scopes/audience；recipes 放 playbook | 避免第二事实源 |
| D10 | **工具名 `<module>__<tool>`** | 稳定、兼容 MCP 命名、避免点分隔歧义 |
| D11 | **网关不是授权边界**：模块 host gate + `callTool` 才是；网关过滤是 UX | 防止“隐藏即安全”的误判 |
| D12 | **legacy 每指标工具不进网关** | 工具面预算/模型可靠性；直连 `/mcp` 仍保留 |
| D13 | **audience/profile = 发现/产品面；module scope + `identity.channel` = 执法** | C 的 notify 更严策略必须在 notify 模块按通道强制；网关头/`x-agent-profile` 可被直连绕过，不能当安全边界 |
| D14 | **C 的 agent namespace 由部署钉死**，不由模型选 | 防跨 namespace；notify 的 owner 校验只作兜底 |

## 4. 架构

```
                    能力核心（模块侧）
        tool metadata / face scope / requiredScope
        tools/list 投影 / callTool 执法 / 审计
          data        notify        forms
             │           │           │
     ┌───────┴───────────┴───────────┴────────┐
     ▼                                        ▼
 A 平台内 agent-loop                  B/C 统一网关 /api/agent/mcp
 （直接 toolset）                     ├ PAT/session  → audiences: [mcp]
                                      └ channel key+userid → [wecom]
                                                │
                                      ┌─────────┴─────────┐
                                      ▼                   ▼
                               B 外部 MCP agent      C openclaw
                               （多工具）            platform_capabilities
                                                     platform_call
                                                     （只 manage 面）
```

## 5. manifest `mcpFaces`

### 5.1 字段

```yaml
mcpFaces:
  - face: read            # 唯一；[a-z][a-z0-9_-]*
    group: agent          # 同 group 内按 precedence 选面
    precedence: 1         # **数字大的优先**（更高权限面）
    path: /mcp-read       # 必须已在 api.internal 中以 POST + 同 scope 声明
    method: POST
    scope: data:read      # face 最低权限
    audiences: [mcp]      # mcp = PAT/session；wecom = 渠道身份
    profile: full         # 可选；缺省 full。网关下发给模块的内部头 x-agent-profile
```

### 5.2 各模块 face

**data**

```yaml
mcpFaces:
  - { face: read,   group: agent,  precedence: 1, path: /mcp-read,    method: POST, scope: data:read,  audiences: [mcp] }
  - { face: agent,  group: agent,  precedence: 2, path: /mcp-curated, method: POST, scope: data:query, audiences: [mcp] }
  - { face: manage, group: manage, precedence: 1, path: /mcp-manage,  method: POST, scope: data:manage, audiences: [mcp, wecom] }
```

- `/mcp-read`：只读工具（`data_agent_guide`、`data_harness_catalog`、`search_catalog`、`describe_metric`、`describe_dataset`、`get_freshness`、`get_quality`、`get_lineage`）。
- `/mcp-curated`：13 个分析师工具 + `query_detail`，**不含 legacy 每指标工具**。
- `/mcp-manage`：现有 11 个管理工具（指标/报表/提案/需求），不变。
- 现有 `/mcp` 全量（含 legacy）保留给直连客户端，**不声明进 `mcpFaces`**。

**notify**

```yaml
mcpFaces:
  - { face: read,        group: notify, precedence: 1, path: /mcp,        method: POST, scope: notify:view,   audiences: [mcp] }
  # B（PAT/平台管理 agent）：N3 的完整 agent 面（含 propose_rule/set_rule_enabled/draft_template）
  - { face: manage,      group: notify, precedence: 2, path: /mcp-manage, method: POST, scope: notify:manage, audiences: [mcp],  profile: full }
  # C（openclaw）：agent-safe 子集；外发/启用一律 pending + 人审批
  - { face: agent-manage, group: notify, precedence: 2, path: /mcp-manage, method: POST, scope: notify:manage, audiences: [wecom], profile: c-manage }
```

- `/mcp`：只读工具（`list_events`、`get_event`、`list_rules`、`list_templates`、`get_template`、`list_deliveries`）。
- `profile=full`（B）：保持 N3 现有工具面，外发未预授权仍落 pending 审批。
- `profile=c-manage`（C）：只暴露 agent-safe 工具——
  `create_agent_rule`、`create_agent_template`、`send_message`、`check_rule`、`preview_template`、`send_test`、`list_deliveries` + 排班工具；
  **不暴露** `propose_rule`、`update_rule`、`set_rule_enabled`、`draft_template`。
- C 的 `create_agent_rule` 在该 profile 下**一律落 pending/disabled**（含 in-app），人用 `notify:publish` 审批/启用；这是 N3 `auto_publish_external` 之上的**更严档**，只作用于 C，不改 B/其他 agent。
- **执法点在 notify 模块，不在网关头**：`identity.channel === 'wecom'` ⇒ 强制 agent-safe 子集 + pending；即使直连 `/api/modules/notify/mcp-manage`、不带 profile、或伪造 `x-agent-profile: full`，`propose_rule`/`set_rule_enabled` 也必须被拒。`x-agent-profile` 只决定**发现视图**，不能覆盖 channel 策略。
- **C 的 namespace 钉死**：`create_agent_rule`/`create_agent_template`/`send_message` 的 `namespace` 由插件/网关注入为 openclaw 部署对应的 agent namespace；模型参数里不暴露 `namespace`。notify 的 owner 校验作兜底。
- `notify:publish` **已存在**（通知底座 N3/N5）；A 不新增权限码。

**forms**

```yaml
mcpFaces:
  - { face: read,   group: forms, precedence: 1, path: /mcp,        method: POST, scope: forms:view,   audiences: [mcp] }
  - { face: manage, group: forms, precedence: 2, path: /mcp-manage, method: POST, scope: forms:manage, audiences: [mcp, wecom] }
```

- `/mcp`：`list_forms`（复用 `GET /defs` 的 `listDefs` 摘要可见性，不回 draft body）。
- `/mcp-manage`：`list_forms` + `generate_form_draft`。
- 发布/回滚/退役（`forms:publish`）**不在任何 MCP face**。

### 5.3 校验

loader 与 `scripts/check-manifests.mjs` 校验：

- `path` 必须在 `api.internal` 中以 `POST` + **同一 scope** 声明；
- `face` 唯一；`group` 非空；`precedence` 为正整数；
- `audiences` ⊆ `{mcp, wecom}`；
- `profile` ∈ `{full, c-manage}`（可扩展；缺省 `full`）；
- 同一 `(module, group, audience)` 内 `precedence` 不重复；不同 audience 可重复（notify 的 B/C 同 group/precedence 但 audience 不相交）；
- 同一 `(path, method, scope)` 允许多个 face **仅当 audiences 不相交且 profile 不同**（如 notify 的 B full / C c-manage）；
- 装载期双向核对不变（路由集合 = 声明集合）。

## 6. 模块侧：face 与 scope 模型

### 6.1 face 门是最低权限

`mcpFaces[].scope` 是访问该 face 的最低权限，由宿主 `api.internal` 门卫施加。face 内的工具：

- `requiredScope: null`：face 门已足够；
- `requiredScope: <scope>`：在该 face 之上还需要的附加权限（如未来的 `data:cost`）。

**不做 scope 层级。** `data:query` 面包含读工具（`requiredScope: null`），所以只有 `data:query` 的用户仍能用读工具；只有 `data:read` 的用户走 `/mcp-read`。

### 6.2 `tools/list` 与 `callTool`

- 每个模块的 MCP `tools/list` 只返回 **该 face 内、调用方满足 `requiredScope`** 的工具。
- 每个模块的 `callTool`（data/notify/forms 各自的唯一分发点）在调用前检查 `requiredScope`；不满足回 `missing_scope` + scope。
- `data_harness_catalog` 等能力目录工具返回 `available` + `locked`（名称 + `faceScope`/`requiredScope`），供 step-up；`tools/list` 仍只返回可用的。

### 6.3 data 的具体变化

- 新增 `/mcp-read` 与 `/mcp-curated` 两个 face（复用 `registerMcpEndpoint`）；现有 `/mcp` 不动。
- `contract.json` / `ToolMeta` 增加 `faceScope`（data:read / data:query）与 `requiredScope`（null）；`data_harness_catalog` 输出两者。
- `callTool` 检查 `requiredScope`；read/query 工具的 `requiredScope` 为 null，face 门负责读/查。
- `agent-loop` 的工具列表复用同一投影函数，按 scope 过滤。
- openclaw 静态工具继续走 `/toolbox`（`data:query`）；`requiredScope` 为 null，不回归。
- `/mcp-read` 的 `data_agent_guide` 使用只读变体（或在共享正文后追加一句「查询/预览类工具需 `data:query`」），
  避免模型按七步工作流直接调 `preview_query`/`query_metric` 被拒；`data_harness_catalog` 标出 locked 的查询工具。

### 6.4 notify 的具体变化（对齐 N1–N5）

- 新增 `/mcp` 只读 face；`/mcp-manage` 保持现有端点，增加 **channel 感知**（不是网关头感知）：
  - `identity.channel === 'wecom'` ⇒ agent-safe 子集（见 §5.2），`tools/list` 过滤、`tools/call` 拒绝子集外工具；`create_agent_rule` 强制 pending/disabled；`namespace` 钉死为 C 的 agent namespace；
  - `identity.channel === 'pat'|'session'` ⇒ N3 现有 full 面，行为不变。
- `x-agent-profile` 只作为发现视图提示（网关设 `full`/`c-manage`）；**模块以 channel 为准**，`wecom + full` 仍按 C 更严档，直连不带 profile 也一样。
- `NOTIFY_TOOLS` 增加 `mutating`/`requiredScope`/annotations；`tools/list` 按 channel + scope 投影。
- **不新增** `draft_rule` / `notify:publish`：C 的 `create_agent_rule` 强制 pending/disabled，复用 N3 `notify.approval` + `notify:publish`。
- N3 的 in-app 自动/外发审批不变；C 的“连 in-app 也 pending”是 **channel 级更严档**，不影响 B/其他 agent。

### 6.5 forms 的具体变化

- 抽出 `modules/forms/mcp-tools.ts`（纯元数据）：`FORMS_MAX_TOOLS = 2`；`list_forms`（read-only）、`generate_form_draft`（mutating，`forms:manage`）。
- 新增 `/mcp` 只读 face（`forms:view`），只暴露 `list_forms`。
- `/mcp-manage`（`forms:manage`）暴露两个工具。
- `forms` 的 `callTool` 增加工具级 scope 检查与 MCP 审计（`forms.mcp_audit`：org/userId/tool/args 摘要/outcome/assetId/version）。
- `generate_form_draft` 只建 draft；返回 `next: '需人在控制台发布'`；不暴露 publish/rollback/retire。
- `scripts/check-mcp-toolface.mjs` 纳入 `FORMS_TOOLS`。

## 7. 网关

### 7.1 路由与身份

- 路由：`POST /api/agent/mcp`（host 路由，挂在 `/api/agent/*`）。
- 身份适配器（复用现有中间件）：
  - **B**：`patIdentityMiddleware`（PAT/session）→ `channel: 'pat'|'session'` → audience `mcp`。
  - **C**：`wecomChannelIdentityMiddleware`（`x-channel-key` + `x-wecom-userid` + `x-session-id`）→ audience `wecom`。
- 网关解析一次身份后，**内部转发不再带原 token/渠道头**：
  - 生成 `x-internal-identity: <payload>.<hmac>`，payload = `{org, userId, accountName?, channel, keyId?, scopes, sessionId?, exp}`；
  - HMAC 用进程内随机密钥（启动生成，不落盘）；TTL 30s；
  - 模块的 PAT/企微中间件先验内部头；有效则直接构造 identity，**不再查 Casdoor**；
  - 外部请求伪造内部头 ⇒ 401；网关剥掉客户端传入的 `x-internal-identity`。
- 网关的模块转发只带内部头 + `content-type`；不带 `authorization`/`cookie`/`x-channel-key`/`x-wecom-userid`。
- **客户端传入的 `x-internal-identity` 与 `x-agent-profile` 一律剥掉**；网关自己生成内部身份，profile 只作发现视图。
- **profile 不是安全边界**：notify 的 C 更严策略由模块按 `identity.channel` 执法；`wecom + profile=full` 也走 C 档。

### 7.2 face 选择与工具命名

- 对每个 `(module, group)` 选调用方 `hasScope(face.scope)` 为真、且 `audiences` 含当前通道的**最高 precedence face**；不探测、不试错。
- 同一 `(path, method, scope)` 的多个 face（如 notify B/C）按 audience 区分；转发时带该 face 的 `x-agent-profile`。
- **audience/profile 只做发现/产品面**；安全相关的差异（notify 的 C 档）由模块按 `identity.channel` 强制，直连模块也不能绕过。
- 只暴露该 face 的工具；工具名 `<module>__<tool>`，不带 face。
- 不同 `(module, group)` 的工具名必须全局唯一；发现期冲突 ⇒ 报错，不静默去重。
- `tools/call` 只接受 `tools/list` 投影过的名字；未知名 ⇒ JSON-RPC `-32601`。

### 7.3 `tools/list`

- 逐可见 face 调模块 `tools/list`（内部身份头 + `x-agent-profile`），合并、命名空间化。
- 支持 `cursor`/`nextCursor`；每页字节上限（建议 10KB）；工具数上限（建议 100）。
- 缓存 `(org, scope-hash, audience, module, face, profile)` 30s；scope 变化即失效；同一个 `(path, scope)` 的 B/C face 不会串缓存。
- 模块 face 403/5xx ⇒ 该 face 标记 unavailable，不影响其他 face。

### 7.4 `tools/call`

- 解析 `<module>__<tool>` → 查 face 映射（缓存）；校验 audience + face scope；转发模块 face 的 `tools/call`（带 `x-agent-profile`）。
- 缓存未命中（scope 变更/工具新增）⇒ 刷新一次 `tools/list` 再查；仍不中 ⇒ `-32601`，不盲目转发。
- 透传 `content` / `isError` / `structuredContent` / `annotations` / `outputSchema`。
- 超时：默认 60s；`forms__generate_form_draft` 120s（LLM）；客户端断开时取消。
- 限流：每 token/per-tool 简单令牌桶（默认 60 次/分钟）；超限回工具级 `rate_limited`。
- 错误映射：
  - 模块 403 ⇒ 工具级 `{status:'denied', reason:'missing_scope', scope}`；
  - 模块 5xx/不可达 ⇒ `{status:'error', reason:'module_unavailable'}`；
  - 未知命名空间 ⇒ JSON-RPC `-32601`；
  - 模块 JSON-RPC error ⇒ 原样透传，`id` 换成调用方 id。
- 不自动重试。

### 7.5 `agent__capabilities`

- 内置只读工具；返回：
  - `faces`: `{module, face, group, audience, scope, available}`；
  - `tools`: 当前可用的 `{name, module, face, mutating, annotations, requiredScope}`；
  - `lockedFaces`: `{module, face, scope}`（不可用 face 只报 face + 所需 scope，**不报工具名**——网关没有权限替调用方枚举该 face 的工具）；
  - `notes`: 人 gate 清单（forms:publish / report publish / monitor dry_run 开启（B spec） / notify:publish）。
- data 的 locked **工具**可由 `data_harness_catalog` 提供（它返回 `available`/`locked` + `faceScope`）；notify/forms 暂无 catalog 时只报 `lockedFaces`。
- **不放 recipes**；`initialize.instructions` 指向 playbook。
- 输出大小受 `tools/list` 分页约束；只读、无租户数据。

### 7.6 审计与开关

- 网关审计（结构化日志或平台审计表）：caller/channel/module/face/tool/latency/outcome；**不记 token/args**。
- 模块审计保留业务动作；data 的 `callTool` 仍记 `data.query_audit`；notify 记 `notify.audit`；forms 新增 `forms.mcp_audit`。
- `AGENT_MCP_ENABLED`（默认按部署开启）；关闭时 `/api/agent/*` 404。

## 8. openclaw C 侧

- 新增两个 native 工具（`deploy/openclaw/data-query-plugin/index.js`）：
  - `platform_capabilities({ q?, tool? })`：用 `requesterSenderId` + `x-channel-key` + `x-session-id` 调网关的 **`agent__capabilities`**（available + lockedFaces + scope）；只返回 `wecom` audience（manage 面）。
    - 无参：返回**紧凑索引**（name + 一句话描述 + mutating/gate）+ `lockedFaces`（如缺 `data:manage`），不返回全部 schema；
    - `q`：按关键词过滤；`tool`：返回单个工具的完整 inputSchema（供 `platform_call` 组装参数）；
    - schema 取自网关 `tools/list`；内部按 `nextCursor` 翻页合并。
  - `platform_call({tool,args})`：调网关 `tools/call`；**不接受 userId 参数**。
  - **namespace 钉死**：对 notify 的 `create_agent_rule`/`create_agent_template`/`send_message`，插件注入 openclaw 部署对应的 agent namespace，模型参数里没有 `namespace`。
- 现有静态查询工具保留，SKILL 明确：
  - **数据查询只用静态工具**；
  - **建指标/报表/监控/通知/表单草稿用 `platform_capabilities` → `platform_call`**。
- 结果映射：MCP `content/isError/structuredContent` → openclaw tool result。
- env：`AGENT_API_BASE=http://server:13000/api/agent`。
- `openclaw.plugin.json` `contracts.tools` + `package.json`/部署 `tools.allow` 加两个工具。
- SKILL 增加「平台能力管理」节：
  1. 先 `platform_capabilities`，只调返回列表里的工具；
  2. 写操作先向用户确认；
  3. 创建只产出草稿；发布/启用告诉用户去 console；
  4. `missing_scope` 如实转告，让用户找管理员授权；
  5. 不要原样重试；`asset_id_taken`/`TITLE_TAKEN` 先 list 查重。

## 9. 安全政策（人 gate 清单）

| 对象 | agent 能做 | 人 gate | 门 |
|---|---|---|---|
| L2 指标 | 建/删（即时生效） | — | `data:manage` |
| L1 指标 | 提案 draft PR | 人 merge PR | `data:manage` |
| 报表 | 提/改未发布 | 发布/回收 | `data:manage` / console |
| 报表监控 | 提/改/停用；默认 `dry_run=true`（B 子项目，按业务监控 spec） | 显式开启投递（人） | 业务监控 spec 的开启动作 |
| 通知规则 | C：`create_agent_rule` 落 pending/disabled；B：N3 的 in-app 自动 / 外发审批 | 审批/启用 | `notify:publish`（人） |
| 通知模板 | 写草稿（C 用 `create_agent_template`，publish=false） | 发布 | `notify:publish`（人） |
| 表单 | 起草 | 发布/回滚/退役 | `forms:publish`（人） |

- agent 面不暴露 publish/enable 类工具。
- 所有写操作审计；网关不记 token/args。
- 缺失权限回 `missing_scope`；能力目录显示 locked + 所需 scope。

## 10. 能力目录与 playbook

- `docs/agent-playbook.md`（或 `.claude/skills/agent-capabilities`）：recipes、scope、step-up、错误处理、人 gate。
- 网关 `initialize.instructions` 只指向 playbook + 一句命名空间约定。
- 插件 `platform_capabilities` 的说明也指向 playbook。
- recipes（playbook）：
  1. L2 指标：`data__list_metrics` → `data__customize_metric` → `data__describe_metric`。
  2. L1 指标：`data__propose_metric_declaration` → `data__apply_pipeline_proposal`（人 merge）。
  3. 报表：`data__list_reports` → `data__propose_report`（人发布）。
  4. 通知：`notify__list_events` → `notify__create_agent_rule` → `notify__check_rule`（C 落 pending；人 `notify:publish` 审批/启用）。
  5. 表单：`forms__list_forms` → `forms__generate_form_draft`（人发布）。
  6. 监控（B）：按 `2026-11-14-business-monitor-design.md` 新增工具后由 `mcpFaces` 自动发现；默认 `dry_run=true`，人显式开启投递。A 不定义监控工具名。

## 11. 错误处理

| 场景 | 网关/模块行为 |
|---|---|
| 缺 face scope | 模块 host gate 403；网关翻成工具级 `missing_scope` + scope |
| 缺工具附加 scope | 模块 `callTool` 回 `missing_scope` + scope |
| face 不可用/5xx | 网关标记 unavailable；调用回 `module_unavailable` |
| 未知命名空间 | JSON-RPC `-32601` |
| 超时 | 工具级 `timeout`；不自动重试 |
| 限流 | 工具级 `rate_limited` |
| 内部身份头伪造/过期 | 模块 401；网关不转发客户端同名头 |
| 写工具重名/陈旧版本 | 模块原错误码透传（`asset_id_taken`/`TITLE_TAKEN`/`STALE_WRITE`） |

## 12. 迁移与兼容

1. **新增 face 是加法**：`/mcp-read`、`/mcp-curated`、notify `/mcp`、forms `/mcp`；现有 `/mcp`、`/mcp-manage` 继续存在。
2. **data**：`contract.json`/`ToolMeta` 增加 `faceScope`；read/query 工具 `requiredScope` 置 null；`data_harness_catalog` 输出两者；`callTool` 加检查。现有 `data:query` 用户不回归（读工具 null）。
3. **notify**：`pat/session` 直连 `/mcp-manage` ⇒ N3 full 不变；**`wecom` 直连 ⇒ C 档（agent-safe 子集 + 规则 pending，刻意更严）**；网关对 C 设 `c-manage` 只是发现视图。**无新权限码、无 `draft_rule`**；`notify:publish` 已存在，沿用 N3 审批。
4. **forms**：新增读 face、`FORMS_TOOLS`、审计表；`generate_form_draft` 行为不变（draft-only）。
5. **openclaw**：加两个元工具；静态工具不动；部署更新 `AGENT_API_BASE` 与 `tools.allow`。
6. **网关**：新路由；`AGENT_MCP_ENABLED` 可关闭；直接模块端点不受影响。

## 13. 测试与验收

### 13.1 模块

- data：`/mcp-read` 只回读工具；`/mcp-curated` 13+query_detail、无 legacy；`data:query` 用户读/查都可用；`data:read` 用户查询工具不可见/`missing_scope`；`callTool` 工具级 scope。
- notify：`/mcp` read face（notify:view）；`pat/session` 的 `/mcp-manage` 保持 N3 full；**`channel=wecom` 无论带不带 profile、带 `full` 还是 `c-manage`，都只回 agent-safe 子集且 `create_agent_rule` 落 pending**；`propose_rule`/`set_rule_enabled` 不可见/调用必拒；`notify:publish` 审批/启用。
- notify 直连测试：用 `x-channel-key`+`x-wecom-userid` 直接打 `/api/modules/notify/mcp-manage`（不带 profile、以及伪造 `x-agent-profile: full`）⇒ 仍看不到/调不了 `propose_rule`/`set_rule_enabled`。
- forms：`/mcp` 只 `list_forms`；`/mcp-manage` 两工具；`generate_form_draft` 落 draft；无 publish；`forms.mcp_audit` 每次调用一行。
- `check-mcp-toolface` 覆盖 data/notify/forms；`check-manifests` 覆盖 `mcpFaces`。

### 13.2 网关

- 双身份：PAT、channel key+userid；channel key 错/缺 userid ⇒ 401。
- 内部签名身份：模块只解析一次；伪造/过期头 ⇒ 401；客户端传入同名头被剥掉。
- **客户端传入 `x-agent-profile` 被剥掉**；`wecom + profile=full` 仍走 C 档（模块 channel 执法）；B 不受影响。
- face 选择 + audience：C 只 manage；B 按 scope 见 read/query/manage；同名工具不同 group ⇒ 发现期报错。
- 缓存 key 含 face/profile：notify B/C 同 path/scope 不串缓存。
- `tools/list` 分页/字节上限/缓存；`tools/call` 超时/限流/错误映射/透传 structuredContent。
- `agent__capabilities` 只读、无租户数据、locked 带 scope/face；data 的 locked 工具由 `data_harness_catalog` 补。
- 无 token/args 审计；`AGENT_MCP_ENABLED=false` ⇒ 404。

### 13.3 openclaw

- `platform_capabilities` 只返回 manage 工具；`platform_call` 不能调查询工具（audience）。
- `platform_capabilities` 无参返回紧凑索引 + `lockedFaces`（调 `agent__capabilities`）；`tool=<name>` 返回完整 schema；`q` 过滤；`nextCursor` 翻页合并。
- `platform_call` 不接受 userId；身份只来自 `requesterSenderId`。
- **namespace 钉死**：`create_agent_rule`/`create_agent_template`/`send_message` 的 namespace 由插件注入；模型传别的 namespace 被忽略/拒绝。
- 静态查询工具回归全绿；`contracts.test.js` 含两个新工具。
- SKILL 文案：草稿/人 gate/step-up/不重试；C 的 notify 规则一律 pending。

### 13.4 端到端

- PAT `data:read`：只读面；`data:query`：读+查；`data:manage`：manage。
- PAT `notify:view`：读；`notify:manage`（B profile=full）：按 N3 建规则（in-app 自动 / 外发 pending）；C profile=c-manage：规则一律 pending；无 `notify:publish` 不能审批/启用。
- 企微用户 `forms:manage`：`platform_capabilities` 含 forms；`platform_call` 建 draft；不能发布。
- 跨模块 recipe：建 L2 → 提报表 → 建 notify draft → 建 form draft，全部按权限与 gate。

## 14. 风险与开放问题

| # | 风险/问题 | 处置 |
|---|---|---|
| R1 | 内部签名身份需要所有模块中间件改造 | 先做 host 共享中间件；模块无需逐个改；loader 注入 |
| R2 | notify 直连客户端行为变化 | pat/session 直连保持 N3 full；**wecom 直连也走 C 档**（这是刻意的更严策略，需在迁移说明中写明） |
| R3 | C 的 manage audience 只覆盖 manage；C 用户想用网关查数 | 明确不支持；查数走静态工具 |
| R4 | `data:read`/`data:query` 的权限发放 | 现有用户不改；read 面新增；查询面读工具 null 不回归 |
| R5 | forms `generate_form_draft` LLM 慢/失败 | 网关 120s；错误透传；SKILL 不重试 |
| R6 | notify `notify:publish` 的授权 | **已存在**（N3/N5；N0.9 已给两套生产的租户管理员授过）；A 不新增码，只确认 C 用户不持有它 |
| R7 | 网关缓存与 scope 变更 | 缓存 key 含 scope-hash + face + profile；TTL 30s |
| R8 | 工具面过大 | 分页 + 字节上限 + curated 面；不做 tool search |
| R9 | **C 直连模块绕过网关头** | 模块按 `identity.channel` 执法；`wecom` 无论 profile/直连都走 C 档；加直连变异测试 |
| R10 | **C 的 namespace 由模型选** | 插件/网关注入固定 namespace；模型参数不暴露；owner 校验兜底 |
| R11 | **`x-agent-profile` 伪造** | 网关剥客户端同名头；模块以 channel 为准，profile 只作展示 |

## 15. 参考

- `docs/architecture.md` §1.5（三通道身份）、§14.6b（AI 写边界）
- `docs/superpowers/specs/2026-11-09-unified-skill-management-design.md`（能力正文单源）
- `apps/server/src/app.ts`、`apps/server/src/loader.ts`（中间件顺序、模块挂载）
- `apps/server/src/pat-auth.ts`、`apps/server/src/wecom-channel-auth.ts`（身份适配）
- `modules/data/routes/mcp.ts`、`mcp-manage.ts`、`domain/toolbox/registry.ts`
- `modules/notify/mcp.ts`、`mcp-tools.ts`、`manifest.yaml`
- `modules/forms/mcp.ts`、`manifest.yaml`、`storage.ts`
- `deploy/openclaw/data-query-plugin/index.js`、`lib.js`、`openclaw.plugin.json`
- `packages/platform-sdk/src/manifest.ts`、`scripts/check-manifests.mjs`、`scripts/check-mcp-toolface.mjs`
