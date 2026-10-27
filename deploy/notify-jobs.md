# 通知基础设施的两个运维 job（健康检查 / 保留期清理）

> 正典：`docs/architecture.md` §2.6；设计 `docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md` §12。
> 二者都是**仓内脚本 + openship job 一次性容器**（零常驻），同 `deploy/notify-reconcile-job.md` 范式。
> **不要**把这两个 job 的逻辑塞进 server 进程（应用进程不跑定时副作用）。

## 1. `notify-health`（建议每 5 分钟）

```bash
DATABASE_URL=<平台库> pnpm exec tsx scripts/notify-health.mjs
```

| 退出码 | 含义 |
|---|---|
| 0 | 干净 |
| 1 | 有 `dead` / 最老 `pending` > 10 分钟 / worker 心跳 > 2 分钟 / 近 1 小时失败 > 50 |
| 2 | 查不成账（缺 `DATABASE_URL` / 查询失败） |

stdout 一行：`notify-health: dead=… stale=… workers=… oldestPending=…s failedLastHour=… channelErrors=…`

- `channelErrors` 与 `oldestPendingSeconds` 是**诊断面**，单独不判红（阈值容易误报）。
- **必须订阅失败通知**：job 静默失败 = 投递积压无人知晓。

## 2. `notify-retention`（建议每日 03:00 UTC）

```bash
DATABASE_URL=<平台库> pnpm exec tsx scripts/notify-retention.mjs
```

| 退出码 | 含义 |
|---|---|
| 0 | 清理完成 |
| 1 | 清理失败 |
| 2 | 缺 `DATABASE_URL` |

保留期（env，缺省见括号）：`NOTIFY_INBOX_RETENTION_DAYS`（90）、
`NOTIFY_ATTEMPT_RETENTION_DAYS`（180）、`NOTIFY_DELIVERY_RETENTION_DAYS`（365）。

- **只删终态**：`delivery` 只删 `sent / suppressed / dead`；`pending / failed` 永不因保留期被删。
- `delivery_attempt` 与 `inbox` 按时间删（审计面保留期比投递长一档）。
- **cron 按 UTC 解释**（`deploy/data-plane-deploy-sop.md` §E.7 实测）。

## 配置从哪取（不写明文）

| 键 | 从哪取 |
|---|---|
| `DATABASE_URL` | openship 该项目 env（isSecret）注入 |
| `NOTIFY_*_RETENTION_DAYS` | 同上（非敏感） |

> ⚠️ **不要去 SSH 读机器上的 env**——那是读机器状态，违反「唯一通道」铁律。
