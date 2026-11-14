# 指标下线提案 job（`metric-retire`）

> 代码：`scripts/metric-retire-job.mjs`（薄 CLI：枚举 org → 逐 org 提单 → 汇总）+
> `modules/data/domain/metric-retire.ts`（候选安全过滤 + 提单，判定全在域层）。
> 计划：`docs/superpowers/plans/2026-11-14-metric-retire-wave.md`（候选池项「使用统计→下线候选接评审」，
> spec §10.4.3）；读面 `modules/data/domain/metric-usage.ts`（`retireCandidatesOf`）。
> 范式与 `deploy/notify-jobs.md` / `deploy/report-scope-scan-job.md` 一致：**仓内脚本 + worker 的
> `platform.scheduler` loop**（常驻，执行在子进程），手动命令走 `docker exec <server 容器> sh -lc '…'`。
> 调度归属（2026-11-14 起）：本脚本的目标载体是 worker 的 `platform.scheduler` loop；
> **迁移按 `deploy/jobs.md` 的切流表逐项进行——未切流的 job 此刻仍由 openship job 驱动**。
> 仍然不要把这逻辑塞进 HTTP 请求路径：执行在 worker 的子进程里。
> ⚠️ **本文件只给参数与命令，job 不代建**——建 job 是运维动作，须由人点名后执行。

## 它补的是哪条断链

L2 租户指标的「下线」此前只有人工入口：零使用的指标永远挂在词表里，没人回头看就永远没人删。
本 job 把候选池的「使用统计→下线候选」这一项接上**评审**——零使用的租户 L2 指标由 job 自动提
**delete 档变更单**（带提议原因），单子落在 console「待核对」页，**人决定采纳/驳回**。

## 安全模型（铁律：job 只提案，永不删行）

1. **job 只提案**：生效唯一路径仍是人在「待核对」页点采纳（决策端点只认会话，PAT 打 adopt 一律 403）。
   job 的提交身份固定 `{userId:'metric-retire-job', channel:'job'}`，采纳侧一眼可辨出处。
2. **四条安全过滤（缺一不提单）**，全在 `domain/metric-retire.ts`，脚本不自带判定：
   - ① 仅 L2 且窗口内 0 次使用（候选池读面；**L1 是平台口径，永不进候选**）；
   - ② 行龄 ≥ 窗口（`updated_at` 早于 now−days——新采纳/新改的口径给满一个观察窗口）；
   - ③ 不被任何报表引用（草稿 `data.reports.spec` ∪ 已发布快照 `data.report_versions.spec`，
     经 `parseStoredSpec` 归一后取 `metricIdsOf`：面板 `metricId` 与 KPI 分母都算；spec 为 null
     的 metabase 行合法缺席，非空但解析失败的行跳过并留痕）；
   - ④ 已有未决单**或人已驳回** ⇒ 跳过（未决的 id 不叠第二张单；驳回是人的明确决定，job 不跟人拉锯）。
3. **驳回不重提**：④ 排除的是 `PENDING_STATUSES ∪ rejected`。回头路是**真实变化**——指标后来
   又有使用再归零时 `updated_at` 刷新、行龄重新给满一个窗口，届时重提是「新证据」不是复读
   （superseded/withdrawn 不排：withdrawn 是提案方自己撤的，不构成人的否决）。
4. **提单带提议原因**：payload `{reason:'连续 N 天 0 次使用（报表引用已排除）'}`，待核对页默认层
   展示（执行器不读 reason）。单子初始 **draft**（试算未跑）：delete 档试算 = 删前口径快照，
   人在待核对页点「跑试算」补出来再决定采纳/驳回——没看到数就不该采纳。

## 命令

```sh
# mytech 实例（serverId 23a1091e-…）
docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/metric-retire-job.mjs'

# 山海实例（serverId 8281d598-…）
docker exec openship-platform-core-shanhai-server sh -lc 'pnpm exec tsx scripts/metric-retire-job.mjs'
```

- env：只需要 `DATABASE_URL`（平台库，`data.metrics` / `data.metric_change` / 报表表都在）。
  已在 server 容器的项目 env 里；**job 不注入 secret**。
- 窗口（天）：`--days N` > env `METRIC_RETIRE_DAYS` > 缺省 90。正整数，非法 exit 2（不猜默认硬跑）。
  加窗口会同时放宽「0 次使用」与「行龄」两道闸（同一个 N）。
- 两实例各有自己的库 ⇒ **每实例一个 job**。排障手动跑可加 `--days 30` 之类收紧/放宽观察。

### 前置条件（缺一不可）

| # | 条件 | 说明 |
|---|---|---|
| 1 | 目标实例的镜像里**已有** `scripts/metric-retire-job.mjs` | mytech 合并 main 后自动部署；**山海是手动更版**（`deploy/delivery-private.md`）。未更版就建 job ⇒ 手动跑会 `Cannot find module …/metric-retire-job.mjs` |
| 2 | 容器里有 `DATABASE_URL`（平台库） | 走 server 的项目 env，job 不另注入 |
| 3 | 平台库迁移已到位（`data.metrics` / `data.metric_change` / `data.reports` / `data.report_versions` / 使用统计审计聚合） | 域层只读写平台库，不碰仓库库 |

## 判据（stdout + 退出码）

```
metric-retire: org=shanhaiyiguo-org days=90 proposed=2 skipped=11 failed=0
metric-retire: orgs=1 failed=0 proposed=2 skipped=11
```

- 逐 org 一行：`proposed=` 提单成功数、`skipped=` 安全过滤挡下的候选数（含未决/已驳回/被引用/行太新）、
  `failed=` 提单动作被拒的候选数（submitChange 返回 !ok；并发双跑主要走 supersede，不走拒绝）。
- 汇总一行：`orgs=` 处理的租户数、`failed=` **失败的 org 数**（域层抛错，或该 org `failed>0`）。

| 退出码 | 含义 |
|---|---|
| 0 | 全部租户处理成功（**`proposed=0` 也是成功**：0 候选不是失败——零使用的指标都被安全闸挡下、或本来就没有候选，都是正常结果） |
| 1 | 有 org 失败（逐行 `org=… 失败 <原因>` 或该行 `failed>0`；幂等：重跑对未决指标不会再提单，安全过滤会跳过它们） |
| 2 | 查不成账（缺 `DATABASE_URL` / `--days` 或 `METRIC_RETIRE_DAYS` 非法 / org 枚举本身失败） |

- **`orgs=0` 是告警信号**：`data.metrics` 里没有 L2 行 = 指标面没同步（`sync-data-semantics` 没跑？）。
  与 candidates job 的 `orgs=0` 同型——正常退出但要人看见。
- 提出去的单落在「待核对」页（draft 态）：**job 红不红只反映「提单链路」健康**；
  单子本身的质量由人按提议原因 + 试算快照裁决。

## openship job（建议排班——**尚未创建，由人点名后按下面步骤执行**）

### 参数

| 字段 | mytech | 山海 |
|---|---|---|
| label | `metric-retire（指标下线提案）` | `metric-retire（山海）` |
| serverId | `23a1091e-b29e-4716-96aa-786d3c90c0a5` | `8281d598-af73-4d0b-99dd-bc8681fcc8bb` |
| cron（UTC） | `23 3 * * 1`（= 北京周一 11:23，**每周一次**） | 同左 |
| timeoutMs | `300000` | 同左 |
| retry | `{ "maxAttempts": 2, "backoffSeconds": 60 }` | 同左 |
| notifyConfig | `{ "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }` | 同左 |

排班依据：提案的时效是「一个观察窗口」（90 天量级），**周一次绰绰有余**；提单有未决/驳回排除，
跑得再密也只会重复撞闸。`23 3 * * 1` 只在周一落在本机既有每日 `23 3 * * *`（notify-retention）
的同一分钟——两个都是轻任务、互不依赖，可容忍；介意就挪几分钟（如 `27 3 * * 1`）。**cron 按 UTC 解释。**

### Step 1：建 job（openship MCP `post_jobs`）

mytech：

```json
{
  "label": "metric-retire（指标下线提案）",
  "command": "docker exec openship-platform-core-server sh -lc 'pnpm exec tsx scripts/metric-retire-job.mjs'",
  "cronExpression": "23 3 * * 1",
  "scheduleType": "recurring",
  "serverId": "23a1091e-b29e-4716-96aa-786d3c90c0a5",
  "timeoutMs": 300000,
  "retry": { "maxAttempts": 2, "backoffSeconds": 60 },
  "notifyConfig": { "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }
}
```

山海（只改 label / command / serverId）：

```json
{
  "label": "metric-retire（山海）",
  "command": "docker exec openship-platform-core-shanhai-server sh -lc 'pnpm exec tsx scripts/metric-retire-job.mjs'",
  "cronExpression": "23 3 * * 1",
  "scheduleType": "recurring",
  "serverId": "8281d598-af73-4d0b-99dd-bc8681fcc8bb",
  "timeoutMs": 300000,
  "retry": { "maxAttempts": 2, "backoffSeconds": 60 },
  "notifyConfig": { "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }
}
```

期望：返回 `key=custom:...`，`nextRunAt` 为下一个周一 `03:23Z`。

### Step 2：手动触发一次（判据是两处都对）

```
MCP post_jobs_by_key_run(key=<返回的 key>)
```

- `status=success`、`exitCode=0`（首跑大概率 `proposed=0`——安全过滤挡掉多数候选是**预期**，
  不是失败）；逐 org 行与汇总行都在；
- `orgs=` 与该实例 `data.metrics` 里 `source='l2'` 的 distinct org 数对得上；
  **`orgs=0` 不要当通过**——按上节判据当告警查。
- 提了单（`proposed>0`）→ 到 console「待核对」页确认：单子 kind=删除指标、提交人是
  `metric-retire-job`、默认层有「提议原因：…」一行。

### Step 3：回读确认

```
MCP get_jobs_by_key(key=<key>) / get_jobs_by_key_runs(key=<key>)
```

确认 `enabled=true`、`cronExpression=23 3 * * 1`、`notifyConfig.states=['failed']` 与预期一致。

## 运维速查

- **重跑安全吗**：安全。同 (org, metric) 未决单被域层排除（并发窗口由
  `metric_change_one_pending_uq` 兜底）；驳回过的指标不会原样重提。
- **想让它更保守**：调大 `--days` / `METRIC_RETIRE_DAYS`（如 180）——窗口拉长，「0 次使用」
  与「行龄」两道闸都更严，提出来的单更少。
- **想把某指标从候选面永久摘掉**：不用改 job——给它加报表引用（人工在用）或提一张
  delete 单后驳回（`rejected` 永久排除，直到指标真实复活再归零）。
- **job 报红了怎么办**：先看逐 org 行是 `失败 <原因>`（域层抛错 = DB/迁移问题，按普通 DB 故障排）
  还是 `failed>0`（提单被拒——查该 org 是否有并发双跑/唯一索引 23505）；都不是 ⇒ 按异常处理，
  别在 job 里加白名单吞掉。
