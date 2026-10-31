# 通知基础设施的四个运维 job（健康检查 / 保留期清理 / 内置 seed / 可送达性体检）

> 正典：`docs/architecture.md` §2.6；设计 `docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md` §12。
> 二者都是**仓内脚本 + openship job**（零常驻），命令形如 `docker exec <server 容器> sh -lc '…'`
> —— 与既有 `notify-reconcile` job 同一范式（本仓实际形态；`deploy/notify-reconcile-job.md` 早期写的
> 「一次性容器跑 docker run」是**示意**，生产未采用）。
> **不要**把这两个 job 的逻辑塞进 server 进程（应用进程不跑定时副作用）。

## 已在生产建成的两个 job（2026-10-28 实测）

| job | key | cron（UTC） | 命令 |
|---|---|---|---|
| `notify-health（通知投递健康检查）` | `custom:2H4wFWXzMvzbt2UU` | `*/5 * * * *` | `docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/notify-health.mjs'` |
| `notify-retention（通知保留期清理）` | `custom:OwCrOG0dkixdkxTL` | `23 3 * * *` | `docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/notify-retention.mjs'` |
| `notify-seed-builtin（内置模板/通道/默认规则幂等 seed）` | `custom:NWK_D7nKpsC7hdhe` | `13 * * * *` | `docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/notify-seed-builtin.mjs'` |
| `notify-preflight（全量规则可送达性体检）` | `custom:D39a1KLz9mMRuxoP` | `43 3 * * *` | `docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/notify-preflight.mjs'` |

- 两者都 `serverId=23a1091e`（mytech-weknora），`notifyConfig.states=['failed']`，
  通道 `nch_XBUs425hd_KsA_lt`（与 `notify-reconcile` 同一通道）。
- **手动触发已验**：health → `dead=0 stale=0 workers=1 …` exit 0；retention → `inbox=0 attempts=0 deliveries=0` exit 0；
  seed → `{"tenants":1,"templates":0,"channels":0,"rules":1}` exit 0（幂等：已存在的模板/通道不再新建）。
- **为什么 seed 也要定时跑**：2026-10-27 生产首次上线时**漏跑 seed**，导致模板/通道/规则全空、
  事件进来零投递。做成小时级幂等 job 后，新租户开通也会被自动兜住。
- 命令用 `docker exec` 进 server 容器（仓内脚本与 `node_modules` 都在），**不是** `docker run` 一次性容器
  —— 与 `notify-reconcile` 的既有范式一致（本机验证过这条路径能跑）。

## 1. `notify-health`（每 5 分钟）

```bash
DATABASE_URL=<平台库> pnpm exec tsx scripts/notify-health.mjs
```

| 退出码 | 含义 |
|---|---|
| 0 | 干净 |
| 1 | 有 `dead` / 最老 `pending` > 10 分钟 / worker 心跳 > 2 分钟 / 近 1 小时失败 > 50 |
| 2 | 查不成账（缺 `DATABASE_URL` / 查询失败） |

stdout 一行：`notify-health: dead=… stale=… workers=… oldestPending=…s failedLastHour=… channelErrors=… noRecipients=… noChannel=… invalid=…`

- `channelErrors` 与 `oldestPendingSeconds` 是**诊断面**，单独不判红（阈值容易误报）。
- **`noRecipients > 0` 或 `noChannel > 0` 直接判红**（2026-10-28 起）：这是**配置错误**
  （配了规则却解析不出人 / 通道全停用），不是流量波动，不给阈值。
- `invalid > 5` 才判红（模板轮换期会短暂出现）。
- **必须订阅失败通知**：job 静默失败 = 投递积压无人知晓。

## 2. `notify-retention`（每日 03:23 UTC）

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
| `NOTIFY_CRED_KEK` | openship 该项目 env（isSecret）。**生成**：`openssl rand -hex 32`（64 hex = 32 字节） |

> ⚠️ **不要去 SSH 读机器上的 env**——那是读机器状态，违反「唯一通道」铁律。

### `NOTIFY_CRED_KEK`（出站渠道凭据的加密密钥）

- 用途：加解密 `notify.channel_credential.secret_enc`（AES-256-GCM）。**只由 notify-worker / 导入 CLI 消费**，
  宿主 server 不读它（宿主不碰渠道凭据）。
- **丢失 = 所有渠道凭据需重录**（重录只需重跑导入，见下）——故它进交付备份清单。
- 缺它时：直连通道**一律发不出去**且判据 PROBE_FAILED（fail-closed，不会降级成明文，也不会偷偷回共享桥）。
- 轮换：换 KEK 后旧密文解不开 ⇒ 用新 KEK 重跑一次导入即可（`upsertCredential` 是 upsert）。

### 渠道凭据导入（企微直连）

从 `platform.tenant` 的 `wecom_corp_id / wecom_agent_id / wecom_secret` 一次性导入并加密：

```bash
pnpm exec tsx scripts/notify-import-wecom-cred.mjs                    # 预演：只列 org / corpId / agentId / secret 长度与尾号
pnpm exec tsx scripts/notify-import-wecom-cred.mjs --apply            # 真写（需 NOTIFY_CRED_KEK）
pnpm exec tsx scripts/notify-import-wecom-cred.mjs --org <org> --apply
```

- 默认预演：写凭据表是要人确认的动作，不该一次误敲就落。
- 只导三者齐全的租户；缺的**点名跳过**（不是静默略过）。
- 导入后通道要显式切 `transport: 'direct'` 才走直连（缺省 `bridge`），回滚就是把配置改回 `bridge`。

## 3. `notify-preflight`（每日 03:43 UTC，D4）

```bash
DATABASE_URL=<平台库> pnpm exec tsx scripts/notify-preflight.mjs
```

| 退出码 | 含义 |
|---|---|
| 0 | 全部规则可送达 |
| 1 | **存在阻塞规则**（输出里 `blocked[]` 逐条列出 org / ruleId / eventKey / 原因） |
| 2 | 查不成账（缺 `DATABASE_URL` / 查询失败） |

- **只读**：不写表、不外发。
- `scopeHoldersUnavailable: true` ⇒ 该实例没配 `CASDOOR_*`，`scope_holders` 类规则**查不了**
  （不等于「没人持有」）——配齐凭据再跑才可信。
- **只扫 `platform.tenant` 里登记的租户**（2026-10-28 实测）：不在租户表里的 org 的规则不会被体检。
  ⇒ 新建租户后必须先登记进 `platform.tenant`，否则它的通知规则是体检盲区。
- `field` 类规则被**跳过并单独计数**（`skippedFieldRules`）——它们必须真实 payload，sample 无意义。

## 4. `notify-preflight` 的首跑结果（2026-10-28 生产实测）

手动触发 → **exit 1**，输出：

```json
{"tenants":1,"checked":2,"skippedFieldRules":0,"blockedCount":1,
 "scopeHoldersUnavailable":false,
 "blocked":[{"org":"mytech",
   "ruleId":"derived:aftersales:aftersales.employee_approval.pending:*",
   "blocked":"no_recipient"}]}
```

**这条告警是真实且有益的**：`aftersales:manage` 在生产**无人持有**，derived 规则解析不出收件人。
目前链路仍能通，是因为有一条 **manual literal 规则**（`ZhangDuo`）覆盖了它——
manual 优先于 derived，所以实际投递不受影响。

⇒ **它揭穿的是「权限一直没配，只是被兜底掩盖了」**。两个选择：
1. 给真实的售后管理员授予 `aftersales:manage`（治本，之后 derived 规则自动生效、可删兜底）；
2. 保留 literal 兜底并**接受 preflight 每天红**（不推荐：红会失去信号价值）。

⚠️ `scopeHoldersUnavailable:false` 说明 Casdoor 解析器**在工作**——这是「真没人」而非「查不了」。
