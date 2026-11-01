# OpenClaw 企微自建应用插件（wecom-app）设计

> 状态：已确认方案 A（2026-11-01，会话 84a6e00d）。前置可行性探针**全部实测通过**，证据见 §9。
> 关联：`docs/superpowers/specs/2026-10-10-shanhai-openclaw-wecom-design.md`（bot 通道，不动）；
> 经验库《OpenClaw 工具层接企微自建应用权限（App B / 1000009）实测》§8（探针与判读口径）。

## 1. 背景与目标

山海 openclaw bot（智能机器人通道）当前没有企微内部能力的工具面：涉及通讯录/文档/智能表格/
会议/日程/待办时，模型只能拿 `exec` 硬试（2026-10-31 实测：用 exec 找 corpid/secret、尝试写
智能表格失败）。本设计新增一个**自建应用（agent 1000009「消息通知」）凭据驱动的 native
plugin**，让 agent：

1. 涉及企微内部功能时，经 1000009 的服务端 API 权限调用（与 bot 通道身份解耦）；
2. 工具面按人白名单（ZhangDuo、yangwei 可用，其余 fail-closed 拒绝）；
3. 由随插件发布的 SKILL 教会模型"什么时候用哪个工具、什么时候不许用 exec"。

## 2. 非目标

- 不改 bot 通道（智能机器人 WebSocket、流式、思考桥补丁一概不动）。
- 不启用官方插件的 `wecom-cli` 与其 `before_prompt_build` 注入（机器人身份 + 与本 skill 指令
  冲突；那道能力门维持现状）。
- 不做"任意端点转发"工具（每把工具固定端点，权限面与审计可枚举）。
- 不做删除类操作（`delete_records` / `del_doc` / 取消会议日程**不进首批**；需要时另议）。
- 不动问数工具面（data-query 插件与 `agents.entries.main.tools.allow` 的既有 8 项）。

## 3. 架构与数据流

```
企微私聊 ─bot通道─► gateway ─► agent main
                                  ├─ wecom-app 插件工具（本设计）
                                  │    ├─ 白名单判定（ctx.requesterSenderId，fail-closed）
                                  │    ├─ token 管理（进程内缓存 gettoken）
                                  │    └─ 固定端点 → https://qyapi.weixin.qq.com/cgi-bin/*
                                  └─ data-query / exec / automations（现状不动）
```

- 插件形态：**native plugin**（同 data-query）。唯一理由：只有 native plugin 的工具 ctx 能拿到
  可信 `ctx.requesterSenderId`（MCP 通道拿不到，2026-09-21 三通道设计已证）——白名单判定依赖它。
- 代码位置：`deploy/openclaw/wecom-app-plugin/`（构建期 COPY 进镜像，与 data-query 同法）。
- 权限裁决**全部在企微服务端**：插件零权限逻辑，只做白名单门 + 参数透传 + 错误文案映射。

## 4. 关键决策

**D1 —— 应用与凭据：复用 1000009，secret 间接引用、零明文复制。**
`WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`（platform-core 项目级 env）实测就是 1000009 的
CorpSecret（`agent/get?agentid=1000009` 回 `errcode 0, name 消息通知`；换 1000012 回 301002
反证，2026-11-01）。插件读 env：`WECOM_APP_CORP_ID` / `WECOM_APP_AGENT_ID` /
`WECOM_APP_SECRET`（直给明文时用）→ 缺省回退 `WECOM_APP_SECRET_FROM` 指名的 env（现配
`WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`）。secret 不进 openclaw.json、不进日志、不进回包。

**D2 —— 白名单双层，插件层是权威。**
- 权威层（fail-closed）：`WECOM_APP_ALLOWED_USERS`（逗号分隔 userid）；每把工具的 execute
  先判 `ctx.requesterSenderId ∈ 白名单`，不在则返回固定文案（见 §7），**不发起任何 API 调用**。
  requesterSenderId 缺失（CLI 轮）= 拒绝（与 data-query 同口径）。
- 隐藏层（best-effort）：`tools.toolsBySender`——`channel:wecom:<uid>` 白名单内放行、`*` 对
  `wecom_app_*` deny，让未授权者连工具都看不见。运行时行为以实测为准；若与文档不符，以插件层
  为准（隐藏层失败不构成安全缺口）。

**D3 —— 工具面：固定端点、首批 17 把**（§5，表 16 行、todo 两把并作一行）。加新 API = 插件
加一把工具 + SKILL 加一行，不做通用转发。

**D4 —— 智能表格数据形状（实测钉死，别按想象写）：**
- `create_doc` 的 `doc_type`：**10=智能表格**、4=电子表格、3=文档（实测三种都建成功）。
- `get_sheet` 回包的 sheet 列表在**顶层 `sheet_list`**（不是 `data.sheets`）；新建智能表格自带
  默认子表（「智能表1」）与 5 个默认字段（文本/单选/人员/数字/日期）。
- `add_records`/`update_records` 的 `records[].values` **键 = 字段标题（field_title）**，不是
  field_id（field_id 报 `2022004 field not exists`）；单元格形态 `{values:[{type:1,text|number}]}`。
- `update_records` 必须带 `record_id`（来自 add_records 回包或 get_records）。
- **应用自建文档天然免文档级授权**（301085 只发生在访问他人/机器人空间的文档时）。

**D5 —— 日程 = 应用自建日历模型（实测钉死，成员日历不可寻址）**：
`oa/calendar/list` **不存在**（HTTP 404）；`get_by_calendar` 传 `ZhangDuo` / `usr:ZhangDuo`
均 `90457`。正确链路：`oa/calendar/add` `{calendar:{summary,…}}` 建应用日历 → 回 `cal_id` →
`oa/schedule/add` `{agentid, schedule:{cal_id, summary, start_time, end_time}}`（unix 秒）→ 回
`schedule_id`；`get_by_calendar` 用该 `cal_id` 查（全链路 2026-11-01 实测 errcode 0）。
⇒ 工具面按此建模：读/写日程都只针对**应用日历**；「查某个成员自己的日程」**不可用**，SKILL
明示这一边界，不猜。自检日历锚点：`wcfjPaWwAAkJwSPR7u7Je4FCYU56msJg`（openclaw-自检日历）。

**D6 —— 待办降级**：服务端 API 只有 `todo/get` / `todo/update`（文档树 parent 101523 下仅两
条），**没有创建待办**。SKILL 明示这一能力边界，禁止模型"编造创建成功"。

**D7 —— token 管理**：进程内缓存 access_token，过期前 5 分钟刷新，并发单飞；token 不落日志、
不回显；`gettoken` 失败按 §7 错误映射回文案。

**D8 —— SKILL 同源**：`deploy/openclaw/wecom-app-plugin/skills/wecom-app/SKILL.md` 随镜像走
（构建期 COPY，改仓文件需重建部署——与 data-query 同律）；不依赖 state 卷 workspace 文件
（卷重建会回退）。

**D9 —— 注册三道门照走**：`openclaw plugins install -l /opt/plugins/wecom-app-plugin --force
--accept-capabilities`；`agents.entries.main.tools.allow` 追加 17 个工具名（或 `wecom_app_*`
glob，以实测为准）；consent → 重启 → allowlist 顺序照经验库 §7 三道门，漏一道 = 模型看不见。

**D10 —— 不拦截"谁能跟 bot 说话"**：`dmPolicy` 维持 open，会话隔离已由 `session.dmScope` 另行
解决；白名单只管这批工具。

## 5. 工具面（首批 17 把）

| 工具 | 端点（cgi-bin/） | 读/写 | 说明 |
|---|---|---|---|
| `wecom_app_status` | `agent/get` | 读 | 自检：应用身份/凭据就绪（agentid+name） |
| `wecom_app_departments` | `department/list` | 读 | 部门树 |
| `wecom_app_users` | `user/list` | 读 | 部门成员（按 department_id） |
| `wecom_app_doc_create` | `wedoc/create_doc` | 写 | 建文档；doc_type 10/4/3（D4） |
| `wecom_app_sheet_sheets` | `wedoc/smartsheet/get_sheet` | 读 | 子表列表（读 `sheet_list`） |
| `wecom_app_sheet_fields` | `wedoc/smartsheet/get_fields` | 读 | 字段定义（field_title/field_type） |
| `wecom_app_sheet_records` | `wedoc/smartsheet/get_records` | 读 | 读记录（offset/limit） |
| `wecom_app_sheet_add_records` | `wedoc/smartsheet/add_records` | 写 | 键=字段标题（D4） |
| `wecom_app_sheet_update_records` | `wedoc/smartsheet/update_records` | 写 | 按 record_id 更新 |
| `wecom_app_meetings` | `meeting/get_user_meetingid` | 读 | 成员会议 ID 列表（时间窗） |
| `wecom_app_meeting_info` | `meeting/get_info` | 读 | 会议详情 |
| `wecom_app_meeting_create` | `meeting/create` | 写 | 建预约会议 |
| `wecom_app_calendar_create` | `oa/calendar/add` | 写 | 建应用日历 → cal_id（D5 链路起点） |
| `wecom_app_schedules` | `oa/schedule/get_by_calendar` | 读 | 应用日历的日程列表（cal_id 必传，D5） |
| `wecom_app_schedule_add` | `oa/schedule/add` | 写 | 建日程（agentid 插件注入；cal_id/时间窗必传） |
| `wecom_app_todo_get` / `wecom_app_todo_update` | `todo/get` / `todo/update` | 读/写 | 待办（无创建，D6） |

（末行两把工具并作一行，共 17 个注册名。）所有工具：参数 schema 校验、结果只回业务字段、
docid/record_id 等由模型按 SKILL 规则取用。

## 6. SKILL 要点（`skills/wecom-app/SKILL.md`）

- **触发**：用户要动企微内部对象（通讯录/文档/智能表格/会议/日程/待办）时。
- **路由表**：能力 → 工具名（§5 的表原样入文）。
- **纪律**（固定四条）：
  1. 企微内部功能只用 `wecom_app_*` 工具；**禁止**为企微功能用 `exec`/`curl`/读源码/翻 env；
  2. 写操作必须先读回现状（get_* 再写），写后回读验证目标状态；
  3. 待办没有创建 API（D6）——如实告知，不编；
  4. 报错按 §7 文案如实转告，不换参数硬试、不降级到 exec。
- **智能表格写法**照 D4 逐字入文（键=字段标题、type 10、record_id 语义）。

## 7. 错误映射（固定文案，实测判读口径）

| errcode | 含义 | 模型可见文案 |
|---|---|---|
| 48002 | 应用权限没开 | 「该能力未对企业应用开放，请联系管理员开启应用权限」 |
| 60020 | 可信 IP 未放行 | 「调用方 IP 不在企业可信 IP 内，请联系管理员」 |
| 301002 | 拿了别的应用的 token | 「凭据与应用不匹配，请联系管理员」 |
| 301085 | 应用看不到该文档 | 「该文档未对应用可见：需要在企微文档里把它共享给应用，或改用应用自建的表格」 |
| 2022004 | 字段键不存在 | 「字段标题不存在：先 `wecom_app_sheet_fields` 看真实字段名」（键=字段标题） |
| 90457 | cal_id 非法 | 内部解析失败如实报错（D5） |
| 40058 / 93017 | 参数形状错 | 原样带 errmsg detail，模型自纠一次，不原样重试 |
| 白名单拒绝 | requesterSenderId 不在名单 | 「你没有企微应用能力的使用权限（联系人：管理员加白名单）」 |

## 8. 部署与接线

1. 仓内 `deploy/openclaw/wecom-app-plugin/`（index.js / lib.js / openclaw.plugin.json /
   skills/wecom-app/SKILL.md / README.md / *.test.js，node --test 可直跑，同 data-query 体例）；
2. `deploy/Dockerfile.openclaw` 加一行 `COPY deploy/openclaw/wecom-app-plugin /opt/plugins/wecom-app-plugin`；
3. 容器内一次性注册：`openclaw plugins install -l /opt/plugins/wecom-app-plugin --force
   --accept-capabilities`（写 state 卷 `plugins.load.paths`）；
4. `agents.entries.main.tools.allow` 追加 17 个工具名（或 `wecom_app_*` glob，以实测为准）→
   重启网关（三道门，D9）；
5. env 已就位并**已生效**（2026-11-01 写入 openclaw 服务行四键；容器随 patch 自动重建，
   `env | grep WECOM_APP_` 实测四键在场）；
6. `tools.toolsBySender` 隐藏层（D2，实施时验，不生效则记录为已知边界）。

## 9. 可行性证据（2026-11-01，openclaw 容器内实测，出口 113.249.104.181）

| 探针 | 结果 |
|---|---|
| `agent/get` (1000009) | **0**（name=消息通知）⇒ secret 身份 + 可信 IP 双确认 |
| `department/list` / `user/list` | **0 / 0** |
| `meeting/get_user_meetingid` | **0** |
| `get_by_calendar`（userid / usr: 前缀） | 90457（成员日历不可寻址 → D5 应用日历模型） |
| `oa/calendar/add` → `schedule/add` → `get_by_calendar(cal_id)` | **0 / 0 / 0**（应用日历全链路，cal_id 见 D5 锚点） |
| `oa/calendar/list` | **HTTP 404**（不存在，别再按它设计） |
| `todo/get` | 40058（权限通，字段名实现期核） |
| `create_doc`(10) + `get_sheet` + `get_fields` | **0 / 0 / 0**（默认子表+5字段） |
| `add_records` → `get_records` → `update_records` | **0 / 0(total=6) / 0**（读改写全链路） |
| 自检表（应用自建，后续验收锚点） | docid `dcrVweRT4jGnodMn3JAGSxHCfa7X4WeqSwnw1yBF3myctqYwJkVu8OWqIV1CcD5n8470ws2k10aVXV2CTzDQATFg`，子表 `q979lj`，探针行 record_id `AQcotP` |

## 10. 验收（真渠道，三条件全中）

1. 白名单内（ZhangDuo）问「公司现在有哪些部门」→ 整轮工具 = `['wecom_app_departments']`，
   零 `exec`；问「建一个智能表格写入 XX」→ `wecom_app_doc_create`+`add_records`，且回读一致；
2. 白名单外（DongJiJuan 或任一非名单用户）同问 → 回固定拒绝文案，**transcript 无任何
   wecom_app_* 调用**（fail-closed 生效）；
3. 问数类问题不受影响（`list_metrics`/`query_data` 照常，工具面无串扰）。

## 11. 已知边界与风险

- 写操作直接落企微真实数据；首批不含删除，读-改-写由 SKILL 纪律约束（模型层，非硬闸）。
- secret 依赖项目级 env 名（`WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`）；该键改名/轮换会使
  `wecom_app_status` 立刻暴露（自检工具即哨兵）。
- `toolsBySender` 隐藏层若实测不符预期，仅影响"未授权者是否看得见工具名"，不影响拦截（D2）。
- 1000009 同时服务数据面 data-analysis 与本插件：token 各自独立获取，互不挤占；但其应用权限
  变更会影响两处（共用应用，改权限前想一下另一边）。
- **exec 可绕过白名单读 secret（存量面，D2 缓解）**：exec 在 agent allowlist 里且 dmPolicy=open ⇒ 非白名单用户理论上可诱导模型 exec 读容器 env 拿 WECOM_APP_SECRET。缓解=部署时 toolsBySender 的 `*` deny 同时含 `wecom_app_*` 与 `exec`（白名单成员的 specific 条目放行）——见 plan Task 5 Step 5。
