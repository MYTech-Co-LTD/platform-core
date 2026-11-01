---
name: wecom-app
description: 企微内部能力（通讯录/文档·智能表格/会议/应用日历/待办）走 wecom_app_* 工具——不要用 exec/curl 硬试。白名单外的用户会收到拒绝文案，如实转告。
metadata:
  openclaw:
    emoji: "🏢"
---

# 企微应用工具 Skill

用户要动**企微内部对象**（查人/查部门/读填文档与智能表格/查建会议/查建日程/看待办）时用
`wecom_app_*` 工具；这些工具走企业自建应用的服务端权限，与你手上的 shell 无关。

## 路由表

| 用户要什么 | 工具链 |
|---|---|
| 公司有哪些部门 / 某部门有哪些人 | `wecom_app_departments` → `wecom_app_users(department_id)` |
| 建表并写入数据 | `wecom_app_doc_create(doc_type=10)` → `wecom_app_sheet_sheets` → `wecom_app_sheet_fields` → `wecom_app_sheet_add_records` → `wecom_app_sheet_records` 回读 |
| 改已有表格的数据 | `wecom_app_sheet_fields`（看字段标题）→ `wecom_app_sheet_records`（拿 record_id）→ `wecom_app_sheet_update_records` → 回读 |
| 查/建会议 | `wecom_app_meetings(userid, 时间窗)` → `wecom_app_meeting_info(meetingid)`；建：`wecom_app_meeting_create(body)` |
| 查/建日程 | 日程只挂在**应用日历**上：`wecom_app_calendar_create`（拿 cal_id，一次建好可复用）→ `wecom_app_schedule_add` / `wecom_app_schedules(cal_id, 时间窗)` |
| 待办 | `wecom_app_todo_get(todo_id)` / `wecom_app_todo_update`。**没有创建待办的 API**——用户要"新建待办"时如实说明做不到，不要编造成功 |
| 排障第一步 | `wecom_app_status`（应用身份+凭据+白名单） |

## 硬纪律

1. 企微内部功能**只用** `wecom_app_*` 工具；禁止为企微功能用 `exec`/`curl`/读插件源码/翻 env。
2. **写操作三步走**：先读现状（fields/records）→ 写（add/update）→ 回读验证目标状态。
3. `wecom_app_sheet_add_records` / `update_records` 的 `records[].values` **键 = 字段标题**
   （不是 field_id）；单元格 `{values:[{type:1,text|number}]}`。不确定字段标题先
   `wecom_app_sheet_fields`，不要臆造。
4. 报错读 detail 自纠**一次**；同一调用不要原样重试。固定文案的错（48002/60020/301085 等）
   是管理员动作，如实转告用户，不要换参数试探。
5. 白名单拒绝文案出现时如实转告（"你没有企微应用能力的使用权限"），不要绕。

## 边界（如实告知，不编）

- 成员**个人日历**查不了（企微 API 只开放应用自建日历）。
- 待办只能读和改状态，不能创建。
- `301085` = 该文档没共享给应用：要么让用户在企微文档里共享，要么用 `wecom_app_doc_create`
  建新表（应用自建天然可见）。
