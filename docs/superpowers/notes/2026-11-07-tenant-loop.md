# 租户级自转 runbook（W7 Task 3，2026-11-07）

> 设计：`docs/superpowers/specs/2026-11-07-tenant-selfdriving-design.md`。
> 本文只写**怎么跑、看什么、边界在哪**；判据与证据的变更记录在路线图 §5/§7。

## 1. 首日基线（shanhai，2026-11-07 真机）

| 项 | 值 |
|---|---|
| 租户 | `shanhaiyiguo-org`（`TENANT_MODE=single`，部署内唯一租户） |
| `data.query_audit` | 7,875 行 |
| `data.demand_signals` | 45 行 |
| `data.demand_mining_state` | 2 个游标（`query_audit` / `askdata_conv`） |
| `data.metric_candidates` | 278 行 |
| `data.verified_questions` | 104 行（回归 `total=50` 为本轮实际重放集；其余是 candidate/弱信号） |
| 回归（修复前） | `total=50 pass=48 fail=2`：`#3` 滚动窗口基线、`#1723` 标识列 sum 漂移 |

## 2. 环路四步（每步都可单独重跑）

### 2.1 需求挖掘（每日 job，`demand-mining-shanhai`）

```sh
# 单租户部署：--all-tenants 与 PLATFORM_ORG 等价；多租户时逐 org 跑
docker exec <server-container> sh -lc 'cd /app && npx tsx scripts/demand-mining.mjs --all-tenants'
```

判据：每 org 一行 `demand-mining: org=… scanned=… conv=ok|skipped(multi-tenant)`；任一 org 失败 ⇒ 退出 1 并点名。

**边界**：`askdata_trace` / `askdata_stuck` 没有租户字段 ⇒ 只有部署**恰好 1 个租户**时才挖 conv；
多租户部署会显式打印 `conv=skipped(multi-tenant)`——这是事实，不是「0 条需求」。

### 2.2 候选池处置（租户在 console）

候选按 `org` 隔离（`data.metric_candidates` 的每条 SQL 都带 `where org = $1`）；
生成入口在 console 的私有测度页（`POST` 路由 → `generateCandidates`）。平台不代跑。

### 2.3 评估集入库（只收**已封板绝对窗口**）

```sh
DATABASE_URL=… DATA_WAREHOUSE_URL=… pnpm exec tsx scripts/apply-eval-set.mjs \
  --org <org> --items <items.json> --by <确认人> [--write]
```

- `window: default` 会被拒（`window_required`）——它会把指标自身的相对缺省固化成滚动基线。
- `fixed` 必须带 `from/to` 且 `to < 今天`；`yesterday/last7/mtd` 在摄入时解析成绝对区间。

### 2.4 回归 + verdict 可见性（每日 job，`verify-regression-shanhai`）

```sh
docker exec <server-container> sh -lc 'cd /app && npx tsx scripts/verify-regression.mjs --org <org>'
```

- `value`/结构漂移 ⇒ `fail`（退出 1）；维度/标识列漂移 ⇒ `warn`（退出 0，逐行打印 + 汇总 `warn=N`）。
- job 末尾把一行 `{probe:"regression", check:"regression:<org>", verdict:"OK|RED", detail:"…"}` 投到
  OO `data_plane_probes`；`oo-notify-bridge.sh` 通道②只转发 `verdict <> 'OK'`（≤2 分钟，per-check 冷却）。
- 投递失败只打 `PROBE_EMIT_FAILED` 告警，**不改变**回归自身退出码。

基线过期（数据回填/行集变化）用受控刷新：

```sh
# 先 dry-run 看 before/after/driftPct
pnpm exec tsx scripts/refresh-baseline.mjs --org <org> --id <N>
# 确认后落库（by/reason 必填）
pnpm exec tsx scripts/refresh-baseline.mjs --org <org> --id <N> --by <人> --reason <原因> --write
```

## 3. 7 / 30 天观察 SQL

```sql
-- 需求信号增长（按 kind）
select kind, count(*) as n, max(updated_at) as last_at
  from data.demand_signals where org = $1 group by kind order by n desc;

-- 处置率（已 resolved / 总数）
select status, count(*) from data.demand_signals where org = $1 group by status;

-- 回归覆盖与稳定性（最近 30 天）
select date_trunc('day', last_checked_at) as d,
       count(*) filter (where last_check_result = 'pass') as pass,
       count(*) filter (where last_check_result = 'fail') as fail,
       count(*) filter (where last_check_result = 'error') as err
  from data.verified_questions
 where org = $1 and last_checked_at > now() - interval '30 days'
 group by 1 order by 1;

-- 候选池吞吐
select status, count(*), max(updated_at) from data.metric_candidates
 where org = $1 group by status;
```

## 4. 当前状态与已知边界

- **30 天判据**：观察中（本文件首日基线 2026-11-07；到期后按 §3 取数）。
- conv 侧多租户不可归因（无租户字段）；要支持需给 openclaw 导出器加 org（历史不可回填）。
- job failed 通知**不进站内 deliveries feed**（平台缺陷，另开 issue）；数据面可见性以 OO 为单出口。
- 候选生成仍由租户在 console 触发，未定时化。
