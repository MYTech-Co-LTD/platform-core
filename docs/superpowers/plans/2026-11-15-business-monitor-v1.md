# Wave 7 V1 · 业务监控（missing / stale + 状态机 + 影子期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 让「某指标 / 某报表面板」可以被挂上监控；`missing`（窗口内 0 行）与 `stale`（读水位、不扫湖）成立时按状态机发通知；`dry_run` 默认开，先跑一周影子期。

**Architecture:** 存储与求值都在 `modules/data`（要用指标词表、只读池与报表 spec）。执行不新建进程：`data.monitor_tick` 是**调度器 registry 的一个 key**（每实例一条系统排班，seed 为 disabled），tick 脚本遍历到期规则、逐条求值、写 `monitor_run`、只在状态跃迁且非影子期时入队 `data.monitor.*` 事件。判据来源全部是既有面：`freshnessFaceFor` / `watermarkSqlFor`（水位）与 `authorize(...).plan.sql`（行数），**不写新查询语义、不重算水位**。

**Tech Stack:** TypeScript / pg / pg_duckdb / vitest / Hono；零新增依赖；tick 由 `pnpm exec tsx` 运行（要 import 域层 `.ts`）。

**Spec:** `docs/superpowers/specs/2026-11-14-business-monitor-design.md`（唯一事实源）；路线图 `2026-11-11-helix-borrow-roadmap.md` §4 Wave 7。**issue #2278**。

## Global Constraints

- **目标与条件闭集**：`target_kind ∈ {metric, report_panel}`；`verdict ∈ {missing, stale, threshold}`（V1 只实现前两类，`threshold` 建行时拒绝）。**不引入表达式 / 任意 SQL**。
- **判不了 ≠ 没问题**：水位读不到、查询失败、编译失败、目标不存在 ⇒ `unknown`，**不是** `missing`。`state` 保持原值，`consecutive_fail+1`。
- **只在状态跃迁时发**；`dry_run=true` ⇒ 只写 `monitor_run`，`notified=false`，**不产生任何 notify 事件**。
- **求值身份 = 创建者**（不是收件人）；创建者失活 ⇒ 自动 `enabled=false` + 通知创建者（fail-visible）。
- **收件人两道门**：创建期校验（必须在 org 内可解析）；**投递期复判**（tick 解析时剔除越权/不存在者并落审计）。
- **不重算水位**：`stale` 只读 `data.metrics.freshness_relations` + `data.load_log`（仓库库）。
- **迁移编号 053**（049 已被 `report_versions_immutable` 占用，048 有重号；本波用 053，**一次用尽**）。DDL 全部幂等（`if not exists`），部署每次全量重跑。
- **cat 口径**：`missing`/`stale` 的 cadence 下界 **300 秒**，且必须晚于上游水位刷新一档（建行时给警告，不硬拦）。
- 测试夹具：平台侧 `montest-<random>` / org `org-mon-<random>`；仓库侧 `whmon_*`；空库可绿。
- Conventional Commits；PR body `Closes #2278`。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/migrations/053_business_monitor.sql` | `data.monitor` + `data.monitor_run`（spec §5 原样 + `notified_at`） |
| `modules/data/domain/monitor-spec.ts` | 闭集校验、`MonitorRecipient`、`windowOf` / `staleThresholdOf` 纯函数 |
| `modules/data/domain/monitor-store.ts` | CRUD、到期列举、`recordRun`、`applyOutcome`、配额 |
| `modules/data/domain/monitor-eval.ts` | `evaluateMonitor`：`stale` 走水位、`missing` 走行数；失败降级 `unknown` |
| `modules/data/domain/monitor-state.ts` | 状态机与跃迁决策（纯函数） |
| `modules/data/domain/monitor-recipients.ts` | 收件人解析（dept/user → 名字，投递期复判） |
| `scripts/data-monitor-tick.mjs` | tick 脚本（薄 CLI，按 `scripts/metric-retire-job.mjs` 骨架） |
| `apps/server/src/scheduler/registry.ts` | 新 key `data.monitor_tick` |
| `modules/data/manifest.yaml` | `notifications.events` 三条 + 路由声明 + 权限码（沿用 `data:query`/`data:manage`） |
| `modules/notify/templates/builtin.ts` / `seed-builtin.ts` | 三条模板 + 派生规则（收件人 `field: to`） |
| `modules/data/routes/monitors.ts` | API：list/create/patch/runs |
| `modules/data/domain/metric-retire.ts` | 引用面补 monitor |
| `modules/data/console/reports/ReportView.tsx` + `MonitorModal.tsx` | 面板卡片「挂监控」入口 |
| `deploy/jobs.md` | tick 排班、开闸步骤、回滚 |

---

### Task 1: 迁移 053 + 存储层

**Files:** Create `modules/data/migrations/053_business_monitor.sql`、`modules/data/domain/monitor-store.ts`、`modules/data/domain/monitor-store.test.ts`。

**DDL（与 spec §5 一致，补充 `notified_at`；全部幂等）：**

```sql
create schema if not exists data;

create table if not exists data.monitor (
  id                bigserial primary key,
  org               text not null,
  name              text not null,
  target_kind       text not null check (target_kind in ('metric','report_panel')),
  metric_id         text,
  report_id         text,
  panel_index       integer,
  filters           jsonb not null default '{}'::jsonb,
  verdict           text not null check (verdict in ('missing','stale','threshold')),
  operator          text check (operator in ('gt','gte','lt','lte','eq')),
  threshold         numeric,
  window_days       integer not null default 1 check (window_days between 1 and 30),
  cadence_secs      integer not null check (cadence_secs >= 300),
  cooldown_secs     integer not null default 3600 check (cooldown_secs >= 0),
  dry_run           boolean not null default true,
  recipients        jsonb not null,
  channel_policy    text not null default 'in_app' check (channel_policy in ('in_app','wecom','webhook')),
  state             text not null default 'ok' check (state in ('ok','firing','unknown')),
  state_since       timestamptz,
  last_eval_at      timestamptz,
  notified_at       timestamptz,
  consecutive_fail  integer not null default 0,
  enabled           boolean not null default true,
  created_by        text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists monitor_due_idx on data.monitor (org, last_eval_at) where enabled;

create table if not exists data.monitor_run (
  id            bigserial primary key,
  monitor_id    bigint not null references data.monitor(id),
  org           text not null,
  evaluated_at  timestamptz not null default now(),
  verdict       text not null,
  value         numeric,
  watermark_ref text,
  state_after   text not null,
  notified      boolean not null default false,
  dry_run       boolean not null default true,
  duration_ms   integer,
  error         text
);
create index if not exists monitor_run_monitor_idx on data.monitor_run (monitor_id, evaluated_at desc);
```

**接口（`monitor-store.ts`）：**

```ts
export interface MonitorRow {
  id: string; org: string; name: string
  targetKind: 'metric' | 'report_panel'
  metricId: string | null; reportId: string | null; panelIndex: number | null
  filters: Record<string, unknown>
  verdict: 'missing' | 'stale' | 'threshold'
  windowDays: number; cadenceSecs: number; cooldownSecs: number
  dryRun: boolean; recipients: MonitorRecipient[]
  channelPolicy: 'in_app' | 'wecom' | 'webhook'
  state: 'ok' | 'firing' | 'unknown'; stateSince: Date | null
  lastEvalAt: Date | null; notifiedAt: Date | null
  consecutiveFail: number; enabled: boolean; createdBy: string
}

export function dueMonitors(pool: Pool, now: Date, limit: number): Promise<MonitorRow[]>
// enabled and (last_eval_at is null or last_eval_at <= now - cadence_secs)
export function recordRun(pool: Pool, run: MonitorRunInput): Promise<void>
export function applyOutcome(pool: Pool, m: MonitorRow, next: ApplyOutcomeInput): Promise<void>
// 单条 UPDATE 同时落 state/state_since/last_eval_at/notified_at/consecutive_fail/updated_at
export function createMonitor(pool: Pool, input: NewMonitor): Promise<{ id: string }>
export function listMonitors(pool: Pool, org: string): Promise<MonitorRow[]>
export function setMonitorEnabled(pool: Pool, org: string, id: string, enabled: boolean): Promise<boolean>
export function quotaOf(pool: Pool, org: string): Promise<{ used: number; limit: number }>
```

- `dueMonitors` 用**单条 SQL**（`order by coalesce(last_eval_at, 'epoch') limit $1`），不逐行查。
- `applyOutcome` 的 SQL 必须带 `where id=$1 and org=$2`——跨租户写入在 SQL 层禁止（spec §16.5）。
- 配额：每 org **20 条**启用监控；`createMonitor` 在同一事务内 `select count(*) ... for update` 防并发超建，超限抛 `MONITOR_QUOTA_EXCEEDED`。
- `verdict='threshold'` 在 store 层直接抛 `MONITOR_VERDICT_UNSUPPORTED`（V1）。

- [ ] 失败测试：DDL 重跑两次不报错；`dueMonitors` 只返回到期且启用的行（造 `last_eval_at=now()` 与 `now()-cadence-1s` 两行）；`applyOutcome` 跨 org 写 0 行；配额第 21 条拒绝；`threshold` 拒绝。
- [ ] RED → GREEN → 提交 `feat(data): 业务监控存储层（W7-V1）`。

---

### Task 2: 判据求值

**Files:** Create `modules/data/domain/monitor-eval.ts`、`modules/data/domain/monitor-eval.test.ts`、`modules/data/domain/monitor-spec.ts` + 测试。

**接口：**

```ts
export type MonitorOutcome =
  | { verdict: 'ok'; watermarkRef: string | null }
  | { verdict: 'missing' | 'stale'; value: number | null; watermarkRef: string | null }
  | { verdict: 'unknown'; error: string; watermarkRef: string | null }

export interface MonitorEvalDeps {
  /** 仓库只读执行器（analystPool 或测试假执行器）。 */
  wh: SqlExecutor
  /** 平台池：读指标词表。 */
  pool: Pool
  /** 面板 → 指标（report_panel 目标）：读 data.reports.spec，panel_index 取 panels[i]。 */
  resolvePanel?: (org: string, reportId: string, panelIndex: number) => Promise<{ metricId: string; args: Record<string, unknown> } | null>
  now?: () => Date
}

export async function evaluateMonitor(deps: MonitorEvalDeps, m: MonitorRow): Promise<MonitorOutcome>
export function windowOf(m: Pick<MonitorRow,'windowDays'>, now: Date): { start: string; end: string }  // YYYY-MM-DD
export function staleThresholdOf(today: string, windowDays: number): string  // today - windowDays 天
```

**求值顺序（先便宜后贵，spec §4 优先级）：**

1. 解析目标：`metric` ⇒ `m.metricId`；`report_panel` ⇒ `resolvePanel`。解析不出 ⇒ `unknown`（不是 missing）。
2. **`stale`**：`loadMergedCatalog(pool, org)` 取该 metric 的 `freshnessRelations`；为空 ⇒ 跳过 stale（该指标无水位声明）。
   有声明 ⇒ `deps.wh(watermarkSqlFor(relations))`；**表缺席 / 无行 / null ⇒ `unknown`**（spec §6：读不到水位 ≠ missing）。
   `watermark < staleThresholdOf(today, windowDays)` ⇒ `stale`。
3. **`missing`**（仅在 stale 不成立时）：`authorize(catalog, requester, metricId, args)`，`args = { bizday: windowOf(...) }` 与 `m.filters` 合并；
   执行 `select count(*)::int as n from (${plan.sql}) t`（`plan` 为授权结果；失败 ⇒ `unknown`）。`n === 0` ⇒ `missing`。
4. 其余 ⇒ `ok`。

- `requester` 用 `monitorRequester(org, m.createdBy)`（本计划新增，`hasScope: (s) => s === 'data:query'`；与 `regressionRequester` 同形，但**只授予查询码**）。
- 所有执行器异常一律 `unknown`（带 `error` 截断 500 字符），**不得**把异常当 `missing`。

- [ ] 失败测试（spec §13 前两条是核心）：
  - 水位表缺席 ⇒ `unknown`（并断言**不是** `missing`）；
  - 窗口内 0 行 ⇒ `missing`；有行且水位旧 ⇒ `stale`；有行且水位新鲜 ⇒ `ok`；
  - `plan.sql` 执行抛错 ⇒ `unknown`；
  - `report_panel` 面板不存在 / 文本面板 ⇒ `unknown`；
  - `windowOf` 边界（window_days=1 ⇒ start=end=today）。
- [ ] RED → GREEN → 提交 `feat(data): 业务监控判据求值（W7-V1）`。

---

### Task 3: 状态机与收件人解析

**Files:** Create `modules/data/domain/monitor-state.ts`、`modules/data/domain/monitor-recipients.ts` + 测试。

**状态机（纯函数）：**

```ts
export interface TransitionInput {
  prev: 'ok' | 'firing' | 'unknown'
  outcome: MonitorOutcome
  prevStateSince: Date | null
  notifiedAt: Date | null
  cooldownSecs: number
  consecutiveFail: number
  now: Date
}
export interface TransitionResult {
  state: 'ok' | 'firing' | 'unknown'
  stateSince: Date
  consecutiveFail: number
  /** 需要投递事件（跃迁 + 未在冷却期内） */
  notify: 'fired' | 'resolved' | 'disabled' | null
  /** 连续失败达到熔断阈值 ⇒ 调用方还要把 enabled 置 false */
  disable: boolean
}
export function transitionOf(i: TransitionInput): TransitionResult
export const MONITOR_FAIL_LIMIT = 5
```

- `unknown`：state **不变**（不是变成 unknown 状态——spec §6 的 `state` 保持原值），`consecutiveFail+1`；`consecutiveFail >= 5` ⇒ `disable=true, notify='disabled'`。
- `ok ⇄ firing`：仅当 verdict 与状态不一致才跃迁；跃迁后 `notifiedAt` 为空或 `now - notifiedAt >= cooldown` 才 `notify='fired'|'resolved'`，否则 `notify=null`（状态照改）。
- 同状态重复求值：`notify=null`，`stateSince` 不变。

**收件人（`monitor-recipients.ts`）：**

```ts
export interface ResolvedRecipients { to: string[]; excluded: Array<{ ref: string; reason: string }> }
export function resolveMonitorRecipients(
  pool: Pool, org: string, recipients: MonitorRecipient[],
): Promise<ResolvedRecipients>
```

- `kind='user'`：`ref` 必须出现在 `platform.org_membership`（经 `platform.tenant` 由 org 映射 tenant_id）；不在 ⇒ excluded `not_member`。
- `kind='dept'`：与通知现有部门收件人同一路径（复用 `modules/notify` 的部门解析实现，**不新造映射**）；解析为空 ⇒ excluded `no_dept_members`。
- 去重后 `to` 为空 ⇒ 调用方 `notify=null` 且 `recordRun(notified=false, error='no_recipients')`（fail-visible，不静默）。

- [ ] 失败测试：ok→firing 跃迁发一条；冷却期内再次跃迁 `notify=null` 但 state 改；firing→ok 发 resolved；unknown 不改 state、连续 5 次 `disable=true`；收件人退权 ⇒ excluded + 其余仍发；全被剔除 ⇒ 不投递且 run 留痕。
- [ ] RED → GREEN → 提交 `feat(data): 业务监控状态机与收件人解析（W7-V1）`。

---

### Task 4: tick 脚本 + registry key

**Files:** Create `scripts/data-monitor-tick.mjs` + `scripts/data-monitor-tick.test.ts`；Modify `apps/server/src/scheduler/registry.ts`、`registry.test.ts`。

**脚本契约（照 `scripts/metric-retire-job.mjs` 骨架）：**

- 缺 `DATABASE_URL` ⇒ exit 2；缺 `DATA_WAREHOUSE_URL` ⇒ `stale` 判据降级 `unknown`，**不整体失败**（打印一次警告）。
- 逐条：`evaluateMonitor` → `transitionOf` → `applyOutcome` → `recordRun`；跃迁且非 `dry_run` ⇒ `enqueueEvent`（下条 Task）。
- 单项异常只记该条 `unknown`，继续下一条；结束时退出码：全 `ok` ⇒ 0；有 `unknown`/失败 ⇒ 1；环境/用法错误 ⇒ 2（exit 2 不重试）。
- 末尾打印一行汇总：`monitor-tick: due=<n> ok=<n> firing=<n> unknown=<n> notified=<n> disabled=<n>`（**验收硬判据看这行**）。
- 写心跳：`insert into platform.job_heartbeat(key, beat_at) values ('data.monitor_tick', now()) on conflict (key) do update set beat_at=now()`（key 与 `check-probe-heartbeat` 的检查清单同步）。

**registry 条目：**

```ts
{ key: 'data.monitor_tick', script: 'scripts/data-monitor-tick.mjs', cron: '* * * * *', timezone: 'UTC',
  timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 60, description: '业务监控求值（到期规则）' }
```

- seed 照既有行为建 `enabled=false` 行（切流前不跑，见 Task 8 四步）。

- [ ] 失败测试：registry 有新 key 且 cron/expectedIntervalSecs 逐字对；脚本在缺 `DATABASE_URL` 时 exit 2；空库（0 条到期）exit 0 且汇总行全 0；注入两条 `dry_run=true` 规则（一条 0 行、一条有数）⇒ exit 1，`monitor_run` 各一行，**无 notify.event 行**。
- [ ] RED → GREEN → 提交 `feat(data): monitor tick 调度作业（W7-V1）`。

---

### Task 5: 事件声明 + 模板 + 派生规则

**Files:** Modify `modules/data/manifest.yaml`、`modules/notify/templates/builtin.ts`、`modules/notify/seed-builtin.ts` + 双侧测试。

**三条事件（`modules/data/manifest.yaml` 的 `notifications.events`）：**

```yaml
- key: data.monitor.fired
  title: 业务监控触发
  description: 指标/报表面板缺失或过期（W7-V1，spec §9）
  scope: { key: monitorId, label: 监控 }
  payload:
    to:        { type: string, required: true, label: 收件人（逗号分隔） }
    monitorId: { type: string, required: true, label: 监控 }
    name:      { type: string, required: true, label: 监控名 }
    verdict:   { type: string, required: true, label: 判据 }
    windowDays:{ type: number, required: true, label: 窗口天数 }
    watermarkRef: { type: string, required: false, label: 水位来源 }
    link:      { type: url, required: true, label: 详情链接 }
  recipients:
    watchers: { kind: field, field: 'to', label: 监控收件人 }
  defaults:
    recipient: watchers
    template: data_monitor_fired
    channels: [inapp_default]
# data.monitor.resolved / data.monitor.disabled 同形（disabled 无 windowDays）
```

- **不携带数值**：`value` 一律不进 payload（`reveal='report'` 安全，spec §3.4/§9）；文案只说「有异常，请登录查看」。
- 模板三条：`data_monitor_fired` / `data_monitor_resolved` / `data_monitor_disabled`（中文、含 `{name}` `{verdict}` `{link}`）。
- seed 计数更新：templates +3、rules +3；护栏测试（声明 ⇔ 模板 ⇔ 派生规则三处同描）沿用 `templates/builtin.test.ts` 双向断言。

- [ ] 失败测试：三条事件在 catalog 里可查；三模板存在；三条派生规则 `recipient_key='watchers'`、`channels=[inapp_default]`；payload 无 `value`/`threshold` 字段；seed 计数断言更新。
- [ ] RED → GREEN → 提交 `feat(notify): data.monitor.* 模板与派生规则（W7-V1）`。

---

### Task 6: 跃迁投递接线 + 退役引用面

**Files:** Modify `scripts/data-monitor-tick.mjs`、`modules/data/domain/metric-retire.ts` + 测试。

**投递：** tick 在 `transition.notify` 非空且 `!dry_run` 时：

```js
await enqueueEvent(pool, {
  org: m.org,
  eventId: `monitor:${m.id}:${transition.state}:${transition.stateSince.toISOString()}`,
  eventKey: transition.notify === 'fired' ? 'data.monitor.fired'
    : transition.notify === 'resolved' ? 'data.monitor.resolved' : 'data.monitor.disabled',
  scope: { monitorId: m.id },
  payload: { to: resolved.to.join(','), monitorId: m.id, name: m.name, verdict: outcome.verdict,
             windowDays: m.windowDays, watermarkRef: outcome.watermarkRef ?? null, link: `/console/data/reports` },
  producer: 'data',
})
```

- `eventId` 以「跃迁后的 state + stateSince」为键 ⇒ 同一跃迁重跑幂等（`duplicate` 视为成功）。
- `enqueueEvent` 抛错**不得**影响 `applyOutcome` 与 `monitor_run`（fail-open，AGENTS.md #12）。

**退役引用面（`metric-retire.ts` 的 `safetyFilterOf`）：** 在报表引用之后加：

```ts
// ④ 业务监控引用（Wave 7）：被监控的指标不得进下线候选
const watched = await pool.query(
  'select distinct metric_id from data.monitor where org = $1 and enabled and metric_id is not null', [org])
```

并入 `blockedIds`（或独立 Set，语义同「不算候选」）。

- [ ] 失败测试：dry_run ⇒ 0 条 event；非 dry_run 跃迁 ⇒ 1 条 event 且 payload 无 `value`；同跃迁重跑 ⇒ 仍 1 条；`enqueueEvent` 抛错被吞（run 行照写、退出码不变）；被 monitor 引用的指标不出现在 `retireEligibleOf`。
- [ ] RED → GREEN → 提交 `feat(data): monitor 跃迁投递 + 退役引用面（W7-V1）`。

---

### Task 7: API 与「挂监控」入口

**Files:** Create `modules/data/routes/monitors.ts` + 测试；Modify `modules/data/manifest.yaml`（`api.internal`）、`modules/data/index.ts`、`modules/data/console/reports/ReportView.tsx`、新增 `modules/data/console/reports/MonitorModal.tsx`。

**路由（全部走 `data:query`；改/停只允许创建者或 `data:manage`）：**

| 方法 | 路径 | 语义 |
|---|---|---|
| GET | `/monitors` | 本 org 列表（含 state / last_eval_at / dry_run） |
| POST | `/monitors` | 新建；`dry_run` 恒 true（V1 不开放建时开闸，开闸走 PATCH） |
| PATCH | `/monitors/:id` | `enabled` / `dry_run` 二选一或同改；写 `data.asset_audit`（action `monitor.toggle`） |
| GET | `/monitors/:id/runs?limit=` | 台账（上限 100） |

- 创建期校验：`target_kind='metric'` 必须有 `metricId` 且指标在本 org 词表；`report_panel` 必须有 `reportId` + `panelIndex` 且报表可见性通过既有 ACL 判定；`verdict='threshold'` ⇒ 400 `MONITOR_VERDICT_UNSUPPORTED`；`cadenceSecs < 300` ⇒ 400；收件人解析为空 ⇒ 400 `MONITOR_NO_RECIPIENTS`。
- 声明集合与 `createRouter` 逐条一致（装载期双向核对）；**不新增权限码**（V1 复用 `data:query`）。

**前端：** `renderPanel` 的普通面板卡片（`ReportView.tsx:1356` 的 `<Card ...>`）加 `extra={<Button size="small" onClick={...}>挂监控</Button>}`；KPI 卡片同样加。点击开 `MonitorModal`：名称 / 判据（missing|stale）/ 窗口天数 / 周期（≥300s）/ 收件人 / 说明「默认影子期，只记录不发送」。按 `DESIGN.md` 与 `docs/design/console-ui-conventions.md`（文本动作、空态、`scroll.x`）。

- [ ] 失败测试：四个路由的 scope 门禁（无码 403）；跨 org 404；非创建者改 403（`data:manage` 放行）；`threshold` 400；声明集合 == 注册集合；`dry_run` 不可在创建时置 false。
- [ ] 前端自验：本地起 dev-stack，打开报表页点「挂监控」，走通创建 + 列表（按 dev-discipline §1.6，自验后再交付）。
- [ ] RED → GREEN → 提交 `feat(data): 业务监控 API 与挂监控入口（W7-V1）`。

---

### Task 8: 全量验证 + PR + 切流开闸

- [ ] `pnpm -r --if-present test` / `pnpm run test:guard` / `pnpm run typecheck` / `node scripts/check-env-example.mjs` / `node scripts/check-compose.mjs` / `node scripts/check-mcp-toolface.mjs` 全绿。
- [ ] 空库复跑 `modules/data/domain/monitor-*`、`scripts/data-monitor-tick.test.ts`。
- [ ] PR `Closes #2278`；CI CLEAN 后合并、两实例部署。
- [ ] **切流四步（每实例）**：① 部署后确认 `data.monitor_tick` 排班存在且 `enabled=false`；② 数据库 `update ... set enabled=true`；③ 手动入队一次，看汇总行 `due=0` 且退出码 0；④ 建一条**真实**影子监控（选一个已知新鲜指标 + 一个已知迟到源），确认 `monitor_run` 有行、`notified=false`、无 `notify.event`。
- [ ] 心跳双路径：`check-probe-heartbeat` 的检查清单加 `data.monitor_tick`；OO 流静默规则由人确认（不在本波写码）。
- [ ] 台账：本 plan 完成入账 + 路线图 §7 追加行（含「W7-V1 已上线，影子期起始日」）。

## Self-Review

- **spec 覆盖**：§5 对象模型（原样 + `notified_at`）、§6 判据（missing/stale/unknown）、§7 状态机、§8 身份与资源、§9 投递（收件人两道门、无值文案）、§10 心跳、§11 配额与熔断、§13 九条测试、§14 五条接线（退役面、可见性、审计、模板）。
- **明确不做**：`threshold`、`no_flap`、组织级限流摘要、外发通道审批、独立 monitor 模块、OO 镜像。
- **风险**：① 面板目标要读 `data.reports.spec`，报表 ACL 变更可能让监控越权 ⇒ 投递期复判兜底；② `authorize` 需要完整 catalog，tick 每轮加载一次（200 条规则共享）；③ cadence 下界 300s 可能与上游物化节奏错位 ⇒ 建行警告 + 影子期观察；④ 迁移 053 一次用尽，后续加列走 054。
