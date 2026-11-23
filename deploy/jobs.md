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
- **业务 job 的定时副作用不进 HTTP 进程**：手动触发只**入队**，执行在 worker 的子进程。
  既有例外是**监控面**的集成健康探针（`apps/server/src/integration-probe.ts:385` 的 `setInterval`，
  由 `apps/server/src/app.ts:445` 启动，`deploy/docker-compose.yml:77` 的 `INTEGRATION_PROBE_INTERVAL_MS=60000` 开启）——
  它不承担业务 job，不改变本条结论。

**当前状态（2026-11-15 订正）**：

- **P1 已上线并完成切流**（迁移 018 + 调度器 + 三个 job）：`notify.reconcile`（mytech + 山海两实例）、
  `metric.candidates`（仅山海）、`report.scope_scan`（两实例）**已由内置调度器驱动**，
  openship 对应 job 已停。
- **P2 已上线**：`SchedulerPort` + `notify.emit` handler + 一次性延迟 + 软删。
- **P3 随本 PR 上线**：agent 排班工具面 + 配额（§11）。
- **P4a 随本 PR 上线**：手动触发迁入 jobs 模块——`POST /api/modules/jobs/:key/run`（需
  `jobs:manage` + CSRF）；宿主旧路由 `/api/platform/jobs/*` **已退役删除**（旧路径一律 404）。
- **P4b 已切（2026-11-15）**：`notify-preflight`（仅 mytech）/ `notify-retention`（仅 mytech）/
  `metric-retire` / `org-sync` / `notify-seed-builtin` / `notify-health` 均已由内置调度器驱动，
  openship 对应作业已停。**未做的优化**：`notify-seed-builtin` 启动期化、`notify-health` 并入
  worker loop（当前以调度器子进程运行，行为一致；去子进程是优化不是必要）。

逐项状态见 §5 切流表。

## 2. 台账：三张表

### 2.1 `platform.job_schedule`（排班）

| 列 | 语义 | 运维要点 |
|---|---|---|
| `id` | 排班主键 | agent 排班允许同一 `key` 多条；system job 由部分唯一索引保持「一 key 一条」 |
| `key` | registry key（如 `notify.reconcile`） | 只有代码里注册过的 key 才会被执行；未注册 key 永远不跑 |
| `cron` | 5 段 cron | 只支持 `* , - /` 与数字；**不支持的语法在 seed 期拒绝**（P1 唯一登记路径；不会静默按错时间跑） |
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
| `updated_at` | 最后变更时间 | 健康宽限起点：取**最后一次运行的 `started_at`**；从未运行过才用 `updated_at` |

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
- **第二看护路径**（`scripts/check-probe-heartbeat.mjs`，openship 基建 job）：存在任一 `enabled` 排班时，
  `scheduler` 心跳**缺失 ⇒ NEVER、> 2 分钟 ⇒ STALE**（两者都判 job 失败，输出点名 `scheduler`）；
  **所有排班都是 `enabled=false`** ⇒ 输出 DISABLED，**不算故障**。
  ⚠️ `SCHEDULER_ENABLED=0` 只停 loop、**不改** `job_schedule.enabled` ⇒ 只设该开关时看护仍判 STALE
  （有意：调度器停了而排班还标着启用）。**回滚须同时把 DB 排班置 `enabled=false`**（或反向切流）。
  该 job 只读心跳与排班计数，不写任何表。

## 3. 执行契约（脚本侧）

| 渠道 | 内容 |
|---|---|
| env | `JOB_KEY` / `JOB_SCHEDULE_ID` / `JOB_OCCURRENCE` / `JOB_OWNER_ORG` / `JOB_OWNER_NAMESPACE`（为空则缺席） |
| **stdin** | `JOB_PARAMS`：**一行 JSON，≤16KB** |

- `JOB_PARAMS` **只走 stdin**，不进 env、不进 argv：argv 和环境对同机进程可见，且有长度上限；stdin 只有父子进程知道。
- `JOB_OCCURRENCE` 走 env（小标量），`params` 走 stdin（可能大）。两者不要互换。
- 子进程一律 **argv 数组 spawn，禁 shell 拼接**。
- 超过 16KB 的 `params` ⇒ **spawn 前抛错**（不会产生脚本 `exit 2`；该 run 记 `failed`）。

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
- **手动触发不要求 `enabled=true`**：启停只影响**自动排班**，不影响运维的显式手动触发（切流程序要在登记态先跑一次比对）。
- **优先用端点入队**：`POST /api/modules/jobs/:key/run`（**W6-P4a 起的唯一入口**；宿主旧路径
  `POST /api/platform/jobs/:key/run` 已退役删除，调用一律 404）。需权限码 **`jobs:manage`** +
  **CSRF 头**（`x-csrf-token`，值取当前会话的 `/session`）。端点在单事务里完成
  「锁排班行 → 判 `queued|running` → insert → 审计」。若必须 SQL 入队（如端点不可用），
  **先确认该排班无 `queued|running` 行**——SQL 旁路绕过了端点的原子判定，并发下会插出重复 `queued`。
- 授权：手动触发挂模块权限码 `jobs:manage`（jobs 模块，W6-P4a 引入；此前挂 `tenant:admin`，
  「多租户下任意租户管理员可触发全局 job」的旧边界随独立权限码消除；读排班/台账另需 `jobs:read`）。

## 5. 切流程序（一次一个 job）

前提：代码已发版（registry 已含该 key）、迁移已跑、seed 已执行。

1. **登记（enabled=false）**：确认 `platform.job_schedule` 有该 key，且 `enabled=false`、`next_run_at=null`、`params={}`。seed 只补新增 key，**不覆盖**人改过的 `cron` / `enabled`。
2. **手动跑一次并比对**：由持有 `jobs:manage` 的账号手动触发（模块端点 `POST /api/modules/jobs/:key/run`，**只入队**），等 worker 领取并记录 `job_run`。**本步在 `enabled=false` 的登记态即可执行**——手动触发不要求 `enabled=true`，启停只影响自动排班。比对产物与 openship 上最近一次结果：数量、口径、落表/落事件都要对得上；**比对不过不启用**。
3. **关 openship**：`patch_jobs_by_key` 把对应 job 置 `enabled=false`，确认 openship 侧不再产生新 run。**若该 job 没有对应的 openship 作业**（如 `metric-retire`、`report.scope_scan`），跳过本步。
   **3.5 观测面判据（🔴 2026-11-21 新增：#2628 的事故换来的）**：如果被切的 job **本身是观测/告警面**
   （探活断言、健康巡检、探针），关掉前必须**逐条点名**它产出的每个 check/流，并确认新驱动方
   **已经在发射同名行**（`grep` OO 流或库内心跳，至少跑过一轮完整周期）。
   ⚠️ **只验证「新 job 能跑」不算过**：Wave 8 迁移时数据面切流有判据（verify-* 切流实录），
   观测面没有——结果 `wire-warehouse` ①–⑱ 随旧 job 停发 **45h+ 无人知晓**，
   其中 ⑯⑰ 是「封版表停更 ⇒ 明细视图静默双算」的唯一防线。
   **判据**：老面最后一次发射时间 → 新面首次发射时间，中间**不允许有断档**（重叠优于断档）。
4. **DB 启用**：置 `enabled=true`，把 `next_run_at` 补算到**下一个未来时点**（不要落在过去，否则会立即补跑），并**同时刷新 `updated_at=now()`**——否则健康判据②的宽限窗口从 seed 时刻起算，可能在该 job 首跑之前就判红。观察首条 `job_run` 为 `ok`，且 openship 侧保持安静。

**按实例各做一次**：`notify.reconcile` / `org-sync` 在 openship 各有两条作业（mytech + 山海），两实例各有独立平台库与独立 `platform.job_schedule`。切流与回滚必须**按实例各执行一遍**；只关一个实例会留下双调度者。实例与 openship job key 的对应见下表及 `deploy/notify-reconcile-job.md` / `deploy/org-sync-job.md` 的生产实例表。

**切流表（已切 / 待切）**：

> P1 的三个 job **已切流**；「当前驱动」为实际状态。openship 原 key 保留在表中用于回滚（现已停用）。

| job | 阶段 | 当前驱动 | 实例 / openship key |
|---|---|---|---|
| `notify.reconcile` | 已切（W6-P1） | worker 的 `platform.scheduler` | 原 openship key（已停）：mytech `custom:KJ_JBrbq68jAHVlO`；山海 `custom:QSr7oZ5KBAVOqx5j`（见 `deploy/notify-reconcile-job.md`） |
| `metric.candidates` | 已切（W6-P1） | worker 的 `platform.scheduler` | 原 openship key（已停）：仅山海 `custom:tB6ulrsKtgW852WL` |
| `report.scope_scan` | 已切（W6-P1） | worker 的 `platform.scheduler` | 两实例各一条（openship 侧本无对应 job） |
| `notify-preflight` | **已切（W6-P4b）** | 内置调度器（仅 mytech；山海保持 disabled——该实例本无此作业） | openship job 已停 |
| `notify-retention` | **已切（W6-P4b）** | 内置调度器（仅 mytech） | openship job 已停 |
| `notify.seed_builtin` | **已切（W6-P4b）** | 内置调度器（两实例） | openship job 已停 |
| `notify.health` | **已切（W6-P4b）** | 内置调度器（两实例） | openship job 已停 |
| `metric.retire` | **已切（W6-P4b）** | 内置调度器（两实例，周一夜） | 本无 openship 作业 |
| `org.sync` | **已切（W6-P4b）** | 内置调度器（两实例，**必须带 `--apply`**——脚本默认 dry-run） | openship job 已停（mytech `qvkapKmBf4jI4H6T` / 山海 `dbuJg85a8UjjObB7`） |
| `data.warehouse_assertions` | **待切（#2628 / 2026-11-21 已登记，`enabled=false`）** | 待切：手动跑一轮 → 18 条 check 输出与旧面比对 → 按 3.5 确认 new face 发射 → enable | 无 openship 对应作业（旧形态是**宿主 cron + `docker exec`**，已随 Wave 8 停发——本 job 就是来补这个断档的） |
| `oa.standard_approval_reconcile` | **已登记（#2385 收口，`enabled=false`）** | 待启用：手动跑一轮 → stdout 统计与 `forms.external_approval` 行数比对 → enable（§13） | 本无 openship 作业（脚本此前零调度登记，2026-11-23 起有 registry key） |
| `oa.approval_reconcile` | **已登记（#2363/#2385 收口，`enabled=false`）** | 待启用：手动跑一轮 → stdout 统计核对 → enable（§13） | 本无 openship 作业（同上） |
| `recon.monthly`（**未进 registry · 技术债**） | **直接由 openship job 驱动**（custom:4UQ2ugvbFRGKtIUv） | 现役：每月 15 号 CST 12:00（cron `0 4 15 * *` UTC）对**上一自然月**逐日跑 `/opt/lemeng-recon-preagg.sh`（两账套 × 30 天 ≈ 60 次，实测 ~1.5 分钟）；全过 `RECON_MONTHLY_OK`，任一有差异 `RECON_MONTHLY_FAILED` + exit 1 → 企微 | **为什么不进 platform scheduler**：worker 容器要调两个 console 的 `/api/run`，需要把两套 `DUCKLE_TOKEN` 注入 worker env（新增密钥）；而 `/opt/lemeng-recon-preagg.sh` 本就在宿主且凭据在容器里。补洞优先，先这样落地（#2728）；等 worker 拿到 token 再迁 |

**顺序按爆炸半径**：已完成 `notify.reconcile` → `metric.candidates` → `report.scope_scan`；
P1+P4b 的切流**已全部完成**（2026-11-15）；新增 job 仍按上表四步执行。
未完成切流的 job 在走完全部四步之前都仍由原驱动方负责——不要提前置 `enabled=true`。

**切流期红线**：发现双调度者（DB `enabled=true` 且 openship job 仍启用）⇒ 立即停 DB 侧 `enabled`，再排查 openship，不要在两边同时「先看看」。

## 6. 回滚

**先看调度跑在哪（2026-11-19 角色拆分，#2504）**：调度 loop 已从应用单元的 `notify-worker`
搬进**数据单元的 `scheduler` 服务**（`deploy/data-compose.yml`），因为应用单元每次发版都重建
容器、把运行中的采集/物化子进程连坐收掉（3 天 40 次部署、13 次 dbt 作业被杀）。两个开关各自
独立，按「`'0'` 才关」解析：

| 谁 | `SCHEDULER_ENABLED` | `NOTIFY_DELIVERY_ENABLED` | `SCHEDULER_JOB_GROUPS` | 实例 id |
|---|---|---|---|---|
| 应用单元 `notify-worker` | `0`（默认） | `1` | `platform` | `scheduler-platform` |
| 数据单元 `scheduler` | `1` | `0`（默认） | `data` | `scheduler-data` |

**作业域（#2511）**：registry 每条作业声明 `scope: platform | data`（平台类需要 Casdoor 等凭据；
数据类要贴 pg_duckdb）。**claim 的 SQL 就按本域 key 收口**——不是靠两个进程「自觉」，而是
不属于我的作业就查不出来，所以**不存在双 claim**。三个连带语义：

- `job_run.runner_id` 记录执行实例；**启动对账只收同 id 的 running 行**（改造前是全表扫，
  数据单元启动那一刻会把应用单元正在跑的作业判 timeout）。
- `job_heartbeat` 每个单元一条（`scheduler-platform` / `scheduler-data`）；
  `/healthz` 只判**自己这组**的作业，不把对方的作业判成「该跑没跑」。
- 作业声明的 `requiresEnv` 缺键 ⇒ **不进 claim 集合**、启动打一行 `missing env`、`/healthz` 报红。
  这是 2026-11-19 `org.sync` 静默失败的直译（当时数据单元没有 `CASDOOR_*`）。
- 代码里删了 key 但排班还 enabled ⇒ **没有任何单元会领取它**，启动时打
  `{schedulerError:'orphan-schedules', keys:[…]}`；见到它就去停用/删除那条排班。

**滚动顺序（2026-11-19 实测踩到）**：schema 迁移的载体是**应用单元的 `server`**（它启动时跑
`runMigrations`），数据单元没有 server 服务 ⇒ **带 migration 的调度器改动必须先滚应用单元**
（或同时滚），否则数据单元的 scheduler 会以 `errorMissingColumn` 崩溃循环。当晚正确顺序：

1. 应用单元定向部署 `server` + `notify-worker`（迁移 + 新代码 + `GROUPS=platform`）；
2. 数据单元再部署 scheduler（`GROUPS=data`）。
   反过来（先数据后应用）会先撞缺列。

**切换后要清一次旧心跳行**：拆分前的心跳行 id 是 `scheduler`，拆分后没人再写它 ⇒ 元级看门狗
（`check-probe-heartbeat`，按 `scheduler%` 逐实例判）会把它当「一个实例死了」而误报。
部署完执行一次 `delete from platform.job_heartbeat where id='scheduler'` 即可
（mytech 那种仍用单实例 `scheduler` 的部署不要删）。

- **关调度（常态化保全）**：改**数据单元 scheduler 服务**的 `SCHEDULER_ENABLED=0`，等它重启。
  应用单元那侧本来就是 0，不用动。
- **回退到单进程形态**（数据单元不可用时的应急）：数据单元 scheduler 置 `SCHEDULER_ENABLED=0`
  **且**应用单元 notify-worker 置 `SCHEDULER_ENABLED=1`；顺序先关后开，别让两边同时 claim。
- 两个都 0 的容器**启动即退出**（空转不算健康），这是配错的信号，不是可用状态。

- **一键停调度 loop**：`SCHEDULER_ENABLED=0`。只停 `platform.scheduler`，**不影响通知投递 loop**；改 env 后需重启/重部署 worker 才生效。
  ⚠️ 它**不清** `job_schedule.enabled` ⇒ 只设该开关时第二看护仍判 STALE（有意）。
  **完整回滚 = 该开关 + DB 排班置 `enabled=false`**（或走下面的反向切流）。
- **env 注入面**：生产 env 由 openship **服务行 / 项目 env** 注入；compose 里的 `${...}` 只在本地
  compose 语义下生效。改完 `SCHEDULER_ENABLED`（及 `SCHEDULER_TICK_MS` 等）必须按**容器内实际 env**
  （服务行 / `printenv`）核对，不要拿 `deploy/docker-compose.yml` 文本当证据。
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

**异常零**：输入源空了，不是「没事做」。判据是**上游计数**而不是结果计数：

- `orgs=0`（画像表 / 指标表 / 报表表里没有 org）⇒ profiler / 同步链路没投递，按告警查；
- `reports=0` / `tenants=0` 且该实例明确不是空库 ⇒ 同上；
- `notify-reconcile` 的 `targets=0`：`targets` 是**所有含 `assignees` 的活跃已发布表单数**
  （`modules/forms/storage.ts` 的 `listAssignmentTargets`，与「到期」无关）⇒ 0 表示指派表单全部消失，
  是**上游异常信号**，不是「没事做」。
- 脚本明确标注「`orgs=0` 是告警信号」的，按告警处理，不要当通过。

**去重造成的零**：`notify-reconcile` 的 `emitted=0` 不一定是异常——`emitted` 统计 `form.assigned` 与
`form.due_reminder` 两类事件的接纳数（`scripts/notify-reconcile.mjs`），重复的计入 `duplicates`；
**`emitted=0` 且 `duplicates>0` ⇒ 正常去重**。

一句话：**看脚本声明的「0 是否成功」+ 看上游分母是否 > 0**；两者不一致就是异常零。

### 7.2 「无运行」分两种

- **启用后从未有 run**：异常。依次查 `enabled=true`、`next_run_at` 非空且在未来、worker 心跳新鲜、registry 含该 key。心跳新鲜但超过 `2×expected_interval_secs` 无 `ok` run ⇒ 健康判红「该跑没跑」。
- **有 schedule 但本来就不该跑**：`enabled=false` 是「登记未启用」，不是故障。seed 后的初始态就是三行 `enabled=false`、`next_run_at=null`。
- **`skipped`**：同 schedule 上一次还在跑，本轮跳过。偶发正常；连续出现说明上一轮卡死，按 §9 查。
- **`queued` 长期不消失**：worker 没在领取。查 worker 心跳与 `/healthz`，不要重复手动触发（端点会对 `queued|running` 返回 409 `JOB_ALREADY_PENDING`）。

## 8. 健康判据（`/healthz`）

以下任一成立 ⇒ `/healthz` 非 200：

1. **调度心跳陈旧**：`platform.job_heartbeat('scheduler').beat_at` 超过 2 分钟未更新，或从未写入。
2. **该跑没跑（cron-aware）**：**任一** `enabled` 排班（`system` 与 `agent` 皆然），
   「上次活动之后**第一个该跑的时点**」（`nextRunAt(cron, timezone, ref)`）已过 `2 × expected_interval_secs` 仍没有 `ok` run。
   宽限起点 `ref` = **最后一次成功运行的 `started_at`**；从未成功过才依次退到「最后一次运行（任何状态）的 `started_at`」、
   再没有运行则 `updated_at`（给新启用一个宽限窗，**启用时必须刷新 `updated_at`**）。
   ⚠️ **不要改成按墙钟 `2×interval` 判**：cron 有窗口（如 `data.dbt_tick` 是 UTC 1-15 点，避开北京时间
   00:01–09:00 的空热 glob 窗口），墙钟判法会把窗口外误判成漏跑 ⇒ worker 夜间恒 503 ⇒ openship 部署收尾被阻塞（#2417）。
3. **连续失败**：任一 **`enabled`** 排班，**最近 3 次运行（不论状态）**全是 `failed` / `timeout`。
   `running` / `queued` 行会稀释连败——这是有意的（有在跑说明调度器活着），不要改成只看终态。
   ⚠️ **`data.dbt_audit*` 除外**：审计 exit 1 = 对账发现数据问题，不是调度故障；计入会让既有
   数据红在 3 天后把 worker 判 503、阻断部署（2026-11-17 实测）。红走 `jobs.job.failed` 通知与 run 台账。

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
| 手动触发返回 503 `JOB_LOCK_TIMEOUT` | 排班行是否被长事务/并发触发持锁 | 端点锁等待上限 2s；稍后重试，持续出现则查持锁长事务（`pg_stat_activity`） |
| `/healthz` 红但 job 其实跑过 | 是否只有 `failed`/`timeout` | 看 `job_run.error` / `output_tail`；连续失败 3 次会判红 |

## 10. 上线/切流检查单

- [ ] 迁移已跑，三张表存在。
- [ ] registry 已含目标 key；`platform.job_schedule` 中该 key `enabled=false`、`next_run_at=null`、`params={}`。
- [ ] worker 已部署，`/healthz` 绿，`platform.job_heartbeat('scheduler')` 在 2 分钟内。
- [ ] 每个待切 job 已手动跑一次，产物与 openship 最近一次比对通过。
- [ ] 对应 openship job 已关（无对应作业的 job 跳过），且确认不再产生新 run。
- [ ] DB 置 `enabled=true` + `next_run_at` 为下一个未来时点。
- [ ] 首条 `job_run` 为 `ok`；openship 侧保持安静。
- [ ] 回滚路径已知：`SCHEDULER_ENABLED=0` + 反向切流（§6）。

## 11. agent 排班（P3，2026-11-14 拍板）

agent 经 notify 工具面管理**周期消息排班**（触发 `notify.emit`）。工具只调
`ctx.scheduler(actor)` → `SchedulerPort`，**不直连 `platform.job_*`**；归属
（`owner_org` / `owner_namespace` / `created_by`）只来自请求身份，参数里的同名键是保留字、
会被端口剥掉。v1 一个 org 一个 namespace（`namespace` 缺省 = `org`），下文的「每 namespace」
即「每租户」。配额在**端口层唯一收口**，工具层只做参数成形、不自己计数。

### 11.1 配额（50 / 5 分钟 / 200）

| 配额 | 值 | 闸门时机 | 超限错误 |
|---|---|---|---|
| 排班条数 | 每 namespace 最多 **50** 条（`source='agent'` 且未软删） | `create_schedule` | `QUOTA_EXCEEDED` `{kind:'schedules', limit:50}` |
| 最小 cron 间隔 | **5 分钟**（300s；按**完整周期内**的最小相邻间隔，不是只看创建时刻的下两格） | `create_schedule` | `QUOTA_EXCEEDED` `{kind:'min_interval', limit:300}` |
| 每日 firing | 每 namespace 最多 **200** 条（**滚动 24 小时**，跨该 namespace 的全部排班） | `create_schedule` | `QUOTA_EXCEEDED` `{kind:'daily_firings', limit:200}` |

- 超限统一为 `code='QUOTA_EXCEEDED'` + 结构化的 `{kind, limit}`，`kind ∈ schedules|min_interval|daily_firings`；**不要按文本匹配**。
- **每日 firing 是「建排班时」的闸门，不是运行期 kill switch**：已建好的排班不会被逐条拦截——它防的是「新排班把当日额度继续抬高」。
- 运维自查：`get_schedule_quota` 返回 `{schedules:{used,limit}, dailyFirings:{used,limit}, minIntervalSecs}`，与创建闸门共用同一组 SQL（口径不会漂移）。**排班建不出来先看它**，不要先猜 cron。

### 11.2 外发通道：不对 agent 开放

- agent 建的排班**只发站内通知**；通道参数（channel / webhook / wecom…）在工具层被丢弃，
  `params` 只白名单成形 `{eventKey, scope?, payload?}`。
- 企微 / webhook 等外发渠道**由人在控制台改 notify 规则**（工具面不提供发布/通道工具）。
- **没有审批状态机**：不做「agent 提交 → 人审批 → 放开外发」；要放开外发就人去改规则。

### 11.3 工具面（8 个）

| 工具 | 语义 |
|---|---|
| `create_schedule` | 建排班；`params.eventKey` v1 只支持 `notify.emit`（key 白名单） |
| `list_schedules` | 列出本 namespace 由 agent 建的排班（`source='agent'`，不含已软删） |
| `pause_schedule` / `resume_schedule` | 启停；`enabled=false` 只停**自动排班**，手动触发不受影响 |
| `delete_schedule` | **软删**：置 `deleted_at` / `enabled=false`、清触发槽；**运行台账保留**（审计面不回删） |
| `list_schedule_runs` | 运行台账（最近 N 条，默认 50、上限 100） |
| `run_schedule_now` | **只入队**：插一行 `trigger='manual'` / `status='queued'`，执行在 worker；不改 cron、不占 cron bucket |
| `get_schedule_quota` | 只读配额使用（§11.1） |

### 11.4 `expected_interval_secs` 与健康判据

- 创建时可省略。省略 ⇒ 端口从 cron 推导**一个完整扫描周期内的最大相邻间隔**（最小 60s），
  作为健康判据的分母；显式传入仍优先，必须 > 0。
- 为什么取最大：§8 的「该跑没跑」= `2 × expected_interval_secs`。工作日 cron（`0 0 * * 1-5`）
  的相邻两格是 86400，但周五→周一是 259200——只看向邻两格会在每周日假红。取周期内最大值 ⇒
  **不假红**；代价是稀疏 cron 发现得晚（宁可晚报，不可假报）。
- 改这个值等于改健康判红的窗口，别随手调。

### 11.5 错误码（与配额区分）

| code | 含义 | 处置 |
|---|---|---|
| `QUOTA_EXCEEDED` | 撞 §11.1 任一配额（带 `kind`/`limit`） | 看 `get_schedule_quota`；删/停旧排班或放慢 cron |
| `JOB_LOCK_TIMEOUT` | 配额锁 / 排班行锁 2s 内有界等待失败（并发创建或触发） | **可重试**（工具返回 `retryable:true`）；持续出现查持锁长事务 |
| `JOB_ALREADY_PENDING` | 该排班已有 `queued|running` 行 | 等当前运行结束，不要重复触发 |
| `NOT_FOUND` | 不存在 / 不属于本 namespace / 已软删（三者不可区分） | 用 `list_schedules` 核对 id |
| `SCHEDULER_UNAVAILABLE` | 宿主未注入 `ctx.scheduler`（旧宿主/单测环境） | 部署问题，不是排班问题 |
| `INVALID_PARAMS` / `INVALID_CRON` / `INVALID_SCHEDULE` / `INVALID_INTERVAL` / `PARAMS_TOO_LARGE` / `UNKNOWN_JOB_KEY` | 入参不合法（缺必填、cron 语法或时区、间隔、`params` >16KB、key 不在白名单） | 按错误码修入参 |

> `QUOTA_EXCEEDED` 与 `JOB_LOCK_TIMEOUT` **不是一回事**：前者要人清额度，后者重试即可。

## 12. 业务监控 tick（W7-V1，2026-11-15）

`data.monitor_tick` 是调度器 registry 的一个系统 key（`* * * * *`，每实例一条排班），
脚本 `scripts/data-monitor-tick.mjs` 遍历到期规则求值（`missing` / `stale`），写
`data.monitor_run`，**只在状态跃迁且非影子期**时入队 `data.monitor.*` 事件。

- **影子期是硬门**：`data.monitor.dry_run` 默认 `true`，只记录不发送；开闸走
  `PATCH /api/modules/data/monitors/:id {dryRun:false}`（创建者或 `data:manage`）。
- **判不了 ≠ 没问题**：水位表缺席、查询失败、目标不存在 ⇒ `monitor_run.verdict='unknown'`，
  状态不变、`consecutive_fail+1`；连续 5 次自动停用并发 `data.monitor.disabled`。
- **开闸四步（每实例）**：
  1. 部署后确认 `platform.job_schedule` 有 `data.monitor_tick` 且 `enabled=false`；
  2. `update platform.job_schedule set enabled=true, next_run_at=now() where key='data.monitor_tick'`；
  3. 手动入队一次，看日志汇总行 `monitor-tick: due=<n> ok=<n> firing=<n> unknown=<n> ...`；
  4. 建一条真实影子监控（一个已知新鲜指标 + 一个已知迟到源），确认 `data.monitor_run` 有行、
     `notified=false`、`notify.event` 无新增。
- **心跳**：脚本写 `platform.job_heartbeat('data.monitor_tick')`；`check-probe-heartbeat`
  的检查清单要同时盯它（第二条独立路径，spec §10）。
- **回滚**：`update platform.job_schedule set enabled=false where key='data.monitor_tick'`。
  已建的监控规则留在库里（不删数据），重新开闸即可继续。
- **判据下界**：`cadence_secs ≥ 300`；`stale` 的窗口必须晚于上游物化节奏一档，否则每轮误报。

## 13. OA 审批对账（#2363 P1 / #2385 P2 收口，2026-11-23 登记）

两条 job 把仓内既有脚本接进平台调度器——此前**零调度登记**，配置齐全也不会跑。执行形态与
`notify.reconcile` 同款：registry 调脚本，stdout 统计 JSON 收进 `platform.job_run.output_tail`
（即「输出统计写入 job 日志」）；失败告警走执行器既有的 `jobs.job.failed` / `jobs.job.timeout` /
`jobs.job.dead` 事件通路，**不新增告警面**。

| | `oa.standard_approval_reconcile` | `oa.approval_reconcile` |
|---|---|---|
| 脚本 | `scripts/oa-standard-approval-reconcile.mjs` | `scripts/oa-approval-reconcile.mjs` |
| 干什么 | 企微标准审批镜像对账：逐租户拉列表/详情 → upsert `forms.external_approval`（**回调的兜底**，同幂等键谁先写谁生效） | 应用内审批终态对账：`pending_approval` 超 10 分钟逐单查 OA 引擎补终态（与回调**同一 SQL**，天然幂等） |
| cron | `17 * * * *`（每小时 :17） | `47 * * * *`（每小时 :47） |
| timezone | `UTC`（registry 不变量；小时级 cron 在 UTC 与 Asia/Shanghai 触发时刻逐点相同） | 同左 |
| timeout / 重试 | 300s / 2 次 | 300s / 2 次 |
| scope / 域 | `platform`（应用单元） | `platform` |
| requiresEnv | `DATABASE_URL`（缺键不进 claim 集合，启动期打 `missing env`，§6） | 同左 |
| 退出码 | 0=跑完（含 config_missing 跳过）；1=有租户 token 失败（其余租户照跑）；2=缺 env/连库（**不重试**） | 0=跑完；1=致命错误（连不上库等） |

**产出判据（stdout JSON，零候选判读按 §7.1）**：

- `oa.standard_approval_reconcile`：`{bindings, tenants, synced, skipped, errors, detailFilled, discovery, configMissingOrgs, listUnavailableOrgs}`。
  - 正常态 `errors=0`；`discovery='callback_only'` = 列表端点不可用、已降级只补详情——**发现新单只靠回调**，不是静默成功。
  - `bindings=0`：该实例没有任何已发布 `wecom_native` 绑定 ⇒ 正常零。有绑定却 `tenants=0` ⇒ 绑定租户的企微五件凭据全缺（`configMissingOrgs` 点名），按异常零查 `platform.tenant` 五列。
  - 业务级事件行（`evt=config_missing` / `evt=list_unavailable` / `evt=detail_failed` / `evt=unknown_status` / `evt=token_failed`）打在 stderr，进 `output_tail`，可直接检索。
- `oa.approval_reconcile`：`{scanned, skippedNoCase, skippedNoEngine, stillPending, engineErrors, writeCandidates, written, byAction, missingEngineOrgs}`。
  - `scanned=0`（没有待补终态的单）⇒ 正常零。`skippedNoEngine>0` ⇒ 有 org 的单在等审批但没配引擎（`missingEngineOrgs` 点名）⇒ 去 `platform.oa_engine` 补行，这不是调度故障。
  - `engineErrors>0` 且连续多轮 ⇒ 引擎侧不可达，按 `jobs.job.failed` 之外的运维事件查引擎可用性（本 job 不对它发红）。

**告警口径**：调度失败（exit≠0 / 超时）⇒ 执行器自动发 `jobs.job.failed`（每次失败）/ `jobs.job.dead`（重试额度耗尽），走既有 notify 通路；连续失败 3 次另触发 `/healthz` 判红（§8）。`oa.standard_approval_reconcile` 的 exit 1（有租户 token 失败）同样按 failed 告警处理——不能把整租户镜像静默停在旧状态。业务级「发现不一致」不打 failed，按上面的事件行检索。

**启用程序**：按 §5 四步，step 3 跳过（无 openship 对应作业）。seed 恒插 `enabled=false`；
先手动触发一轮（`POST /api/modules/jobs/:key/run`，`enabled=false` 登记态即可）核对 stdout 统计，再置
`enabled=true` + `next_run_at` 补算到未来时点 + 刷新 `updated_at`。
