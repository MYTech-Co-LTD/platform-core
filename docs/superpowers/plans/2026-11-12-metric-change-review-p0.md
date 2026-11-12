# 指标语义治理 P0（变更单 + 试算硬门 + 采纳/驳回）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** agent 的一切指标写（create/update/meta/delete）落 `data.metric_change` 待办单，提交即试算出证据快照，人只能经会话通道采纳或驳回——未试算不可采纳。

**Architecture:** 新表 + 一个域文件（状态机）+ 一个试算文件（只读求值）+ 一组路由（决策端点拒绝 PAT/企微）+ 两把 MCP 工具 + console「待核对」页。生效仍走既有唯一编译点（`writeL2Declaration` / `updateMetricMeta` / `deleteMetricDeclaration`），本波不改它们一行。

**Tech Stack:** TypeScript / Hono / pg / zod / vitest（`modules/data`）。不新增运行时依赖。

**Spec（唯一事实源）:** `docs/superpowers/specs/2026-11-12-metric-semantic-governance-design.md` §5.2 / §6 / §7 / §13 / §15。
**P0 的 kind 范围（计划决策）:** `create | update | meta | delete`。`override` / declared 档依赖 declaration-compiler 与 YAML 流程，随 P1 接入（spec §18 P1）。

## Global Constraints（每个任务隐式继承）

- 提交纪律：Conventional Commits `type(scope): subject`；本计划一个 issue 一个 PR（body 含 `Closes #<issue>`）。
- **装载期双向核对**：改路由必须与 `modules/data/manifest.yaml` 的 `api.internal` 同提交对齐（多声明 ⇒ 装载失败，漏声明 ⇒ 恒 403）。
- 迁移幂等：`create table if not exists` / `create [unique] index if not exists`。
- 决策端点（adopt/reject）**只认会话**：`c.get(REQUESTER_CHANNEL) ?? 'session'`，非 `session` ⇒ 403 `DECISION_REQUIRES_SESSION`。
- 试算只走只读执行器（`ctx.execute ?? runWarehouseSql(analystPool(), …)`），永不写库。
- MCP 工具面：不动 `MANAGE_TOOLS`（≤11 预算），新工具挂 `metricTools` 组；`tools/list` 静态序列化 ≤10KB（门禁 `check-mcp-toolface`）。
- 本地测试需 `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform`（compose pg）。
- ⚠️ 本 worktree 若路径含中文，`apps/server` vitest 会因 fixture URL 编码挂掉（已知环境问题）——跑 `modules/data` 与 gates 即可，server 全量以 CI 为准。

## 前置（开工前人工完成）

1. 建真实 issue：`feat(data): 指标语义治理 P0——变更单+试算+采纳驳回`，正文引 spec §18 P0。下文 `<ISSUE>` 替换为真实号。
2. 从最新 `origin/main` 拉分支 `feat/metric-change-p0`（动手前 `git fetch origin main`）。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/migrations/046_metric_change.sql` | 变更单表 + 两个索引 |
| `modules/data/domain/metric-change.ts` | 状态机：submit / list / get / withdraw / reject / adopt（分发到既有写函数） |
| `modules/data/domain/metric-change-preview.ts` | 试算：编译 → 只读求值 → 快照；纯函数可注入 execute |
| `modules/data/routes/metric-changes.ts` | 7 个端点（含会话限定与 notify） |
| `modules/data/routes/mcp-metric-tools.ts` | +`submit_metric_change` / `list_metric_changes` |
| `modules/data/console/changes/index.tsx` | 「待核对」页 |
| `modules/data/console/index.tsx` / `manifest.yaml` / `apps/web/src/console-registry.gen.ts` | 菜单接线（生成物经 `node scripts/gen-console-registry.mjs` 重生成） |
| `modules/data/index.ts` | 注册新路由 |

---

### Task 1: 迁移 046 —— `data.metric_change`

**Files:**
- Create: `modules/data/migrations/046_metric_change.sql`

**Interfaces:**
- Produces: 表 `data.metric_change`（Task 2 直接依赖）；唯一索引名 `metric_change_one_pending_uq`（Task 2 捕获 23505 用）。

- [ ] **Step 1: 写迁移**

```sql
-- 046_metric_change.sql —— 指标变更单（spec 2026-11-12 §5.2，P0）。
-- 一张单 = agent 的一次提案；人只对它做「采纳 / 驳回」。生效路径不在本表——
-- 采纳时走既有唯一编译点，产物落 data.metrics，本表只留 adopted_snapshot 作凭据。
-- kind 按 spec 五值备全：override 档随 P1 接入，表先按 spec 备好值（P0 代码只写前四值）。
create table if not exists data.metric_change (
  id            bigserial primary key,
  org           text not null,
  metric_id     text not null,
  kind          text not null check (kind in ('create','update','meta','override','delete')),
  payload       jsonb not null,
  status        text not null default 'draft'
                check (status in ('draft','preview_ready','preview_failed','adopted','rejected','superseded','withdrawn')),
  preview       jsonb,
  submitted_by  text not null,
  submitted_channel text not null,
  submitted_at  timestamptz not null default now(),
  decided_by    text,
  decided_at    timestamptz,
  reject_reason text,
  adopted_snapshot jsonb
);

-- 同一指标同时只允许一张未决单（防两份草稿互相覆盖，评审 #1271-#7 同款问题）
create unique index if not exists metric_change_one_pending_uq
  on data.metric_change (org, metric_id)
  where status in ('draft','preview_ready','preview_failed');

create index if not exists metric_change_queue_idx
  on data.metric_change (org, status, submitted_at desc);
```

- [ ] **Step 2: 验证迁移可跑且幂等**

Run: `cd modules/data && DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm exec vitest run domain/metric-governance.test.ts`
Expected: PASS（applyMigrations 会执行 046；幂等由「每个测试文件重复跑迁移」隐式覆盖）。

- [ ] **Step 3: Commit**

```bash
git add modules/data/migrations/046_metric_change.sql
git commit -m "feat(data): 变更单表 metric_change（P0 Task 1）"
```

---

### Task 2: 域层状态机（submit / list / get / withdraw / supersede）

**Files:**
- Create: `modules/data/domain/metric-change.ts`
- Test: `modules/data/domain/metric-change.test.ts`

**Interfaces:**
- Consumes: `L2RefineDeclarationSchema` / `L2ExprDeclarationSchema` / `exceedsNesting`（`./semantic-compiler`）。
- Produces（Task 3/4/5/6 依赖，签名逐字）:
  - `type ChangeKind = 'create' | 'update' | 'meta' | 'delete'`
  - `type ChangeStatus = 'draft' | 'preview_ready' | 'preview_failed' | 'adopted' | 'rejected' | 'superseded' | 'withdrawn'`
  - `interface MetricChangeRow { id: number; org: string; metricId: string; kind: ChangeKind; payload: Record<string, unknown>; status: ChangeStatus; preview: Record<string, unknown> | null; submittedBy: string; submittedChannel: string; submittedAt: string; decidedBy: string | null; decidedAt: string | null; rejectReason: string | null }`
  - `type SubmitOutcome = { ok: true; change: MetricChangeRow } | { ok: false; http: 400 | 409; error: 'INVALID_DECLARATION' | 'INVALID_META' | 'CHANGE_ALREADY_PENDING' }`
  - `submitChange(pool: Pool, org: string, submitter: { userId: string; channel: string }, metricId: string, kind: ChangeKind, payload: unknown): Promise<SubmitOutcome>`
  - `listChanges(pool: Pool, org: string, status?: ChangeStatus | 'pending'): Promise<MetricChangeRow[]>`（`'pending'` = 三种未决态）
  - `getChange(pool: Pool, org: string, id: number): Promise<MetricChangeRow | null>`
  - `withdrawChange(pool: Pool, org: string, id: number, userId: string): Promise<boolean>`

- [ ] **Step 1: 写失败测试**

```ts
// metric-change.test.ts — 变更单状态机（P0）。隔离键与其它文件不同。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { submitChange, listChanges, withdrawChange } from './metric-change'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-metric-change'
const DECL = { baseMetric: 'b:sales', op: { kind: 'refine' }, alias: '我的销售' }

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
})
afterAll(async () => { await pool.end() })

describePg('submitChange', () => {
  it('create 档：合法声明落单（draft），重复提交把旧单 superseded', async () => {
    const r1 = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:net_sales', 'create', DECL)
    expect(r1.ok).toBe(true)
    if (r1.ok) expect(r1.change.status).toBe('draft')

    const r2 = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:net_sales', 'create', { ...DECL, alias: '改' })
    expect(r2.ok).toBe(true)
    const all = await listChanges(pool, ORG)
    expect(all.filter((c) => c.metricId === 'x:net_sales' && c.status === 'superseded')).toHaveLength(1)
    expect(all.filter((c) => c.metricId === 'x:net_sales' && c.status === 'draft')).toHaveLength(1)
  })

  it('自由 SQL 字段 ⇒ INVALID_DECLARATION（结构化声明纪律）', async () => {
    const r = await submitChange(pool, ORG, { userId: 'agent1', channel: 'pat' }, 'x:bad', 'create',
      { baseMetric: 'b:sales', op: { kind: 'refine' }, selectSql: 'select 1' })
    expect(r).toMatchObject({ ok: false, error: 'INVALID_DECLARATION' })
  })

  it('meta 档：三字段字符串；非法类型 ⇒ INVALID_META', async () => {
    const ok = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_ok', 'meta',
      { bizDescription: '不含税', unit: '元', caliberNote: '' })
    expect(ok.ok).toBe(true)
    const bad = await submitChange(pool, ORG, { userId: 'a', channel: 'session' }, 'x:meta_bad', 'meta',
      { bizDescription: 123 })
    expect(bad).toMatchObject({ ok: false, error: 'INVALID_META' })
  })

  it('withdraw 只允许提交者本人', async () => {
    const r = await submitChange(pool, ORG, { userId: 'u1', channel: 'pat' }, 'x:w', 'create', DECL)
    if (!r.ok) throw new Error('unreachable')
    expect(await withdrawChange(pool, ORG, r.change.id, '别人')).toBe(false)
    expect(await withdrawChange(pool, ORG, r.change.id, 'u1')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm exec vitest run domain/metric-change.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// metric-change.ts —— 指标变更单状态机（spec §5.2/§7，P0）。
// 本文件不生效任何指标：生效在 adoptChange（Task 4）分发到既有唯一编译点。
import type { Pool } from 'pg'
import { z } from 'zod'
import { exceedsNesting, L2ExprDeclarationSchema, L2RefineDeclarationSchema } from './semantic-compiler'

export type ChangeKind = 'create' | 'update' | 'meta' | 'delete'
export type ChangeStatus = 'draft' | 'preview_ready' | 'preview_failed' | 'adopted' | 'rejected' | 'superseded' | 'withdrawn'
export const PENDING_STATUSES: readonly ChangeStatus[] = ['draft', 'preview_ready', 'preview_failed']

export interface MetricChangeRow {
  id: number; org: string; metricId: string; kind: ChangeKind
  payload: Record<string, unknown>; status: ChangeStatus
  preview: Record<string, unknown> | null
  submittedBy: string; submittedChannel: string; submittedAt: string
  decidedBy: string | null; decidedAt: string | null; rejectReason: string | null
}

export type SubmitOutcome =
  | { ok: true; change: MetricChangeRow }
  | { ok: false; http: 400 | 409; error: 'INVALID_DECLARATION' | 'INVALID_META' | 'CHANGE_ALREADY_PENDING' }

const MetaPayload = z.object({
  bizDescription: z.string().max(500).optional(),
  unit: z.string().max(32).optional(),
  caliberNote: z.string().max(500).optional(),
}).strict()

/** 声明档 payload：refine/expr 判别式 union（复用编译器的 zod——第二份形状就是第二事实源）。 */
function parseDeclaration(payload: unknown): boolean {
  if (exceedsNesting(payload)) return false
  const refine = L2RefineDeclarationSchema.safeParse(payload)
  if (refine.success) return true
  const expr = L2ExprDeclarationSchema.safeParse(payload)
  return expr.success
}

const COLS = 'id, org, metric_id, kind, payload, status, preview, submitted_by, submitted_channel, submitted_at, decided_by, decided_at, reject_reason'
type DbRow = Record<string, unknown>
function toRow(r: DbRow): MetricChangeRow {
  return {
    id: Number(r.id), org: String(r.org), metricId: String(r.metric_id), kind: String(r.kind) as ChangeKind,
    payload: (r.payload ?? {}) as Record<string, unknown>, status: String(r.status) as ChangeStatus,
    preview: (r.preview ?? null) as Record<string, unknown> | null,
    submittedBy: String(r.submitted_by), submittedChannel: String(r.submitted_channel),
    submittedAt: new Date(r.submitted_at as string).toISOString(),
    decidedBy: r.decided_by === null ? null : String(r.decided_by),
    decidedAt: r.decided_at === null ? null : new Date(r.decided_at as string).toISOString(),
    rejectReason: r.reject_reason === null ? null : String(r.reject_reason),
  }
}

export async function submitChange(
  pool: Pool, org: string, submitter: { userId: string; channel: string },
  metricId: string, kind: ChangeKind, payload: unknown,
): Promise<SubmitOutcome> {
  if (metricId.trim() === '' || metricId.length > 128) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  if ((kind === 'create' || kind === 'update') && !parseDeclaration(payload)) return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  if (kind === 'meta' && !MetaPayload.safeParse(payload).success) return { ok: false, http: 400, error: 'INVALID_META' }
  if (kind === 'delete' && payload !== null && typeof payload === 'object' && Object.keys(payload as object).length > 0) {
    return { ok: false, http: 400, error: 'INVALID_DECLARATION' }
  }

  const client = await pool.connect()
  try {
    await client.query('begin')
    // 旧未决单自动 superseded（spec §7）；并发双提交靠唯一索引兜底
    await client.query(
      `update data.metric_change set status = 'superseded'
        where org = $1 and metric_id = $2 and status = any($3)`,
      [org, metricId, PENDING_STATUSES],
    )
    const ins = await client.query(
      `insert into data.metric_change (org, metric_id, kind, payload, submitted_by, submitted_channel)
       values ($1, $2, $3, $4::jsonb, $5, $6) returning ${COLS}`,
      [org, metricId, kind, JSON.stringify(payload ?? {}), submitter.userId, submitter.channel],
    )
    await client.query('commit')
    return { ok: true, change: toRow(ins.rows[0]!) }
  } catch (e) {
    await client.query('rollback').catch(() => {})
    if ((e as { code?: string }).code === '23505') return { ok: false, http: 409, error: 'CHANGE_ALREADY_PENDING' }
    throw e
  } finally {
    client.release()
  }
}

export async function listChanges(pool: Pool, org: string, status?: ChangeStatus | 'pending'): Promise<MetricChangeRow[]> {
  const r = status === undefined
    ? await pool.query(`select ${COLS} from data.metric_change where org = $1 order by submitted_at desc limit 200`, [org])
    : status === 'pending'
      ? await pool.query(`select ${COLS} from data.metric_change where org = $1 and status = any($2) order by submitted_at desc limit 200`, [org, PENDING_STATUSES])
      : await pool.query(`select ${COLS} from data.metric_change where org = $1 and status = $2 order by submitted_at desc limit 200`, [org, status])
  return r.rows.map(toRow)
}

export async function getChange(pool: Pool, org: string, id: number): Promise<MetricChangeRow | null> {
  const r = await pool.query(`select ${COLS} from data.metric_change where org = $1 and id = $2`, [org, id])
  return r.rows[0] === undefined ? null : toRow(r.rows[0])
}

export async function withdrawChange(pool: Pool, org: string, id: number, userId: string): Promise<boolean> {
  const r = await pool.query(
    `update data.metric_change set status = 'withdrawn', decided_by = $3, decided_at = now()
      where org = $1 and id = $2 and submitted_by = $3 and status = any($4)`,
    [org, id, userId, PENDING_STATUSES],
  )
  return (r.rowCount ?? 0) > 0
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS（4 条）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/metric-change.ts modules/data/domain/metric-change.test.ts
git commit -m "feat(data): 变更单状态机 submit/list/get/withdraw（P0 Task 2）"
```

---

### Task 3: 试算（编译 → 只读求值 → 快照）

**Files:**
- Create: `modules/data/domain/metric-change-preview.ts`
- Test: `modules/data/domain/metric-change-preview.test.ts`

**Interfaces:**
- Consumes: `compileL2` / `resolveL1Base`（`./semantic-compiler`）、`loadMergedCatalog`（`./metric-store`）。
- Produces（Task 4/5 依赖）:
  - `interface PreviewSnapshot { window: { from: string; to: string } | null; value: number | null; rows: number; baseline: { id: string; value: number | null; deltaPct: number | null } | null; sample: Record<string, unknown>[]; compiledHash: string; ranAt: string; durationMs: number }`
  - `type PreviewOutcome = { ok: true; snapshot: PreviewSnapshot } | { ok: false; error: string }`
  - `runPreview(deps: { pool: Pool; execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, org: string, change: MetricChangeRow): Promise<PreviewOutcome>`
  - `applyPreview(pool: Pool, id: number, outcome: PreviewOutcome): Promise<void>`（写 status + preview）
  - `PREVIEW_TIMEOUT_MS = 10_000`

- [ ] **Step 1: 写失败测试**

```ts
// metric-change-preview.test.ts —— 试算纯函数（execute 全注入，不碰真仓库）。
import { describe, expect, it } from 'vitest'
import { previewWindow, timeColumnOf, runPreview } from './metric-change-preview'
import type { MetricChangeRow } from './metric-change'

const decl = { baseMetric: 'b:sales', op: { kind: 'refine' } }
function row(kind: MetricChangeRow['kind'], payload: unknown, metricId = 'x:net'): MetricChangeRow {
  return {
    id: 1, org: 'o', metricId, kind, payload: payload as Record<string, unknown>,
    status: 'draft', preview: null, submittedBy: 'a', submittedChannel: 'pat',
    submittedAt: '2026-11-12T00:00:00Z', decidedBy: null, decidedAt: null, rejectReason: null,
  }
}

describe('timeColumnOf / previewWindow', () => {
  it('从 group_by 里认出时间列（bizday 优先），没有则 null', () => {
    expect(timeColumnOf('system_book, bizday')).toBe('bizday')
    expect(timeColumnOf('day')).toBe('day')
    expect(timeColumnOf('system_book')).toBeNull()
  })
  it('窗口 = 北京时区 [昨天-7, 昨天]', () => {
    const w = previewWindow()
    expect(w.to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Date.parse(w.to) - Date.parse(w.from)).toBe(7 * 86_400_000)
  })
})

describe('runPreview', () => {
  it('create(refine)：值 + 行数 + baseline Δ + 样本 + 哈希', async () => {
    // 编译需要 L1 目录：fixture 一条 b:sales
    const upsert = await (async () => {
      const { Pool } = await import('pg')
      const pool = new Pool({ connectionString: process.env.DATABASE_URL })
      const { upsertL1Metric } = await import('./metric-store')
      await upsertL1Metric(pool, 'o', {
        id: 'b:sales', title: '销售', description: '', requiredScope: null, subjectColumn: 'org',
        selectSql: 'select sum(t.amt) as value, org, bizday from marts.f t', groupBy: 'org, bizday',
        params: {}, source: 'lemeng', owner: 'x', definition: 'd', expression: 'sum(amt)', grain: ['org', 'bizday'],
        tier: 'certified', freshnessSlaDays: 1,
      } as never)
      return pool
    })()
    const calls: string[] = []
    const execute = async (sql: string, params?: unknown[]) => {
      calls.push(sql)
      if (sql.includes('p.bizday')) return { rows: [{ rows: 12, value: 900 }] }   // 窗口聚合
      if (sql.startsWith('select count')) return { rows: [{ rows: 12, value: 900 }] }
      return { rows: [{ org: 'A', bizday: '2026-11-11', value: 900 }] }          // sample
    }
    const out = await runPreview({ pool: upsert, execute }, 'o', row('create', decl))
    expect(out.ok).toBe(true)
    if (out.ok) {
      expect(out.snapshot.rows).toBe(12)
      expect(out.snapshot.value).toBe(900)
      expect(out.snapshot.baseline?.id).toBe('b:sales')
      expect(out.snapshot.baseline?.deltaPct).toBe(0)
      expect(out.snapshot.sample.length).toBeGreaterThan(0)
      expect(out.snapshot.compiledHash).toMatch(/^[0-9a-f]{64}$/)
    }
    await upsert.end()
  })

  it('delete/meta 档：无编译，快照 value 可为 null 但 rows 必须有（当前口径仍可算）', async () => {
    const pool = { query: async () => ({ rows: [{ select_sql: 'select sum(x) as value, bizday from m', group_by: 'bizday' }] }) } as never
    const execute = async () => ({ rows: [{ rows: 3, value: 42 }] })
    const out = await runPreview({ pool, execute }, 'o', row('delete', {}))
    expect(out.ok).toBe(true)
    if (out.ok) expect(out.snapshot.rows).toBe(3)
  })
})
```

（`upsertL1Metric` 的字段以 `metric-store.ts` 的 `L1MetricDef` 为准——上面用 `as never` 占位仅为示意，实现时按真实 `L1MetricDef` 必填字段写齐：`id/title/description/requiredScope/subjectColumn/selectSql/groupBy/params/source/owner/definition/expression/grain/tier/freshnessSlaDays`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm exec vitest run domain/metric-change-preview.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

```ts
// metric-change-preview.ts —— 试算：编译（不生效）→ 只读求值 → 快照（spec §6）。
// 纯度约束：execute 由调用方注入（生产=只读池；测试=假执行器）。本文件永不写 data.metrics。
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { compileL2, resolveL1Base } from './semantic-compiler'
import { loadMergedCatalog } from './metric-store'
import type { MetricChangeRow } from './metric-change'

export const PREVIEW_TIMEOUT_MS = 10_000

export interface PreviewSnapshot {
  window: { from: string; to: string } | null
  value: number | null
  rows: number
  baseline: { id: string; value: number | null; deltaPct: number | null } | null
  sample: Record<string, unknown>[]
  compiledHash: string
  ranAt: string
  durationMs: number
}
export type PreviewOutcome = { ok: true; snapshot: PreviewSnapshot } | { ok: false; error: string }

export interface PreviewDeps {
  pool: Pool
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
}

const TIME_COLS = ['bizday', 'biz_date', 'day', 'date']
export function timeColumnOf(groupBy: string): string | null {
  const dims = groupBy.split(',').map((s) => s.trim()).filter((s) => s !== '')
  return dims.find((d) => TIME_COLS.includes(d.toLowerCase())) ?? null
}

const beijingDay = (offsetDays: number): string =>
  new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10)
/** 窗口 = 北京时区 [昨天-7 天, 昨天]（不含今天：当日未封版，比了必假红）。 */
export function previewWindow(): { from: string; to: string } {
  return { from: beijingDay(-8), to: beijingDay(-1) }
}

async function evalSql(deps: PreviewDeps, selectSql: string, groupBy: string, win: { from: string; to: string } | null): Promise<{ value: number | null; rows: number }> {
  const tc = timeColumnOf(groupBy)
  const inner = tc !== null && win !== null
    ? `select * from (${selectSql}) p where p."${tc}"::text between $1 and $2`
    : `select * from (${selectSql}) p`
  const r = await deps.execute(
    `select count(*)::bigint as rows, sum(value)::double precision as value from (${inner}) t`,
    inner.includes('between') ? [win!.from, win!.to] : [],
  )
  const first = r.rows[0] ?? {}
  return { value: first.value === null || first.value === undefined ? null : Number(first.value), rows: Number(first.rows ?? 0) }
}

const deltaPctOf = (v: number | null, b: number | null): number | null =>
  v === null || b === null || b === 0 ? null : Math.round(((v - b) / b) * 10000) / 100

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => {
    const t = setTimeout(() => rej(new Error('PREVIEW_TIMEOUT')), ms)
    ;(t as unknown as { unref?: () => void }).unref?.()
  })])
}

/**
 * 试算一条变更单。create/update 档：编译草稿声明（compileL2，不落库）；
 * meta/delete 档：编译「当前生效口径」（证明改前/删前这个数仍算得出来）。
 */
export async function runPreview(deps: PreviewDeps, org: string, change: MetricChangeRow): Promise<PreviewOutcome> {
  const startedAt = Date.now()
  const win = previewWindow()
  try {
    let selectSql: string
    let groupBy: string
    let baseline: PreviewSnapshot['baseline'] = null

    if (change.kind === 'create' || change.kind === 'update') {
      const catalog = await loadMergedCatalog(deps.pool, org)
      const l1 = catalog.filter((m) => m.source === 'l1')
      const compiled = compileL2(l1, change.payload as never)
      selectSql = compiled.selectSql
      groupBy = compiled.groupBy
      const decl = change.payload as { baseMetric?: string }
      if (typeof decl.baseMetric === 'string' && decl.baseMetric !== '') {
        const base = resolveL1Base(l1, decl.baseMetric)
        const b = await withTimeout(evalSql(deps, base.selectSql, base.groupBy, win), PREVIEW_TIMEOUT_MS)
        baseline = { id: base.id, value: b.value, deltaPct: null }
      }
    } else {
      const cur = await deps.pool.query(
        'select select_sql, group_by from data.metrics where org = $1 and id = $2', [org, change.metricId],
      )
      if (cur.rows[0] === undefined) return { ok: false, error: 'METRIC_NOT_FOUND' }
      selectSql = String(cur.rows[0].select_sql)
      groupBy = String(cur.rows[0].group_by)
    }

    const main = await withTimeout(evalSql(deps, selectSql, groupBy, win), PREVIEW_TIMEOUT_MS)
    const sample = (await withTimeout(
      deps.execute(`select * from (${selectSql}) p limit 10`), PREVIEW_TIMEOUT_MS,
    )).rows.map((r) => r as Record<string, unknown>)

    if (baseline !== null) baseline = { ...baseline, deltaPct: deltaPctOf(main.value, baseline.value) }
    return {
      ok: true,
      snapshot: {
        window: win, value: main.value, rows: main.rows, baseline, sample,
        compiledHash: createHash('sha256').update(selectSql).digest('hex'),
        ranAt: new Date().toISOString(), durationMs: Date.now() - startedAt,
      },
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** 把试算结果写回变更单：成功 ⇒ preview_ready；失败 ⇒ preview_failed（仍不可采纳）。 */
export async function applyPreview(pool: Pool, id: number, outcome: PreviewOutcome): Promise<void> {
  if (outcome.ok) {
    await pool.query(
      `update data.metric_change set status = 'preview_ready', preview = $2::jsonb where id = $1`,
      [id, JSON.stringify(outcome.snapshot)],
    )
  } else {
    await pool.query(
      `update data.metric_change set status = 'preview_failed', preview = $2::jsonb where id = $1`,
      [id, JSON.stringify({ error: outcome.error, ranAt: new Date().toISOString() })],
    )
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: 同 Step 2。Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/metric-change-preview.ts modules/data/domain/metric-change-preview.test.ts
git commit -m "feat(data): 变更单试算——编译+只读求值+快照（P0 Task 3）"
```

---

### Task 4: 采纳 / 驳回（分发到既有唯一编译点）

**Files:**
- Modify: `modules/data/domain/metric-change.ts`（追加 adopt/reject）
- Test: `modules/data/domain/metric-change.test.ts`（追加用例）

**Interfaces:**
- Consumes: `writeL2Declaration` / `updateMetricMeta` / `deleteMetricDeclaration`（`./metric-write`，签名见该文件 89/318 行与路由 `metrics.ts:306`）；`MetricWriteDeps`。
- Produces（Task 5/6 依赖）:
  - `type DecideOutcome = MetricWriteOutcome | { ok: false; http: 409; error: 'PREVIEW_UNAVAILABLE' | 'CHANGE_STATE_CHANGED' | 'REASON_REQUIRED' }`
  - `adoptChange(deps: MetricWriteDeps, org: string, id: number): Promise<DecideOutcome & { snapshot?: PreviewSnapshot }>`
  - `rejectChange(pool: Pool, org: string, id: number, reviewerId: string, reason: string): Promise<boolean>`

- [ ] **Step 1: 追加失败测试**

```ts
import { adoptChange, rejectChange } from './metric-change'
import { upsertL1Metric } from './metric-store'
import type { Requester } from './authz'

const REQ: Requester = { userId: 'reviewer', orgId: ORG, displayName: 'r', scopes: ['data:manage'], hasScope: () => true } as never
const writeDeps = (pool: Pool) => ({ pool, adoptedSources: new Set(['lemeng']), requester: REQ })

it('未试算（draft）⇒ 409 PREVIEW_UNAVAILABLE；不生效任何东西', async () => {
  const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:no_preview', 'create', DECL)
  if (!s.ok) throw new Error('unreachable')
  const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
  expect(out).toMatchObject({ ok: false, error: 'PREVIEW_UNAVAILABLE' })
})

it('preview_ready ⇒ 采纳走唯一编译点：data.metrics 出现行，单据 adopted 且带快照', async () => {
  await upsertL1Metric(pool, ORG, { /* L1MetricDef：b:sales，见 Task 3 fixture */ } as never)
  const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:adopt_me', 'create', DECL)
  if (!s.ok) throw new Error('unreachable')
  await pool.query(`update data.metric_change set status='preview_ready', preview='{"rows":1}'::jsonb where id=$1`, [s.change.id])
  const out = await adoptChange(writeDeps(pool), ORG, s.change.id)
  expect(out.ok).toBe(true)
  const live = await pool.query(`select id, title from data.metrics where org=$1 and id=$2`, [ORG, 'x:adopt_me'])
  expect(live.rows[0]?.title).toBe('我的销售')
  const after = await getChange(pool, ORG, s.change.id)
  expect(after?.status).toBe('adopted')
  expect(after?.preview).toMatchObject({ rows: 1 })
})

it('重复采纳 ⇒ 409 CHANGE_STATE_CHANGED（CAS）', async () => {
  // 沿用上一条的 adopted 单
  const adopted = (await listChanges(pool, ORG, 'adopted')).find((c) => c.metricId === 'x:adopt_me')
  if (adopted === undefined) throw new Error('前置缺失')
  const again = await adoptChange(writeDeps(pool), ORG, adopted.id)
  expect(again).toMatchObject({ ok: false, error: 'CHANGE_STATE_CHANGED' })
})

it('驳回必填原因；驳回后单据 rejected 且原因可读', async () => {
  const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:rej', 'create', DECL)
  if (!s.ok) throw new Error('unreachable')
  expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '')).toBe(false)
  expect(await rejectChange(pool, ORG, s.change.id, 'reviewer', '差 12%，疑似含退货')).toBe(true)
  const after = await getChange(pool, ORG, s.change.id)
  expect(after?.status).toBe('rejected')
  expect(after?.rejectReason).toBe('差 12%，疑似含退货')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && DATABASE_URL=… pnpm exec vitest run domain/metric-change.test.ts`
Expected: FAIL（adoptChange 未导出）。

- [ ] **Step 3: 在 metric-change.ts 追加实现**

```ts
import type { MetricWriteDeps, MetricWriteOutcome, MetricMetaPatch } from './metric-write'
import { writeL2Declaration, updateMetricMeta, deleteMetricDeclaration } from './metric-write'
import type { L2Declaration } from './semantic-compiler'
import type { PreviewSnapshot } from './metric-change-preview'

export type DecideOutcome =
  | (MetricWriteOutcome & { snapshot?: PreviewSnapshot })
  | { ok: false; http: 409; error: 'PREVIEW_UNAVAILABLE' | 'CHANGE_STATE_CHANGED' | 'REASON_REQUIRED' }

/** 采纳：preview_ready 才可；按 kind 分发到既有唯一编译点（本函数不自造第二条写路径）。 */
export async function adoptChange(deps: MetricWriteDeps, org: string, id: number): Promise<DecideOutcome> {
  const cur = await getChange(deps.pool, org, id)
  if (cur === null) return { ok: false, http: 404, error: 'NOT_FOUND' }
  if (cur.status !== 'preview_ready') return { ok: false, http: 409, error: 'PREVIEW_UNAVAILABLE' }

  let out: MetricWriteOutcome
  if (cur.kind === 'create' || cur.kind === 'update') {
    out = await writeL2Declaration(deps, org, cur.metricId, cur.payload as unknown as L2Declaration)
  } else if (cur.kind === 'meta') {
    const p = cur.payload as Partial<MetricMetaPatch>
    out = await updateMetricMeta(deps, org, cur.metricId, {
      bizDescription: p.bizDescription ?? '', unit: p.unit ?? '', caliberNote: p.caliberNote ?? '',
    })
  } else {
    out = await deleteMetricDeclaration(deps, org, cur.metricId)
  }
  if (!out.ok) return out

  // CAS 收尾：写成功后才翻状态；被并发抢先 ⇒ 409（写本身幂等：upsert/meta 幂等，delete 重试会 NOT_FOUND，如实返回）
  const mark = await deps.pool.query(
    `update data.metric_change set status='adopted', decided_by=$3, decided_at=now(), adopted_snapshot=$4::jsonb
      where org=$1 and id=$2 and status='preview_ready'`,
    [org, id, deps.requester.userId, JSON.stringify(cur.preview ?? {})],
  )
  if ((mark.rowCount ?? 0) === 0) return { ok: false, http: 409, error: 'CHANGE_STATE_CHANGED' }
  return { ok: true, snapshot: (cur.preview ?? undefined) as PreviewSnapshot | undefined }
}

export async function rejectChange(pool: Pool, org: string, id: number, reviewerId: string, reason: string): Promise<boolean> {
  if (reason.trim() === '' || reason.length > 500) return false
  const r = await pool.query(
    `update data.metric_change set status='rejected', decided_by=$3, decided_at=now(), reject_reason=$4
      where org=$1 and id=$2 and status = any($5)`,
    [org, id, reviewerId, reason.trim(), PENDING_STATUSES],
  )
  return (r.rowCount ?? 0) > 0
}
```

（`MetricMetaPatch` 若在 `metric-write.ts` 未导出，就地用 `{ bizDescription: string; unit: string; caliberNote: string }` 字面形状并删掉该 import——以仓库现状为准，两处必须同形。）

- [ ] **Step 4: 跑测试确认通过** → PASS。

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/metric-change.ts modules/data/domain/metric-change.test.ts
git commit -m "feat(data): 变更单采纳/驳回——分发唯一编译点+CAS（P0 Task 4）"
```

---

### Task 5: 路由 + manifest 声明（决策端点只认会话）

**Files:**
- Create: `modules/data/routes/metric-changes.ts`
- Modify: `modules/data/index.ts`（注册）、`modules/data/manifest.yaml`（api.internal +7 条）
- Test: `modules/data/routes/metric-changes.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 全部导出；`requesterOf`（`./context`）；`REQUESTER_CHANNEL`、`TENANT_SOURCES`（`@platform/sdk`）；`analystPool` / `runWarehouseSql`（`../domain/warehouse`）。
- Produces: `registerMetricChanges(r: ModuleHono, ctx: RouteCtx): void`；7 条端点。

- [ ] **Step 1: 写失败测试**

```ts
// metric-changes.test.ts —— 端点行为 + 会话限定。壳不挂宿主门卫（沿 metrics.test.ts 惯例）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import mod from '../index'
import { submitChange } from '../domain/metric-change'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-p0-mc-routes'

let pool: Pool
beforeAll(async () => {
  pool = new Pool({ connectionString: dbUrl })
  await applyMigrations(pool)
})
afterAll(async () => { await pool.end() })

describePg('POST/GET /metric-changes', () => {
  it('提交 create 档 → 自动试算 → preview_ready（execute 注入）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }),
      { pool, execute: async () => ({ rows: [{ rows: 5, value: 100 }] }) } as never)
    const res = await app.request('/api/modules/data/metric-changes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'x:auto', kind: 'create', payload: { baseMetric: 'b:sales', op: { kind: 'refine' } } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { change: { status: string; preview: { rows: number } } }
    expect(body.change.status).toBe('preview_ready')
    expect(body.change.preview.rows).toBe(5)
  })

  it('采纳：PAT 通道 ⇒ 403 DECISION_REQUIRES_SESSION；会话通道（缺省）⇒ 可采纳', async () => {
    const identity = makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] })
    const app = buildTestApp(mod, identity, { pool, execute: async () => ({ rows: [{ rows: 1, value: 1 }] }) } as never)
    const s = await submitChange(pool, ORG, { userId: 'agent', channel: 'pat' }, 'x:decide', 'meta', { unit: '元' })
    await pool.query(`update data.metric_change set status='preview_ready', preview='{"rows":1}'::jsonb where id=$1`, [s.ok ? s.change.id : 0])

    // PAT 通道：裸 Hono + 先挂 channel 中间件再注册模块（宿主真实装配中该值由 pat-auth 设置）
    const patApp = new Hono()
    patApp.use('*', (c, next) => { c.set(REQUESTER_CHANNEL, 'pat'); return next() })
    patApp.route('/', app)
    const refused = await patApp.request(`/api/modules/data/metric-changes/${s.ok ? s.change.id : 0}/adopt`, { method: 'POST' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toMatchObject({ error: 'DECISION_REQUIRES_SESSION' })

    const okRes = await app.request(`/api/modules/data/metric-changes/${s.ok ? s.change.id : 0}/adopt`, { method: 'POST' })
    expect([200, 404]).toContain(okRes.status)   // 200=meta 落库；404=该指标不存在（也算正常路径，断言不 5xx）
  })

  it('驳回缺 reason ⇒ 400；list 按 pending 过滤', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG, scopes: ['data:query', 'data:manage'] }),
      { pool, execute: async () => ({ rows: [] }) } as never)
    const s = await submitChange(pool, ORG, { userId: 'a', channel: 'pat' }, 'x:rej2', 'meta', {})
    const noReason = await app.request(`/api/modules/data/metric-changes/${s.ok ? s.change.id : 0}/reject`, { method: 'POST' })
    expect(noReason.status).toBe(400)
    const list = await app.request('/api/modules/data/metric-changes?status=pending')
    expect(list.status).toBe(200)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**（路由 404）。

- [ ] **Step 3: 实现路由 + 注册 + manifest**

`routes/metric-changes.ts`：

```ts
// metric-changes.ts — 变更单端点（spec §6/§7，P0）。
// 采纳/驳回是**人的决策**：只认会话通道（PAT/企微 ⇒ 403 DECISION_REQUIRES_SESSION）。
// 试算只读：ctx.execute 缺省时走 analystPool 只读池。
import { z } from 'zod'
import { REQUESTER_CHANNEL, TENANT_SOURCES } from '@platform/sdk'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'
import { adoptChange, getChange, listChanges, rejectChange, submitChange, withdrawChange, type ChangeKind } from '../domain/metric-change'
import { applyPreview, runPreview } from '../domain/metric-change-preview'
import { analystPool, runWarehouseSql } from '../domain/warehouse'

const SubmitBody = z.object({
  metricId: z.string().min(1).max(128),
  kind: z.enum(['create', 'update', 'meta', 'delete']),
  payload: z.unknown().optional(),
})
const RejectBody = z.object({ reason: z.string().min(1).max(500) })

const requireSession = (c: { get: (k: typeof REQUESTER_CHANNEL) => string | undefined }) => {
  const channel = c.get(REQUESTER_CHANNEL) ?? 'session'
  return channel === 'session'
}

export function registerMetricChanges(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/metric-changes', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const parsed = SubmitBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const org = c.get('tenant').casdoor_org
    const out = await submitChange(ctx.pool, org,
      { userId: requester.userId, channel: c.get(REQUESTER_CHANNEL) ?? 'session' },
      parsed.data.metricId, parsed.data.kind as ChangeKind, parsed.data.payload ?? {})
    if (!out.ok) return c.json({ error: out.error }, out.http)

    // 提交即试算（spec §6.1）：失败落 preview_failed，单据仍可读、不可采纳
    const preview = await runPreview(
      { pool: ctx.pool, execute: (q, p) => ctx.execute !== undefined ? ctx.execute(q, p) : runWarehouseSql(analystPool(), q) },
      org, out.change,
    )
    await applyPreview(ctx.pool, out.change.id, preview)
    return c.json({ change: await getChange(ctx.pool, org, out.change.id) }, 200)
  })

  r.get('/metric-changes', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const q = c.req.query('status')
    const changes = await listChanges(ctx.pool, c.get('tenant').casdoor_org,
      q === 'pending' || q === undefined ? 'pending' : (q as never))
    return c.json({ changes }, 200)
  })

  r.get('/metric-changes/:id', async (c) => {
    const change = await getChange(ctx.pool, c.get('tenant').casdoor_org, Number(c.req.param('id')))
    return change === null ? c.json({ error: 'NOT_FOUND' }, 404) : c.json({ change }, 200)
  })

  r.post('/metric-changes/:id/preview', async (c) => {
    const org = c.get('tenant').casdoor_org
    const change = await getChange(ctx.pool, org, Number(c.req.param('id')))
    if (change === null) return c.json({ error: 'NOT_FOUND' }, 404)
    const preview = await runPreview(
      { pool: ctx.pool, execute: (q, p) => ctx.execute !== undefined ? ctx.execute(q, p) : runWarehouseSql(analystPool(), q) },
      org, change,
    )
    await applyPreview(ctx.pool, change.id, preview)
    return c.json({ change: await getChange(ctx.pool, org, change.id) }, 200)
  })

  // ── 决策端点：只认会话（结构性禁止 agent 自审）──
  r.post('/metric-changes/:id/adopt', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    if (!requireSession(c)) return c.json({ error: 'DECISION_REQUIRES_SESSION' }, 403)
    const out = await adoptChange(
      { pool: ctx.pool, adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []), requester },
      c.get('tenant').casdoor_org, Number(c.req.param('id')),
    )
    if (!out.ok) return c.json({ error: out.error }, out.http)
    if (ctx.notify) {
      try { /* 沿 confirm-draft 的通知形态：eventKey data.metric.definition.changed */
        const row = await ctx.pool.query(`select title, version from data.metrics where org=$1 and id=(select metric_id from data.metric_change where id=$2)`,
          [c.get('tenant').casdoor_org, Number(c.req.param('id'))])
        const mid = await ctx.pool.query(`select metric_id from data.metric_change where id=$1`, [Number(c.req.param('id'))])
        const metricId = String(mid.rows[0]?.metric_id ?? '')
        await ctx.notify.emit(c.get('identity'), {
          eventKey: 'data.metric.definition.changed',
          eventId: `data.metric.definition.changed:${c.get('tenant').casdoor_org}:${metricId}:${row.rows[0]?.version ?? 0}`,
          scope: metricId,
          payload: {
            metricId,
            title: String(row.rows[0]?.title ?? metricId),
            changedBy: requester.userId,
            link: `${process.env.PLATFORM_CONSOLE_BASE_URL ?? ''}/console/data/changes`,
          },
        })
      } catch { /* fail-open：通知失败不阻断采纳（模块协议 12） */ }
    }
    return c.json({ ok: true }, 200)
  })

  r.post('/metric-changes/:id/reject', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    if (!requireSession(c)) return c.json({ error: 'DECISION_REQUIRES_SESSION' }, 403)
    const parsed = RejectBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'REASON_REQUIRED' }, 400)
    const ok = await rejectChange(ctx.pool, c.get('tenant').casdoor_org, Number(c.req.param('id')), requester.userId, parsed.data.reason)
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'CHANGE_STATE_CHANGED' }, 409)
  })

  r.post('/metric-changes/:id/withdraw', async (c) => {
    const requester = requesterOf(c)
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
    const ok = await withdrawChange(ctx.pool, c.get('tenant').casdoor_org, Number(c.req.param('id')), requester.userId)
    return ok ? c.json({ ok: true }, 200) : c.json({ error: 'FORBIDDEN' }, 403)
  })
}
```

`modules/data/index.ts`：import 区加 `import { registerMetricChanges } from './routes/metric-changes'`，注册区（`registerMetrics` 之后）加 `registerMetricChanges(r, _ctx)`。

`modules/data/manifest.yaml` `api.internal`（`/scopes` 组之后追加，注释写明决策端点语义）：

```yaml
    # ── 指标变更单（Wave 5 P0，spec 2026-11-12 §6/§7）：agent 只提案，人只采纳 ──
    # 提交/重跑试算/撤回 = data:manage（agent 写面）；**采纳/驳回虽也声明 data:manage，
    # 但路由内另判会话通道**（PAT/企微 ⇒ 403 DECISION_REQUIRES_SESSION）——页门管不了通道，
    # 这是有意的第二道闸（结构性禁止自审）。
    - { method: POST, path: /metric-changes,                scope: data:manage }
    - { method: GET,  path: /metric-changes,                scope: data:manage }
    - { method: GET,  path: /metric-changes/:id,            scope: data:manage }
    - { method: POST, path: /metric-changes/:id/preview,    scope: data:manage }
    - { method: POST, path: /metric-changes/:id/adopt,      scope: data:manage }
    - { method: POST, path: /metric-changes/:id/reject,     scope: data:manage }
    - { method: POST, path: /metric-changes/:id/withdraw,   scope: data:manage }
```

- [ ] **Step 4: 跑测试 + 装载门禁**

Run:
```bash
cd modules/data && DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm exec vitest run routes/metric-changes.test.ts
pnpm exec tsx ../../scripts/check-manifests.mjs
```
Expected: 测试 PASS；manifest 双向核对 OK（路由与声明逐条一致，否则装载失败）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/metric-changes.ts modules/data/routes/metric-changes.test.ts modules/data/index.ts modules/data/manifest.yaml
git commit -m "feat(data): 变更单端点——决策只认会话（P0 Task 5）"
```

---

### Task 6: MCP 工具（submit_metric_change / list_metric_changes）

**Files:**
- Modify: `modules/data/routes/mcp-metric-tools.ts`（list + call）
- Modify: `modules/data/routes/mcp-manage.test.ts`（`METRIC_REPORT_TOOL_NAMES` 名单 +1 场景）
- Test: 追加于 `mcp-manage.test.ts`

**Interfaces:**
- Consumes: `submitChange` / `listChanges`（Task 2）；`mutatingAllowed`（`../domain/toolbox/registry`）。
- Produces: MCP 工具 `submit_metric_change`（mutating，受 `DATA_MCP_ALLOW_MUTATING`）、`list_metric_changes`（只读）。

- [ ] **Step 1: 写失败测试（追加到 mcp-manage.test.ts 的既有 describe）**

```ts
it('submit_metric_change：落单为 draft/pending，永不直接生效；list_metric_changes 能看到自己的单', async () => {
  // 夹具沿本文件既有形态（app + identity + pool）；核心断言：
  const res = await app.request('/api/modules/data/mcp-manage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'submit_metric_change', arguments: {
        metricId: 'x:via_mcp', kind: 'create',
        payload: { baseMetric: L1_ID, op: { kind: 'refine' }, alias: '经 MCP 提的' } } } }),
  })
  const body = await res.json() as { result: { content: { text: string }[] } }
  const payload = JSON.parse(body.result.content[0]!.text)
  expect(payload.status === 'draft' || payload.status === 'preview_ready' || payload.status === 'preview_failed').toBe(true)
  // 生效路径未被触碰：
  const live = await pool.query(`select 1 from data.metrics where org=$1 and id='x:via_mcp'`, [ORG])
  expect(live.rowCount).toBe(0)
})
```

（`app`/`ORG`/`L1_ID`/`pool` 沿用该测试文件的既有夹具变量名；若该文件用别的装配函数名，照它来。）

- [ ] **Step 2: 跑测试确认失败**（unknown_tool）。

- [ ] **Step 3: 实现**

在 `mcp-metric-tools.ts` 的 `list()` 返回数组里追加两个定义（`submit_metric_change` 描述必须写明「**只提案不生效，等待人工采纳**；驳回原因在 list_metric_changes 里读」）；`call()` 里追加认领分支：

```ts
if (name === 'submit_metric_change') {
  if (!mutatingAllowed(process.env as Record<string, string | undefined>)) {
    return { text: JSON.stringify({ status: 'error', reason: 'mutating_disabled' }), isError: true }
  }
  const args2 = args as { metricId?: unknown; kind?: unknown; payload?: unknown }
  const out = await submitChange(deps.pool, deps.org,
    { userId: requester.userId, channel: 'mcp' },
    String(args2.metricId ?? ''), String(args2.kind ?? '') as ChangeKind, args2.payload ?? {})
  if (!out.ok) return { text: JSON.stringify({ status: 'refused', error: out.error }), isError: true }
  return { text: JSON.stringify({ status: 'ok', changeId: out.change.id, state: out.change.status }) }
}
if (name === 'list_metric_changes') {
  const changes = await listChanges(deps.pool, deps.org, 'pending')
  return { text: JSON.stringify({ status: 'ok', changes: changes.map((c) => ({
    id: c.id, metricId: c.metricId, kind: c.kind, status: c.status, preview: c.preview,
    submittedBy: c.submittedBy, submittedAt: c.submittedAt,
  })) }) }
}
```

（`deps.org` / `requester` 在该文件的 `call(deps, name, args)` 里已就位；`ChangeKind`/`submitChange`/`listChanges` 从 `../domain/metric-change` import。`submitted_channel` 用 `'mcp'`——比 `'pat'` 更准确地区分工具面来源；check 约束是「非 session 即拒决策端点」，不受影响。）

同时把 `mcp-manage.test.ts` 顶部的 `METRIC_REPORT_TOOL_NAMES` 数组追加 `'submit_metric_change', 'list_metric_changes'`。

- [ ] **Step 4: 跑测试 + 工具面门禁**

```bash
cd modules/data && DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm exec vitest run routes/mcp-manage.test.ts
pnpm exec tsx ../../scripts/check-mcp-toolface.mjs
```
Expected: PASS；toolface OK（tools/list ≤10KB）。

- [ ] **Step 5: Commit**

```bash
git add modules/data/routes/mcp-metric-tools.ts modules/data/routes/mcp-manage.test.ts
git commit -m "feat(data): MCP 提案工具 submit/list_metric_changes（P0 Task 6）"
```

---

### Task 7: console「待核对」页

**Files:**
- Create: `modules/data/console/changes/index.tsx`
- Modify: `modules/data/console/index.tsx`（TABS + 页表）、`modules/data/manifest.yaml`（frontend.console）
- Generate: `node scripts/gen-console-registry.mjs`（产物 `apps/web/src/console-registry.gen.ts` 进提交）
- Test: `modules/data/console/changes/index.test.tsx`

**Interfaces:**
- Consumes: `apiGet` / `apiSend`（`../lib/api`）、`humanError`（`../lib/explain`）、`TechDetails`（`../components/TechDetails`）、Task 5 的 `GET /metric-changes?status=pending` / `POST :id/adopt` / `POST :id/reject`。

- [ ] **Step 1: 写失败测试**

```tsx
// changes/index.test.tsx — 待核对页：默认层给「数与差异」，决策只有两个按钮。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ChangesPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const PENDING = {
  changes: [{
    id: 7, metricId: 'x:net_sales', kind: 'create', status: 'preview_ready',
    payload: { baseMetric: 'b:sales', op: { kind: 'refine' }, alias: '净销售额（财务）' },
    preview: { window: { from: '2026-11-04', to: '2026-11-11' }, value: 1102340.12, rows: 12,
      baseline: { id: 'b:sales', value: 1234567.89, deltaPct: -10.71 }, sample: [] },
    submittedBy: 'agent', submittedChannel: 'pat', submittedAt: '2026-11-12T02:00:00Z',
    decidedBy: null, decidedAt: null, rejectReason: null,
  }],
}

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/metric-changes') && (init?.method ?? 'GET') === 'GET') return json(PENDING)
    if (u.includes('/adopt') || u.includes('/reject')) return json({ ok: true })
    return json({})
  })
})
afterEach(cleanup)

describe('待核对页', () => {
  it('默认层：指标 / 类型 / 试算值 vs 参照值 Δ；动作只有采纳与驳回', async () => {
    render(<ChangesPage />)
    await waitFor(() => expect(screen.getByText(/x:net_sales/)).toBeInTheDocument())
    expect(screen.getByText(/1,102,340/)).toBeInTheDocument()       // 试算值
    expect(screen.getByText(/−?10\.71/)).toBeInTheDocument()        // 差异
    expect(screen.getByRole('button', { name: /采\s*纳/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /驳\s*回/ })).toBeInTheDocument()
    // 原始声明/快照收进展开层（TechDetails）
    expect(document.querySelectorAll('details').length).toBeGreaterThan(0)
  })

  it('驳回必填原因：空原因点驳回不发请求', async () => {
    render(<ChangesPage />)
    await waitFor(() => expect(screen.getByText(/x:net_sales/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    const calls = m.mock.calls.filter(([u, i]) => String(u).includes('/reject') && i?.method === 'POST')
    expect(calls.length).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && pnpm exec vitest run console/changes/index.test.tsx` → FAIL。

- [ ] **Step 3: 实现页面 + 接线**

`changes/index.tsx` 骨架（Card 列表 + Modal 驳回原因 + message 反馈；样式沿 `candidates/index.tsx`，不引新依赖）：

```tsx
// console/changes/index.tsx — 「待核对」（Wave 5 P0）：agent 的提案单，人只做采纳/驳回。
// 默认层人话：改什么 / 数是多少 / 与参照差多少；原始声明与快照收进 TechDetails。
import { useCallback, useEffect, useState } from 'react'
import { Alert, Button, Card, Empty, Input, Modal, Space, Tag, Typography, message } from 'antd'
import { apiGet, apiSend } from '../lib/api'
import { humanError } from '../lib/explain'
import { TechDetails } from '../components/TechDetails'

type Row = {
  id: number; metricId: string; kind: 'create' | 'update' | 'meta' | 'delete'
  status: string; payload: Record<string, unknown>
  preview: { window?: { from: string; to: string }; value?: number | null; rows?: number
    baseline?: { id: string; value: number | null; deltaPct: number | null } | null
    error?: string } | null
  submittedBy: string; submittedAt: string
}
const KIND_LABEL: Record<Row['kind'], string> = { create: '新建指标', update: '修改口径', meta: '改标注', delete: '删除指标' }

export default function ChangesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [err, setErr] = useState<{ text: string; code: string } | null>(null)
  const [rejecting, setRejecting] = useState<Row | null>(null)
  const [reason, setReason] = useState('')
  const [messageApi, ctx] = message.useMessage()

  const load = useCallback(async () => {
    try {
      const body = await apiGet('/metric-changes?status=pending') as { changes?: Row[] }
      setRows(Array.isArray(body.changes) ? body.changes : [])
    } catch (e) { setErr(humanError(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  const adopt = async (r: Row) => {
    try { await apiSend(`/metric-changes/${r.id}/adopt`, 'POST'); messageApi.success('已采纳并生效'); await load() }
    catch (e) { messageApi.error(humanError(e).text) }
  }
  const reject = async () => {
    if (rejecting === null || reason.trim() === '') return
    try { await apiSend(`/metric-changes/${rejecting.id}/reject`, 'POST', { reason: reason.trim() })
      messageApi.success('已驳回，agent 会看到原因'); setRejecting(null); setReason(''); await load() }
    catch (e) { messageApi.error(humanError(e).text) }
  }

  return (
    <Card title="待核对" extra={<Button size="small" onClick={() => void load()}>刷新</Button>}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        这些是 agent 提交的指标变更。<strong>没看到数就不该采纳</strong>——先看试算值与参照值的差异，
        对得上点「采纳」，对不上点「驳回」并写清哪里不对。
      </Typography.Paragraph>
      {err !== null && <Alert type="error" showIcon style={{ marginBottom: 12 } as never} message={err.text} />}
      {rows.length === 0
        ? <Empty description="没有待核对的变更。agent 提交后会出现在这里。" />
        : rows.map((r) => (
          <Card key={r.id} size="small" style={{ marginBottom: 10 }}>
            <Space align="start" style={{ width: '100%', justifyContent: 'space-between' }} wrap>
              <div style={{ minWidth: 280, flex: 1 }}>
                <Space size={6} wrap>
                  <Typography.Text strong style={{ fontSize: 15 }}>{r.metricId}</Typography.Text>
                  <Tag>{KIND_LABEL[r.kind]}</Tag>
                  {r.status === 'preview_failed' && <Tag color="warning">试算失败</Tag>}
                  <Typography.Text type="secondary">{r.submittedBy} · {r.submittedAt.slice(0, 16).replace('T', ' ')}</Typography.Text>
                </Space>
                <Typography.Paragraph type="secondary" style={{ margin: '6px 0 0', fontSize: 13 }}>
                  {r.preview?.error !== undefined
                    ? `试算没跑成：${r.preview.error}（不可采纳）`
                    : r.preview?.baseline != null && r.preview.baseline.deltaPct !== null
                      ? `试算 ${r.preview.value?.toLocaleString?.() ?? r.preview.value}（${r.preview.rows ?? 0} 行），`
                        + `参照 ${r.preview.baseline.id} ${r.preview.baseline.value?.toLocaleString?.() ?? r.preview.baseline.value}，`
                        + `差 ${r.preview.baseline.deltaPct > 0 ? '+' : ''}${r.preview.baseline.deltaPct}%`
                      : `试算 ${r.preview?.value?.toLocaleString?.() ?? r.preview?.value ?? '—'}（${r.preview?.rows ?? 0} 行）`}
                </Typography.Paragraph>
                <TechDetails>
                  <div>窗口：{r.preview?.window ? `${r.preview.window.from} ~ ${r.preview.window.to}` : '—'}</div>
                  <div>原始声明：{JSON.stringify(r.payload)}</div>
                  <div>快照：{JSON.stringify(r.preview)}</div>
                </TechDetails>
              </div>
              <Space>
                <Button type="primary" disabled={r.status !== 'preview_ready'} onClick={() => void adopt(r)}>采纳</Button>
                <Button disabled={r.status !== 'preview_ready'} onClick={() => setRejecting(r)}>驳回</Button>
              </Space>
            </Space>
          </Card>
        ))}
      <Modal title="驳回这条变更" open={rejecting !== null} okText="驳回" okButtonProps={{ danger: true, disabled: reason.trim() === '' }}
             onOk={() => void reject()} onCancel={() => setRejecting(null)}>
        <Input.TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500}
                        placeholder="哪里不对？（agent 会按这个改，必填）" />
      </Modal>
      {ctx}
    </Card>
  )
}
```

`console/index.tsx`：`import ChangesPage from './changes'`；`TABS` 追加 `{ key: 'changes', label: '待核对', manageOnly: true }`；页表追加 `changes: ChangesPage`（照 `candidates` 三处同款）。

`manifest.yaml` `frontend.console` 追加（在 candidates 之后）：

```yaml
    # 待核对（Wave 5 P0）：agent 提案单的评审面——只有采纳/驳回两个动作
    - { path: /console/data/changes, title: 待核对, scope: data:manage, entry: ./console/index.tsx }
```

然后 `node scripts/gen-console-registry.mjs`（在仓根跑）重生成 `apps/web/src/console-registry.gen.ts`。

- [ ] **Step 4: 跑测试 + 类型 + 装载冒烟**

```bash
cd modules/data && pnpm exec vitest run console/changes/index.test.tsx console/index.test.tsx
pnpm exec tsc --noEmit
cd ../.. && pnpm --filter @platform/web typecheck
```

- [ ] **Step 5: Commit**

```bash
git add modules/data/console/changes modules/data/console/index.tsx modules/data/manifest.yaml apps/web/src/console-registry.gen.ts
git commit -m "feat(data): console 待核对页——只有采纳/驳回（P0 Task 7）"
```

---

### Task 8: 全量验证 + PR + 部署验证

- [ ] **Step 1: 全量本地验证**

```bash
DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm -r --filter '!@platform/server' --if-present test
pnpm typecheck
pnpm run test:guard
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/check-mcp-toolface.mjs
```

- [ ] **Step 2: PR**

标题 `feat(data): 指标语义治理 P0——变更单+试算+采纳驳回 (#<ISSUE>)`…（实际以 squash 后缀为准）；body 含 `Closes #<ISSUE>`、spec 链接、验收清单。等 CI **全绿**（unit/gates/web/smoke/discipline）再合。

- [ ] **Step 3: 部署与线上验证（shanhai 手动部署）**

- openship MCP `post_deployments`（projectId `proj_GLXUtN2bJ92DpPrS`、serverId `8281d598-…`、branch main、带 commitSha）。
- 容器内验证（`post_projects_by_id_services_by_serviceId_exec`，server 服务）：
  1. `grep -r "metric_change" /app/modules/data/migrations/` → 046 在；
  2. `psql $DATABASE_URL -c "\d data.metric_change"`（或经 server exec 的 node 查询）确认表与两个索引；
  3. 未鉴权 `POST /api/modules/data/metric-changes` ⇒ 401；
  4. console 产物里有「待核对」文案（`grep -r 待核对 /app/apps/web/dist/assets/`）。
- 台账回填：开发地图 §3 P0 行写证据（PR 号 + 部署 id + 容器实测），`没证据不翻绿`。

---

## Self-Review（写完自检的结论）

- **Spec 覆盖**：§5.2 表（Task 1）、§6 试算+硬门（Task 3/4）、§7 采纳/驳回+会话限定（Task 4/5）、§11 工具（Task 6）、§12 待核对页（Task 7）、§13 错误码（散布各 Task，全部出现）、§15 测试（各 Task 内）。spec §6.3 的「重跑限速 1/分钟」与 `PREVIEW_RATE_LIMITED` **本波未做**——重跑端点存在但未限速，记为 P4 收口项（写进 PR body 的已知边界）。
- **类型一致性**：`MetricChangeRow`/`SubmitOutcome`/`PreviewSnapshot`/`DecideOutcome` 在 Task 2/3/4 定义、Task 5/6/7 消费，签名逐字对齐。
- **已知取舍**：① `override`/declared 档不在 P0（P1）；② adopt 的 CAS 在写之后——写幂等（upsert/meta）或如实报 `NOT_FOUND`（delete 重试），不会静默双写；③ 试算窗口固定「昨天往前 7 天」，不可配（YAGNI，P6 再议）。
