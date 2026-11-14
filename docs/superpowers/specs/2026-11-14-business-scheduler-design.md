# 业务定时归属：从 openship job 迁到平台内置调度器——设计

> 状态：2026-11-14 与用户逐条确认（方案 A′）。
> 关联：`docs/architecture.md` §2.11（定时载体）、开发地图 `2026-11-11-helix-borrow-roadmap.md` Wave 6。
> 起因：用户定调「业务层面的压力不放到 openship 上」。这是**架构变更**，顺序是
> 「人同意 → 改本文与正典 → 再写码」。

## 1. 背景：三个已经成立的失败形态

1. **openship 上压着业务。** 与本项目相关的 job 共 55 个，其中 **30 个是周期排班**，
   业务属性为主：`notify-*` 6 个、`metric-candidates` / `report-scope-scan`、`pipeline-scorecard` 2 个、
   `verify-regression` / `verify-ingest`、`org-sync` 2 个、`dbt-materialize`、`L1 词表物化`、
   duckle 月合并 / 删小时对象 / 维表发布、`archive-private-measures`、`demining` 等。
   真正属于基建的只有 `host-metrics`、`OO 桥 / 看门狗`、`integration-probe 心跳`。
2. **正典现在写的是反的。** `docs/architecture.md:497-503`：「定时载体 = openship job（2026-10-19 拍板）……
   openship 打 `docker run` 一次性容器，**零常驻**」；`deploy/notify-jobs.md:7`、`deploy/org-sync-job.md:4-5`、
   `deploy/metric-retire-job.md:7-8` 等处重复「**应用进程不跑定时副作用**」。
3. **openship 当业务调度器的失败模式已经真实发生过**：
   - 部署互斥被 worker 挂死 40+ 分钟，需重启 api 解锁（`openship-platform` PR #34）；
   - 长 job 被 SSH 会话取消连坐杀死，表象是 `SKIP:holds-lock`；
   - job 通知不进 deliveries feed，业务失败在运维面上「看得见但查不到」。

同时本仓**没有通用调度器**：常驻进程只有 `notify-worker`（2s 轮询 outbox，`SKIP LOCKED` + 60s 租约，
自带 `worker_heartbeat` + `/healthz`），业务定时全靠外部 cron。

## 2. 目标 / 非目标

**目标**

- 业务定时的**调度定义、运行台账、失败可见性**全部在平台自己的库里；openship 退回
  「部署 / 回滚 / 备份 / 主机基建」。
- 先**减少**需要排班的东西，再决定要不要造机器。

**非目标**

- 不做通用工作流引擎：不做 DAG、不做依赖编排、不做回填队列、不做分布式执行。
- 不动数据面（本波）。
- 不替代 duckle console 已有的管线排班。

## 3. 不变量

1. **调度器只做 cron + 台账。** 要 DAG / 依赖 / 回填 ⇒ 上 duckle 或 Airflow，不在本仓长出来。
2. **单调度者。** 任一 job 在同一时刻只能有一个调度者（openship 或本调度器），切流必须先把旧的关掉。
3. **业务定时归业务，基建定时留 openship。** 判据：这条定时的失败意味着「业务数据/业务动作没发生」⇒ 业务；
   意味着「机器/进程/证书状态异常」⇒ 基建。
4. **执行隔离。** 周期任务一律子进程执行 + 超时 kill；**不在 HTTP 进程里**、也不与投递循环共享执行线程。
5. **静默失败不可接受。** 每个 job 必须声明期望间隔；「该跑没跑」必须能把健康判成红。

## 4. 选型：为什么不是行业里那几个大件

| 方案 | 适用 | 本场景结论 |
|---|---|---|
| Airflow / Dagster / Prefect / Temporal | 有 DAG 依赖、需回填、跨系统编排的数据管道 | 7 个互相独立的 product job 用它=用航母送快递，且新引入一个运维面（正是要消除的） |
| K8s CronJob | 容器编排平台 | compose 单机部署，无 k8s |
| 云调度（EventBridge / Cloud Scheduler） | 无状态 HTTP 触发 | 需要公网入站端点 + 云侧权限；**运行台账在云上，不在平台库** |
| `pg_cron` | 纯 SQL 任务 | job 是 Node 脚本；pg_cron 只能当闹钟，仍缺执行器与台账 |
| **应用内 worker + 库内排班表** | < 20 个无依赖周期任务 | **本方案**。行业原型：Oban（Elixir）、GoodJob（Rails）、Quartz JDBC JobStore、celery-beat |

## 5. 去留表（决定值不值得造机器）

| job（实例级条数） | 现在 | 判定 | 理由 |
|---|---|---|---|
| `notify-seed-builtin`（2，每小时） | openship cron | **启动期化** | 幂等 seed 属启动路径；每小时重敲是历史惯性 |
| `notify-health`（2，5 分钟） | openship cron | **并入 worker 循环** | 与 worker 已有的 `drainStaleAlerts` 同域同进程；**先核实重叠度再并**（P2） |
| `notify-reconcile`（2，每小时） | openship cron | **需 cron** | 对账依赖时间窗 |
| `notify-preflight`（1，每日） | openship cron | **需 cron** | 全量规则体检，只读 |
| `notify-retention`（1，每日） | openship cron | **需 cron** | 删行；保留期口径不变，不新增权限 |
| `metric-candidates`（1，每日） | openship cron | **需 cron** | 候选池生成 |
| `report-scope-scan`（未建） | — | **需 cron** | 只读巡检 |
| `metric-retire`（未建） | — | **需 cron** | 周频提案 |
| `org-sync`（2，6 小时） | openship cron | **需 cron** | 外部系统同步 |
| `verify-regression` / `verify-ingest`（2） | openship cron | **第二步：导出到观测面** | 本质是 QA / 新鲜度判据，不是作业 |
| `dbt-materialize` / `L1 词表物化` / duckle 系列 / `scorecard`（6+） | openship cron | **第二步：归 duckle 排班或观测面** | 数据编排归数据编排器 |
| `host-metrics` / `OO 桥·看门狗` / `integration-probe 心跳`（4+） | openship cron | **留 openship** | 基建定时 |

**净结果：11 类 → 7 类**；两条（seed / health）从系统里消失而不是搬家。

## 6. 架构

```
deploy/docker-compose.yml
├── server           HTTP（不跑定时副作用）
├── notify-worker    常驻（P1 起 = worker：多 loop 注册表）
│     loop notify.dispatch   ← 现有：outbox 轮询 2s
│     loop platform.scheduler ← 新增：30s 一跳
│            │
│            ├─ claim: UPDATE platform.job_schedule … FOR UPDATE SKIP LOCKED RETURNING
│            ├─ spawn: pnpm exec tsx scripts/<job>.mjs   （子进程，超时 kill）
│            └─ record: platform.job_run
└── postgres         platform.job_schedule / job_run / job_heartbeat
```

- **P1 不改 compose 服务名**（仍叫 `notify-worker`）：避免 openship 侧服务身份变更引入额外风险；
  改名是可选后续动作。文档与代码注释里称其为「worker（含通知投递与业务定时两 loop）」。
- 任务目录在代码（`apps/server/src/jobs/registry.ts`），排班状态在库；启动幂等 seed，
  **不覆盖人改过的 cron**（只补新增 key、只补缺失行）。

## 7. 数据模型（迁移 `apps/server/src/migrations/018_platform_jobs.sql`）

```sql
create table if not exists platform.job_schedule (
  key                    text primary key,
  cron                   text not null,
  timezone               text not null default 'Asia/Shanghai',
  enabled                boolean not null default false,
  next_run_at            timestamptz,
  timeout_ms             integer not null default 300000,
  max_attempts           integer not null default 1,
  expected_interval_secs integer not null,       -- 「该跑没跑」判据的分母
  updated_at             timestamptz not null default now()
);

create table if not exists platform.job_run (
  id          bigserial primary key,
  key         text not null references platform.job_schedule(key),
  trigger     text not null check (trigger in ('schedule','manual')),
  status      text not null check (status in ('running','ok','failed','timeout','skipped')),
  attempt     integer not null default 1,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  exit_code   integer,
  duration_ms integer,
  output_tail text,                              -- 尾部 4KB
  error       text
);
create index if not exists job_run_key_started_idx on platform.job_run (key, started_at desc);

create table if not exists platform.job_heartbeat (
  id      text primary key,
  beat_at timestamptz not null
);
```

- `enabled` 默认 **false**：新 job 登记后必须显式开启，避免「登记即跑」。
- `next_run_at` 为 null 且 enabled 时，seed/开启时立即补算，不立即执行。

## 8. 执行语义

- **抢单与前推合一**（一条语句完成，多副本天然安全；不复用 `integration-probe` 那套跨连接 advisory lock）：
  ```sql
  with due as (
    select key from platform.job_schedule
     where enabled and next_run_at is not null and next_run_at <= now()
     order by next_run_at
     for update skip locked
     limit $1
  )
  update platform.job_schedule s set next_run_at = $nextFrom(s.key, now()), updated_at = now()
    from due where s.key = due.key
  returning s.*;
  ```
- **misfire**：若 `now - next_run_at > 3 × expected_interval_secs`，本次**只跑一次**并直接快进到下一个未来时点，
  **不回填**错过的历史轮次。
- **执行**：`spawn('pnpm', ['exec','tsx', script], {cwd:'/app', env: process.env})`；
  `timeout_ms` 到点 `SIGTERM`，5s 后 `SIGKILL`，run 记 `timeout`。
- **重试**：`exit 2`（缺 env / 判不了）**不重试**；其余非 0 在 `max_attempts` 内隔 60s 重排（写新 run 行，`attempt+1`）。
- **并发**：全局上限 `SCHEDULER_MAX_CONCURRENCY`（默认 2）；同一 key 不重叠（内存中活跃集合足够——单 loop 进程）。
- **时区**：`cron` 按 `timezone` 解释（默认 `Asia/Shanghai`，无 DST）；`job_run` 时间戳一律 UTC。
- **cron 解析**：**零依赖自写纯函数**（仓内既有风格：元 schema 校验器就是零依赖自写），
  只支持 `* , - /` 与 0–7 周几；**不支持的语法在 seed 期直接报错拒绝**（fail-closed，绝不静默按错时间跑）。
  需要的子集就是实际在用的 7 条：`7 * * * *`、`43 3 * * *`、`23 3 * * *`、`40 6 * * *`、`37 1 * * *`、`23 3 * * 1`、`13 */6 * * *`。

## 9. 故障可见性（P1 必含）

1. **台账**：每次执行一行 `job_run`（谁触发、多久、退出码、日志尾）。
2. **心跳 + healthz**：loop 每跳 upsert `platform.job_heartbeat('scheduler')`；`/healthz` 判三件事——
   - 心跳陈旧 > 2 分钟 ⇒ 非 200；
   - **任一 enabled job 超过 `2 × expected_interval_secs` 无 `status='ok'` 的 run ⇒ 非 200**（「该跑没跑」）；
   - 连续失败 ≥ 3 次 ⇒ 非 200。
3. **手动触发**：`POST /api/platform/jobs/:key/run`（会话 + 平台管理员），写 `trigger='manual'` 的 run 行，落 `platform.audit`。
4. P2 再把 ②③ 接 notify 通道。**P1 不新增告警出口**（避免第二套告警路径）。

## 10. 迁移与回滚

**切流铁律**：同一 job 任一时刻只有一个调度者。

```
登记 key（enabled=false） → 手动触发一次，比对产物与 openship 上最近一次的结果
  → 关掉 openship 的那个 job（enabled=false 或删除）
  → DB 置 enabled=true（next_run_at 补算到下一个未来时点）
```

- 回滚：反向操作；`SCHEDULER_ENABLED=0` 可一次性停掉调度 loop（投递 loop 不受影响）。
- 顺序按爆炸半径：`notify-reconcile` → `metric-candidates` → `report-scope-scan`
  → `notify-preflight` → `notify-retention` → `metric-retire` → `org-sync`。

## 11. 正典要改的条文

| 位置 | 现在 | 改成 |
|---|---|---|
| `docs/architecture.md:497-503` | 定时载体 = openship job / 零常驻 | 拆两条线：基建定时留 openship job；业务定时归 worker 的 `platform.scheduler` loop（目录在代码、排班与台账在库） |
| `deploy/notify-jobs.md:7`、`deploy/org-sync-job.md:4-5`、`deploy/metric-candidates-job.md:5-6`、`deploy/metric-retire-job.md:7-8`、`deploy/report-scope-scan-job.md:7-8` | 「不要塞进 server 进程（应用进程不跑定时副作用）」 | 理由保留（反对**把副作用藏进 HTTP 进程**），结论改为「归 worker 的调度 loop，不归 HTTP 进程」 |
| `docs/architecture.md`（新增不变量） | — | 「调度器只做 cron + 台账」写进 §2.11 |

## 12. 测试策略

- 纯函数：`nextRunAt(cron, tz, from)` 真值表（跨月/跨年、`*/n`、`a-b`、`a,b`、周几 0 与 7、非法语法抛错）。
- 纯函数：misfire 判定（错过 1 个周期不跳、错过 4 个周期只跑一次）。
- 真库：并发两连接抢同一到期 job ⇒ 只有一方拿到（`SKIP LOCKED` 实证）。
- 真库：`exit 2` 不重试；非 0 按 `max_attempts` 重排；超时留 `timeout` 行。
- 真库：seed 幂等——重复 seed 不覆盖人改过的 `cron`/`enabled`。
- 路由：手动触发无会话 ⇒ 401/403；有会话 ⇒ 建 run 行；审计落 `platform.audit`。
- healthz：心跳陈旧 / 超期未成功 / 连续失败三种形态各自非 200。

## 13. 分期

| 期 | 交付 | 验收 |
|---|---|---|
| **P1** | 迁移 018 + registry + 调度 loop（并入 worker）+ 子进程执行器 + 台账 + healthz 判据 + 手动触发端点；迁入 3 个 job（`notify-reconcile` / `metric-candidates` / `report-scope-scan`） | 3 个 job 在自家台账连跑 48h 无漏跑；openship 对应 job 已关；`exit 2` 不重试经实测；healthz 三判据各有一条实证 |
| **P2** | 迁入 `notify-preflight` / `notify-retention` / `metric-retire` / `org-sync`；`notify-seed-builtin` 启动期化；`notify-health` 并入 loop；失败接 notify 通道 | 应用面 7 类全部脱离 openship；`seed`/`health` 两个 job 从系统里删除 |
| **P3（另一波，另出计划）** | 数据面「消」：duckle 排班承接管道类；`scorecard`/`verify-*` 导出为观测面判据（消费 `data.load_log` 与 `metric_freshness`） | 数据面 openship job 数量下降且无一静默失效 |

## 14. 风险与已知边界

1. **自己造调度器的长期成本**：靠不变量 §3.1 压制（只做 cron + 台账）。任何「顺手加个依赖编排」的提案一律驳回。
2. **调度器成为业务新鲜度的单点**：故 §9 的心跳与「该跑没跑」判据必须与调度器同时上线；compose healthcheck 把容器级异常暴露给 openship（基建语义，不违背第 1 条）。
3. **切流期双调度者**：靠 §10 的顺序约束；发现重叠 ⇒ 立即停 DB 侧 `enabled`。
4. **`notify-health` 与 `drainStaleAlerts` 的重叠度未核实**：P2 开工前先读两者判据，重叠则以保留一份为准，不并行两套。
5. **`notify-seed-builtin` 启动期化的并发安全未核实**：多副本/重启风暴下并发 seed 的幂等性要在 P2 前实测。
6. **服务名仍叫 `notify-worker`**：语义不符是已知债，改名涉及 openship 服务身份变更，单列动作。
7. **时区**：`Asia/Shanghai` 无 DST；若将来引入有 DST 的时区，`nextRunAt` 必须补 DST 用例后才能启用。

## 15. 验收指标

| 指标 | 目标 |
|---|---|
| 业务 job 仍在 openship 上排班的条数（应用面） | P2 后 = 0 |
| 漏跑被人工发现的比例 | 0（全部由 healthz/台账先发现） |
| 双调度者同时存在时长 | 0 |
| 调度器代码里出现 DAG/依赖/回填语义 | 0（评审红线） |
