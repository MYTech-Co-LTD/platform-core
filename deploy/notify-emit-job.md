# `notify.emit` job handler（平台调度器 → 通知）

> 正典：`docs/superpowers/specs/2026-11-14-business-scheduler-design.md` §10；
> 计划：`docs/superpowers/plans/2026-11-14-scheduler-p1.md`。
> 调度器板块负责“到点 spawn”；本文件只定义通知侧 handler 的输入/输出。

## 注册

- job key：`notify.emit`
- 脚本：`pnpm exec tsx scripts/notify-emit-job.mjs`
- 子进程由 `platform.scheduler` 到点拉起；**不常驻**。

## 调度器注入的 env

| 通道 | 键 | 必填 | 语义 |
|---|---|---|---|
| env | `DATABASE_URL` | 是 | 平台库 |
| env | `JOB_KEY` | 否 | 若提供必须是 `notify.emit` |
| env | `JOB_SCHEDULE_ID` | 是 | `platform.job_schedule.id` |
| env | `JOB_OCCURRENCE` | 是 | claim 到的那一格 bucket（UTC ISO） |
| env | `JOB_OWNER_ORG` | 是 | 事件归属租户；**系统排班的 `notify.emit` 也必须带**（通知是租户级的） |
| env | `JOB_OWNER_NAMESPACE` | agent 排班必填 | `ext.<namespace>.<event>` 的命名空间 |
| env | `JOB_TIMEZONE` | 否 | 默认 `Asia/Shanghai`，用于 `{{date}}` |
| **stdin** | `JOB_PARAMS` | 是 | 一行 JSON，≤16KB；**不走 env**（`/proc/<pid>/environ` 对同机进程可见） |

手动跑：

```bash
printf '%s' '{"eventKey":"ext.demo.daily","payload":{}}' \
  | JOB_KEY=notify.emit JOB_SCHEDULE_ID=1 JOB_OCCURRENCE=2026-11-14T01:00:00Z \
    JOB_OWNER_ORG=mytech JOB_OWNER_NAMESPACE=demo \
    pnpm exec tsx scripts/notify-emit-job.mjs
```

## `JOB_PARAMS`

```json
{
  "eventKey": "ext.<namespace>.<event>",
  "scope": "<optional>",
  "payload": {},
  "eventId": "<optional template>"
}
```

- `eventId` 缺省：`schedule:<JOB_SCHEDULE_ID>:<JOB_OCCURRENCE>`；模板只支持
  `{{scheduleId}}` / `{{occurrence}}`。
- payload 字符串支持四个保留变量：`{{occurrence}}`、`{{now}}`、`{{date}}`、`{{timezone}}`。
- 不做通用模板引擎。

## 退出码

| 退出码 | 含义 | 调度器动作 |
|---|---|---|
| `0` | 已入队 / duplicate（视为成功） | 记 `ok` |
| `2` | 参数/声明/namespace 不可用 | **不重试** |
| `1` | DB 等临时错误 | 按 `max_attempts` 重排 |

## 边界

- **job 成功 = `notify.event` 已写入**；provider 投递失败仍由 `notify-worker` 重试，
  不回滚 job。
- agent 排班只能发自己 namespace 的 `ext.*` 事件；平台事件只允许系统 job（无 namespace）。
- 声明事实源：平台事件 `platform.event_catalog`；租户/agent 事件 `notify.event_decl`
  （agent 自助面迁移后存在）。
