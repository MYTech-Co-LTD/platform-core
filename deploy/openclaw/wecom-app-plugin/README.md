# wecom-app-plugin（企微自建应用工具）

OpenClaw native plugin：17 把固定端点工具（通讯录/文档·智能表格/会议/应用日历/待办），
凭据走 env、使用人白名单 fail-closed、权限裁决在企微服务端。设计正典：
`docs/superpowers/specs/2026-11-01-openclaw-wecom-app-plugin-design.md`。

## env

| 键 | 说明 |
|---|---|
| `WECOM_APP_CORP_ID` | 企业 CorpID |
| `WECOM_APP_AGENT_ID` | 自建应用 agentId（1000009） |
| `WECOM_APP_SECRET` | CorpSecret 明文（可选，优先） |
| `WECOM_APP_SECRET_FROM` | 间接引用：secret 所在的 env 变量名（现配 `WECOM_SYNC_SECRET__SHANHAIYIGUO_ORG`） |
| `WECOM_APP_ALLOWED_USERS` | 逗号分隔的企微 userid 白名单 |

## 工具（17 把）

| 工具 | 端点（cgi-bin/） | 读/写 |
|---|---|---|
| `wecom_app_status` | `agent/get` | 读 |
| `wecom_app_departments` / `wecom_app_users` | `department/list` / `user/list` | 读 |
| `wecom_app_doc_create` | `wedoc/create_doc` | 写 |
| `wecom_app_sheet_sheets` / `_fields` / `_records` | `wedoc/smartsheet/get_sheet` / `get_fields` / `get_records` | 读 |
| `wecom_app_sheet_add_records` / `_update_records` | `wedoc/smartsheet/add_records` / `update_records` | 写 |
| `wecom_app_meetings` / `_info` / `_create` | `meeting/get_user_meetingid` / `get_info` / `create` | 读/读/写 |
| `wecom_app_calendar_create` | `oa/calendar/add` | 写 |
| `wecom_app_schedules` / `_schedule_add` | `oa/schedule/get_by_calendar` / `add` | 读/写 |
| `wecom_app_todo_get` / `_todo_update` | `todo/get` / `todo/update` | 读/写（无创建 API） |

## 部署（三道门）

1. 镜像：`deploy/Dockerfile.openclaw` 已 COPY 到 `/opt/plugins/wecom-app-plugin`；
2. 容器内：`openclaw plugins install -l /opt/plugins/wecom-app-plugin --force --accept-capabilities`；
3. `openclaw config set agents.entries.main.tools.allow '[…既有 8 项…, "wecom_app_status", … ]'`
   （17 个工具名），然后重启网关。工具注册成功 ≠ agent 可见——allowlist 是最后一道门。

## 测试

`node --test`（lib 纯逻辑 + contracts 契约）。改动实测形状前先读 spec §9 的证据表。
