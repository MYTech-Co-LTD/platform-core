# notify-reconcile job（指派与催办定时对账）

> 正典依据：`docs/architecture.md` §2.4「指派与催办」；实施计划
> `docs/superpowers/plans/2026-10-19-form-assignment-reminder-impl.md`（Task 4/5）；
> 决策 D-A（2026-10-19 人拍板）：`form.assigned` **全交本 job**，发布路径不接线。

## 这个 job 干什么

跑仓内脚本 `scripts/notify-reconcile.mjs`，三件事（全部幂等）：

1. **派生**：已发布表单的 `assignees` 声明 → upsert `form.assigned` / `form.due_reminder` 两条 notify 规则（确定性 id）。
2. **指派**：逐人 emit `form.assigned`（`event_id = form:<assetId>:<version>:assigned:<user>`）。
3. **催办**：`published_at + due.afterDays` 到期且**未提交**者，逐人 emit `form.due_reminder`（`event_id` 含日期 ⇒ 同日重跑不重复）。

> ⚠️ **D-A 的语义后果**：`form.assigned` 的投递时刻 = **下一次调度**，不是发布瞬间。
> 要「发布后尽快通知」就把频率设成小时级（延迟 ≤ 1 个周期）。

## 建在哪 / 怎么建

- **openship 面板 → Jobs** 新建（口径见 `deploy/openship-adopt.md` 同款「清理由 openship job 定时执行，应用进程不自己跑」）。
- 执行形态照 `deploy/data-compose.yml` 的 dbt runner 范式：**一次性容器跑 `docker run`，零常驻**。
- 命令（示意）：在项目容器内跑 `pnpm exec tsx scripts/notify-reconcile.mjs --json`。
- **cron 按 UTC 解释**（`deploy/data-plane-deploy-sop.md` §E.7 已实测，不是服务器本地时区）：
  要「每日 08:00 CST」须写 UTC `0 0 * * *`；建议**小时级**（见上）。

## 配置从哪取（不写明文）

| 键 | 从哪取 |
|---|---|
| `DATABASE_URL` | openship 该项目 env（isSecret）注入 |
| `NOVU_BASE_URL` / `NOVU_API_KEY` | 同上（缺省时脚本仍跑：emit 落 failed 回执，不抛） |

> ⚠️ **不要去 SSH 读机器上的 env**——那是读机器状态，违反「唯一通道」铁律
> （同 `scripts/reconcile-tenant-sources.mjs` 头注口径）。脚本只接受**运行方传进来的**声明。

## 怎么读结果 / 告警

- 退出码（与既有对账脚本同口径）：**0** = 干净；**1** = 有失败（emit 回执 `failed > 0`）；
  **2** = 对不成账（缺 `DATABASE_URL` / 查询失败）。
- stdout：一行结论（`--json` 则给结构化 `{targets, derived, emitted, failed}`）。
- **必须订阅失败通知**：job 静默失败 = 指派/催办没发生，且没有任何一处会红
  （`deploy/openship-adopt.md` 同款要求；不许 `continue-on-error`）。

## 待实测（不得据以声称可用）

- **N=500 名单**时的调度耗时与 Novu 限速（正典 §2.4 实施注记的验收项）。
- 首次上线前按 §2.4 验收五条走一遍：发布各收到一次 / 到期未提交各一次 / 已提交不收 /
  存量（无 `assignees`）零影响 / 停用规则后不通知。
