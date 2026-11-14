# 业务定时归属：从 openship job 迁到平台内置调度器——设计（v2）

> 状态：2026-11-14 与用户逐条确认（方案 A′）；v2 并入通知板块的 handoff（接缝与分工）。
> 关联：`docs/architecture.md` §2.4「定时载体」小节、开发地图 `2026-11-11-helix-borrow-roadmap.md` Wave 6，
> 下游能力 `2026-11-14-business-monitor-design.md`（Wave 7）。
> 起因：用户定调「业务层面的压力不放到 openship 上」。这是**架构变更**，顺序是
> 「人同意 → 改本文与正典 → 再写码」。

## 1. 背景：三个已经成立的失败形态

1. **openship 上压着业务。** 与本项目相关的 job 共 55 个，其中 **30 个是周期排班**；
   真正属于基建的只有 `host-metrics`、`OO 桥 / 看门狗`、`integration-probe 心跳`。
2. **正典现在写的是反的。** `docs/architecture.md:497-503`：「定时载体 = openship job（2026-10-19 拍板）……
   零常驻」；`deploy/notify-jobs.md:7`、`deploy/org-sync-job.md:4-5`、`deploy/metric-retire-job.md:7-8`
   等处重复「应用进程不跑定时副作用」。
3. **openship 当业务调度器的失败模式已真实发生**：部署互斥被 worker 挂死 40+ 分钟（`openship-platform` PR #34）；
   长 job 被 SSH 取消连坐杀死（表象 `SKIP:holds-lock`）；job 通知不进 deliveries feed。

本仓没有通用调度器：常驻进程只有 `notify-worker`（2s 轮询 outbox，`SKIP LOCKED` + 60s 租约，
`worker_heartbeat` + `/healthz`），业务定时全靠外部 cron。

## 2. 目标 / 非目标

**目标**：业务定时的调度定义、运行台账、失败可见性全部在平台自己的库里；openship 退回
「部署 / 回滚 / 备份 / 主机基建」。

**非目标**：不做通用工作流引擎（DAG / 依赖编排 / 回填队列 / 分布式执行）；不动数据面；
不替代 duckle console 的管线排班；不做通知投递（那是通知板块）。

## 3. 不变量

1. **调度器只排「引擎」，不排「规则」。** 引擎是被评审的代码（registry key），规则是数据
   （`platform.job_schedule` 的 agent 行 / `data.monitor` 行）。agent 永远不能注册 handler。
2. **只做 cron + 台账。** 要 DAG / 依赖 / 回填 ⇒ 上 duckle 或 Airflow，不在本仓长出来。
3. **单调度者。** 任一 job 任一时刻只有一个调度者（openship 或本调度器），切流先关旧的。
4. **业务定时归业务，基建定时留 openship。** 判据：失败意味着「业务数据/业务动作没发生」⇒ 业务；
   意味着「机器/进程/证书异常」⇒ 基建。
5. **执行隔离。** 周期任务一律子进程执行 + 超时 kill；不在 HTTP 进程里。
6. **系统 job 的 `params` 不生效。** `source='system'` 时行为只由代码 registry 决定，
   改库改不了行为（否则绕过代码评审就能改副作用）。
7. **静默失败不可接受。** 每个 job 声明期望间隔；「该跑没跑」必须能把健康判成红。

## 4. 选型：为什么不是行业里那几个大件

| 方案 | 本场景结论 |
|---|---|
| Airflow / Dagster / Prefect / Temporal | 7 个互相独立的 product job 用它=用航母送快递，且新引入一个运维面（正是要消除的） |
| K8s CronJob | compose 单机部署，无 k8s |
| 云调度（EventBridge / Cloud Scheduler） | 要公网入站端点 + 云侧权限；**运行台账不在平台库** |
| `pg_cron` | job 是 Node 脚本；只能当闹钟，仍缺执行器与台账 |
| **应用内 worker + 库内排班表** | **本方案**。行业原型：Oban（Elixir）、GoodJob（Rails）、Quartz JDBC JobStore、celery-beat |

## 5. 去留表（决定值不值得造机器）

| job（实例级条数） | 现在 | 判定 | 理由 |
|---|---|---|---|
| `notify-seed-builtin`（2，每小时） | openship cron | **启动期化** | 幂等 seed 属启动路径 |
| `notify-health`（2，5 分钟） | openship cron | **并入 worker 循环** | 与 `drainStaleAlerts` 同域同进程；**先核实重叠度再并** |
| `notify-reconcile`（2，每小时） | openship cron | **需 cron** | 对账依赖时间窗 |
| `notify-preflight`（1，每日） | openship cron | **需 cron** | 全量规则体检，只读 |
| `notify-retention`（1，每日） | openship cron | **需 cron** | 删行；保留期口径不变 |
| `metric-candidates`（1，每日） | openship cron | **需 cron** | 候选池生成 |
| `report-scope-scan`（未建） | — | **需 cron** | 只读巡检 |
| `metric-retire`（未建） | — | **需 cron** | 周频提案 |
| `org-sync`（2，6 小时） | openship cron | **需 cron** | 外部系统同步 |
| `verify-regression` / `verify-ingest`（2） | openship cron | **第二步：导出到观测面** | 本质是 QA / 新鲜度判据，不是作业 |
| `dbt-materialize` / `L1 词表物化` / duckle 系列 / `scorecard`（6+） | openship cron | **第二步：归 duckle 排班或观测面** | 数据编排归数据编排器 |
| `host-metrics` / `OO 桥·看门狗` / `integration-probe 心跳`（4+） | openship cron | **留 openship** | 基建定时 |

**净结果：11 类 → 7 类**；`seed` / `health` 两条从系统里消失而不是搬家。

## 6. 架构

```
deploy/docker-compose.yml
├── server        HTTP（不跑定时副作用）
├── notify-worker 常驻 = worker（多 loop 注册表）
│     loop notify.dispatch      ← 现有：outbox 轮询 2s
│     loop platform.scheduler   ← 新增：30s 一跳
│            │ claim（CAS：UPDATE … FOR UPDATE SKIP LOCKED RETURNING）
│            ├─ spawn: pnpm exec tsx scripts/<job>.mjs（子进程，超时 kill）
│            └─ record: platform.job_run
└── postgres      platform.job_schedule / job_run / job_heartbeat
```

- **P1 不改 compose 服务名**（仍叫 `notify-worker`）：避免 openship 服务身份变更带来的额外风险；
  代码与文档里称其为「worker（通知投递 + 业务调度两 loop）」。
- 任务目录在代码（`apps/server/src/scheduler/registry.ts`），排班状态在库；启动幂等 seed，
  **不覆盖人改过的 cron**（只补新增 key、只补缺失行）。

**配置（env，缺省即可用）**

| env | 缺省 | 语义 |
|---|---|---|
| `SCHEDULER_ENABLED` | `1` | `0` = 只停调度 loop（投递照跑），切流回滚用 |
| `SCHEDULER_TICK_MS` | `30000` | 一拍间隔 |
| `SCHEDULER_MAX_CONCURRENCY` | `2` | 同时执行上限 |
| `SCHEDULER_HEALTH_PORT` | 同 `WORKER_HEALTH_PORT` | 复用现有 worker 健康端口 |

## 7. 数据模型（迁移 `apps/server/src/migrations/018_platform_jobs.sql`）

> **v2 变更**：主键由 `key` 改为 `id`——agent 排班需要「同一 key 多条排班」，系统 job 用部分唯一索引
> 保持「一 key 一条」。现在改成本最低（尚无数据）。

```sql
create table if not exists platform.job_schedule (
  id                     bigserial primary key,
  key                    text not null,                -- registry key，如 notify.emit
  cron                   text not null,
  timezone               text not null default 'Asia/Shanghai',
  params                 jsonb not null default '{}'::jsonb,  -- 仅 source='agent' 生效
  owner_org              text,                         -- 系统 job 为 null
  owner_namespace        text,                         -- agent job 必填
  source                 text not null default 'system'
                         check (source in ('system','agent')),
  created_by             text,
  enabled                boolean not null default false,
  next_run_at            timestamptz,
  timeout_ms             integer not null default 300000,
  max_attempts           integer not null default 1,
  expected_interval_secs integer not null,
  retry_at               timestamptz,                  -- 重试游标：重试不改 next_run_at
  retry_occurrence       timestamptz,                  -- 重试槽绑定的原格 occurrence（排班侧，不从 job_run 反查）
  retry_attempt          integer not null default 0,   -- 已排重试的尝试序号
  updated_at             timestamptz not null default now()
);
create unique index if not exists uq_job_schedule_system_key
  on platform.job_schedule(key) where source = 'system';
create index if not exists idx_job_schedule_owner
  on platform.job_schedule(owner_org, owner_namespace);
create index if not exists idx_job_schedule_due
  on platform.job_schedule(next_run_at) where enabled;

create table if not exists platform.job_run (
  id              bigserial primary key,
  schedule_id     bigint not null references platform.job_schedule(id),
  key             text not null,
  occurrence      timestamptz not null,               -- 本次 claim 的 bucket（不是实际开跑时刻）
  owner_org       text,
  owner_namespace text,
  params_snapshot jsonb,
  trigger         text not null check (trigger in ('schedule','manual')),
  status          text not null check (status in ('queued','running','ok','failed','timeout','skipped')),
  attempt         integer not null default 1,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  exit_code       integer,
  duration_ms     integer,
  output_tail     text,                               -- 尾部 4KB
  error           text
);
create index if not exists job_run_schedule_started_idx
  on platform.job_run (schedule_id, started_at desc);

create table if not exists platform.job_heartbeat (
  id      text primary key,
  beat_at timestamptz not null
);
```

- `enabled` 默认 **false**：登记不跑，必须显式开启。
- 系统 job 的 `params` 恒为 `{}`（seed 强制写），**读侧按 `source` 分支**：system 只认 registry。
- `params` 形状与上限由各 handler 自己校验（超过 16KB ⇒ `exit 2`）。

## 8. 执行契约

**互斥**：claim 语句在 SQL 里排除「同 `schedule_id` 已有 `running` 行」的排班 —— 该格**不消费**
（不前推 `next_run_at`）、下一拍再来；`claim` 与建 `running` 行在同一事务内（库为准，多副本同样成立）。
长期堵住（job 永远起不来）由健康判据兜住：2× 期望间隔无成功即告警。
**僵尸回收**：`running` 且 `started_at < now() - 2 × timeout_ms` ⇒ 下一跳改判 `timeout`
（`error='stale running reaped'`）；卡住的 `queued` 行按排队超时改判 `timeout`
（`error='stale queued reaped'`），否则调度器崩一次就把该 key（或路由的 busy 判定）永久堵死。

**注入**（argv 数组 spawn，禁 shell 拼接）：

| 渠道 | 内容 |
|---|---|
| env | `JOB_KEY` / `JOB_SCHEDULE_ID` / `JOB_OCCURRENCE` / `JOB_OWNER_ORG` / `JOB_OWNER_NAMESPACE` |
| **stdin** | `JOB_PARAMS`：一行 JSON，≤16KB（不走 env：`/proc/<pid>/environ` 对同机进程可见，且有长度上限） |

**`JOB_OCCURRENCE` 语义（钉死）**：= **claim 时拿到的那一格 bucket** 的 UTC ISO 时刻，**不是**实际开跑时刻。
misfire 迟到 3 小时也用它；重试沿用同一 occurrence ⇒ 下游幂等键稳定。

**执行**：`timeout_ms` 到点 `SIGTERM`，5s 后 `SIGKILL`，记 `timeout`。
**重试**：`exit 2`（缺 env / 判不了）**不重试**；其余非 0 在 `max_attempts` 内隔 60s 重排（新 run 行，`attempt+1`）。
**misfire**：`now - next_run_at > 3 × expected_interval_secs` ⇒ **只补跑一次**并快进到下一个未来时点，**不回填**。
**时区**：`cron` 按 `timezone` 解释（默认 `Asia/Shanghai`，无 DST）；run 时间戳一律 UTC。
**cron 解析**：**零依赖自写纯函数**（仓内既有风格），只支持 `* , - /` 与 0–7 周几；
**不支持的语法在 seed 期直接报错拒绝**（fail-closed，绝不静默按错时间跑）。

## 9. 故障可见性（P1 必含）

1. **台账**：每次执行一行 `job_run`。
2. **心跳 + healthz**：loop 每跳 upsert `platform.job_heartbeat('scheduler')`；`/healthz` 判三件事——
   心跳陈旧 > 2 分钟 / **任一 enabled schedule 超过 `2 × expected_interval_secs` 无 `ok` run**
   （起点 = 最后一次成功运行；从未成功过才依次退到「最后一次运行（任何状态）的 `started_at`」、
   再没有运行则 `updated_at`——故**启用时必须刷新 `updated_at`**，否则宽限从 seed 时刻起算） /
   **连续失败**：最近 3 次运行（**不论状态**）全为 `failed` / `timeout`
   （`running` / `queued` 行会稀释连败，这是有意的——有在跑说明调度器活着），
   任一成立 ⇒ 非 200。
3. **第二看护路径**：`scripts/check-probe-heartbeat.mjs`（已是 openship 基建 job）**同时检查 scheduler 心跳**——
   判据：`platform.job_schedule` 存在任一 `enabled` 排班时，`platform.job_heartbeat('scheduler')`
   缺失或超过 **2 分钟** ⇒ STALE（exit 1，输出点名 `scheduler`）；**没有任何 `enabled` 排班**
   （含 `SCHEDULER_ENABLED=0` 回滚态）⇒ DISABLED（**不算故障**，exit 0）。
   判定为纯函数 `judgeScheduler(beatAt, enabledCount, now)`，用例在 `scripts/check-probe-heartbeat.test.ts`。
   不把「引擎还活着」这一判断单独押在 OO 上（OO 有流静默导致状态机冻结的实测形态）。
4. **手动触发**：`POST /api/platform/jobs/:key/run`（会话 + `tenant:admin`；本仓无独立「平台管理员」码，单实例单租户下等价），写 `trigger='manual'` 的 run 行，落 `platform.audit`。**已知边界**：多租户实例下这等于任意租户管理员可触发全局 job——届时须引入平台级码或按 `owner_org` 限定。

## 10. 与通知板块的接缝（handoff 答复）

| 层 | 负责 | 不负责 |
|---|---|---|
| 调度器 | cron 解析、排班表、下一次运行、运行台账、子进程、超时/重试/misfire、心跳与 healthz、并发、job 注册表 | 事件目录、模板、规则、收件人、通道、投递回执 |
| 通知 | 事件声明/目录、模板、规则、收件人解析、outbox、provider 投递、收件箱、投递重试 | cron、排班表、运行台账、worker 生命周期 |

共同不变量：**单调度者**（通知不再有独立 scheduler）；**一次运行只入队一次**（job 成功即事件已入队，
投递失败由通知侧重试，不回落 job）；**agent 只能排已注册 key**（v1 仅 `notify.emit`）；
**参数不拼 shell**；**归属只来自身份**（`owner_org` / `owner_namespace` 由宿主按身份填，不读请求体）。

### 10.1 对 handoff 五个确认点的答复

1. **`job_schedule` 改 id 主键 + params/owner/source：接受，P1 就按 id 建表**（见 §7）。
   补充一条：`source='system'` 时 `params` 不生效（§3.6）。
2. **提供 `SchedulerPort`，宿主注入 to 通知模块**：接受。通知模块**不读 `platform.job_*` 表、不自起 HTTP 循环**。
   P1 只暴露系统 job 的只读面；agent 面 W6-P3 才开。
3. **job 生命周期事件（`jobs.job.failed|timeout|dead`）**：要，但**归属先裁决**——
   现有 module protocol 要求**行为方**在 manifest `notifications.events` 声明，而调度器是**宿主面、不是模块**。
   两条路：(a) 最小 `jobs` 模块只做事件声明 + 注入 emit 回调（复用装载期双向核对与模板 seed）；
   (b) 宿主层新增事件声明面（新概念）。**倾向 (a)**，前置动作：验证「零路由模块」能通过装载期双向核对。
   在裁决前，调度器至少要保证失败在 `/healthz` 与台账里可见；**通知侧不假装能收到**。
4. **`JOB_PARAMS` 走 stdin**（不是 env），≤16KB，超限 `exit 2`（见 §8）。
5. **schema 与核心里程碑**：表结构 **W6-P1 一次到位**；agent 面能力 **W6-P3**。
   理由：改主键在有数据后是昂贵手术；开能力是行为变更，爆炸半径不同。

### 10.2 端到端

```
agent / console / MCP → SchedulerPort.createSchedule(key='notify.emit', cron, params, owner…)
  → platform.job_schedule(id, key, params, owner…)
  → scheduler loop：claim / 前推 next_run_at
  → spawn(scripts/notify-emit-job.mjs, JOB_PARAMS via stdin)
  → 校验 namespace / 策略 / payload → enqueueEvent(eventId=schedule:<id>:<occurrence>)
  → notify.event → worker dispatch → provider → delivery / receipt / inbox
```

一次性延迟**不经过调度器**：`emit(availableAt)` ⇒ `notify.event.available_at` ⇒ 投递循环 claim 到点的事件。

## 11. 迁移与回滚

**切流铁律**：同一 job 任一时刻只有一个调度者。

```
登记 key（enabled=false） → 手动触发一次，比对产物与 openship 最近一次结果
  → 关掉 openship 那个 job → DB 置 enabled=true（next_run_at 补算到下一个未来时点）
```

回滚：反向操作；`SCHEDULER_ENABLED=0` 可一次性停掉调度 loop（投递 loop 不受影响）。
顺序按爆炸半径：`notify-reconcile` → `metric-candidates` → `report-scope-scan`
→ `notify-preflight` → `notify-retention` → `metric-retire` → `org-sync`。

## 12. 正典要改的条文

| 位置 | 现在 | 改成 |
|---|---|---|
| `docs/architecture.md:497-503` | 定时载体 = openship job / 零常驻 | 拆两条线：基建定时留 openship job；业务定时归 worker 的 `platform.scheduler` loop（目录在代码、排班与台账在库） |
| `deploy/notify-jobs.md:7`、`deploy/org-sync-job.md:4-5`、`deploy/metric-candidates-job.md:5-6`、`deploy/metric-retire-job.md:7-8`、`deploy/report-scope-scan-job.md:7-8` | 「不要塞进 server 进程（应用进程不跑定时副作用）」 | 理由保留（反对把副作用藏进 **HTTP 进程**），结论改为「归 worker 的调度 loop」 |
| `docs/architecture.md` §2.4「定时载体」小节 | — | 新增不变量：只做 cron + 台账；调度器排引擎不排规则；system job 的 params 不生效 |

## 13. 测试策略

- 纯函数：`nextRunAt(cron, tz, from)` 真值表（跨月/跨年、`*/n`、`a-b`、`a,b`、周几 0 与 7、非法语法抛错）。
- 纯函数：misfire 判定（错过 1 个周期不跳、错过 4 个周期只跑一次）；occurrence = bucket 不是实际时刻。
- 真库：并发两连接抢同一到期 schedule ⇒ 只有一方拿到（`SKIP LOCKED` 实证）。
- 真库：`exit 2` 不重试；非 0 按 `max_attempts` 重排；超时留 `timeout` 行；僵尸 running 被回收。
- 真库：seed 幂等——重复 seed 不覆盖人改过的 `cron`/`enabled`；system job 的 `params` 恒 `{}`。
- 路由：手动触发无会话 ⇒ 401/403；有会话 ⇒ 建 run 行；审计落 `platform.audit`。
- healthz：心跳陈旧 / 超期未成功 / 连续失败三种形态各自非 200。

## 14. 分期

| 期 | 交付 | 验收 |
|---|---|---|
| **W6-P1** | 迁移 018 + registry + 调度 loop（并入 worker）+ 子进程执行器 + 台账 + healthz 三判据 + 手动触发；迁入 `notify-reconcile` / `metric-candidates` / `report-scope-scan` | 3 个 job 连跑 48h 无漏跑；openship 对应 job 已关；`exit 2` 不重试经实测 |
| **W6-P2** | 通知接缝：`SchedulerPort` + `scripts/notify-emit-job.mjs` + `notify.event.available_at`（一次性延迟，不走 cron） | agent 建一条 `notify.emit` 排班，按 cron 到达且重复 occurrence 不双发 |
| **W6-P3** | agent 自助面（`create_schedule` / `pause` / `resume` / `delete` / `list_runs` / `run_now`）+ 配额 + 外发审批 + 租户级 kill switch | 超配额被拒；外发未审批不可生效；kill switch 一键全停 |
| **W6-P4** | 迁入 `notify-preflight` / `notify-retention` / `metric-retire` / `org-sync`；`notify-seed-builtin` 启动期化；`notify-health` 并入 loop；失败接 notify | 应用面 7 类全部脱离 openship；`seed`/`health` 两个 job 从系统里删除 |
| **Wave 7** | 业务监控（另见 `2026-11-14-business-monitor-design.md`） | — |
| **Wave 8（触发式）** | 数据面「消」：管道归 duckle 排班；`scorecard`/`verify-*` 导出为观测面判据 | 另出计划 |

## 15. 风险与已知边界

1. **自建调度器的长期成本**：靠不变量 §3.1/§3.2 压制；任何「顺手加个依赖编排」的提案一律驳回。
2. **调度器是业务新鲜度的单点**：§9 的心跳与「该跑没跑」判据必须与调度器同时上线。
3. **切流期双调度者**：靠 §11 顺序约束；发现重叠 ⇒ 立即停 DB 侧 `enabled`。
4. **`notify-health` 与 `drainStaleAlerts` 的重叠度未核实**：W6-P4 前先读两者判据，重叠则保留一份。
5. **`notify-seed-builtin` 启动期化的并发安全未核实**：重启风暴下的幂等性要在 W6-P4 前实测。
6. **服务名仍叫 `notify-worker`**：语义债，改名涉及 openship 服务身份变更，单列动作。
7. **job 生命周期事件归属未裁决**（§10.1 第 3 条）：未裁决前通知侧不得假装能收到。
8. **agent 排班是新攻击面**：v1 key 白名单只有 `notify.emit`；配额与审批在 W6-P3 与通知板块同批交付。
9. **时区**：`Asia/Shanghai` 无 DST；将来引入有 DST 的时区前必须补 DST 用例。

## 16. 验收指标

| 指标 | 目标 |
|---|---|
| 业务 job 仍在 openship 上排班的条数（应用面） | W6-P4 后 = 0 |
| 漏跑被人工发现的比例 | 0（全部由 healthz/台账先发现） |
| 双调度者同时存在时长 | 0 |
| 调度器代码里出现 DAG/依赖/回填语义 | 0（评审红线） |
| 系统 job 因改库而改变行为 | 0（§3.6） |
