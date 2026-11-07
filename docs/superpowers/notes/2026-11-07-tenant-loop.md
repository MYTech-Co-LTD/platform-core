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
| 回归（上线后，见 §5） | 最终 `total=49 pass=49 fail=0 warn=0`；处置过程见 §5（源数据修订 → 受控刷新；另发现 ingest 静默覆盖基线，issue #1594） |

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

### 3.1 观察起点快照（2026-11-07T07:26:40Z）

| 指标 | 值 |
|---|---|
| `data.demand_signals` | **45** 条（已否决 0） |
| `data.metric_candidates` | pending **276** / created **2** |
| `data.verified_questions` | **49 verified** / 24 stale / 5 candidate / 26 rejected |
| 回归（job `jrun_7OiISVYyAA2kuoTD`） | **49/49 pass、0 warn** |

**7 天对照基线**：下次按 §3 取数，比较 `demand_signals` 总量/否决数、候选 pending 吞吐、`verified` 数量与回归 pass 率。
观察起点 = 2026-11-07；30 天判据到期 ≈ **2026-12-07**。

## 4. 当前状态与已知边界

- **30 天判据**：观察中（本文件首日基线 2026-11-07；到期后按 §3 取数）。
- conv 侧多租户不可归因（无租户字段）；要支持需给 openclaw 导出器加 org（历史不可回填）。
- job failed 通知**不进站内 deliveries feed**（平台缺陷，另开 issue）；数据面可见性以 OO 为单出口。
- 候选生成仍由租户在 console 触发，未定时化。

## 5. 上线实测（2026-11-07，shanhai v203 / `30c71d7c`）

| 项 | 结果 |
|---|---|
| 部署 | `dep_SlvLoUCdPBzCDFow` · v203 · `30c71d7c` · 4/4 服务成功 |
| 数据面投递 | `SYNC_OK 384/384` · revision `30c71d7c` · `/opt/lemeng-emit-probe.py` 在场 |
| 多 org 挖掘 | `demand-mining --all-tenants` → `org=shanhaiyiguo-org … conv=ok`，rc=0（单租户，对话侧可挖） |
| 评估集卫生 | `#3`（近 7 天，`params={}`）置 `stale`（`decided_by=claude`）；回归集 50 → **49** |
| 判定分级 | `#1723` 由 **fail → pass + warn**（仅 `branch_num` 标识列 sum 漂移）；value 漂移仍 fail |
| 可见性 | 手动触发回归 job（`jrun_pWUwtgh_y8cKU51T`）：末行 `emit-probe: 已投递 … RED`；OO `data_plane_probes` 可查 `verdict=RED, detail=verify-regression: total=49 pass=39 fail=10 error=0 warn=38` |

### ★ 实测发现的数据修订（**未刷新基线，待裁决**）

上线后首次重放出现 **10 条 `value` 漂移**（10 月出库类）：

- `fct_hq_outbound` 相关：`gross_profit` 156,965.72 → 145,481.79；`line_count` 7,348 → 7,080；
  `net_amount` 1,955,298.38 → 1,924,578.99；`region_l1` nulls 252 → 249、`client_fid` nulls 748 → 751；
  `system_book` sum 5,623,788 → 13,196,220（**行集构成大幅变化**）。
- `#1`「昨天的净销售额」203,765.28 → 247,333.54。
- 原因：staging 已翻**直读湖视图**（`lemeng-staging-views-flip`）⇒ 湖侧 10 月数据修订会**立即**反映到
  mart 查询；本次时间窗与 03:54–05:21 的一次全量物化尝试重合，但该 job 最终以 git 超时失败、
  未写水位（`data.load_log` 里 `fct_hq_outbound` 停在 10-17）。
- **定性证据**：湖侧 10 月 `stg_lemeng_transfer_out` 行数 32,304，`max(batch_id)=to-64188-transfer_out-20261106T234522Z`
  ⇒ 源侧在 11-06 23:45Z 重采过；而 `fct_hq_outbound` 的 load_log 停在 10-17 ⇒ 早上的物化重建才把
  这次修订带进 mart。故定为**基线过期**（口径未变），不是口径回归。

### 处置结果（2026-11-07 收尾）

- **受控刷新**：`refresh-baseline --write` 刷新 9 条 value 基线（by=claude，reason 记
  `transfer_out batch 20261106T234522Z + mart 重建后基线过期；口径未变`）+ `#1723`（行集变化）。
- **回归终态**：`total=49 pass=49 fail=0 warn=0`，rc=0；job `jrun_7OiISVYyAA2kuoTD` 成功并投递
  `OK`（OO `data_plane_probes` 三态齐全：shadow OK → RED → OK）。
- **★ 途中发现（issue #1594，已修）**：`#1` 的基线在 05:40 被 **`verify-ingest-shanhai`（每小时 :40）**
  重放后 `upsertCandidate` **静默覆盖**（auto-strong 分支），`baseline_refreshed_*` 仍为空。
  **修复（PR #1596，v204）**：覆盖已验基线的同一条 UPDATE 写
  `by = human|auto:strong`、`reason = human:upsert|auto:verify-ingest`、`at = now()`。
  真机探针（容器内临时 org，自清理）复验：
  `{"baseline_refreshed_by":"auto:strong","baseline_refresh_reason":"auto:verify-ingest"}`；
  修复后回归仍 `49/49 pass`。
