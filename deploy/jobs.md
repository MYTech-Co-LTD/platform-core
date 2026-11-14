# 业务定时（`platform.scheduler`）运维口径

> 正典：`docs/architecture.md` §2.4「定时载体（2026-11-14 修订）」。
> 设计：`docs/superpowers/specs/2026-11-14-business-scheduler-design.md`（v2）。
> 本文只写**口径与程序**，不写实现细节；表结构与代码以实际发版为准。
> 运维操作一律走 openship MCP / dashboard，不裸 SSH。

## 1. 两条线：基建定时 vs 业务定时

| | 基建定时 | 业务定时 |
|---|---|---|
| 载体 | openship job | worker 的 `platform.scheduler` loop |
| 典型 | 主机指标、探活看门狗、备份、证书 | 通知对账、指标候选池、报表受众巡检、组织同步… |
| 判据 | 失败 = **机器/进程/证书状态异常** | 失败 = **业务数据/业务动作没发生** |
| 台账 | openship job run | `platform.job_run` |
| 回滚 | openship 侧停 job | `SCHEDULER_ENABLED=0` + 反向切流（见 §6） |

**硬口径**：

- **单调度者**：任一 job 任一时刻只能有一个调度者（openship 或本调度器）。切流期间不得双跑。
- **排引擎不排规则**：可排的是代码里已注册的 key；agent 不能注册 handler，也不能凭空排一个未注册 key。
- **只做 cron + 台账**：不做 DAG / 依赖编排 / 回填队列 / 分布式执行。
- **system job 的 `params` 不生效**：`source='system'` 时行为只由代码 registry 决定，改库改不了副作用。
- **HTTP 进程不跑定时副作用**：宿主 `server` 不装 interval；手动触发只**入队**，执行在 worker 的子进程。

**当前状态（2026-11-14，P1）**：只有 `notify.reconcile` / `metric.candidates` / `report.scope_scan` 三个 job 已切到本调度器；
其余业务 job（`notify-health` / `notify-retention` / `notify-seed-builtin` / `notify-preflight` / `metric-retire` / `org-sync`）
**此刻仍由 openship job 驱动**。逐项状态见 §5 切流表。

## 2. 台账：三张表

### 2.1 `platform.job_schedule`（排班）

| 列 | 语义 | 运维要点 |
|---|---|---|
| `id` | 排班主键 | agent 排班允许同一 `key` 多条；system job 由部分唯一索引保持「一 key 一条」 |
| `key` | registry key（如 `notify.reconcile`） | 只有代码里注册过的 key 才会被执行；未注册 key 永远不跑 |
| `cron` | 5 段 cron | 只支持 `* , - /` 与数字；**不支持的语法在登记期直接拒绝**（不会静默按错时间跑） |
| `timezone` | IANA 时区名 | 迁入的系统 job 一律 `UTC`（与 openship 现有 cron 的 UTC 语义一致）；新建业务排班默认 `Asia/Shanghai` |
| `params` | 运行参数 JSON | **仅 `source='agent'` 生效**；system job 恒为 `{}` |
| `owner_org` / `owner_namespace` | 归属 | system job 为 null；由宿主按身份填，不读请求体 |
| `source` | `system` / `agent` | 决定 `params` 是否生效，以及「一 key 一条」约束 |
| `enabled` | 是否参与调度 | **默认 false**：seed 只登记不启用，切流由人显式打开 |
| `next_run_at` | 下一次 claim 的 bucket | 为空 = 未排班；启用后必须补算到**未来**时点（不要用 `now()`，否则会立刻跑） |
| `timeout_ms` | 单次执行超时 | 到点 `SIGTERM`，5s 后 `SIGKILL`，台账记 `timeout` |
| `max_attempts` | 最大尝试次数 | 非 0 失败在额度内隔 60s 重排；`exit 2` 永不重试 |
| `expected_interval_secs` | 期望间隔 | 健康判据的分母：「超过 2× 无成功 run」判红（见 §8） |
| `retry_at` / `retry_attempt` | 重试游标 | 重试与下一格是两件事：重试**不改** `next_run_at`，沿用原 occurrence |
| `updated_at` | 最后变更时间 | 从未成功过的排班，健康判据以它为宽限起点 |

### 2.2 `platform.job_run`（运行台账）

| 列 | 语义 | 运维要点 |
|---|---|---|
| `schedule_id` / `key` | 归属排班 / registry key | 按 `schedule_id, started_at desc` 查最近运行 |
| `occurrence` | 本次执行的 **claim bucket**（UTC） | 不是实际开跑时刻，见 §4 |
| `trigger` | `schedule` / `manual` | 手动触发只入队，worker 领取后执行 |
| `status` | `queued` / `running` / `ok` / `failed` / `timeout` / `skipped` | 闭集；`queued` 只用于手动触发的待执行行 |
| `attempt` | 第几次尝试 | 重试递增；`exit 2` 不重试 |
| `started_at` / `finished_at` | 起止时间（UTC） | `running` 且 `started_at < now - 2×timeout_ms` ⇒ 下一跳回收为 `timeout` |
| `exit_code` / `duration_ms` | 退出码 / 耗时 | 判读失败原因的第一手证据 |
| `output_tail` | 输出尾部（约 4KB） | 只留尾部，不替代完整日志 |
| `error` | 失败摘要 | 含超时、信号、退出码、僵尸回收等 |

### 2.3 `platform.job_heartbeat`（调度器心跳）

- 每跳 upsert 一行（`id='scheduler'`），`beat_at` 为 UTC。
- `beat_at` 陈旧 > 2 分钟 ⇒ 调度 loop 本身不健康（`/healthz` 非 200）。这是「引擎还活着」的判据，**不要**用「最近没有作业」代替。

## 3. 执行契约（脚本侧）

| 渠道 | 内容 |
|---|---|
| env | `JOB_KEY` / `JOB_SCHEDULE_ID` / `JOB_OCCURRENCE` / `JOB_OWNER_ORG` / `JOB_OWNER_NAMESPACE`（为空则缺席） |
| **stdin** | `JOB_PARAMS`：**一行 JSON，≤16KB** |

- `JOB_PARAMS` **只走 stdin**，不进 env、不进 argv：argv 和环境对同机进程可见，且有长度上限；stdin 只有父子进程知道。
- `JOB_OCCURRENCE` 走 env（小标量），`params` 走 stdin（可能大）。两者不要互换。
- 子进程一律 **argv 数组 spawn，禁 shell 拼接**。
- 超过 16KB 的 `params` ⇒ 脚本 `exit 2`（判不了，不跑）。

**退出码分类**：

| 退出码 | 台账状态 | 是否重试 |
|---|---|---|
| `0` | `ok` | — |
| `2` | `failed` | **不重试**（缺 env / 判不了 / 参数非法：重跑也判不了） |
| 其他非 0 | `failed` | 在 `max_attempts` 内隔 60s 重排（`attempt+1`，新 run 行） |
| 超时被 kill | `timeout` | 可重试（仍受 `max_attempts` 约束） |

## 4. `JOB_OCCURRENCE` = claim bucket

- 语义**钉死**：`JOB_OCCURRENCE` = claim 到的那一格 **bucket 的 UTC ISO 时刻**，**不是实际开跑时刻**。
- misfire 迟到 3 小时也用它；重试沿用**同一 occurrence**。
- 下游幂等键应基于 `occurrence`（而不是 `now()`）构造，否则迟到/重试会双发。
- 手动触发不占 cron bucket：`trigger='manual'`，台账另记一行。

## 5. 切流程序（一次一个 job）

前提：代码已发版（registry 已含该 key）、迁移已跑、seed 已执行。

1. **登记（enabled=false）**：确认 `platform.job_schedule` 有该 key，且 `enabled=false`、`next_run_at=null`、`params={}`。seed 只补新增 key，**不覆盖**人改过的 `cron` / `enabled`。
2. **手动跑一次并比对**：由平台管理员手动触发（P1 端点 `POST /api/platform/jobs/:key/run`，**只入队**），等 worker 领取并记录 `job_run`。比对产物与 openship 上最近一次结果：数量、口径、落表/落事件都要对得上；**比对不过不启用**。
3. **关 openship**：`patch_jobs_by_key` 把对应 job 置 `enabled=false`，确认 openship 侧不再产生新 run。
4. **DB 启用**：置 `enabled=true`，并把 `next_run_at` 补算到**下一个未来时点**（不要落在过去，否则会立即补跑）。观察首条 `job_run` 为 `ok`，且 openship 侧保持安静。

**切流表（P1 已切 / 待切）**：

| job | 阶段 | 当前驱动 |
|---|---|---|
| `notify.reconcile` | **P1 已切** | worker 的 `platform.scheduler` |
| `metric.candidates` | **P1 已切** | worker 的 `platform.scheduler` |
| `report.scope_scan` | **P1 已切** | worker 的 `platform.scheduler`（openship 侧本无对应 job） |
| `notify-preflight` | 待切（W6-P4） | openship job |
| `notify-retention` | 待切（W6-P4） | openship job |
| `notify-seed-builtin` | 待切（W6-P4，计划启动期化） | openship job |
| `notify-health` | 待切（W6-P4，计划并入 worker loop） | openship job |
| `metric-retire` | 待切（W6-P4） | openship job |
| `org-sync` | 待切（W6-P4） | openship job |

**顺序按爆炸半径**：`notify.reconcile` → `metric.candidates` → `report.scope_scan` → `notify-preflight` → `notify-retention` → `metric.retire` → `org-sync`。
未列入「P1 已切」的 job，在完成全部四步切流之前**都仍由 openship 驱动**——不要提前置 `enabled=true`。

**切流期红线**：发现双调度者（DB `enabled=true` 且 openship job 仍启用）⇒ 立即停 DB 侧 `enabled`，再排查 openship，不要在两边同时「先看看」。

## 6. 回滚

- **一键停调度 loop**：`SCHEDULER_ENABLED=0`。只停 `platform.scheduler`，**不影响通知投递 loop**；改 env 后需重启/重部署 worker 才生效。
- **反向切流（逐 job）**：
  1. DB 置 `enabled=false`（先停新 claim，避免与 openship 抢）；
  2. 重新启用 openship 对应 job，确认它产生新 run；
  3. 观察 `platform.job_run` 不再新增。
- 回滚**不删台账**：`job_schedule` / `job_run` 是审计面，保留原样。
- 回滚后不要手工把 `running` 改成 `ok`；僵尸行由下一跳回收为 `timeout`，或按实际结果记失败。

## 7. 判读：零候选 / 无运行是正常还是异常

### 7.1 「零候选」分两种

**正常零**：脚本自己的判据说 0 是成功，且**输入源健康**。例：

- `metric-candidates`：`added=0` 是成功（没有可推的列）。
- `metric-retire`：`proposed=0` 是成功（候选全被安全闸挡下，或本来就没有候选）。
- `notify-reconcile`：`targets=0 / emitted=0` 表示本轮没有到期催办，正常。

**异常零**：输入源空了，不是「没事做」。判据是**上游计数**而不是结果计数：

- `orgs=0`（画像表 / 指标表 / 报表表里没有 org）⇒ profiler / 同步链路没投递，按告警查；
- `reports=0` / `tenants=0` 且该实例明确不是空库 ⇒ 同上；
- 脚本明确标注「`orgs=0` 是告警信号」的，按告警处理，不要当通过。

一句话：**看脚本声明的「0 是否成功」+ 看上游分母是否 > 0**；两者不一致就是异常零。

### 7.2 「无运行」分两种

- **启用后从未有 run**：异常。依次查 `enabled=true`、`next_run_at` 非空且在未来、worker 心跳新鲜、registry 含该 key。心跳新鲜但超过 `2×expected_interval_secs` 无 `ok` run ⇒ 健康判红「该跑没跑」。
- **有 schedule 但本来就不该跑**：`enabled=false` 是「登记未启用」，不是故障。seed 后的初始态就是三行 `enabled=false`、`next_run_at=null`。
- **`skipped`**：同 schedule 上一次还在跑，本轮跳过。偶发正常；连续出现说明上一轮卡死，按 §9 查。
- **`queued` 长期不消失**：worker 没在领取。查 worker 心跳与 `/healthz`，不要重复手动触发（端点会对 `queued|running` 返回 409 `JOB_ALREADY_PENDING`）。

## 8. 健康判据（`/healthz`）

以下任一成立 ⇒ `/healthz` 非 200：

1. **调度心跳陈旧**：`platform.job_heartbeat('scheduler').beat_at` 超过 2 分钟未更新，或从未写入。
2. **该跑没跑**：任一 `enabled` 的 system schedule，超过 `2 × expected_interval_secs` 没有 `ok` run（从未成功过时从 `updated_at` 起算，给新启用一个宽限窗）。
3. **连续失败**：最近 3 次运行（按 `started_at desc`）全部是 `failed` / `timeout`。

**边界**：健康面回答「引擎活着吗、该跑的在跑吗」，**不回答产物语义是否正确**。切流比对与业务验收仍要做。

## 9. 常见处置

| 症状 | 首查 | 处置 |
|---|---|---|
| 双调度者（DB + openship 都在跑） | 两侧 `enabled` | 先置 DB `enabled=false`，再收 openship；确认只留一个 |
| 一直 `running` 不结束 | worker 进程 / 子进程 | 等 `2×timeout_ms` 被回收为 `timeout`；不要手工改 `ok` |
| 启用后从不执行 | `enabled` / `next_run_at` / worker 心跳 / registry key | 逐项修；`next_run_at` 必须补算到未来时点 |
| 改了 `params` 行为不变 | `source` 是否 `system` | 预期行为：system job 只认代码 registry；要改行为请改代码并发版 |
| seed 没覆盖我改的 cron | seed 语义 | 预期行为：seed 只补新增 key、不覆盖人改过的 `cron`/`enabled` |
| cron 到点没跑 / 时区差 8 小时 | `timezone` 列 | 迁入系统 job 应为 `UTC`；新建业务排班默认 `Asia/Shanghai`；run 时间戳一律 UTC |
| 手动触发返回 409 `JOB_ALREADY_PENDING` | 是否已有 `queued`/`running` | 不重复触发；等当前运行结束 |
| `/healthz` 红但 job 其实跑过 | 是否只有 `failed`/`timeout` | 看 `job_run.error` / `output_tail`；连续失败 3 次会判红 |

## 10. 上线/切流检查单

- [ ] 迁移已跑，三张表存在。
- [ ] registry 已含目标 key；`platform.job_schedule` 中该 key `enabled=false`、`next_run_at=null`、`params={}`。
- [ ] worker 已部署，`/healthz` 绿，`platform.job_heartbeat('scheduler')` 在 2 分钟内。
- [ ] 每个待切 job 已手动跑一次，产物与 openship 最近一次比对通过。
- [ ] 对应 openship job 已关，且确认不再产生新 run。
- [ ] DB 置 `enabled=true` + `next_run_at` 为下一个未来时点。
- [ ] 首条 `job_run` 为 `ok`；openship 侧保持安静。
- [ ] 回滚路径已知：`SCHEDULER_ENABLED=0` + 反向切流（§6）。
