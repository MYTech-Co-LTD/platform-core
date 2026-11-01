# notify-reconcile job（指派与催办定时入队）

> 正典依据：`docs/architecture.md` §2.4「指派与催办」；通知基础设施设计
> `docs/superpowers/specs/2026-10-27-notification-infrastructure-design.md`；决策 D-A（2026-10-19）：
> `form.assigned` 全交本 job，发布路径不接线。
> ⚠️ 2026-10-27 起本 job **只入队、不投递、不派生规则**（规则由 `notify-seed-builtin` seed；投递由 `notify-worker`）。

## 这个 job 干什么

跑仓内脚本 `scripts/notify-reconcile.mjs`，两件事（全部幂等）：

1. **指派**：逐人入队 `forms.form.assigned`（`event_id = form:<assetId>:<version>:assigned:<user>`）。
2. **催办**：`published_at + due.afterDays` 到期且**未提交**者，逐人入队 `forms.form.due_reminder`
   （`event_id` 含日期 ⇒ 同日重跑不重复）。

> ⚠️ **D-A 的语义后果**：入队时刻 = **下一次调度**；真正送达还要等 `notify-worker` 的下一次轮询
> （≤2s）与 provider 投递。要「发布后尽快通知」就把本 job 频率设成小时级（延迟 ≤ 1 个周期）。

## 建在哪 / 怎么建

- **openship 面板 → Jobs** 新建（口径见 `deploy/openship-adopt.md`：「清理由 openship job 定时执行，
  应用进程不自己跑」）。
- **生产实际形态（2026-10-28 核对）**：job 命令 = `docker exec openship-platform-core-server sh -lc
  'pnpm exec tsx scripts/notify-reconcile.mjs --json'`（进 server 容器跑仓内脚本，零常驻）。
  ⚠️ 本文早期写的「一次性容器跑 `docker run`」是**示意**，生产未采用。
- **cron 按 UTC 解释**（`deploy/data-plane-deploy-sop.md` §E.7 已实测）：要「每日 08:00 CST」
  须写 UTC `0 0 * * *`；建议**小时级**（见上）。

## 配置从哪取（不写明文）

| 键 | 从哪取 |
|---|---|
| `DATABASE_URL` | openship 该项目 env（isSecret）注入 |
| `PLATFORM_CONSOLE_BASE_URL` | 同上；拼通知里的详情链接（缺省 ⇒ 相对路径，企微里不可点） |

> ⚠️ **不要去 SSH 读机器上的 env**——那是读机器状态，违反「唯一通道」铁律。
> 投递侧密钥不在本 job：桥路线的 `WECOM_BRIDGE_URL__<ORG>` 属 **notify-worker** 服务行；
> 直连路线的凭据在 `notify.channel_credential`（密文，KEK 解密），根本不经 env（2026-10-31 起）。

## 怎么读结果 / 告警

- 退出码：**0** = 全部入队成功（含重复）；**1** = 有入队异常；**2** = 缺 `DATABASE_URL` / 查询失败。
- stdout：一行结论（`--json` 则 `{targets, emitted, duplicates}`）。
- **投递失败不在本 job 可见**（已异步）：由 `scripts/notify-health.mjs` job（dead / 积压 / 心跳）
  与 console 投递回执负责红。**本 job 必须订阅失败通知**（静默失败 = 指派/催办没发生）。

## 待实测（不得据以声称可用）

- **N=500 名单**时的入队耗时与 worker 发送节奏 / 企微限流（正典 §2.4 实施注记）。
- 首次上线前按 §2.4 验收五条走一遍：发布各收到一次 / 到期未提交各一次 / 已提交不收 /
  存量（无 `assignees`）零影响 / 停用规则后不通知。
