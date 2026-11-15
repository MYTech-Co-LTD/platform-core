# Wave 6 P4a · `jobs` 模块（域面 + 事件声明）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 把「定时任务」变成一个**真模块**：它拥有 `jobs.job.*` 事件声明、对外 API（排班与运行台账、手动触发）与权限码；调度器（宿主）仍负责执行，并以生产者身份发事件。

**Architecture:** 模块**不读 `platform.job_*`**（B1），数据由宿主注入的 `ctx.jobs` 端口提供；模块只做域面（声明 / 路由 / 权限）。宿主 `platform-jobs` 路由**迁入模块**并保留 CSRF。

**Tech Stack:** TypeScript / Hono / pg / vitest；零新增依赖。

**Spec:** `2026-11-14-business-scheduler-design.md` §10.1（第 3 条）、§14 P4；handoff §2.5。

## Global Constraints

- 模块 **id = DB schema 名 = API 前缀**（三同纪律）：id `jobs`，路由挂在 `/api/modules/jobs`。
- **B1**：模块不读 `platform.*`；一切 job 数据经 `ctx.jobs`（宿主注入，未注入 ⇒ 路由返回 `JOBS_UNAVAILABLE`）。
- **api.internal 与 createRouter 逐条一致**（装载期双向核对）；**声明了才放行**。
- **权限码**：`jobs:read`（看排班与台账）、`jobs:manage`（手动触发）。声明进 manifest，由装载器按租户扇出。
- **手动触发仍只入队**，且**必须带 CSRF**（照 `apps/server/src/routes/api-keys.ts` 的写法——模块子树默认没有 CSRF，迁入时必须自带）。
- **事件 fail-open**：发通知失败**不得**影响 run 终态或重试决策（AGENTS.md #12）。
- 事件名：`jobs.job.failed` / `jobs.job.timeout` / `jobs.job.dead`；`eventId` 确定性（见 Task 4）。
- 测试夹具：`jobtest-p4a:*` / `org-p4a-*`；空库可绿。

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/platform-sdk/src/module.ts` | `ModuleContext.jobs?: JobsPort`（只读 + 入队，结构化类型） |
| `apps/server/src/scheduler/jobs-port.ts` | 宿主实现：系统排班列表 / 台账 / 手动入队 |
| `apps/server/src/loader.ts` / `app.ts` | 注入 `ctx.jobs` |
| `modules/jobs/manifest.yaml` | id/名称/权限码/api.internal/notifications.events |
| `modules/jobs/index.ts` / `routes.ts` | 模块定义与路由（含 CSRF） |
| `modules/jobs/routes.test.ts` | 权限、声明一致性、CSRF、只入队 |
| `apps/server/src/scheduler/loop.ts` | 失败/超时/死信时发事件（fail-open） |
| `modules/notify/templates/builtin.ts` + `seed-builtin.ts` | `jobs.job.*` 模板与派生规则（收件人 `admins`） |
| `deploy/jobs.md` | 手动触发端点新路径 + 模块权限码 |

---

### Task 1: `ctx.jobs` 端口（宿主侧）

**Files:** `packages/platform-sdk/src/module.ts`、`apps/server/src/scheduler/jobs-port.ts`（新）、`apps/server/src/loader.ts`、`apps/server/src/app.ts`、测试。

**接口：**

```ts
export interface SystemJobScheduleView {
  id: string; key: string; enabled: boolean; cron: string; timezone: string
  nextRunAt: string | null; lastStatus: string | null; lastRunAt: string | null
}
export interface JobRunView {
  id: string; key: string; status: string; trigger: string; attempt: number
  startedAt: string; finishedAt: string | null; exitCode: number | null; durationMs: number | null
  outputTail: string | null
}
export interface JobsPort {
  listSchedules(): Promise<SystemJobScheduleView[]>            // source='system' and deleted_at is null
  listRuns(key: string, limit: number): Promise<JobRunView[]>   // 上限 100，started_at desc
  runNow(key: string): Promise<{ runId: string }>              // 只入队；未知/停用 ⇒ 抛带 code 的错误
}
export function buildJobsPort(deps: { pool: Pool; now?: () => Date }): JobsPort
```

- `runNow` 复用 P1 路由的语义（事务内锁排班行 → 判 `queued|running` → insert → 2s `lock_timeout`），错误码沿用 `JOB_NOT_FOUND` / `JOB_ALREADY_PENDING` / `JOB_LOCK_TIMEOUT`。
- 注入：`loader.ts` 把 `deps.jobs` 原样放进 `ModuleContext`；`app.ts` 用 `buildJobsPort({ pool })`。未注入 ⇒ `undefined`。

- [ ] 失败测试：列表只含 `source='system'` 且排除软删；`listRuns` 截断 100；`runNow` 只建 queued 行 + 重复 409 语义 + 锁超时；未注入时 ctx 里是 `undefined`。
- [ ] RED → GREEN → 提交 `feat(data): ctx.jobs 端口（W6-P4a）`。

---

### Task 2: `jobs` 模块骨架（声明 + 路由 + 权限）

**Files:** `modules/jobs/manifest.yaml`、`modules/jobs/index.ts`、`modules/jobs/routes.ts`、`modules/jobs/routes.test.ts`。

**manifest 要点：**

```yaml
id: jobs
name: 定时任务
version: 0.1.0
platform: '>=0.1'
permissions:
  - { code: jobs:read,    name: 定时任务查看 }
  - { code: jobs:manage,  name: 定时任务手动触发 }
api:
  internal:
    - { method: GET,  path: /schedules,      scope: jobs:read }
    - { method: GET,  path: /runs/:key,      scope: jobs:read }
    - { method: POST, path: /:key/run,       scope: jobs:manage }
notifications:
  events:
    - key: jobs.job.failed
      title: 定时任务失败
      description: 由宿主 platform.scheduler 发出（模块只声明契约）
      payload: { type: object, required: [scheduleId, key, runId, exitCode], properties: {...} }
      recipients: { ... }   # 形状照 modules/data 的既有声明（scope_holders / admins）
    # timeout / dead 同形，dead 多 attempts
```

- 路由：`GET /schedules`、`GET /runs/:key?limit=`、`POST /:key/run`；`ctx.jobs` 缺失 ⇒ 503 `JOBS_UNAVAILABLE`。
- **`runNow` 必须传身份**（`{tenantId, userId}` 来自会话）；集成断言「审计行的 tenant_id/actor 非空」——端口层 actor 可选，靠这一条兜住。
- `POST /:key/run` 必须校验 **CSRF**（`csrfToken(session, sessionSecret)`，secret 由模块 deps 注入——照 `routes/api-keys.ts`）。
- 测试：三个端点的 scope 门禁（无码 403）；**声明集合 == 注册集合**（可由装载期核对覆盖，再加一条单元断言）；CSRF 缺失 403、正确 200；`ctx.jobs` 缺失 503。

- [ ] RED → GREEN → 提交 `feat(jobs): jobs 模块骨架——声明/路由/权限（W6-P4a）`。

---

### Task 3: 迁入手动触发，退役宿主路由

**Files:** 删除 `apps/server/src/routes/platform-jobs.ts` 及其测试；`apps/server/src/app.ts` 去掉挂载；`deploy/jobs.md` 更新路径与权限码。

- 行为对齐：新端点与原端点**语义一致**（只入队 / 409 / 锁超时 503 / 审计 `admin.job.run`）。
- 审计保留：模块路由内写 `platform.audit`？**不行**（B1）。改为由 `ctx.jobs.runNow` 在宿主侧写审计（端口内写），模块不碰。
- `deploy/jobs.md` 的「优先用端点入队」改为 `/api/modules/jobs/:key/run`，并写明需 `jobs:manage` + CSRF。

- [ ] 失败测试：旧路径 404；新路径行为与原用例逐条等价（迁移测试而非删测试）。
- [ ] RED → GREEN → 提交 `feat(jobs): 手动触发迁入模块，退役宿主路由（W6-P4a）`。

---

### Task 4: 调度器发 `jobs.job.*`（fail-open）

**Files:** `apps/server/src/scheduler/loop.ts`（或新增 `emit-job-events.ts`）、测试。

**语义：**
- `finishRun` 落 `failed` ⇒ 发 `jobs.job.failed`；落 `timeout` ⇒ `jobs.job.timeout`。
- **死信**：`status in (failed,timeout)` 且 `attempt >= maxAttempts` ⇒ 追加 `jobs.job.dead`（与 health 的「连续失败 ≥3」**不是同一判据**，这里是尝试耗尽；两者可同时存在，不去重彼此）。
- `eventId`：`jobs.job.failed:<runId>` / `...:timeout:<runId>` / `jobs.job.dead:<scheduleId>:<occurrence>`（死信按**格**去重，重试同一格只发一次）。
- payload：`{scheduleId, key, runId, exitCode, error, durationMs, ownerOrg, ownerNamespace}`。
- **fail-open**：整段 try/catch，异常只 `log`，**不得**改变 run 状态、不得影响重试/清槽。
- 发点用 `enqueueEvent`（与 `integration.stale` 同路径），**不新起子进程**。

- [ ] 失败测试：失败 run ⇒ 发 failed；超时 ⇒ timeout；attempt 耗尽 ⇒ 追加 dead；同一 occurrence 重发 ⇒ 只有一行（幂等）；**enqueue 抛错时 run 行状态与重试槽不变**（故障注入）。
- [ ] RED → GREEN → 提交 `feat(data): 调度器发任务生命周期事件（fail-open）（W6-P4a）`。

---

### Task 5: 模板与派生规则（`jobs.job.*`）

**Files:** `modules/notify/templates/builtin.ts`、`modules/notify/seed-builtin.ts`、`templates/builtin.test.ts`。

- 三条模板（中文，含 `{key}` `{exitCode}` 等占位）；派生规则 `recipient_key='admins'`（与 `integration.stale` 同款：**只走 in_app**，理由同——通道本身可能就是坏的）。
- 护栏测试：**声明 ⇔ 模板 ⇔ 派生规则三处同描**（沿用 `templates/builtin.test.ts` 的双向断言）。

- [ ] RED → GREEN → 提交 `feat(notify): jobs.job.* 模板与派生规则（W6-P4a）`。

---

### Task 6: 全量验证 + PR + 部署核验

- [ ] 全仓 `pnpm -r test` / `test:guard` / `typecheck` / `check-env-example` / `check-compose` / `check-mcp-toolface` 全绿。
- [ ] PR（`Closes #<issue>`）；CI 绿后合并、部署两实例。
- [ ] 容器核验：`/api/modules/jobs/schedules` 未鉴权 401（而非 404）；模块在装载列表里；`ctx.jobs` 注入（用一次 `GET /schedules` 真请求或装载测试证明）。
- [ ] 台账：Wave 6 P4a 入账。

## Self-Review

- **覆盖**：事件声明归属（模块自己声明）、API 归属（迁入模块）、权限码、fail-open、幂等。
- **不做**：P4b（其余 4 类 job 迁移 + `seed`/`health` 折叠）；租户级 kill switch；console 页面（本波只开 API）。
- **风险**：迁入模块会**丢掉模块子树默认没有的 CSRF**（Task 2/3 明确要求自带）；`ctx.jobs` 未注入的降级路径要测（旧宿主/单测）；`jobs` 模块的权限码需要在真实租户上被扇出后才可用（切流前用平台管理员验证；否则会 403）。
