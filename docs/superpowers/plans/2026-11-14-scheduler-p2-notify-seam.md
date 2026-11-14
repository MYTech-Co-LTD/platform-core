# Wave 6 P2 · 通知接缝（SchedulerPort + notify.emit + 一次性延迟）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让「周期消息」能在内置调度器上跑：agent/console 经 `SchedulerPort` 建一条 `notify.emit` 排班，到点由 worker 子进程把事件入队；一次性延迟走 outbox 的 `available_at`，不进 cron。

**Architecture:** 调度器侧只加两样——一个 handler（`scripts/notify-emit-job.mjs`）与一个端口（`apps/server/src/scheduler/port.ts`）；通知侧只加一列（`notify.event.available_at`）与一条 claim 过滤。**不新增第二个调度器、不在通知模块里写 cron 解析、不让通知模块直连 `platform.job_*`。**

**Tech Stack:** TypeScript / Hono / pg / vitest；零新增依赖。

**Spec:** `docs/superpowers/specs/2026-11-14-business-scheduler-design.md` §7–§10；handoff（通知板块）§2.2/§2.3/§3.1/§3.2。

## Global Constraints

- **agent 只能排已注册 key**：v1 白名单只有 `notify.emit`；端口对未知 key 直接拒绝（`UNKNOWN_JOB_KEY`）。
- **归属只来自身份**：`owner_org` / `owner_namespace` 由调用方身份决定，**不读请求体**。
- **一次运行只入队一次**：eventId 缺省 = `schedule:<scheduleId>:<occurrence>`；同一 occurrence 重跑撞主键即去重（`duplicate` 视为成功）。
- **`JOB_PARAMS` 走 stdin**，≤16KB；超限或形状非法 ⇒ **exit 2**（不重试）。
- **一次性延迟不进 cron**：`available_at` 存在 `notify.event` 上，由投递循环 claim 到点事件。
- 迁移编号：`platform` 用 **019**（018 已上线）；`notify` 用 **010**。
- 测试夹具：platform 用 `jobtest-port:*`，notify 用 `org-p2-*`；真库用例空库可绿。
- Conventional Commits；**issue #2221**。

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/server/src/migrations/019_job_schedule_soft_delete.sql` | `job_schedule.deleted_at`（P3 删排班前的落点；本波只加列 + claim 过滤） |
| `apps/server/src/scheduler/registry.ts` | `JobDef` 增 `noSystemSchedule?`；新增 `notify.emit` 条目 |
| `apps/server/src/scheduler/store.ts` | claim 过滤 `deleted_at is null`；新增 `softDeleteSchedule` |
| `apps/server/src/scheduler/port.ts` | `SchedulerPort` 实现（白名单 + 身份注入 + 六个方法） |
| `apps/server/src/scheduler/port.test.ts` | 端口行为（白名单/归属/幂等/软删） |
| `scripts/notify-emit-job.mjs` | handler：stdin 读 params → 校验 → `enqueueEvent` |
| `scripts/notify-emit-job.test.ts` | handler 退出码与幂等（黑盒 spawn） |
| `modules/notify/migrations/010_event_available_at.sql` | `available_at` 列 + 索引 |
| `modules/notify/storage.ts` | `enqueueEvent` 接受 `availableAt`；`claimEvents` 过滤到点 |
| `modules/notify/storage.test.ts` | 延迟领取真值表 |

---

### Task 1: 通知侧一次性延迟（`notify.event.available_at`）

**Files:** Create `modules/notify/migrations/010_event_available_at.sql`；Modify `modules/notify/storage.ts`（`enqueueEvent` / `claimEvents`）；Test `modules/notify/storage.test.ts`。

**Interfaces:**
- `enqueueEvent(pool, input)` 的 `input` 增可选 `availableAt?: Date`（缺省 = now ⇒ 立即可领）。
- `claimEvents(pool, limit)` 只领 `available_at <= now()`。

- [ ] **Step 1: 迁移**

```sql
-- 010_event_available_at.sql — 一次性延迟队列（手递：调度器只负责 cron，一次性延迟进 outbox）
alter table notify.event add column if not exists available_at timestamptz not null default now();
create index if not exists idx_notify_event_due
  on notify.event (status, available_at) where status = 'new';
```

- [ ] **Step 2: 失败测试**

```ts
// 追加到 modules/notify/storage.test.ts（沿用该文件既有夹具风格）
it('★ 未来事件不被领取；到点后可领', async () => {
  const future = new Date(Date.now() + 3600_000)
  await enqueueEvent(pool, { org: ORG, eventId: 'delay-1', eventKey: 'test.event', scope: '*', payload: {}, producer: 'test', availableAt: future })
  expect((await claimEvents(pool, 50)).some(e => e.eventId === 'delay-1')).toBe(false)
  await enqueueEvent(pool, { org: ORG, eventId: 'delay-2', eventKey: 'test.event', scope: '*', payload: {}, producer: 'test' })
  expect((await claimEvents(pool, 50)).some(e => e.eventId === 'delay-2')).toBe(true)
  await pool.query("update notify.event set available_at = now() - interval '1 second' where event_id='delay-1'")
  expect((await claimEvents(pool, 50)).some(e => e.eventId === 'delay-1')).toBe(true)
})
```

- [ ] **Step 3–5:** RED → 实现（`insert ... available_at` 取 `input.availableAt ?? now`；claim 加 `and available_at <= now()`）→ GREEN → 提交 `feat(notify): 一次性延迟——notify.event.available_at（W6-P2）`。

---

### Task 2: 调度器软删列 + claim 过滤

**Files:** Create `apps/server/src/migrations/019_job_schedule_soft_delete.sql`；Modify `apps/server/src/scheduler/store.ts`；Test `apps/server/src/scheduler/store.test.ts`。

- [ ] **Step 1: 迁移**

```sql
-- 019_job_schedule_soft_delete.sql — 删排班一律软删（job_run 是审计，不能被级联带走）
alter table platform.job_schedule add column if not exists deleted_at timestamptz;
```

- [ ] **Step 2: 失败测试**：软删后的排班不被 `claimDue` / `claimQueuedManual` 领取；`softDeleteSchedule` 同时清 `next_run_at`/`retry_at`/`retry_occurrence`/`retry_attempt` 并置 `enabled=false`。
- [ ] **Step 3–5:** 实现 `softDeleteSchedule(pool, id, now)`；claim 两条 SQL 加 `and s.deleted_at is null`（`claimQueuedManual` 的 join 条件里加）；RED→GREEN→提交 `feat(data): 排班软删 + claim 过滤（W6-P2）`。

---

### Task 3: handler `scripts/notify-emit-job.mjs`

**Files:** Create `scripts/notify-emit-job.mjs` + `scripts/notify-emit-job.test.ts`。

**契约：**
- 从 **stdin** 读一行 JSON（`JOB_PARAMS`）：`{ eventKey, scope?, payload?, eventId? }`。
- `eventId` 缺省 `schedule:${JOB_SCHEDULE_ID}:${JOB_OCCURRENCE}`。
- 校验：`eventKey` 必填且非空；`payload` 必须是对象；序列化 ≤ 16KB。
- 调 `enqueueEvent`（producer=`scheduler`，org 取 `JOB_OWNER_ORG`，为空 ⇒ exit 2）。
- `accepted:true` 或 `reason:'duplicate'` ⇒ exit 0；其余 ⇒ exit 2（不重试）；DB 异常 ⇒ exit 1（可重试）。

- [ ] **Step 1: 失败测试（黑盒 spawn，注入 DATABASE_URL）**：合法参数 ⇒ exit 0 且 event 行存在且 `event_id` 为缺省格式；重复同一 occurrence ⇒ 仍 exit 0 且只有一行；缺 `eventKey` ⇒ exit 2 且无行；超 16KB ⇒ exit 2。
- [ ] **Step 2–5:** 实现 → GREEN → 提交 `feat(data): notify.emit handler（W6-P2）`。

---

### Task 4: registry 增 `notify.emit`（handler-only）

**Files:** Modify `apps/server/src/scheduler/registry.ts`（`JobDef` 增可选 `noSystemSchedule?: boolean`；seed 跳过这类条目）；Test `registry.test.ts` 追加一条。

- [ ] **Step 1: 失败测试**：`seedSchedules` 对 `noSystemSchedule: true` 的条目**不建系统排班行**，但该 key 仍可被 handler 查找。
- [ ] **Step 2–5:** 实现 → GREEN → 提交 `feat(data): registry 支持 handler-only key（W6-P2）`。

---

### Task 5: `SchedulerPort`

**Files:** Create `apps/server/src/scheduler/port.ts` + `port.test.ts`。

**接口（与 handoff 一致）：**

```ts
export interface SchedulerActor { userId: string; org: string; namespace: string }
export interface SchedulerPort {
  createSchedule(input: { key: string; cron: string; timezone: string; params: Record<string, unknown>;
    expectedIntervalSecs: number; timeoutMs?: number; maxAttempts?: number }): Promise<{ id: string; nextRunAt: string }>
  listSchedules(filter: { ownerOrg: string; ownerNamespace?: string }): Promise<Array<{ id: string; key: string; cron: string; enabled: boolean; nextRunAt: string | null; deletedAt: string | null }>>
  setScheduleEnabled(id: string, enabled: boolean): Promise<void>
  deleteSchedule(id: string): Promise<void>            // 软删
  listRuns(scheduleId: string, limit: number): Promise<Array<{ id: string; status: string; startedAt: string; finishedAt: string | null; exitCode: number | null; outputTail: string | null }>>
  runNow(id: string): Promise<{ runId: string }>        // 只入队
}
export function buildSchedulerPort(deps: { pool: Pool; actor: SchedulerActor; now?: () => Date }): SchedulerPort
```

- 白名单：`createSchedule` 的 key 仅允许 `notify.emit`，否则抛 `UNKNOWN_JOB_KEY`。
- 归属：`owner_org`/`owner_namespace`/`created_by` **只从 `actor` 取**；`source='agent'`。
- `createSchedule` 用 `nextRunAt` 算下一次并落库；`enabled=true`（agent 建完即生效——启停由 `setScheduleEnabled` 控制）。
- `deleteSchedule` 调 `softDeleteSchedule`；跨归属（id 不属于该 actor）⇒ `NOT_FOUND`。
- `runNow` 只插入 `queued` 行（与手动触发端点同语义），不 spawn。

- [ ] **Step 1: 失败测试**：白名单拒绝未知 key；归属来自 actor（请求体伪造无效——用 `params` 里塞 `ownerOrg` 证明被忽略）；跨归属操作 404；`runNow` 只建 queued 行；`deleteSchedule` 后不可见。
- [ ] **Step 2–5:** 实现 → GREEN → 提交 `feat(data): SchedulerPort（W6-P2）`。

---

### Task 6: 全量验证 + PR + 部署核验

- [ ] `pnpm -r --if-present test`、`pnpm run test:guard`、`pnpm run typecheck`、`node scripts/check-env-example.mjs`、`node scripts/check-compose.mjs` 全绿。
- [ ] 空库复跑 `modules/notify` 与 `apps/server/src/scheduler` 用例。
- [ ] PR（`Closes #2221`）；CI 绿后合并并按需部署两实例。
- [ ] 容器核验：`notify.event.available_at` 列在、`platform.job_schedule.deleted_at` 列在、`notify-emit-job.mjs` 在镜像内且 `node --check` 通过。

## Self-Review

- **Spec 覆盖**：§7（软删列）/§10.1 第 2 条（SchedulerPort）/§10.2（端到端）/handoff §3.1（available_at）§3.2（handler）。
- **不做**：agent 工具面与配额/审批（P3）；`jobs.job.*` 事件声明（P4，归属待裁决）；console 页面。
- **风险**：`claimEvents` 加 `available_at` 过滤后，**既有 `notify.event` 行的 `available_at` 由默认值补为 `now()`**（迁移里 `not null default now()` 会回填），不会把存量事件永久卡住——实施时在迁移注释里写明。
