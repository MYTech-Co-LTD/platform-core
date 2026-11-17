# agent playbook：外部 agent 与 openclaw 的平台能力使用手册

> 面向两类调用方：**B（外部 agent，PAT / 平台会话）** 与 **C（openclaw，企微 userid）**。
> 本文只写「怎么用 + 指针」：scope 语义、协议正文、face 设计依据的正典是
> `docs/superpowers/specs/2026-11-16-agent-capability-gateway-design.md` 与
> `docs/module-protocol.md`「agent 能力面：mcpFaces」节；架构背景见 `docs/architecture.md` §1.5.1。
> **scope 总表、工具清单以各模块 `modules/<id>/manifest.yaml` 的 `permissions[]` / `mcpFaces[]`
> 与模块代码为准**——本文不复述全表，列出的名字是常用速查，不是授权面。

## 1. 入口与协议

- **唯一入口**：`POST /api/agent/mcp`（JSON-RPC 2.0；协议版本 `2025-11-25`）。
- 方法：`initialize` / `ping` / `tools/list` / `tools/call`；未知方法回 JSON-RPC `-32601`。
  通知（无 `id`）回 202 无 body，不产生结果。
- 工具名：`<module>__<tool>`（如 `data__list_reports`）；另有内置发现工具 `agent__capabilities`。
- 身份（二选一，**不合并**）：
  - **B（PAT / 平台会话）**：`Authorization: Bearer dkq_…`（个人 Key，
    `apps/server/src/pat-auth.ts`）或平台 session（登录后的浏览器/系统内会话）。PAT 的
    scopes **每次请求实时向 Casdoor 取**（吊销/禁用后下一次请求立即 401）；PAT 侧限速
    60 次/分钟/密钥。
    两者在网关同属 audience `mcp`（channel `pat` / `session`，spec D5）。
  - **C（openclaw）**：`x-channel-key`（部署级渠道凭证）+ `x-wecom-userid`（企微 userid），
    可选 `x-session-id`（`apps/server/src/wecom-channel-auth.ts`）。身份 = 渠道凭证反查 Casdoor。
- **网关只做投影/路由**（face 选择 + 命名空间 + 转发），**授权在模块**：face 门
  （manifest `api.internal` 的 scope）+ 工具级 `requiredScope`（模块 `tools/list`/`callTool` 再判）。
  网关不做第二套授权，也不自动重试。
- **开关**：`AGENT_MCP_ENABLED=0` 关闭（缺省开启）；关闭后 `/api/agent/*` 一律 404。

## 2. 发现与授权

- **先调 `agent__capabilities`**：返回
  - `faces`：当前身份选中的面（module/face/group/audience/scope/available/reason）；
    `available:false` 时 `reason` 为 `module_disabled`（模块 404/未启用）或
    `module_unavailable`（5xx/超时/非法回包）；
  - `tools`：当前可用的工具（带 module/face）；
  - `lockedFaces`：**锁定面**——只报 face + 所需 scope + `reason:"scope_missing"`，不报工具名
    （网关无权替调用方枚举）；
  - `notes`：人 gate 清单。
- `tools/list` 只回调用方 scope 可见的工具（按 face 门 + 工具级 requiredScope 投影）；
  分页：`cursor`（非负整数字符串），每页 ≤50 个工具 / ≤10KB，续页带 `nextCursor`；坏 cursor ⇒ `-32602`。
- data 的锁定**工具**可由 `data__data_harness_catalog` 补（逐工具回 `available` 布尔 + 所需
  `requiredScope`；`available=false` 即该工具在当前 face 不可用（锁定），供 step-up 申请权限）。
- **错误与处置**（不要原样重试，按错误里的 scope/参数自纠一次）：

  | 错误 | 形态 | 下一步 |
  |---|---|---|
  | 缺 face scope | 工具级 `{status:'denied', reason:'missing_scope', scope}` | 向管理员申请该 scope；不要换工具试探 |
  | 缺工具附加 scope | 模块透传 `missing_scope` + scope | 同上 |
  | face 不可用/5xx | `{status:'error', reason:'module_unavailable'}` | 稍后再试；持续失败报障 |
  | 限流 | `{status:'error', reason:'rate_limited'}`（60 次/分钟/工具） | 等待窗口过去 |
  | 未知工具/方法 | JSON-RPC `-32601` | 回 `agent__capabilities` 查名单，不要凭记忆拼 |
  | 面外调用 | 模块工具级 `{status:'denied', reason:'unknown_tool', name}`（如 data read face 调查询/管理工具——本面没有该工具，不回退 full/legacy） | 处置同 `-32601`：回 `agent__capabilities` 查可用名单，不换工具试探 |
  | 网关内部错误 | JSON-RPC `-32603`（发现期工具重名 / 网关内部错误） | 不要原样重试；报告管理员 |
  | 参数坏 | `-32602`（cursor）/ 模块错误码透传 | 按错误 detail 自纠 |

- scope 命名速查（**以 manifest 为准**）：`data:read/query/manage`、
  `notify:view/manage/publish/emit`、`forms:view/manage/publish`。声明出处：
  `modules/data/manifest.yaml`、`modules/notify/manifest.yaml`、`modules/forms/manifest.yaml`。
- **“不可用”不等于“缺 scope”**：看 `reason`。`module_disabled` = 该租户没有启用模块
  （如山海未订阅 forms），申请 scope 也不会出现工具；`module_unavailable` = 模块临时故障；
  `scope_missing` 才是缺权限。不要把这三种混为一谈。
- **openclaw 工具为何不在清单**：openclaw 有三层白名单——全局 `tools.allow`、
  `agents.entries.<agent>.tools.allow`、按发送人的 `tools.toolsBySender`。三层都含该工具
  才会出现在模型清单；只改其中一层不会生效。排查时先看交集，不要用 `openclaw --help` 猜。

## 3. 各模块工具面（agent 面）

> 完整清单经 `agent__capabilities` / `tools/list` 实时取；下面只列**名字级速查**（已对照模块代码核实）。

### data（`modules/data`）

- **read face（`data:read`，audience mcp）**：8 个只读工具——
  `data_agent_guide`、`data_harness_catalog`、`search_catalog`、`describe_metric`、
  `describe_dataset`、`get_freshness`、`get_quality`、`get_lineage`。**无查询/下钻工具**。
- **curated face（`data:query`，audience mcp）**：13 个分析师工具（含 `preview_query`、
  `query_metric`、`explore_query` 等）+ 下钻 `query_detail`；**不含 legacy 每指标工具**。
- **manage face（`data:manage`，audience mcp + wecom）**：20 个工具 =
  指标 5 + 报表 4 + 管线/需求 11。关键工具：
  - 指标：`data__list_metrics`、`data__customize_metric`、`data__delete_custom_metric`、
    `data__submit_metric_change`、`data__list_metric_changes`
  - 报表：`data__list_reports`、`data__get_report_spec`、`data__propose_report`、
    `data__revise_report_spec`
  - 管线/提案：`data__list_pipelines`、`data__get_pipeline`、`data__list_pipeline_runs`、
    `data__get_pipeline_run`、`data__run_pipeline_sandbox`、`data__propose_pipeline_change`、
    `data__propose_contract_change`、`data__propose_metric_declaration`、
    `data__apply_pipeline_proposal`
  - 需求台账：`data__list_demand_signals`、`data__dismiss_demand_signal`
- 报表的**发布/回收不是工具**：`propose_report` 建出来的页门恒钉 `data:manage`（未发布态），
  agent 改不了；`revise_report_spec` 只对未发布报表生效。

### notify（`modules/notify`）

- **read face（`notify:view`，audience mcp）**：只投影非 mutating 工具（事件目录、规则/模板/
  投递的只读查询、`check_rule` 与只读排班等）；`requiredScope` 按**调用方 scope 过滤**
  ——仅持 `notify:view` 的调用方看不到 `preview_template` 这类要 `notify:manage` 的工具；
  同时持 `notify:view + notify:manage` 的调用方在本面能看到它们。
- **manage face（`notify:manage`）**，按通道分两档：
  - **B（pat/session，profile=full）**：N3 完整 agent 面（含 `propose_rule`/`update_rule`/
    `set_rule_enabled`/`draft_template` + 排班 8 工具；`notify:emit` 的直发工具也在 B 面，
    见 `modules/notify/mcp-tools.ts`）；外发未预授权仍落 pending 审批。
  - **C（wecom，profile=c-manage）**：agent-safe 子集——读工具（`list_events`/`get_event`/
    `list_rules`/`list_templates`/`get_template`/`list_deliveries`）+
    `check_rule`/`preview_template`/`send_test`/`create_agent_template`/`create_agent_rule` + 排班 8 工具。
    **不含 `send_message`**（C 不授 `notify:emit`）、**不含** `propose_rule`/`update_rule`/
    `set_rule_enabled`/`draft_template`。
  - 执法点在 notify 模块按 `identity.channel` 强制：直连 `/api/modules/notify/mcp-manage`
    或伪造 profile 都绕不过；profile 只决定发现视图。
- 排班 8 工具：`create_schedule`、`list_schedules`、`pause_schedule`、`resume_schedule`、
  `delete_schedule`、`list_schedule_runs`、`run_schedule_now`、`get_schedule_quota`
  （只发站内通知，不接受任何通道参数）。
- **无 publish/通道工具**：模板发布、通道配置、审批决策都不是 MCP 工具。

### forms（`modules/forms`）

- `forms__list_forms`（`forms:view`）：只读摘要，不回 draft body。
- `forms__generate_form_draft`（`forms:manage`）：**只落 draft**；assetId 重名会报错，先
  `list_forms` 查重。
- **无 publish/rollback/retire 工具**：`forms:publish` 是人 gate，不在任何 MCP face。

### 报表监控（`data.monitor`）

- **本网关（A 子项目）不定义任何监控工具**；监控属 B 子项目（正典：
  `docs/superpowers/specs/2026-11-14-business-monitor-design.md`）。接入后由
  `mcpFaces` 自动发现，默认 `dry_run=true`，投递开启必须人做。**不要凭记忆拼监控工具名。**

## 4. recipes（每步：工具 → 人 gate）

1. **L2 指标**（租户自定义口径，**提案制**，门 `data:manage`）：
   `data__list_metrics`（找基底/查重）→ `data__customize_metric`（提案式变更；或
   `data__submit_metric_change` 走变更单——**只提案不生效，等人工采纳**）→
   `data__list_metric_changes` 看采纳/驳回状态。
   采纳/驳回是人工决策，agent 没有工具可做（决策端点 PAT/企微一律 403
   `DECISION_REQUIRES_SESSION`，只认会话登录）。
2. **L1 指标声明**（平台口径，门 `data:manage`）：
   `data__propose_metric_declaration` → `data__apply_pipeline_proposal`（落盘并开 draft PR）
   → **人 merge PR**。
3. **报表**（门 `data:manage`）：
   `data__list_reports`（查重 + 看模板）→ `data__propose_report`（新建，未发布；页门钉
   `data:manage`）/ `data__revise_report_spec`（**仅未发布**，带 `expectedVersion`）→
   **人在 console 发布**（改页门）。
   - 版本语义：`version` 是草稿写入计数器；`publishedVersion` 是线上内容版本；
     `publishedDraftVersion` 是发布那一刻的草稿版本。三者是独立计数器——`version=21`、
     `publishedVersion=16`、`publishedDraftVersion=21`、`hasUnpublishedChanges=false`
     是合法状态，不代表线上就是 v21；确认线上版本读 `data__get_report_spec` 的
     `publishedVersion`/`publishedAt`。
4. **通知规则/模板**（门 `notify:manage`；审批/启用 `notify:publish`）：
   `notify__list_events`（选事件）→ `notify__list_templates`（看模板）→
   `notify__create_agent_template`（C 恒 `publish=false`）→ `notify__create_agent_rule`
   （C 一律 pending/disabled，含 in-app）→ `notify__check_rule`（自证「会发给谁/为什么发不出去」）
   → **人审批/启用**（`notify:publish`）。C 的 namespace 由服务端钉死，模板/规则入参不要传。
5. **表单**（门 `forms:manage`）：
   `forms__list_forms`（查重）→ `forms__generate_form_draft` → **人在 console 发布**
   （`forms:publish`）。
6. **业务监控**：`data__list_monitors` → `data__create_monitor`（**恒 dry_run=true**，只求值不投递）→ 人在控制台显式开启投递。目标只能是 `metric` 或 `report_panel`；`threshold` 仅支持可加指标。设计：`docs/superpowers/specs/2026-11-14-business-monitor-design.md`。
7. **agent 自有通知事件**：`notify__declare_agent_event`（key 必须 `ext.<namespace>.<event>`）→ `notify__create_agent_template` → `notify__create_agent_rule`（`draft:true`，C 无条件草稿）→ 人 `notify:publish` 审批/启用。平台事件（`data.*`）不能给 agent 建规则。

## 5. 人 gate 表（行为边界；正典 = spec §9）

| 对象 | agent 能做 | 人 gate | 门 |
|---|---|---|---|
| L2 指标 | 提建/删变更单（提案制，人工采纳） | 采纳/驳回 | `data:manage` |
| L1 指标 | 提案 draft PR | 人 merge PR | `data:manage` |
| 报表 | 提/改未发布 | 发布/回收 | `data:manage` / console |
| 报表监控 | 提/改/停用；默认 `dry_run=true`（B 子项目，按业务监控 spec） | 显式开启投递（人） | 业务监控 spec 的开启动作 |
| 通知规则 | C：`create_agent_rule` 落 pending/disabled；B：N3 的 in-app 自动 / 外发审批 | 审批/启用 | `notify:publish`（人） |
| 通知模板 | 写草稿（C 用 `create_agent_template`，publish=false） | 发布 | `notify:publish`（人） |
| 表单 | 起草 | 发布/回滚/退役 | `forms:publish`（人） |

agent 面不暴露 publish/enable 类工具；缺权限回 `missing_scope` + 所需 scope。

## 6. C（openclaw）特别约束

- **只走 manage audience**：能力目录只回各模块 manage 面；**数据查询继续用静态
  search/query 工具**（`deploy/openclaw/data-query-plugin` 的既有工具面），不走网关。
- 两个元工具（native，`deploy/openclaw/data-query-plugin/index.js`）：
  - `platform_capabilities({ q?, tool? })`：无参回紧凑索引（一句话描述 + mutating/gate）+
    `lockedFaces`；`tool=<name>` 回单个工具完整 inputSchema；
  - `platform_call({ tool, args })`：只调列表里的工具；**不接受 userId 参数**（身份只来自
    当前企微会话），`notify__*` 的 `namespace` 参数被插件剥掉。
- **notify namespace 是 service-owned、部署钉死**：服务端 env `NOTIFY_WECOM_NAMESPACE`
  指向 openclaw 专属 namespace（owner `system:openclaw`），模型传的 `namespace` 被忽略；
  未配置 ⇒ 相关工具回 `namespace_unconfigured`（fail-closed，不猜、不回落 org）。
- **notify 规则一律 pending/disabled**（连 in-app 也 pending，比 N3 更严、只作用于 C）；
  启用/恢复必须持 `notify:publish` 的人做——直连 HTTP 路由（规则启停/恢复）同样按
  channel/scope 拦。
- **C 不含 `send_message`**（不授 `notify:emit`）；需要发通知就建规则草稿等审批。
- openclaw 服务容器 env：`AGENT_API_BASE`（缺省 `http://server:13000/api/agent`）。
- **`exec` 不是平台能力**：它是 openclaw 本地工具，白名单由 `tools.toolsBySender` 按发送人
  维护（`*` 默认不含 `exec`，只给运维白名单用户）。`exec` 只能用于诊断；
  **locked 能力（如 forms）不得用 `exec` 或本地文件替代**，如实报 `reason` 即可。

## 7. 错误处理与反模式

- `missing_scope` → **如实转告缺哪个 scope**，让用户找管理员授权；不要换工具试探、不要重试。
- `asset_id_taken`（forms）/`TITLE_TAKEN`（report）→ **先 list 查重**（`forms__list_forms` /
  `data__list_reports`），换名或换 assetId，不要盲目重试。
- `BAD_PARAM` / `-32602` → 按 detail/inputSchema 自纠**一次**；再失败就停下来问人。
- `STALE_WRITE` → 带 `expectedVersion` 的写撞了版本，先重新 get 再改。
- `timeout` → 工具级超时（表单 LLM 起草 120s，其余 60s）；**不自动重试**——让用户稍后再试，
  或把一次起草的描述拆小/收窄范围再试。
- 反模式：不原样重试（写工具非幂等，网关也不自动重试）；不凭记忆拼工具名（先
  `agent__capabilities`/`platform_capabilities({ tool })`）；不用网关查数（C）；
  不把「tools/list 里没出现」理解成「重试几次就会出现」——那是 scope 锁定。

## 8. 内部身份信任边界（运维/平台侧须知）

- 网关 → 模块用进程内 HMAC 头 `x-internal-identity`：密钥 `randomBytes(32)` **进程启动生成、
  不落盘**；TTL 30s；验签后仍与当前租户封印绑定（`apps/server/src/internal-identity.ts`）。
- 必须同进程/同副本：拆进程或跨副本 ⇒ 验签必然失败（fail-closed，功能中断）。
- 客户端传入的同名头一律剥掉；网关转发不带原 token/渠道凭证。
- ⚠️ **进程内任何代码都能签发任意身份**（密钥只对本模块私有，对同进程代码不设防）——
  不要把签发能力（`issueInternalIdentity`）暴露给不可信代码；插件/agent 永远走外部通道。

## 9. 示例 JSON-RPC（值均为占位符）

B（PAT）：

```sh
curl -s https://<host>/api/agent/mcp \
  -H 'authorization: Bearer dkq_<personal-access-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
```

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-11-25","capabilities":{"tools":{}},
 "serverInfo":{"name":"platform-agent-mcp","version":"0.1.0"},
 "instructions":"工具按 <module>__<tool> 命名；先调 agent__capabilities；发布/启用必须人做。"}}
```

C（openclaw）——同样请求，换渠道头：

```sh
curl -s http://<host>/api/agent/mcp \
  -H 'x-channel-key: <deployment-channel-key>' \
  -H 'x-wecom-userid: <wecom-userid>' \
  -H 'x-session-id: <optional-session-id>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[
  {"name":"agent__capabilities","description":"返回当前身份可用的能力、lockedFaces 与所需 scope；先调它，再调列表里的工具。","inputSchema":{"type":"object","properties":{},"required":[]},"annotations":{"readOnlyHint":true}},
  {"name":"data__list_reports","title":"…","description":"…","inputSchema":{…},"annotations":{…}},
  {"name":"notify__create_agent_rule","…":"…"}
],"nextCursor":"3"}}
```

`tools/call`（B，报表草稿；C 同形，只换头）：

```sh
curl -s https://<host>/api/agent/mcp \
  -H 'authorization: Bearer dkq_<personal-access-token>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",
       "params":{"name":"data__propose_report",
                 "arguments":{"title":"<report-title>","templateId":"<template-id>","values":{"<slot>":"<metric-id>"}}}}'
```

工具级错误长这样（ isError=true，不自纠就别重试）：

```json
{"jsonrpc":"2.0","id":3,
 "result":{"content":[{"type":"text","text":"{\"status\":\"denied\",\"reason\":\"missing_scope\",\"scope\":\"data:manage\"}"}],
           "isError":true}}
```
