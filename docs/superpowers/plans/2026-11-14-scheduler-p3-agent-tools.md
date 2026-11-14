# Wave 6 P3 · agent 排班能力（工具面 + 配额）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让 agent 能建/查/停/删自己的周期消息排班，并执行配额。**外发通道不对 agent 开放**（只能人改）。

**Architecture:** 排班是 `notify.emit` 的排班 ⇒ **工具面归 notify 模块**（事件/模板/规则与排班同一域）。宿主把 `SchedulerPort` 注入模块上下文（与 `ctx.notify` 同款注入），模块只经端口操作，**不直连 `platform.job_*`**。配额在端口层强制（唯一收口），工具层只做参数成形。

**Tech Stack:** TypeScript / Hono / MCP tool registration / pg / vitest。零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-business-scheduler-design.md` §10.1（第 2 条）、handoff §3.4/§3.5；**配额与通道口径由用户拍板（2026-11-14）**。

## Global Constraints（用户拍板，逐字执行）

- **配额**：每 `owner_namespace` 最多 **50** 条排班；最小 cron 间隔 **5 分钟**；每 namespace 每日最多 **200** 条 firing。超限 ⇒ 端口抛 `QUOTA_EXCEEDED`（带 `limit` 与 `kind`）。
- **外发通道不对 agent 开放**：`createSchedule` 不接受任何通道参数；agent 建的排班一律 `in_app`（通道由人在控制台改 notify 规则）。**不新增审批状态机**。
- 归属只来自身份；跨归属 `NOT_FOUND`；`runNow` 只入队。
- 工具面只调用 `SchedulerPort`，**不得**出现 `platform.job_*` 的 SQL。
- 迁移：无新增（P2 已就位）；若确需，`platform` 用 020、`notify` 用 011。
- 测试：`jobtest-p3:*` / `org-p3-*`；空库可绿。

## File Structure

| 文件 | 职责 |
|---|---|
| `packages/platform-sdk/src/module.ts` | `ModuleContext` 增可选 `scheduler?: SchedulerPortFactory`（`(actor) => SchedulerPort`；仅类型，端口实体在宿主） |
| `apps/server/src/scheduler/port.ts` | 配额强制（50 / 5min / 200 per day）+ `quotaOf` 只读查询 |
| `apps/server/src/loader.ts` | 把端口注入模块上下文（与 `notify` 注入同一处） |
| `modules/notify/tools/schedules.ts` | 七个 MCP 工具（create/list/pause/resume/delete/list_runs/run_now），只调端口 |
| `modules/notify/manifest.yaml` | 工具声明（api.internal 同步；装载期双向核对会拦漏声明） |
| `modules/notify/tools/schedules.test.ts` | 工具面行为（配额/归属/停删/只入队） |
| `deploy/jobs.md` | 配额与外发口径写入运维文档 |

---

### Task 1: 端口层配额

**Files:** Modify `apps/server/src/scheduler/port.ts`；Test `port.test.ts`。

**语义：**
1. `createSchedule` 前置检查（同一事务内 count，避免并发超建）：
   - `select count(*) from platform.job_schedule where owner_org=$1 and owner_namespace=$2 and deleted_at is null and source='agent'` ⇒ `>= 50` 抛 `QUOTA_EXCEEDED {kind:'schedules', limit:50}`。
   - cron 最小间隔：用 `nextRunAt` 连算两次，间隔 `< 5 分钟` 抛 `QUOTA_EXCEEDED {kind:'min_interval', limit:300}`。
   - 每日 firing：`select count(*) from platform.job_run r join platform.job_schedule s on s.id=r.schedule_id where s.owner_org=$1 and s.owner_namespace=$2 and r.started_at > now() - interval '1 day'` ⇒ `>= 200` 抛 `QUOTA_EXCEEDED {kind:'daily_firings', limit:200}`。
2. 新增只读 `quotaOf(actor)` ⇒ `{ schedules: {used,limit}, dailyFirings: {used,limit}, minIntervalSecs }`。

- [ ] 失败测试：49 条可建、第 50 条拒；`*/5` 可建、`*/4` 拒；造 200 条当日 run ⇒ 拒；`quotaOf` 数字对得上。
- [ ] RED → GREEN → 提交 `feat(data): SchedulerPort 配额（50/5min/200）`。

---

### Task 2: 端口注入模块上下文

**Files:** Modify `packages/platform-sdk/src/module.ts`、`apps/server/src/loader.ts`、`apps/server/src/app.ts`（构造端口并传入 loader）；Test `apps/server/src/loader.test.ts` 追加。

- [ ] 失败测试：装载后 `ctx.scheduler` 是**工厂函数**，`ctx.scheduler(actor)` 按**请求身份**绑定 actor（actor A 建一条 ⇒ 库行归属 A；A 列得到自己那条，B 列举为空）；未注入时 `ctx.scheduler` 为 `undefined`（旧宿主/单测），模块必须显式降级（工具返回 `SCHEDULER_UNAVAILABLE`）。
- [ ] RED → GREEN → 提交 `feat(data): SchedulerPort 注入模块上下文`。

---

### Task 3: notify 工具面（七个工具）

**Files:** Create `modules/notify/tools/schedules.ts` + 测试；Modify `modules/notify/manifest.yaml`。

**工具**（每个都只调 `ctx.scheduler`；`actor` 由**工具层从请求身份取**——`{userId, org, namespace?}` 再 `ctx.scheduler(actor)` 造端口，**不接受用户参数传 org/namespace**）：

| 工具 | 入参 | 出参 |
|---|---|---|
| `create_schedule` | `cron`, `params{eventKey,payload,scope?}`, `timezone?` | `{id, nextRunAt}` |
| `list_schedules` | — | 排班列表（含 enabled / nextRunAt） |
| `pause_schedule` / `resume_schedule` | `id` | `{ok}` |
| `delete_schedule` | `id` | `{ok}`（软删） |
| `list_schedule_runs` | `id`, `limit?` | 运行台账 |
| `run_schedule_now` | `id` | `{runId}`（只入队） |
| `get_schedule_quota` | — | 配额使用情况 |

- 描述里**明确写**：排班只用于「周期消息」；外发通道由控制台改规则，工具不提供。
- 工具预算：新增 7 个工具会吃 toolface 预算（10240 字节上限），先跑 `node scripts/check-mcp-toolface.mjs` 看余量；超了就压缩描述（不删能力）。

- [ ] 失败测试：create 落库且 `source='agent'`；pause 后 `enabled=false`；delete 后 list 不含；`run_now` 只建 queued 行；配额超限错误码透出；`ctx.scheduler` 缺失 ⇒ `SCHEDULER_UNAVAILABLE`。
- [ ] RED → GREEN → 提交 `feat(notify): agent 排班工具面`。

---

### Task 4: 文档与额度口径

**Files:** `deploy/jobs.md`、`docs/architecture.md`（§2.4 定时载体小节追加一句：agent 排班走 notify 工具，配额见 jobs.md）。

- [ ] 写清：50/5min/200、外发只能人改、`get_schedule_quota` 可自查、超限错误码。
- [ ] 提交 `docs(data): agent 排班配额与外发口径`。

---

### Task 5: 全量验证 + PR + 部署核验

- [ ] `pnpm -r test` / `test:guard` / `typecheck` / `check-env-example` / `check-compose` / `check-mcp-toolface` 全绿。
- [ ] PR（`Closes #<issue>`）；CI 绿后合并、部署两实例。
- [ ] 容器核验：工具面带 `create_schedule`、`ctx.scheduler` 在（用一次真实 create 后 `list_schedules` 能看到并 `delete` 掉，**在测试租户或 mytech 上做，不在山海生产数据上留垃圾**）。

## Self-Review

- **覆盖**：配额（用户拍板值）、外发不对 agent 开放、工具面归 notify、端口注入。
- **不做**：外发审批状态机（用户选「只在控制台改」）；`jobs.job.*` 事件（P4）；租户级 kill switch（等有真实租户需求再加，记 P4 待办）。
- **风险**：工具预算（七个工具）可能超 10240 字节 ⇒ Task 3 先量再写；注入改动触及 loader，回归面大 ⇒ Task 2 的测试要覆盖「未注入」与「已注入」两态。
