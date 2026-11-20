# 派发 / 执行拆分（方案 A）实施计划

> 依据：`docs/superpowers/specs/2026-11-20-deploy-safe-execution-design.md`（方案 B 已证伪，改推 A）。
> 前置：排空围栏已上线实测（#2569 / #2572）。

## 0. 先说清楚「A 买到了什么」

**买到**
- 改调度器自身代码（`registry.ts` / `loop.ts` / 通知逻辑）⇒ 只重启**派发器**，在跑的作业**完全不受影响**。
- 执行器重建变成**显式动作**：可以先排空（`drain.sh`）再重建，而不是被任意一次部署顺手 SIGKILL。
- 事故面收窄：`job_run` 里「running 却没人管」的窗口只剩执行器自身崩溃这一种。

**没买到（必须知道）**
- `dbt/`、`scripts/` 是**执行时才读**的代码；执行器要跑到新脚本/新模型，**仍然需要重建容器**。
  这段仍由**排空围栏**保护（部署前等到 running=0）。要让它们也不需要重启，得把「作业代码」
  变成数据（DB/YAML 驱动的管线）——那是另一个量级的改造，不在本计划内。

## 1. 目标形态

```
scheduler（派发器，复用现有 notify-worker --scheduler）
  claim → 建 running 行 → POST 给执行器 → 不管后续
  健康/心跳/对账照旧；容器里没有作业子进程

executor（执行器，新服务，同镜像不同入口）
  POST /run {runId, key}  → 按 **自己的 JOB_REGISTRY** 解析出 def → spawn → finishRun
  启动时 reapLostRunners(executor 实例 id)
  /healthz
```

**为什么 payload 只传 `{runId, key}`**：执行器按 key 在**自己进程里的 registry** 查 def，
不信任请求体里的 script/args/env —— 否则这个端点等于「任意命令执行」。

## 2. 任务分解

### Task 1：执行器服务
- 新文件 `scripts/executor-server.mjs`：
  - `POST /run`：校验 `EXECUTOR_TOKEN`（Bearer）→ `JOB_REGISTRY` 里查 key（查不到 400）→
    `defaultSpawn`（复用 `apps/server/src/scheduler/runner.ts`）→ 结束后 `finishRun`。
  - 并发上限沿用 `SCHEDULER_MAX_CONCURRENCY`。
  - `GET /healthz`：返回 `{ok, running}`；running 从进程内 Set 取（执行器是唯一权威）。
  - 启动时 `reapLostRunners(pool, now, instanceId)`（instanceId 形如 `executor-data`）。
- 单测：鉴权失败 → 401；未登记 key → 400；正常 → 202 且后续 finishRun（用注入的 spawn/pool）。

### Task 2：派发器改为「派发」
- `loop.ts` 增加 `deps.dispatch?: (job: ClaimedJob, def: JobDef) => Promise<void>`；
  **缺省仍走本地 spawn**（保持现有单测与回滚能力）。
- `scripts/notify-worker.mjs`：当 `EXECUTOR_URL` 存在时，`dispatch` = POST；
  非 2xx ⇒ 立即 `finishRun(status='failed', error='dispatch failed: <code>')`（不重试，交给排班重试）。
- 并发闸门：有 `EXECUTOR_URL` 时用 `countRunning(pool)`（DB 计数）代替进程内 `running.size`；
  本地 spawn 模式保持原样。
- 单测：dispatch 抛错 ⇒ 该 run 落 failed；DB 计数模式在 running 满时不再 claim。

### Task 3：编排与配置
- `deploy/data-compose.yml` 新增 `executor` 服务：同镜像、`command: pnpm exec tsx scripts/executor-server.mjs`、
  `EXECUTOR_TOKEN`（project env isSecret）、healthcheck 打 `/healthz`、**无 ports**（只在本 compose 网络内）。
- `scheduler` 增加 `EXECUTOR_URL: http://executor:13100`。
- `.env.example` 补齐两个新键（B9 门禁）。

### Task 4：部署子集与文档
- CI `deploy-data`：默认只重建 `scheduler`；**执行器只在「执行时读的东西」变更时重建**——
  `dbt/`、`scripts/`、`contracts/`、`deploy/Dockerfile.server`。其余（`apps/server/src/scheduler/`、
  registry、通知）只重建 scheduler。
- `deploy/deployment-units.md` §5 增补「派发器 / 执行器」两个角色与各自的重建触发面。

### Task 5：演练与验收
1. 一条 20 分钟作业运行中，**重建 scheduler** ⇒ 作业终态 `ok`（今天的三次是 `dur=0s`）。
2. 同场景**重建 executor**（先排空）⇒ 作业 `ok`；不排空直接重建 ⇒ 作业被 reap 成 timeout（这是执行器的真实边界，要写进文档）。
3. 执行器宕机演练：停掉 executor ⇒ 派发 POST 失败 ⇒ run 立即 `failed`（不是卡 running）。

## 3. 回滚路径

`EXECUTOR_URL` 不配 ⇒ 派发器回到本地 spawn（现状行为）。执行器服务可以先上线不用，
随时摘掉不影响调度。**这是本方案最容易回滚的地方，也是它比 B 更稳的理由。**

## 4. 不做的事

- 不改 `job_run` 状态机（不加 `dispatched` 态）：A2 的 HTTP 交接下，claim 即 running，
  语义与今天一致，迁移面最小。
- 不做执行器侧的自动更新（拉代码/热加载）：见 §0「没买到」。
