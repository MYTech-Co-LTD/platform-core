# Wave 6 P1 · 平台内置调度器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让平台自己拥有业务定时——库内排班表 + 运行台账 + 子进程执行器 + 「该跑没跑」健康判据，首批迁入 `notify-reconcile` / `metric-candidates` / `report-scope-scan` 三个系统 job。

**Architecture:** 不新增容器。把已有的 `notify-worker`（常驻、`SKIP LOCKED`、心跳、`/healthz`）扩成**多 loop 注册表**：保留 `notify.dispatch`，新增 `platform.scheduler` loop。调度逻辑在 `apps/server/src/scheduler/`（宿主面，可单测），`scripts/notify-worker.mjs` 只做接线。任务目录在代码（registry），排班状态与运行台账在库（`platform.job_schedule` / `job_run` / `job_heartbeat`）。执行一律**子进程 + 超时 kill**，长任务不阻塞投递 loop。

**Tech Stack:** TypeScript / Hono / pg / vitest / node:child_process。**不新增任何 npm 依赖**（cron 解析自写）。

**Spec:** `docs/superpowers/specs/2026-11-14-business-scheduler-design.md`（v2）。开发地图：`docs/superpowers/plans/2026-11-11-helix-borrow-roadmap.md` §4 Wave 6。

## Global Constraints

- **只做 cron + 台账**：不引入 DAG / 依赖编排 / 回填队列 / 分布式执行（评审红线）。
- **调度器排「引擎」不排「规则」**：agent 永远不能注册 handler；本波不开放任何 agent 面。
- **系统 job 的 `params` 不生效**：`source='system'` 时行为只由代码 registry 决定，seed 强制写 `{}`。
- **执行隔离**：一律 `spawn` 子进程 + 超时 kill；**不在 HTTP 进程里跑副作用**（手动触发只入队）。
- **注入只走两条通道**：小标量走 env（`JOB_KEY` / `JOB_SCHEDULE_ID` / `JOB_OCCURRENCE` / `JOB_OWNER_ORG` / `JOB_OWNER_NAMESPACE`），`JOB_PARAMS` 走 **stdin**（≤16KB）。**argv 数组 spawn，禁 shell 拼接**。
- **`JOB_OCCURRENCE` = claim 到的那一格 bucket**（不是实际开跑时刻）；重试沿用同一 occurrence。
- **迁移编号**：宿主迁移用 `018_platform_jobs.sql`（宿主现有最大 017）；数据模块编号与本次无关。
- **时区**：`timezone` 列按 IANA 名解释；**迁入的系统 job 一律 `timezone='UTC'`**（与 openship 上现有 cron 的 UTC 语义逐字一致，避免整体挪 8 小时）；新建业务排班默认 `Asia/Shanghai`。
- **安全**：`enabled` 默认 `false`——seed 只登记不启用，切流由人显式开启。
- 测试隔离：DB 用例用独立 key 前缀 `jobtest:*`，**自建夹具、空库可绿**；本地 `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform'`。
- Conventional Commits；feat 挂 issue（本波 issue：**#2172**）。

## File Structure

| 文件 | 职责 |
|---|---|
| `apps/server/src/migrations/018_platform_jobs.sql` | 三张表 + 约束/索引（幂等） |
| `apps/server/src/scheduler/cron.ts` | cron 解析 + `nextRunAt`（纯函数，零依赖） |
| `apps/server/src/scheduler/registry.ts` | 系统 job 目录 + `seedSchedules`（幂等、不覆盖、`params={}`） |
| `apps/server/src/scheduler/store.ts` | claim（含 retry 路径）/ queued manual / recordRun / beat / reapStale / hasRunning |
| `apps/server/src/scheduler/runner.ts` | `spawn` 子进程实现 + 超时 kill + 退出码分类 |
| `apps/server/src/scheduler/loop.ts` | 一次 tick 的编排 + 并发上限 + 运行中集合 |
| `apps/server/src/scheduler/health.ts` | 三判据（心跳 / 超期未成功 / 连续失败） |
| `apps/server/src/routes/platform-jobs.ts` | `POST /api/platform/jobs/:key/run`（入队 + 审计） |
| `scripts/notify-worker.mjs` | 接线：每 `SCHEDULER_TICK_MS` 跑一次 tick；healthz 合并调度健康 |
| `deploy/docker-compose.yml` / `.env.example` | `SCHEDULER_*` 四个键 |
| `deploy/jobs.md` | 调度器运维口径 + 切流程序 |
| `docs/architecture.md` | §2.11 正典改写 + 新不变量 |

---

### Task 1: 正典与运维文档先行（先改文档，再写码）

**Files:**
- Modify: `docs/architecture.md:497-503`（定时载体条文）
- Modify: `deploy/notify-jobs.md:7`、`deploy/org-sync-job.md:4-5`、`deploy/metric-candidates-job.md:5-6`、`deploy/metric-retire-job.md:7-8`、`deploy/report-scope-scan-job.md:7-8`
- Create: `deploy/jobs.md`

**Interfaces:**
- Produces: 后续任务引用 `deploy/jobs.md` 作为运维口径唯一入口。

- [ ] **Step 1: 改写 `docs/architecture.md` §2.11 的定时载体条文**

把「定时载体 = openship job（零常驻）」拆成两条线，并在同节追加三条不变量。改完该节应能回答：基建定时在哪、业务定时在哪、为什么应用 HTTP 进程仍然不跑副作用。

```markdown
**定时载体（2026-11-14 修订）分为两条线：**

- **基建定时 = openship job**：主机指标、探活看门狗、备份、证书类。判据：失败意味着「机器/进程/证书状态异常」。
- **业务定时 = worker 的 `platform.scheduler` loop**：在 `notify-worker` 容器内（同镜像、多 loop 注册表），
  任务目录在代码（`apps/server/src/scheduler/registry.ts`），排班与运行台账在库
  （`platform.job_schedule` / `platform.job_run`），执行一律子进程 + 超时。
  判据：失败意味着「业务数据/业务动作没发生」。

**不变量**：① 调度器只排「引擎」不排「规则」（agent 只能排已注册 key）；② 只做 cron + 台账，
不做 DAG / 依赖编排 / 回填队列；③ `source='system'` 时 `params` 不生效——行为只由代码 registry 决定。

**HTTP 进程仍然不跑定时副作用**：宿主 `apps/server` 不装任何 interval；手动触发端点只**入队**，
执行发生在 worker 进程。
```

- [ ] **Step 2: 改写五处「应用进程不跑定时副作用」的结论句**

每处保留理由（反对把副作用藏进 **HTTP 进程**），把结论改成「归 worker 的调度 loop，不归 HTTP 进程」。五个文件各改一处，措辞统一为：

```markdown
> 调度归属（2026-11-14 起）：本脚本由 worker 的 `platform.scheduler` loop 按库内排班执行，
> 不再由 openship job 驱动。**仍然不要**把这段逻辑塞进 HTTP 请求路径——执行在 worker 的子进程里。
```

- [ ] **Step 3: 新建 `deploy/jobs.md`（只写口径与程序，不写实现）**

内容必须包含：两条线的划分判据、`platform.job_schedule` / `job_run` 的字段语义、`JOB_PARAMS` 走 stdin 的契约、`JOB_OCCURRENCE` 是 claim bucket、切流四步（登记 `enabled=false` → 手动跑一次比对 → 关 openship → DB 置 `enabled=true`）、回滚（`SCHEDULER_ENABLED=0` + 反向切流）、以及「零候选/无运行是正常还是异常」的判读。

- [ ] **Step 4: 跑文档门禁**

Run: `node scripts/check-env-example.mjs 2>/dev/null; pnpm run test:guard`
Expected: PASS（本步只改 md，门禁不应因文档而红；若有 docs 引用检查，按提示修）

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md deploy/*.md
git commit -m "docs(data): 正典改写——业务定时归 worker 的 scheduler loop（Wave 6 P1）"
```

---

### Task 2: 迁移 018（三张表）

**Files:**
- Create: `apps/server/src/migrations/018_platform_jobs.sql`
- Test: `apps/server/src/scheduler/migrate.test.ts`

**Interfaces:**
- Produces: 表 `platform.job_schedule(id, key, cron, timezone, params, owner_org, owner_namespace, source, created_by, enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs, retry_at, retry_attempt, updated_at)`、`platform.job_run(id, schedule_id, key, occurrence, owner_org, owner_namespace, params_snapshot, trigger, status, attempt, started_at, finished_at, exit_code, duration_ms, output_tail, error)`、`platform.job_heartbeat(id, beat_at)`。

- [ ] **Step 1: 写迁移 SQL**

```sql
-- 018_platform_jobs.sql — 平台内置调度器的排班、运行台账与心跳（Wave 6 P1）
-- spec: docs/superpowers/specs/2026-11-14-business-scheduler-design.md §7
-- 两处实现细节（spec 未写、实现需要）：
--   · retry_at / retry_attempt：重试不改动 cadence（重试与下一格是两件事）
--   · job_run.status 增加 'queued'：手动触发只入队，执行发生在 worker 进程
-- 幂等：全部 if not exists。
create table if not exists platform.job_schedule (
  id                     bigserial primary key,
  key                    text not null,
  cron                   text not null,
  timezone               text not null default 'Asia/Shanghai',
  params                 jsonb not null default '{}'::jsonb,
  owner_org              text,
  owner_namespace        text,
  source                 text not null default 'system' check (source in ('system','agent')),
  created_by             text,
  enabled                boolean not null default false,
  next_run_at            timestamptz,
  timeout_ms             integer not null default 300000,
  max_attempts           integer not null default 1,
  expected_interval_secs integer not null,
  retry_at               timestamptz,
  retry_attempt          integer not null default 0,
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
  occurrence      timestamptz not null,
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
  output_tail     text,
  error           text
);
create index if not exists job_run_schedule_started_idx
  on platform.job_run (schedule_id, started_at desc);
create index if not exists job_run_queued_idx
  on platform.job_run (id) where status = 'queued';

create table if not exists platform.job_heartbeat (
  id      text primary key,
  beat_at timestamptz not null
);
```

- [ ] **Step 2: 写失败测试（空库可绿 + 幂等）**

```ts
// apps/server/src/scheduler/migrate.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

describePg('018_platform_jobs', () => {
  let pool: Pool
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
  })
  afterAll(async () => { await pool.end() })

  it('幂等：连跑两次不报错', async () => {
    await runMigrations(pool, 'platform', dir)
    await runMigrations(pool, 'platform', dir)
    const { rows } = await pool.query(
      "select count(*)::int as n from information_schema.tables where table_schema='platform' and table_name in ('job_schedule','job_run','job_heartbeat')")
    expect(rows[0].n).toBe(3)
  })

  it('系统 job 一 key 一条：部分唯一索引生效', async () => {
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    await pool.query(
      "insert into platform.job_schedule(key,cron,source,enabled,expected_interval_secs) values ('jobtest:uq','* * * * *','system',false,60)")
    await expect(pool.query(
      "insert into platform.job_schedule(key,cron,source,enabled,expected_interval_secs) values ('jobtest:uq','* * * * *','system',false,60)",
    )).rejects.toThrow(/uq_job_schedule_system_key/)
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
  })

  it('status/trigger 闭集：非法值被拒', async () => {
    await expect(pool.query(
      "insert into platform.job_run(schedule_id,key,occurrence,trigger,status) values (1,'jobtest:x',now(),'nope','ok')",
    )).rejects.toThrow()
  })
})
```

- [ ] **Step 3: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/migrate.test.ts`
Expected: 若无 `DATABASE_URL` 则 skip；有则 3 passed。

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/migrations/018_platform_jobs.sql apps/server/src/scheduler/migrate.test.ts
git commit -m "feat(data): 迁移 018——调度排班/运行台账/心跳（Wave 6 P1）"
```

---

### Task 3: cron 解析与下一次触发（纯函数）

**Files:**
- Create: `apps/server/src/scheduler/cron.ts`
- Test: `apps/server/src/scheduler/cron.test.ts`

**Interfaces:**
- Produces:
  - `parseCron(expr: string): CronSpec`（不支持的语法**抛错**，fail-closed）
  - `isValidCron(expr: string): boolean`
  - `nextRunAt(expr: string, timezone: string, from: Date): Date`（严格晚于 `from`）

- [ ] **Step 1: 写失败测试（真值表）**

```ts
// apps/server/src/scheduler/cron.test.ts
import { describe, expect, it } from 'vitest'
import { isValidCron, nextRunAt, parseCron } from './cron'

const at = (iso: string) => new Date(iso)

describe('parseCron', () => {
  it('支持 * , - / 与数字；周几 0 与 7 都是周日', () => {
    expect(parseCron('*/15 * * * *').minutes).toEqual([0, 15, 30, 45])
    expect(parseCron('1-3 * * * *').minutes).toEqual([1, 2, 3])
    expect(parseCron('1,5,9 * * * *').minutes).toEqual([1, 5, 9])
    expect(parseCron('0 0 * * 7').daysOfWeek).toEqual([0])
    expect(parseCron('0 0 * * 0').daysOfWeek).toEqual([0])
  })

  it('★ 不支持的语法直接抛错（不许静默按错时间跑）', () => {
    for (const bad of ['0 0 * * MON', '0 0 L * *', '@daily', '0 0 * * * *', '60 * * * *', '0 0 32 * *']) {
      expect(() => parseCron(bad)).toThrow()
      expect(isValidCron(bad)).toBe(false)
    }
  })
})

describe('nextRunAt（Asia/Shanghai，无 DST）', () => {
  it('每小时第 7 分：从 10:07:30 起跳到 11:07', () => {
    expect(nextRunAt('7 * * * *', 'Asia/Shanghai', at('2026-11-14T02:07:30Z')).toISOString())
      .toBe('2026-11-14T03:07:00.000Z') // 11:07 +08:00
  })

  it('每日 03:43（沪）：跨日', () => {
    expect(nextRunAt('43 3 * * *', 'Asia/Shanghai', at('2026-11-14T05:31:00Z')).toISOString())
      .toBe('2026-11-14T19:43:00.000Z') // 次日 03:43 +08:00
  })

  it('UTC 口径（迁入的系统 job 用这个）', () => {
    expect(nextRunAt('43 3 * * *', 'UTC', at('2026-11-14T05:31:00Z')).toISOString())
      .toBe('2026-11-15T03:43:00.000Z')
  })

  it('跨月：每月 1 日 01:00（沪）', () => {
    expect(nextRunAt('0 1 1 * *', 'Asia/Shanghai', at('2026-11-14T00:00:00Z')).toISOString())
      .toBe('2026-11-30T17:00:00.000Z')
  })

  it('★ 严格晚于 from：恰好命中当前分钟时跳到下一次', () => {
    expect(nextRunAt('7 * * * *', 'UTC', at('2026-11-14T02:07:00Z')).toISOString())
      .toBe('2026-11-14T03:07:00.000Z')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/cron.test.ts`
Expected: FAIL（`Cannot find module './cron'`）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/scheduler/cron.ts — cron 解析与下一次触发（纯函数、零依赖）。
//
// 只支持 * , - / 与数字；不支持的语法**抛错**（seed 期即拒绝，绝不静默按错时间跑）。
// 周几：0 与 7 都是周日。DOM/DOW 采用标准 cron 语义：两个字段都被限制时取「或」，否则取「与」。
// 时区：按 IANA 名用 Intl 求偏移；目标时区无 DST 时（如 Asia/Shanghai）结果稳定。
export interface CronSpec {
  minutes: number[]
  hours: number[]
  daysOfMonth: number[]
  months: number[]
  daysOfWeek: number[]
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS: Array<{ name: string; min: number; max: number }> = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
]

function parseField(raw: string, min: number, max: number): number[] {
  const out = new Set<number>()
  for (const part of raw.split(',')) {
    if (part === '') throw new Error(`cron: 空字段片段 "${raw}"`)
    const [rangeRaw, stepRaw] = part.split('/')
    let step = 1
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) throw new Error(`cron: 非法步长 "${part}"`)
      step = Number(stepRaw)
      if (step <= 0) throw new Error(`cron: 步长必须为正 "${part}"`)
    }
    let lo: number
    let hi: number
    if (rangeRaw === '*') {
      lo = min; hi = max
    } else if (/^\d+$/.test(rangeRaw)) {
      lo = Number(rangeRaw); hi = stepRaw === undefined ? lo : max
    } else if (/^\d+-\d+$/.test(rangeRaw)) {
      const [a, b] = rangeRaw.split('-').map(Number)
      lo = a; hi = b
    } else {
      throw new Error(`cron: 不支持的语法 "${part}"（只支持 * , - / 与数字）`)
    }
    if (lo < min || hi > max || lo > hi) throw new Error(`cron: 越界 "${part}"（允许 ${min}-${max}）`)
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return [...out].sort((a, b) => a - b)
}

export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) throw new Error(`cron: 需要 5 个字段，得到 ${parts.length} 个`)
  const [mi, ho, dom, mo, dow] = parts
  const spec: CronSpec = {
    minutes: parseField(mi, FIELDS[0].min, FIELDS[0].max),
    hours: parseField(ho, FIELDS[1].min, FIELDS[1].max),
    daysOfMonth: parseField(dom, FIELDS[2].min, FIELDS[2].max),
    months: parseField(mo, FIELDS[3].min, FIELDS[3].max),
    daysOfWeek: parseField(dow, FIELDS[4].min, FIELDS[4].max).map((d) => (d === 7 ? 0 : d)),
    domRestricted: dom !== '*',
    dowRestricted: dow !== '*',
  }
  spec.daysOfWeek = [...new Set(spec.daysOfWeek)].sort((a, b) => a - b)
  return spec
}

export function isValidCron(expr: string): boolean {
  try { parseCron(expr); return true } catch { return false }
}

const fmt = new Map<string, Intl.DateTimeFormat>()
function partsIn(instant: Date, timeZone: string): { y: number; mo: number; d: number; h: number; mi: number } {
  let f = fmt.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    fmt.set(timeZone, f)
  }
  const p: Record<string, string> = {}
  for (const { type, value } of f.formatToParts(instant)) p[type] = value
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute }
}

function offsetMs(instantMs: number, timeZone: string): number {
  const p = partsIn(new Date(instantMs), timeZone)
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - instantMs
}

/** 把「时区里的墙钟时间」换成 UTC instant（无 DST 时区一次收敛；有 DST 时二次校正）。 */
function zonedToInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const off1 = offsetMs(guess, timeZone)
  const t1 = guess - off1
  const off2 = offsetMs(t1, timeZone)
  return off2 === off1 ? t1 : guess - off2
}

function dowOf(y: number, mo: number, d: number): number {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

export function nextRunAt(expr: string, timeZone: string, from: Date): Date {
  const spec = parseCron(expr)
  const base = partsIn(from, timeZone)
  // 从「当前分钟的下一个分钟」开始逐日扫描；最多看 5 年（覆盖 2 月 30 日这类永不到来的组合）。
  let y = base.y, mo = base.mo, d = base.d
  for (let day = 0; day < 366 * 5; day++) {
    const dim = new Date(Date.UTC(y, mo, 0)).getUTCDate()
    const dow = dowOf(y, mo, d)
    const domOk = spec.daysOfMonth.includes(d)
    const dowOk = spec.daysOfWeek.includes(dow)
    const dayOk = spec.domRestricted && spec.dowRestricted ? (domOk || dowOk) : (domOk && dowOk)
    if (spec.months.includes(mo) && dayOk) {
      for (const h of spec.hours) {
        for (const mi of spec.minutes) {
          const t = zonedToInstant(y, mo, d, h, mi, timeZone)
          if (t > from.getTime()) return new Date(t)
        }
      }
    }
    d += 1
    if (d > dim) { d = 1; mo += 1; if (mo > 12) { mo = 1; y += 1 } }
  }
  throw new Error(`cron: 5 年内没有下一次触发（${expr} @ ${timeZone}）`)
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/cron.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler/cron.ts apps/server/src/scheduler/cron.test.ts
git commit -m "feat(data): cron 解析与下一次触发（Wave 6 P1）"
```

---

### Task 4: 任务目录与 seed

**Files:**
- Create: `apps/server/src/scheduler/registry.ts`
- Test: `apps/server/src/scheduler/registry.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `nextRunAt`、`isValidCron`
- Produces:
  - `export interface JobDef { key: string; script: string; cron: string; timezone: string; timeoutMs: number; maxAttempts: number; expectedIntervalSecs: number; description: string }`
  - `export const JOB_REGISTRY: JobDef[]`
  - `export async function seedSchedules(pool: Pool, registry?: JobDef[]): Promise<{ inserted: string[]; filled: string[] }>`

- [ ] **Step 1: 写失败测试（幂等、不覆盖人改、params 恒空）**

```ts
// apps/server/src/scheduler/registry.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { seedSchedules, type JobDef } from './registry'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

const defs: JobDef[] = [
  { key: 'jobtest:alpha', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 1000, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't' },
]

describePg('seedSchedules', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest:%'"); await pool.end() })

  it('首次插入：enabled=false 且 next_run_at 为空（登记不跑）', async () => {
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    const r = await seedSchedules(pool, defs)
    expect(r.inserted).toContain('jobtest:alpha')
    const { rows } = await pool.query("select enabled, next_run_at, params, source from platform.job_schedule where key='jobtest:alpha'")
    expect(rows[0].enabled).toBe(false)
    expect(rows[0].next_run_at).toBeNull()
    expect(rows[0].params).toEqual({})
    expect(rows[0].source).toBe('system')
  })

  it('★ 二次 seed 不覆盖人改过的 cron / enabled', async () => {
    await pool.query("update platform.job_schedule set cron='*/5 * * * *', enabled=true where key='jobtest:alpha'")
    await seedSchedules(pool, defs)
    const { rows } = await pool.query("select cron, enabled from platform.job_schedule where key='jobtest:alpha'")
    expect(rows[0].cron).toBe('*/5 * * * *')
    expect(rows[0].enabled).toBe(true)
  })

  it('★ 已启用但 next_run_at 为空 ⇒ 补算（不立即跑）', async () => {
    await pool.query("update platform.job_schedule set next_run_at=null where key='jobtest:alpha'")
    const r = await seedSchedules(pool, defs)
    expect(r.filled).toContain('jobtest:alpha')
    const { rows } = await pool.query("select next_run_at from platform.job_schedule where key='jobtest:alpha'")
    expect(new Date(rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('★ 非法 cron 在 seed 期炸（fail-closed）', async () => {
    await expect(seedSchedules(pool, [{ ...defs[0], key: 'jobtest:bad', cron: '0 0 * * MON' }]))
      .rejects.toThrow(/cron/)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/registry.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/scheduler/registry.ts — 系统 job 目录（代码）与幂等 seed。
//
// 目录在代码：新增 job 必须发版、经评审；排班状态在库：改时间/开关不用发版。
// seed 三条语义：① 只补新增 key，**不覆盖**人改过的 cron/enabled；
// ② `params` 恒 `{}`（source='system' 时 params 不生效，见 spec §3.6）；
// ③ enabled 行缺 next_run_at 时补算（补算 ≠ 立即执行）。
import type { Pool } from 'pg'
import { isValidCron, nextRunAt } from './cron'

export interface JobDef {
  key: string
  script: string
  cron: string
  timezone: string
  timeoutMs: number
  maxAttempts: number
  expectedIntervalSecs: number
  description: string
}

/** P1 首迁三个系统 job。时区一律 UTC——与 openship 上现有 cron 的 UTC 语义逐字一致。 */
export const JOB_REGISTRY: JobDef[] = [
  { key: 'notify.reconcile', script: 'scripts/notify-reconcile.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 3600, description: '通知指派与催办对账' },
  { key: 'metric.candidates', script: 'scripts/metric-candidates-job.mjs', cron: '40 6 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '指标候选池生成' },
  { key: 'report.scope_scan', script: 'scripts/report-scope-scan.mjs', cron: '37 1 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '报表受众 × 指标可见性巡检' },
]

export async function seedSchedules(
  pool: Pool,
  registry: JobDef[] = JOB_REGISTRY,
  now: Date = new Date(),
): Promise<{ inserted: string[]; filled: string[] }> {
  for (const d of registry) {
    if (!isValidCron(d.cron)) throw new Error(`registry: ${d.key} 的 cron 非法（${d.cron}）`)
    if (!d.script.startsWith('scripts/')) throw new Error(`registry: ${d.key} 的 script 必须在 scripts/ 下`)
  }
  const inserted: string[] = []
  for (const d of registry) {
    const { rowCount } = await pool.query(
      `insert into platform.job_schedule
         (key, cron, timezone, params, source, enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs)
       values ($1,$2,$3,'{}'::jsonb,'system',false,null,$4,$5,$6)
       on conflict (key) where source = 'system' do nothing`,
      [d.key, d.cron, d.timezone, d.timeoutMs, d.maxAttempts, d.expectedIntervalSecs],
    )
    if ((rowCount ?? 0) > 0) inserted.push(d.key)
  }
  const filled: string[] = []
  const { rows } = await pool.query(
    `select id, key, cron, timezone from platform.job_schedule
      where source='system' and enabled and next_run_at is null`,
  )
  for (const r of rows) {
    await pool.query('update platform.job_schedule set next_run_at=$2, updated_at=now() where id=$1 and next_run_at is null',
      [r.id, nextRunAt(String(r.cron), String(r.timezone), now)])
    filled.push(String(r.key))
  }
  return { inserted, filled }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/registry.test.ts`
Expected: PASS（4 个用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler/registry.ts apps/server/src/scheduler/registry.test.ts
git commit -m "feat(data): 调度任务目录与幂等 seed（Wave 6 P1）"
```

---

### Task 5: store（claim / retry / 台账 / 心跳 / 僵尸回收）

**Files:**
- Create: `apps/server/src/scheduler/store.ts`
- Test: `apps/server/src/scheduler/store.test.ts`

**Interfaces:**
- Consumes: Task 3 `nextRunAt`、Task 2 表结构
- Produces:
  - `export interface ClaimedJob { scheduleId: number; key: string; occurrence: Date; attempt: number; params: Record<string, unknown>; timeoutMs: number; maxAttempts: number; isRetry: boolean; ownerOrg: string | null; ownerNamespace: string | null }`
  - `claimDue(pool, limit, now, next: (cron, tz, from) => Date): Promise<ClaimedJob[]>`
  - `claimQueuedManual(pool, limit, now): Promise<ClaimedJob[]>`
  - `recordRun(pool, job, outcome): Promise<number>`（返回 runId）
  - `scheduleRetry(pool, scheduleId, occurrence, nextAttempt, now): Promise<void>`
  - `clearRetry(pool, scheduleId): Promise<void>`
  - `hasRunning(pool, scheduleId): Promise<boolean>`
  - `reapStale(pool, now): Promise<number>`
  - `beat(pool, now, id?): Promise<void>`

- [ ] **Step 1: 写失败测试（抢单唯一、retry 不改 cadence、僵尸回收）**

```ts
// apps/server/src/scheduler/store.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { nextRunAt } from './cron'
import { beat, claimDue, claimQueuedManual, clearRetry, hasRunning, reapStale, recordRun, scheduleRetry } from './store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

async function mkSchedule(pool: Pool, key: string, over: Record<string, unknown> = {}) {
  await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
  const { rows } = await pool.query(
    `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
     values ($1,$2,'UTC','system',true,$3,$4,$5,$6) returning id`,
    [key, over.cron ?? '7 * * * *', over.nextRunAt ?? new Date(Date.now() - 60_000), over.timeoutMs ?? 5000, over.maxAttempts ?? 2, over.expectedIntervalSecs ?? 3600],
  )
  return Number(rows[0].id)
}

describePg('scheduler store', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest:%'"); await pool.end() })

  it('到期 job 被 claim，且 next_run_at 前推', async () => {
    const id = await mkSchedule(pool, 'jobtest:claim')
    const jobs = await claimDue(pool, 5, new Date(), nextRunAt)
    const j = jobs.find((x) => x.scheduleId === id)!
    expect(j.key).toBe('jobtest:claim')
    expect(j.attempt).toBe(1)
    const { rows } = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    expect(new Date(rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('★ 同一 job 不会被第二次 claim（并发安全）', async () => {
    const id = await mkSchedule(pool, 'jobtest:once')
    await claimDue(pool, 5, new Date(), nextRunAt)
    const again = await claimDue(pool, 5, new Date(), nextRunAt)
    expect(again.some((x) => x.scheduleId === id)).toBe(false)
  })

  it('★ retry 路径：不改 next_run_at，attempt 递增', async () => {
    const id = await mkSchedule(pool, 'jobtest:retry')
    const [j] = (await claimDue(pool, 5, new Date(), nextRunAt)).filter((x) => x.scheduleId === id)
    const before = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    await recordRun(pool, j, { status: 'failed', exitCode: 1, durationMs: 10, outputTail: '', error: 'boom' })
    await scheduleRetry(pool, id, j.occurrence, 1, new Date(Date.now() - 1000))
    const retries = await claimDue(pool, 5, new Date(), nextRunAt)
    const r = retries.find((x) => x.scheduleId === id)!
    expect(r.isRetry).toBe(true)
    expect(r.attempt).toBe(2)
    expect(r.occurrence.toISOString()).toBe(j.occurrence.toISOString())
    const after = await pool.query('select next_run_at from platform.job_schedule where id=$1', [id])
    expect(after.rows[0].next_run_at.toISOString()).toBe(before.rows[0].next_run_at.toISOString())
    await clearRetry(pool, id)
  })

  it('★ 僵尸 running 被回收成 timeout', async () => {
    const id = await mkSchedule(pool, 'jobtest:zombie', { timeoutMs: 1000 })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status,started_at)
       values ($1,'jobtest:zombie',now(),'schedule','running', now() - interval '1 hour')`, [id])
    expect(await reapStale(pool, new Date())).toBeGreaterThanOrEqual(1)
    const { rows } = await pool.query("select status from platform.job_run where schedule_id=$1", [id])
    expect(rows[0].status).toBe('timeout')
  })

  it('手动入队：只有 queued 行能被 claim，且带 trigger=manual', async () => {
    const id = await mkSchedule(pool, 'jobtest:manual', { nextRunAt: new Date(Date.now() + 86_400_000) })
    await pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status) values ($1,'jobtest:manual',now(),'manual','queued')`, [id])
    const jobs = await claimQueuedManual(pool, 5, new Date())
    const j = jobs.find((x) => x.scheduleId === id)!
    expect(j.occurrence).toBeInstanceOf(Date)
    expect(await hasRunning(pool, id)).toBe(true)
  })

  it('心跳 upsert：同 id 只一行', async () => {
    await beat(pool, new Date(), 'jobtest')
    await beat(pool, new Date(), 'jobtest')
    const { rows } = await pool.query("select count(*)::int as n from platform.job_heartbeat where id='jobtest'")
    expect(rows[0].n).toBe(1)
    await pool.query("delete from platform.job_heartbeat where id='jobtest'")
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/scheduler/store.ts — 排班与台账的 SQL 面（无业务判断，判断在 loop/健康里）。
//
// claim 为什么是「事务内 SELECT … FOR UPDATE SKIP LOCKED + 逐行 JS 计算 + UPDATE + COMMIT」：
//   next_run_at 的下一次值必须用 cron 解析算（SQL 算不了），所以不能像伪代码那样一条 update 搞定；
//   但**锁必须覆盖「读到期行 → 算出下一次 → 写回」这段**，否则两个副本会 claim 到同一格。
//   计算是纯 JS、微秒级，事务内做安全；spawn 一律在 COMMIT 之后。
import type { Pool } from 'pg'

export interface ClaimedJob {
  scheduleId: number
  key: string
  occurrence: Date
  attempt: number
  params: Record<string, unknown>
  timeoutMs: number
  maxAttempts: number
  isRetry: boolean
  ownerOrg: string | null
  ownerNamespace: string | null
}

export interface RunOutcome {
  status: 'ok' | 'failed' | 'timeout' | 'skipped'
  exitCode?: number | null
  durationMs?: number
  outputTail?: string
  error?: string
}

type NextFn = (cron: string, timezone: string, from: Date) => Date

interface Row {
  id: string; key: string; cron: string; timezone: string; params: unknown
  timeout_ms: number; max_attempts: number; expected_interval_secs: number
  next_run_at: Date | null; retry_at: Date | null; retry_attempt: number
  owner_org: string | null; owner_namespace: string | null
}

const SELECT_COLS = `id,key,cron,timezone,params,timeout_ms,max_attempts,expected_interval_secs,
  next_run_at,retry_at,retry_attempt,owner_org,owner_namespace`

export async function claimDue(pool: Pool, limit: number, now: Date, next: NextFn): Promise<ClaimedJob[]> {
  const client = await pool.connect()
  const out: ClaimedJob[] = []
  try {
    await client.query('begin')
    const { rows } = await client.query<Row>(
      `select ${SELECT_COLS} from platform.job_schedule
        where enabled and (
          (retry_at is not null and retry_at <= $2)
          or (retry_at is null and next_run_at is not null and next_run_at <= $2))
        order by coalesce(retry_at, next_run_at)
        limit $1
        for update skip locked`, [limit, now])
    for (const r of rows) {
      if (r.retry_at) {
        // 重试：沿用原 occurrence（从最近一次失败 run 取），**不动 next_run_at**。
        const occ = await client.query(
          `select occurrence from platform.job_run where schedule_id=$1 order by started_at desc limit 1`, [r.id])
        const attempt = r.retry_attempt + 1
        await client.query('update platform.job_schedule set retry_attempt=$2, updated_at=now() where id=$1', [r.id, attempt])
        out.push({
          scheduleId: Number(r.id), key: r.key, occurrence: new Date(occ.rows[0].occurrence),
          attempt, params: (r.params ?? {}) as Record<string, unknown>,
          timeoutMs: r.timeout_ms, maxAttempts: r.max_attempts, isRetry: true,
          ownerOrg: r.owner_org, ownerNamespace: r.owner_namespace,
        })
      } else {
        const occurrence = r.next_run_at as Date
        const from = occurrence.getTime() > now.getTime() ? occurrence : now
        const nextAt = next(r.cron, r.timezone, from)
        await client.query(
          'update platform.job_schedule set next_run_at=$2, retry_at=null, retry_attempt=0, updated_at=now() where id=$1',
          [r.id, nextAt])
        out.push({
          scheduleId: Number(r.id), key: r.key, occurrence, attempt: 1,
          params: (r.params ?? {}) as Record<string, unknown>,
          timeoutMs: r.timeout_ms, maxAttempts: r.max_attempts, isRetry: false,
          ownerOrg: r.owner_org, ownerNamespace: r.owner_namespace,
        })
      }
    }
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 手动触发只入队（trigger='manual'）；执行仍在 worker 进程。 */
export async function claimQueuedManual(pool: Pool, limit: number, now: Date): Promise<ClaimedJob[]> {
  const client = await pool.connect()
  const out: ClaimedJob[] = []
  try {
    await client.query('begin')
    const { rows } = await client.query<Row & { occurrence: Date }>(
      `select r.id as run_id, ${SELECT_COLS.split(',').map((c) => 's.' + c.trim()).join(',')}, r.occurrence
         from platform.job_run r join platform.job_schedule s on s.id = r.schedule_id
        where r.status='queued' and s.enabled and s.retry_at is null
        order by r.id limit $1 for update of r skip locked`, [limit])
    for (const r of rows as Array<Row & { occurrence: Date; run_id: string }>) {
      await client.query(
        `update platform.job_run set status='running', started_at=$2, attempt=1 where id=$1`, [r.run_id, now])
      out.push({
        scheduleId: Number(r.id), key: r.key, occurrence: new Date(r.occurrence), attempt: 1,
        params: (r.params ?? {}) as Record<string, unknown>,
        timeoutMs: r.timeout_ms, maxAttempts: 1, isRetry: false,
        ownerOrg: r.owner_org, ownerNamespace: r.owner_namespace,
      })
    }
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 手动行已由 claimQueuedManual 建好，这里只补 outcome（不新建行）。 */
export async function recordRun(pool: Pool, job: ClaimedJob, o: RunOutcome): Promise<number> {
  const { rows } = await pool.query(
    `insert into platform.job_run
       (schedule_id,key,occurrence,owner_org,owner_namespace,params_snapshot,trigger,status,attempt,
        started_at,finished_at,exit_code,duration_ms,output_tail,error)
     values ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9, now(), now(), $10,$11,$12,$13) returning id`,
    [job.scheduleId, job.key, job.occurrence, job.ownerOrg, job.ownerNamespace,
      JSON.stringify(job.params ?? {}), 'schedule',
      o.status, job.attempt, o.exitCode ?? null, o.durationMs ?? null, o.outputTail ?? null, o.error ?? null],
  )
  return Number(rows[0].id)
}

/** 手动触发的运行结束后回填（不新建行）。 */
export async function finishRun(pool: Pool, runId: number, o: RunOutcome): Promise<void> {
  await pool.query(
    `update platform.job_run set status=$2, finished_at=now(), exit_code=$3, duration_ms=$4, output_tail=$5, error=$6 where id=$1`,
    [runId, o.status, o.exitCode ?? null, o.durationMs ?? null, o.outputTail ?? null, o.error ?? null])
}

export async function scheduleRetry(pool: Pool, scheduleId: number, _occurrence: Date, attempt: number, at: Date): Promise<void> {
  await pool.query('update platform.job_schedule set retry_at=$2, retry_attempt=$3, updated_at=now() where id=$1',
    [scheduleId, at, attempt])
}

export async function clearRetry(pool: Pool, scheduleId: number): Promise<void> {
  await pool.query('update platform.job_schedule set retry_at=null, retry_attempt=0, updated_at=now() where id=$1', [scheduleId])
}

export async function hasRunning(pool: Pool, scheduleId: number): Promise<boolean> {
  const { rows } = await pool.query(
    "select 1 from platform.job_run where schedule_id=$1 and status='running' limit 1", [scheduleId])
  return rows.length > 0
}

export async function reapStale(pool: Pool, now: Date): Promise<number> {
  const { rowCount } = await pool.query(
    `update platform.job_run r set status='timeout', finished_at=$1, error='stale running reaped'
       from platform.job_schedule s
      where r.schedule_id = s.id and r.status='running'
        and r.started_at < $1::timestamptz - make_interval(secs => 2 * s.timeout_ms / 1000)`, [now])
  return rowCount ?? 0
}

export async function beat(pool: Pool, now: Date, id = 'scheduler'): Promise<void> {
  await pool.query(
    `insert into platform.job_heartbeat(id, beat_at) values ($1,$2)
     on conflict (id) do update set beat_at = excluded.beat_at`, [id, now])
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/store.test.ts`
Expected: PASS（7 个用例）。若 `recordRun` 的手动分支需要 runId 回填，按 Step 3 的 `finishRun` 在 loop 里用；测试里只验手动 claim 与 running 判定。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler/store.ts apps/server/src/scheduler/store.test.ts
git commit -m "feat(data): 调度 store——claim/retry/台账/心跳/僵尸回收（Wave 6 P1）"
```

---

### Task 6: 子进程执行器（超时 kill + 退出码分类）

**Files:**
- Create: `apps/server/src/scheduler/runner.ts`
- Test: `apps/server/src/scheduler/runner.test.ts`

**Interfaces:**
- Consumes: Task 5 `ClaimedJob`、`RunOutcome`
- Produces:
  - `export interface SpawnOpts { command: string; args: string[]; env: NodeJS.ProcessEnv; stdin: string; timeoutMs: number; cwd: string }`
  - `export interface SpawnResult { code: number | null; signal: string | null; timedOut: boolean; outputTail: string; durationMs: number }`
  - `export type SpawnFn = (o: SpawnOpts) => Promise<SpawnResult>`
  - `export const defaultSpawn: SpawnFn`
  - `export function envFor(job: ClaimedJob): NodeJS.ProcessEnv`
  - `export function classify(r: SpawnResult): RunOutcome & { retryable: boolean }`

- [ ] **Step 1: 写失败测试（注入假 spawn，钉注入契约与分类）**

```ts
// apps/server/src/scheduler/runner.test.ts
import { describe, expect, it } from 'vitest'
import { classify, envFor } from './runner'
import type { ClaimedJob } from './store'

const job: ClaimedJob = {
  scheduleId: 7, key: 'notify.reconcile', occurrence: new Date('2026-11-14T02:07:00Z'),
  attempt: 1, params: { a: 1 }, timeoutMs: 1000, maxAttempts: 2, isRetry: false,
  ownerOrg: null, ownerNamespace: null,
}

describe('envFor', () => {
  it('小标量进 env；params 不进 env（走 stdin）', () => {
    const e = envFor(job)
    expect(e.JOB_KEY).toBe('notify.reconcile')
    expect(e.JOB_SCHEDULE_ID).toBe('7')
    expect(e.JOB_OCCURRENCE).toBe('2026-11-14T02:07:00.000Z')
    expect(e.JOB_PARAMS).toBeUndefined()
    expect(e.JOB_OWNER_ORG).toBeUndefined()
  })
})

describe('classify', () => {
  it('exit 0 ⇒ ok', () => expect(classify({ code: 0, signal: null, timedOut: false, outputTail: '', durationMs: 1 }).status).toBe('ok'))
  it('★ exit 2 ⇒ failed 且不重试（判不了不重试）', () => {
    const r = classify({ code: 2, signal: null, timedOut: false, outputTail: '', durationMs: 1 })
    expect(r.status).toBe('failed')
    expect(r.retryable).toBe(false)
  })
  it('其他非 0 ⇒ failed 且可重试', () => {
    const r = classify({ code: 1, signal: null, timedOut: false, outputTail: '', durationMs: 1 })
    expect(r.retryable).toBe(true)
  })
  it('★ 超时 ⇒ timeout 且可重试（即使进程被信号杀掉）', () => {
    const r = classify({ code: null, signal: 'SIGKILL', timedOut: true, outputTail: '', durationMs: 1000 })
    expect(r.status).toBe('timeout')
    expect(r.retryable).toBe(true)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/runner.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/scheduler/runner.ts — 子进程执行器：注入契约、超时 kill、退出码分类。
//
// 为什么 argv 数组 spawn 且 params 走 stdin：argv/环境在网络与进程列表里都可见，把「参数」写成
// 命令行或 env 等于把业务参数广播给同机所有人。stdin 只有父子进程知道，且没有长度上限问题。
import { spawn as nodeSpawn } from 'node:child_process'
import type { ClaimedJob, RunOutcome } from './store'

export interface SpawnOpts {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  stdin: string
  timeoutMs: number
  cwd: string
}
export interface SpawnResult {
  code: number | null
  signal: string | null
  timedOut: boolean
  outputTail: string
  durationMs: number
}
export type SpawnFn = (o: SpawnOpts) => Promise<SpawnResult>

const TAIL_BYTES = 4096

export const defaultSpawn: SpawnFn = (o) => new Promise((resolve) => {
  const started = Date.now()
  const child = nodeSpawn(o.command, o.args, { cwd: o.cwd, env: o.env, stdio: ['pipe', 'pipe', 'pipe'] })
  let tail = ''
  let timedOut = false
  const append = (chunk: Buffer): void => {
    tail += chunk.toString('utf8')
    if (tail.length > TAIL_BYTES) tail = tail.slice(-TAIL_BYTES)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  const killer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
    setTimeout(() => child.kill('SIGKILL'), 5000).unref()
  }, o.timeoutMs)
  killer.unref()
  child.on('error', (e) => {
    clearTimeout(killer)
    resolve({ code: null, signal: null, timedOut, outputTail: `${tail}\n${e.message}`, durationMs: Date.now() - started })
  })
  child.on('close', (code, signal) => {
    clearTimeout(killer)
    resolve({ code, signal: signal ?? null, timedOut, outputTail: tail, durationMs: Date.now() - started })
  })
  if (child.stdin) {
    child.stdin.on('error', () => {}) // 子进程不读 stdin 时 EPIPE 不算失败
    child.stdin.end(o.stdin)
  }
})

/** 只放小标量；`params` 必须走 stdin。 */
export function envFor(job: ClaimedJob): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  env.JOB_KEY = job.key
  env.JOB_SCHEDULE_ID = String(job.scheduleId)
  env.JOB_OCCURRENCE = job.occurrence.toISOString()
  delete env.JOB_PARAMS
  if (job.ownerOrg) env.JOB_OWNER_ORG = job.ownerOrg; else delete env.JOB_OWNER_ORG
  if (job.ownerNamespace) env.JOB_OWNER_NAMESPACE = job.ownerNamespace; else delete env.JOB_OWNER_NAMESPACE
  return env
}

export function paramsStdin(job: ClaimedJob): string {
  const s = JSON.stringify(job.params ?? {})
  if (Buffer.byteLength(s, 'utf8') > 16 * 1024) throw new Error('JOB_PARAMS 超过 16KB')
  return s
}

export function classify(r: SpawnResult): RunOutcome & { retryable: boolean } {
  if (r.timedOut) {
    return { status: 'timeout', exitCode: r.code, durationMs: r.durationMs, outputTail: r.outputTail, error: 'timeout', retryable: true }
  }
  if (r.code === 0) {
    return { status: 'ok', exitCode: 0, durationMs: r.durationMs, outputTail: r.outputTail, retryable: false }
  }
  return {
    status: 'failed', exitCode: r.code, durationMs: r.durationMs, outputTail: r.outputTail,
    error: r.signal ? `signal ${r.signal}` : `exit ${String(r.code)}`,
    retryable: r.code !== 2,
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/runner.test.ts`
Expected: PASS（5 个用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler/runner.ts apps/server/src/scheduler/runner.test.ts
git commit -m "feat(data): 调度的子进程执行器与退出码分类（Wave 6 P1）"
```

---

### Task 7: tick 编排（并发上限 + 运行中集合）

**Files:**
- Create: `apps/server/src/scheduler/loop.ts`
- Test: `apps/server/src/scheduler/loop.test.ts`

**Interfaces:**
- Consumes: Task 4 `JobDef`/`JOB_REGISTRY`、Task 5 store、Task 6 `SpawnFn`/`classify`/`envFor`/`paramsStdin`
- Produces:
  - `export interface SchedulerDeps { pool: Pool; registry?: JobDef[]; spawn?: SpawnFn; now?: () => Date; maxConcurrency?: number; log?: (o: unknown) => void; cwd?: string }`
  - `export function createSchedulerLoop(deps: SchedulerDeps): { tick(): Promise<TickStats>; inFlight(): number }`
  - `export interface TickStats { claimed: number; started: number; skipped: number; reaped: number }`

- [ ] **Step 1: 写失败测试（不阻塞、并发上限、跳过同 job 重叠）**

```ts
// apps/server/src/scheduler/loop.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { createSchedulerLoop } from './loop'
import type { JobDef } from './registry'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))
const def: JobDef = { key: 'jobtest:loop', script: 'scripts/x.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 500, maxAttempts: 1, expectedIntervalSecs: 3600, description: 't' }

describePg('scheduler loop', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest:%'"); await pool.end() })

  async function seed(): Promise<number> {
    await pool.query("delete from platform.job_run where key like 'jobtest:%'")
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    const { rows } = await pool.query(
      `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
       values ('jobtest:loop','7 * * * *','UTC','system',true, now() - interval '1 minute', 500, 1, 3600) returning id`)
    return Number(rows[0].id)
  }

  it('★ tick 不等子进程结束就返回（长任务不阻塞投递 loop）', async () => {
    await seed()
    let finished = false
    const loop = createSchedulerLoop({
      pool, registry: [def], cwd: process.cwd(), maxConcurrency: 2,
      spawn: async () => { await new Promise((r) => setTimeout(r, 300)); finished = true; return { code: 0, signal: null, timedOut: false, outputTail: '', durationMs: 300 } },
    })
    const stats = await loop.tick()
    expect(stats.started).toBe(1)
    expect(finished).toBe(false)
    await new Promise((r) => setTimeout(r, 500))
    expect(finished).toBe(true)
    const { rows } = await pool.query("select status from platform.job_run where key='jobtest:loop' order by id desc limit 1")
    expect(rows[0]?.status).toBe('ok')
  })

  it('并发上限：maxConcurrency=1 时第二次 tick 不再起新进程', async () => {
    await seed()
    const loop = createSchedulerLoop({
      pool, registry: [def], cwd: process.cwd(), maxConcurrency: 1,
      spawn: () => new Promise(() => {}), // 永不返回，占满名额
    })
    await loop.tick()
    const second = await loop.tick()
    expect(second.started).toBe(0)
    expect(loop.inFlight()).toBe(1)
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/loop.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

```ts
// apps/server/src/scheduler/loop.ts — 一次 tick 的编排。**不等子进程结束**：
// 起进程即返回，完成回调里写台账/排重试。长任务因此不会阻塞投递 loop。
import type { Pool } from 'pg'
import { nextRunAt } from './cron'
import { JOB_REGISTRY, seedSchedules, type JobDef } from './registry'
import { classify, defaultSpawn, envFor, paramsStdin, type SpawnFn } from './runner'
import {
  beat, claimDue, claimQueuedManual, clearRetry, hasRunning, reapStale, recordRun, scheduleRetry,
  type ClaimedJob,
} from './store'

export interface SchedulerDeps {
  pool: Pool
  registry?: JobDef[]
  spawn?: SpawnFn
  now?: () => Date
  maxConcurrency?: number
  log?: (o: unknown) => void
  /** 子进程工作目录；生产 = `/app`。 */
  cwd?: string
}

export interface TickStats {
  claimed: number
  started: number
  skipped: number
  reaped: number
}

export function createSchedulerLoop(deps: SchedulerDeps) {
  const registry = deps.registry ?? JOB_REGISTRY
  const spawn = deps.spawn ?? defaultSpawn
  const now = deps.now ?? (() => new Date())
  const max = deps.maxConcurrency ?? Number(process.env.SCHEDULER_MAX_CONCURRENCY ?? 2)
  const log = deps.log ?? ((o: unknown) => console.log(JSON.stringify(o)))
  const cwd = deps.cwd ?? process.cwd()
  const running = new Set<number>()
  let seeded = false

  const runOne = async (job: ClaimedJob): Promise<void> => {
    const def = registry.find((d) => d.key === job.key)
    if (!def) {
      log({ ts: new Date().toISOString(), job: job.key, error: 'unknown registry key' })
      return
    }
    running.add(job.scheduleId)
    try {
      const res = await spawn({
        command: 'pnpm', args: ['exec', 'tsx', def.script],
        env: envFor(job), stdin: paramsStdin(job), timeoutMs: job.timeoutMs, cwd,
      })
      const outcome = classify(res)
      await recordRun(deps.pool, job, outcome)
      if (outcome.status !== 'ok' && outcome.retryable && job.attempt < job.maxAttempts) {
        await scheduleRetry(deps.pool, job.scheduleId, job.occurrence, job.attempt, new Date(Date.now() + 60_000))
      } else {
        await clearRetry(deps.pool, job.scheduleId)
      }
      log({ ts: new Date().toISOString(), job: job.key, occurrence: job.occurrence.toISOString(), status: outcome.status, exitCode: outcome.exitCode ?? null, durationMs: outcome.durationMs ?? null })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await recordRun(deps.pool, job, { status: 'failed', error: msg }).catch(() => {})
      await clearRetry(deps.pool, job.scheduleId).catch(() => {})
      log({ ts: new Date().toISOString(), job: job.key, error: msg })
    } finally {
      running.delete(job.scheduleId)
    }
  }

  return {
    inFlight: () => running.size,
    async tick(): Promise<TickStats> {
      const t = now()
      const stats: TickStats = { claimed: 0, started: 0, skipped: 0, reaped: 0 }
      if (!seeded) { await seedSchedules(deps.pool, registry, t); seeded = true }
      await beat(deps.pool, t)
      stats.reaped = await reapStale(deps.pool, t)

      const free = Math.max(0, max - running.size)
      if (free === 0) return stats
      const manual = await claimQueuedManual(deps.pool, free, t)
      // claimQueuedManual 已把行置 running，这里直接起进程（不重复查 hasRunning）
      for (const job of manual) { void runOne(job); stats.started += 1 }
      stats.claimed += manual.length

      const room = Math.max(0, max - running.size - manual.length)
      if (room === 0) return stats
      const due = await claimDue(deps.pool, room, t, nextRunAt)
      stats.claimed += due.length
      for (const job of due) {
        if (running.has(job.scheduleId) || await hasRunning(deps.pool, job.scheduleId)) {
          await recordRun(deps.pool, job, { status: 'skipped', error: 'previous run still running' })
          stats.skipped += 1
          continue
        }
        void runOne(job)
        stats.started += 1
      }
      return stats
    },
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/loop.test.ts`
Expected: PASS（2 个用例）。第一条用例里对 run 行的断言按实际 `scheduleId` 查；若实现与断言不符，**改断言前先确认是断言写错而不是实现有洞**。

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler/loop.ts apps/server/src/scheduler/loop.test.ts
git commit -m "feat(data): 调度 tick 编排——并发上限与不阻塞（Wave 6 P1）"
```

---

### Task 8: 健康判据（三判据）

**Files:**
- Create: `apps/server/src/scheduler/health.ts`
- Test: `apps/server/src/scheduler/health.test.ts`

**Interfaces:**
- Produces: `export async function jobHealth(pool: Pool, now: Date): Promise<{ ok: boolean; reasons: string[] }>`

- [ ] **Step 1: 写失败测试（三态各自判红）**

```ts
// apps/server/src/scheduler/health.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { jobHealth } from './health'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

describePg('jobHealth', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest:%'"); await pool.end() })

  it('心跳新鲜 + 无作业 ⇒ ok', async () => {
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    await pool.query("insert into platform.job_heartbeat(id,beat_at) values ('scheduler',now()) on conflict (id) do update set beat_at=now()")
    expect((await jobHealth(pool, new Date())).ok).toBe(true)
  })

  it('★ 心跳陈旧 > 2 分钟 ⇒ 红', async () => {
    await pool.query("update platform.job_heartbeat set beat_at = now() - interval '3 minutes' where id='scheduler'")
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(h.reasons.join()).toContain('心跳')
    await pool.query("update platform.job_heartbeat set beat_at = now() where id='scheduler'")
  })

  it('★ 该跑没跑：enabled 且超 2×expected_interval 无 ok run ⇒ 红', async () => {
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    const { rows } = await pool.query(
      `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs,updated_at)
       values ('jobtest:overdue','0 * * * *','UTC','system',true, now() + interval '1 hour', 1000, 1, 60, now() - interval '1 hour') returning id`)
    const h = await jobHealth(pool, new Date())
    expect(h.ok).toBe(false)
    expect(h.reasons.join()).toContain('jobtest:overdue')
    await pool.query('delete from platform.job_schedule where id=$1', [rows[0].id])
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/health.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
// apps/server/src/scheduler/health.ts — 三判据：心跳新鲜 / 该跑没跑 / 连续失败。
// 「该跑没跑」的分母是 expected_interval_secs；从未成功过时用 updated_at 起算（给全新启用一个宽限窗）。
import type { Pool } from 'pg'

export interface JobHealth { ok: boolean; reasons: string[] }

export async function jobHealth(pool: Pool, now: Date): Promise<JobHealth> {
  const reasons: string[] = []

  const hb = await pool.query("select beat_at from platform.job_heartbeat where id='scheduler'")
  const beatAt = hb.rows[0]?.beat_at ? new Date(hb.rows[0].beat_at) : null
  if (!beatAt || now.getTime() - beatAt.getTime() > 120_000) {
    reasons.push(beatAt ? `调度心跳陈旧（${Math.round((now.getTime() - beatAt.getTime()) / 1000)}s）` : '调度心跳从未写入')
  }

  const overdue = await pool.query(
    `select s.key from platform.job_schedule s
      where s.enabled and s.source='system'
        and not exists (
          select 1 from platform.job_run r
           where r.schedule_id = s.id and r.status='ok'
             and r.started_at > $1::timestamptz - make_interval(secs => 2 * s.expected_interval_secs))
        and coalesce(
          (select max(r.started_at) from platform.job_run r where r.schedule_id = s.id),
          s.updated_at) < $1::timestamptz - make_interval(secs => 2 * s.expected_interval_secs)
      order by s.key`, [now])
  for (const r of overdue.rows) reasons.push(`${r.key}：超过 2×期望间隔没有成功运行`)

  const failing = await pool.query(
    `select s.key from platform.job_schedule s
      where s.enabled and (
        select count(*) from (
          select status from platform.job_run r where r.schedule_id = s.id order by started_at desc limit 3
        ) t where t.status in ('failed','timeout')) >= 3
      order by s.key`)
  for (const r of failing.rows) reasons.push(`${r.key}：连续失败 ≥ 3 次`)

  return { ok: reasons.length === 0, reasons }
}
```

- [ ] **Step 4: 运行测试**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/health.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/scheduler/health.ts apps/server/src/scheduler/health.test.ts
git commit -m "feat(data): 调度健康三判据——心跳/该跑没跑/连续失败（Wave 6 P1）"
```

---

### Task 9: worker 接线（调度 loop + healthz 合并）

**Files:**
- Modify: `scripts/notify-worker.mjs`（healthz 与主循环）
- Modify: `deploy/docker-compose.yml`（worker 服务 env）
- Modify: `.env.example`
- Test: `apps/server/src/scheduler/worker-wiring.test.ts`（只测可测的部分：`jobHealth` 与 tick 的 env 开关语义）

**Interfaces:**
- Consumes: Task 7 `createSchedulerLoop`、Task 8 `jobHealth`
- Produces: 生产行为——`SCHEDULER_ENABLED=0` 时不跑 tick 且 healthz 不因调度红。

- [ ] **Step 1: 改 `scripts/notify-worker.mjs`**

在 `const once = process.argv.includes('--once')` 之后加：

```js
  // ── 业务调度 loop（Wave 6 P1）：与投递 loop 同进程、独立节拍、独立 try/catch ──
  // 不 await 子进程完成（tick 只起进程）；长任务因此不会饿死投递。
  const schedulerEnabled = process.env.SCHEDULER_ENABLED !== '0'
  const schedulerTickMs = Number(process.env.SCHEDULER_TICK_MS ?? 30000)
  let scheduler = null
  let lastSchedulerTick = 0
  if (schedulerEnabled) {
    const { createSchedulerLoop } = await import('../apps/server/src/scheduler/loop.ts')
    scheduler = createSchedulerLoop({ pool, cwd: process.cwd() })
    console.log(JSON.stringify({ ts: new Date().toISOString(), scheduler: 'enabled', tickMs: schedulerTickMs }))
  } else {
    console.log(JSON.stringify({ ts: new Date().toISOString(), scheduler: 'disabled' }))
  }
```

把 healthz 的处理体替换成「两份健康都要过」：

```js
  const healthServer = createServer(async (req, res) => {
    if (req.url !== '/healthz') { res.writeHead(404); res.end('not found'); return }
    try {
      const { rows } = await pool.query(
        "select 1 from notify.worker_heartbeat where beat_at > now()-interval '2 minutes'")
      /** @type {string[]} */
      const reasons = rows.length > 0 ? [] : ['通知投递心跳陈旧']
      if (schedulerEnabled) {
        const { jobHealth } = await import('../apps/server/src/scheduler/health.ts')
        const h = await jobHealth(pool, new Date())
        if (!h.ok) reasons.push(...h.reasons)
      }
      const ok = reasons.length === 0
      res.writeHead(ok ? 200 : 503, { 'content-type': 'text/plain' })
      res.end(ok ? 'ok' : reasons.join('; '))
    } catch (e) {
      res.writeHead(503, { 'content-type': 'text/plain' })
      res.end(e instanceof Error ? e.message : String(e))
    }
  })
```

在主循环里加一拍（放在 `runOnceCli` 之前或之后都行，必须在同一个 `do/while` 内）：

```js
      if (scheduler && Date.now() - lastSchedulerTick >= schedulerTickMs) {
        lastSchedulerTick = Date.now()
        try {
          const stats = await scheduler.tick()
          if (stats.claimed > 0 || stats.reaped > 0) {
            console.log(JSON.stringify({ ts: new Date().toISOString(), schedulerTick: stats }))
          }
        } catch (e) {
          console.error('scheduler tick 失败:', e instanceof Error ? e.message : e)
        }
      }
```

- [ ] **Step 2: 加 env（compose + `.env.example`）**

`deploy/docker-compose.yml` 的 `notify-worker.environment` 增加：

```yaml
      SCHEDULER_ENABLED: '1'
      SCHEDULER_TICK_MS: '30000'
      SCHEDULER_MAX_CONCURRENCY: '2'
```

`.env.example` 增加同三键（注释写清：`SCHEDULER_ENABLED=0` 只停调度 loop，不影响投递）。

- [ ] **Step 3: 写接线测试（env 语义，不需要真进程）**

```ts
// apps/server/src/scheduler/worker-wiring.test.ts
import { describe, expect, it } from 'vitest'
import { jobHealth } from './health'
import { createSchedulerLoop } from './loop'

describe('scheduler 接线契约', () => {
  it('createSchedulerLoop 在没有任何到期任务时返回零统计（不抛）', async () => {
    // 纯契约：pool 用最小桩，claim 查询返回空 ⇒ tick 应安静返回
    const calls: string[] = []
    const pool = {
      query: async (sql: string) => { calls.push(sql.trim().slice(0, 20)); return { rows: [], rowCount: 0 } },
      connect: async () => ({ query: async () => ({ rows: [], rowCount: 0 }), release: () => {} }),
    }
    const loop = createSchedulerLoop({ pool: pool as never, registry: [], maxConcurrency: 1, cwd: '/' })
    const stats = await loop.tick()
    expect(stats.started).toBe(0)
    expect(calls.some((c) => c.startsWith('insert into platform.j'))).toBe(false)
  })

  it('jobHealth 在空库上不抛（返回 ok 或 reasons 均可，但必须是合法形状）', async () => {
    const pool = { query: async () => ({ rows: [] }) }
    const h = await jobHealth(pool as never, new Date())
    expect(typeof h.ok).toBe('boolean')
    expect(Array.isArray(h.reasons)).toBe(true)
  })
})
```

- [ ] **Step 4: 运行**

Run: `cd apps/server && pnpm exec vitest run src/scheduler/worker-wiring.test.ts`
Expected: PASS（2 个用例）。若 `seedSchedules` 在空 registry 下仍执行 insert，第一条会红——那说明 tick 在 registry 为空时也应跳过 seed，按红修实现（不是改断言）。

- [ ] **Step 5: 类型与门禁**

Run: `pnpm run typecheck && pnpm run typecheck:scripts`
Expected: PASS（`notify-worker.mjs` 走 checkJs，注意 `pool.query` 返回 `any` 时回调参数要标类型）

- [ ] **Step 6: Commit**

```bash
git add scripts/notify-worker.mjs deploy/docker-compose.yml .env.example apps/server/src/scheduler/worker-wiring.test.ts
git commit -m "feat(data): worker 接入调度 loop 与合并 healthz（Wave 6 P1）"
```

---

### Task 10: 手动触发端点（只入队 + 审计）

**Files:**
- Create: `apps/server/src/routes/platform-jobs.ts`
- Modify: `apps/server/src/app.ts`（挂载 `/api/platform/jobs`）
- Test: `apps/server/src/routes/platform-jobs.test.ts`

**Interfaces:**
- Consumes: `platform.job_schedule` / `job_run`
- Produces: `POST /api/platform/jobs/:key/run` → `{ runId }`；同 schedule 已有 `queued|running` ⇒ 409 `JOB_ALREADY_PENDING`；未知 key ⇒ 404；无 `tenant:admin` ⇒ 403。

- [ ] **Step 1: 写失败测试（权限 + 去重 + 只入队）**

```ts
// apps/server/src/routes/platform-jobs.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { runMigrations } from '../migrate'
import { platformJobRoutes } from './platform-jobs'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const dir = fileURLToPath(new URL('../migrations', import.meta.url))

/** 极简身份注入：只验本路由的判定，不重复测宿主门卫。 */
function appFor(pool: Pool, scopes: string[]) {
  const app = new Hono()
  app.use('*', async (c, next) => {
    c.set('identity', { userId: 'u1', orgId: 'org-x', scopes, hasScope: (s: string) => scopes.includes(s) } as never)
    c.set('tenant', { id: 1, casdoor_org: 'org-x' } as never)
    await next()
  })
  app.route('/jobs', platformJobRoutes({ pool }))
  return app
}

describePg('platform-jobs routes', () => {
  let pool: Pool
  beforeAll(async () => { pool = new Pool({ connectionString: dbUrl }); await runMigrations(pool, 'platform', dir) })
  afterAll(async () => { await pool.query("delete from platform.job_schedule where key like 'jobtest:%'"); await pool.end() })

  async function seed() {
    await pool.query("delete from platform.job_run where key like 'jobtest:%'")
    await pool.query("delete from platform.job_schedule where key like 'jobtest:%'")
    await pool.query(
      `insert into platform.job_schedule(key,cron,timezone,source,enabled,next_run_at,timeout_ms,max_attempts,expected_interval_secs)
       values ('jobtest:route','7 * * * *','UTC','system',true, now() + interval '1 hour', 1000, 1, 3600)`)
  }

  it('无 tenant:admin ⇒ 403', async () => {
    await seed()
    const res = await appFor(pool, []).request('/jobs/jobtest:route/run', { method: 'POST' })
    expect(res.status).toBe(403)
  })

  it('未知 key ⇒ 404', async () => {
    const res = await appFor(pool, ['tenant:admin']).request('/jobs/jobtest:nope/run', { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('★ 正常触发 ⇒ 只建 queued 行（不 spawn、不改 next_run_at）', async () => {
    await seed()
    const res = await appFor(pool, ['tenant:admin']).request('/jobs/jobtest:route/run', { method: 'POST' })
    expect(res.status).toBe(200)
    const body = await res.json() as { runId: number }
    expect(body.runId).toBeGreaterThan(0)
    const run = await pool.query('select status, trigger from platform.job_run where id=$1', [body.runId])
    expect(run.rows[0]).toMatchObject({ status: 'queued', trigger: 'manual' })
    const sch = await pool.query("select next_run_at from platform.job_schedule where key='jobtest:route'")
    expect(new Date(sch.rows[0].next_run_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('★ 已有 queued/running ⇒ 409 JOB_ALREADY_PENDING', async () => {
    await seed()
    const app = appFor(pool, ['tenant:admin'])
    await app.request('/jobs/jobtest:route/run', { method: 'POST' })
    const second = await app.request('/jobs/jobtest:route/run', { method: 'POST' })
    expect(second.status).toBe(409)
    const body = await second.json() as { error: string }
    expect(body.error).toBe('JOB_ALREADY_PENDING')
  })
})
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/server && pnpm exec vitest run src/routes/platform-jobs.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现路由**

```ts
// routes/platform-jobs.ts — 手动触发：**只入队**，执行在 worker 进程（不变量：HTTP 进程不跑副作用）。
import { Hono } from 'hono'
import type { Pool } from 'pg'

export interface PlatformJobDeps { pool: Pool }

interface Vars { identity: { userId: string; hasScope(code: string): boolean }; tenant: { casdoor_org: string } }

export function platformJobRoutes(deps: PlatformJobDeps): Hono<{ Variables: Vars }> {
  const app = new Hono<{ Variables: Vars }>()

  app.post('/:key/run', async (c) => {
    const who = c.get('identity')
    if (!who?.hasScope('tenant:admin')) return c.json({ error: 'FORBIDDEN', need: 'tenant:admin' }, 403)
    const key = c.req.param('key')
    const { rows } = await deps.pool.query(
      "select id, enabled from platform.job_schedule where key=$1 and source='system'", [key])
    const sch = rows[0]
    if (!sch) return c.json({ error: 'JOB_NOT_FOUND', key }, 404)
    if (!sch.enabled) return c.json({ error: 'JOB_DISABLED', key }, 409)

    const busy = await deps.pool.query(
      "select 1 from platform.job_run where schedule_id=$1 and status in ('queued','running') limit 1", [sch.id])
    if (busy.rows.length > 0) return c.json({ error: 'JOB_ALREADY_PENDING', key }, 409)

    const ins = await deps.pool.query(
      `insert into platform.job_run(schedule_id,key,occurrence,trigger,status)
       values ($1,$2, now(), 'manual', 'queued') returning id`, [sch.id, key])
    const runId = Number(ins.rows[0].id)
    await deps.pool.query(
      'insert into platform.audit(tenant_id, actor, action, detail) values ($1,$2,$3,$4)',
      [c.get('tenant')?.casdoor_org ?? null, who.userId, 'admin.job.run', { key, runId }])
    return c.json({ runId, key, status: 'queued' })
  })

  return app
}
```

- [ ] **Step 4: 挂载到 app.ts**

在 `app.route('/api/platform/keys', ...)` 之后加一行（同一段注释块内，保持既有顺序）：

```ts
  // ⑧d 业务调度手动触发（Wave 6 P1）：只入队，执行在 worker 进程
  app.route('/api/platform/jobs', platformJobRoutes({ pool }))
```

并在文件顶部的 import 区加 `import { platformJobRoutes } from './routes/platform-jobs'`。

- [ ] **Step 5: 运行测试 + 类型检查**

Run: `cd apps/server && pnpm exec vitest run src/routes/platform-jobs.test.ts && pnpm run typecheck`
Expected: PASS（4 个用例）

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/platform-jobs.ts apps/server/src/routes/platform-jobs.test.ts apps/server/src/app.ts
git commit -m "feat(data): 手动触发端点——只入队 + 审计（Wave 6 P1）"
```

---

### Task 11: 全量验证 + PR

**Files:** 无新增（验证与提交）

- [ ] **Step 1: 跑全量门禁**

```bash
pnpm -r --if-present test
pnpm run test:guard
pnpm run typecheck
```
Expected: 全绿。若 `modules/aftersales` 在 `pnpm -r` 并发下偶发红，单独重跑该包确认不是本次改动引起（已知本地共享 PG 的并发 flake）。

- [ ] **Step 2: 空库验证（防「本地残留数据假绿」）**

```bash
docker compose -f deploy/docker-compose.yml down -v 2>/dev/null || true
pnpm exec vitest run --dir apps/server src/scheduler
```
Expected: 全绿（migration + 全部调度用例在空库上自建表、自建夹具）。

- [ ] **Step 3: 开 PR**

```bash
git push -u origin <branch>
gh pr create --title "feat(data): 平台内置调度器——排班/台账/执行器/健康（Wave 6 P1）" \
  --body "Closes #2172

## 做了什么
- 迁移 018：platform.job_schedule / job_run / job_heartbeat（含 retry_at / queued，实现所需的两处扩展已在 SQL 头注说明）
- scheduler/{cron,registry,store,runner,loop,health}：零依赖 cron、目录与幂等 seed、claim（事务内 FOR UPDATE SKIP LOCKED）、子进程执行器（stdin 传参）、三判据健康
- worker 接线：同进程第二 loop（不阻塞投递）+ healthz 合并
- 手动触发端点：只入队，执行在 worker
- 正典改写：业务定时归 worker 的 scheduler loop

## 未做
- 不迁移任何 openship job（切流是部署后的独立动作，见 deploy/jobs.md）
- 不开放 agent 面（W6-P3）
- 不接 notify 失败事件（W6-P4，事件声明归属待裁决）"
```

- [ ] **Step 4: 等 CI CLEAN 再合**

```bash
gh pr checks --watch
gh pr merge <n> --squash
```
Expected: 全绿后合并。**不要**在 UNSTABLE 时强合。

---

### Task 12: 部署 + 容器核验 + 切流三个 job（运维，走 openship MCP）

**Files:** 无代码改动；`deploy/jobs.md` 已含程序。

- [ ] **Step 1: 部署两实例**

mytech 由 CI `deploy` job 自动；山海手动触发（`deploy/delivery-private.md`）。
核验（`post_projects_by_id_services_by_serviceId_exec`，服务 `server`）：

```sh
ls -l /app/apps/server/src/scheduler/ /app/apps/server/src/migrations/018_platform_jobs.sql
pnpm exec tsx -e "import('/app/apps/server/src/scheduler/registry.ts').then(m=>console.log('KEYS', m.JOB_REGISTRY.map(x=>x.key).join(',')))"
```

- [ ] **Step 2: 确认 seed 生效但未启用**

```sh
pnpm exec tsx -e "const {Pool}=require('pg');void(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});const r=await p.query(\"select key,enabled,next_run_at,cron,timezone from platform.job_schedule where source='system' order by key\");console.log(JSON.stringify(r.rows));await p.end()})()"
```
Expected: 三行，`enabled=false`，`next_run_at=null`。**若 enabled=true 立即停下**——说明 seed 写错了。

- [ ] **Step 3: 逐 job 切流（一次一个）**

对 `notify.reconcile`：
1. 手动跑一次（MCP 端点或 SQL 入队），比对产物与 openship 上最近一次；
2. `update platform.job_schedule set enabled=true, next_run_at=now()+interval '1 hour' where key='notify.reconcile'`（让首跳落在下一个整点前后，别立刻跑）；
3. 关 openship：`patch_jobs_by_key` 把 `custom:KJ_JBrbq68jAHVlO`（mytech）/`custom:QSr7oZ5KBAVOqx5j`（山海）`enabled=false`；
4. 观察两条 run 行 + openship 侧不再有新 run。

同样程序依次对 `metric.candidates`（`custom:tB6ulrsKtgW852WL`）、`report.scope_scan`（未建，无需关）。

- [ ] **Step 4: 留证**

把「三行 schedule 的 enabled/next_run_at」「每个 job 首次 run 的 status/duration」「openship 侧 job 已停」三类证据写进 PR 描述或台账。

---

### Task 13: 台账入账

**Files:**
- Modify: `docs/superpowers/plans/2026-11-11-helix-borrow-roadmap.md`（§3 已完成 + §7 变更记录）

- [ ] **Step 1: 按「没证据不翻绿」入账**

§3 已完成新增一行（Wave 6 P1：PR 号 + 部署 id + 容器实测 + 三个 job 首跑证据）；§7 追加当日一行。若任一切流未完成，**如实写「部分切流」**并把未切项列入待办。

- [ ] **Step 2: Commit + 合并（docs PR 或随下一 PR）**

```bash
git add docs/superpowers/plans/2026-11-11-helix-borrow-roadmap.md
git commit -m "docs(data): 台账——Wave 6 P1 完成入账"
```

---

## Self-Review

**1. Spec 覆盖**

| spec 条目 | 本计划任务 |
|---|---|
| §3 不变量 1/2/6 | Task 4（registry 唯一事实源）、Task 7（无 DAG 语义）、Task 9（不开放 agent 面） |
| §6 架构与配置 | Task 9（worker 接线 + env） |
| §7 数据模型 | Task 2（含 retry/queued 两处扩展） |
| §8 执行语义（claim/misfire/重试/超时/并发/时区/cron 子集） | Task 3、5、6、7 |
| §9 故障可见性（台账/心跳/healthz 三判据/手动触发/第二看护路径） | Task 8、9、10；**第二看护路径（`check-probe-heartbeat.mjs` 扩检）未在本计划**——列入 Wave 6 P1 收尾待办，不阻塞 |
| §11 迁移与回滚 | Task 12（切流）+ `deploy/jobs.md`（Task 1） |
| §12 正典改写 | Task 1 |
| §13 测试策略 | 各任务的测试步骤 |

**已知缺口（有意不做，写入 PR 描述）**：第二看护路径（扩 `check-probe-heartbeat.mjs`）与 `jobs.job.*` 事件声明（待裁决）不在 P1。

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤都有可复制代码。

**3. 类型一致性**：`ClaimedJob` / `RunOutcome` / `JobDef` 在 Task 4–7 之间逐字一致；`recordRun`（调度触发的运行新建行）与 `finishRun`（手动触发的运行回填）分工在 Task 5 注释里写明；`TickStats` 只有 `claimed/started/skipped/reaped` 四个字段，测试一律按 `key` 查 run 行，**不要为了断言给 `TickStats` 加字段**。
