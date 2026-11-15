# 通知底座剩余候选设计评审（通道自助 / 保留期 / 规则历史）

- 日期：2026-11-15
- 状态：**评审结论已确认**；仅「规则历史/回滚」进入实现，另两项不做/暂缓
- 关联：`docs/superpowers/plans/2026-11-14-notification-platform-roadmap.md` §9 候选池
- 基线：N0–N5 已完成，两套生产 `notify-health` 全绿、`notify-preflight blockedCount:0`

## 1. 评审范围与事实

三项是独立子系统，分别评审；不合并成一个实现计划。

生产数据现状（2026-11-15 实测）：

| 表 | mytech | shanhai |
|---|---|---|
| `notify.event` | 2 行 | 6 行 |
| `notify.delivery` | 4 行 | 10 行 |
| `notify.inbox` | 2 行 | 4 行 |
| `notify.audit` | 2 行 | 7 行 |

## 2. 决策一：通道自助 —— **不做**

### 现状

- `notify.channel` 支持 provider / 非敏感 config / `secret_refs`；直连凭据在
  `notify.channel_credential`（AES-256-GCM，KEK 来自 env）。
- 已有运维 CLI `scripts/notify-import-wecom-cred.mjs` 负责导入/轮换企微凭据。
- HTTP 面只有 `GET /channels`、`PATCH /channels/:id`、`POST /channels/:id/health`；
  没有创建通道、没有凭据录入入口。

### 不做的理由

1. 与定案 **D1「通道由平台预备」** 冲突。通道是出站能力边界，不是租户内容。
2. 开放创建要同时解决：provider 专属凭据表单、密钥写入/轮换/回读、出站地址
   SSRF 校验、测试发送、健康探测、审计、误建通道的爆炸半径。工作量最大、风险最高。
3. **没有真实案例**支撑（当前每租户只有 2 个通道，新增需求由运维 CLI 即可覆盖）。

### 触发再评审的条件

- 出现“租户必须自助接入新通道”的真实交付需求；且已有至少一次运维 CLI 无法满足的案例。
- 届时先做**平台运维专用创建接口/CLI**，不直接开放租户自助。

## 3. 决策二：保留期 —— **维持现状，设触发条件**

### 现状

`notify-retention`（每日）窗口：inbox 90d / attempt 180d / delivery 365d /
event 90d / audit 365d；只删终态（`delivery` 仅 sent/suppressed/dead，`event` 仅非 `new`）。
`delivery.rendered` 跟随 delivery 保留 365 天，当前**没有脱敏**。

### 决策

维持 90/180/365，不改窗口、不加脱敏。理由：

- 生产数据量仍是个位数行级，没有存储压力；
- 没有合规要求明确“payload 只能留 N 天”的案例；
- 缩短窗口会直接削弱排障能力，属于“无案例立标准”。

### 触发再评审的条件

任一条件成立时启动「rendered 脱敏 + 窗口调整」：

1. `notify.delivery` 单租户超过 100 万行或 2GB；
2. 出现 PII/合规要求，明确 rendered 内容不得长期留存；
3. 排障/审计提出“需要更长窗口”或“必须更短窗口”的真实案例。

## 4. 决策三：规则历史/回滚 —— **做轻量版（本 spec 的范围）**

### 问题

规则决定“谁在什么情况下收到什么”，一次错误编辑可能发错人/发漏人。当前：

- `notify.rule` 是可变单行，无 `updated_at`；
- 写操作有 audit，但 HTTP `POST /rules` 与 agent `agent.rule.upsert` 的 detail 只是
  **部分字段**（eventKey/template/channels 等），缺 recipientLiteral / recipientDepts /
  cooldown / ownerNamespace / enabled；
- 没有一键回滚入口，事故恢复靠人从日志拼字段。

### 不做的方案

- **完整 `rule_revision` 表 + 发布指针**：规则是运维配置，不是内容；照搬模板 revision
  会引入不必要的版本/发布语义，YAGNI。
- **恢复已删除规则**：删除是显式动作，恢复已删规则涉及 ID 复用/归属重建，超出本次事故模型。

### 采用的方案：审计快照 + 历史查询 + 单步恢复

#### 4.1 数据模型

不加新表。所有规则写路径在 `notify.audit.detail` 中写入**完整快照**：

```json
{
  "snapshot": {
    "id": "rule:...",
    "enabled": true,
    "eventKey": "ext.agent_a.daily",
    "scope": "*",
    "recipientKey": "assignee",
    "recipientLiteral": null,
    "recipientDepts": null,
    "templateKey": "tpl",
    "channels": ["inapp_default"],
    "cooldownMinutes": null,
    "origin": "manual",
    "ownerNamespace": "agent_a"
  }
}
```

- 兼容旧数据：历史 audit 没有 `snapshot` 的条目在 history 中返回 `complete:false`，
  **不可恢复**。
- 保留既有 detail 字段不动（避免破坏现有审计消费者）。

覆盖写路径：

| 路径 | action |
|---|---|
| HTTP `POST /rules` | `rule.upsert` |
| HTTP `PUT /rules/:id/enabled` | `rule.enabled`（快照含改后 enabled） |
| MCP `propose_rule` / `update_rule` | `mcp.propose_rule` / `mcp.update_rule` |
| agent `createAgentRule` | `agent.rule.upsert` |
| 恢复 | `rule.restore`（快照含 restoredFrom） |

#### 4.2 API

`GET /api/modules/notify/rules/:id/history?limit=50`（`notify:view`）

- 只返回本 org、target=id、含 `snapshot` 或旧 detail 的写操作；
- 响应：`{ history: [{ auditId, at, actor, action, complete, snapshot? }] }`；
- `limit` 1..100，默认 50，按时间倒序。

`POST /api/modules/notify/rules/:id/restore`（`notify:manage`）

- body：`{ auditId: number }`；
- 校验顺序：
  1. 规则**仍存在**（404 `RULE_NOT_FOUND`；已删规则不支持恢复）；
  2. audit 属于本 org、target=id、有 `snapshot`（404 `HISTORY_NOT_FOUND` / 409 `HISTORY_INCOMPLETE`）；
  3. `isWritableRuleId(id)`；`derived:`/`manual:` 返回 409 `RULE_ID_RESERVED`（系统规则由 seed 维护）；
  4. owner_namespace 归属：与现有写路由同一 `ownsNamespace` 判定，非 owner 403 `RULE_NOT_OWNED`；
  5. 快照按当前事件声明/启用通道/已发布模板重新跑 `validateRule`；
     失败返回 409 `RULE_RESTORE_INVALID` + issues（不信任历史快照当时的配置）。
- 写入：**只更新不插入**的 `updateRule`（含 enabled；rowCount=0 ⇒ 规则已在检查后被删，返回 404，
  不复活）+ audit `rule.restore`，detail 含 `{ snapshot, restoredFrom: auditId }`；
- 响应：`{ id, restoredFrom, enabled }`。
- 并发：不做乐观锁；恢复是普通写，最后写者胜，历史保持 append-only。

#### 4.3 权限与边界

- 历史读：`notify:view`；恢复写：`notify:manage`（与现有规则写一致）。
- manifest `api.internal` 增加两条声明，装载期双向核对。
- 恢复不绕过 `validateRule`，不复活已删规则，不覆盖 `derived:`/`manual:`。
- 迁移：新增 `notify.audit (org, target, created_at desc)` 索引（017），供 history 查询。

#### 4.4 验收

- 写规则后 audit detail 含完整 snapshot（HTTP / MCP / agent 三条路径）；
- history 能列出快照并标记旧条目 `complete:false`；
- restore 成功后规则字段与所选快照一致，且写 `rule.restore` 审计；
- 负例：非 owner 403、reserved id 409、无快照 409、配置已失效 409、规则已删 404；
- 生产演练：改一条 agent 规则 → 恢复 → 字段与审计均符合预期（在 shanhai 或 mytech 选一条非关键规则）。

#### 4.5 不在本次范围

- 规则删除后的恢复；
- 规则版本 diff / 可视化对比；
- 规则发布审批语义（沿用现有 N3 爆炸半径规则）；
- 保留期窗口/脱敏（见决策二）。

## 5. 结论与顺序

1. **规则历史/回滚（轻量）**：唯一进入实现。
2. 保留期：维持现状，记录触发条件。
3. 通道自助：不做，保持 D1。

本文件即三项的决策记录；实现计划另出 `docs/superpowers/plans/2026-11-15-notify-rule-history.md`。
