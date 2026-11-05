# 需求挖掘（Phase 2）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「用户想要但词表没有」从用法轨迹里挖出来，落成一张人审需求台账，并提供 manage 面读写工具。

**Architecture:** 纯判定器（`classify.ts`，零 IO、零阈值）→ 存储层（`store.ts`，upsert 幂等 + 水位入 DB）→ 编排（`mine.ts`，注入读者，可单测）→ CLI（`scripts/demand-mining.mjs`，docker exec 跑）→ 工具面（`demand/tools.ts` + `handlers.ts`，合并进 manage 面）。四类 `kind`：`alias_gap` / `new_metric` / `drill_gap` / `metric_hunt`。

**Tech Stack:** TypeScript（ESM）/ Postgres（pg）/ OpenObserve 组织级 `_search` / vitest。

## Global Constraints

- 判定**零阈值**：只用结构化字段；唯一「≥2」是 `metric_hunt` 的结构判据（同一会话同一时间窗出现 ≥2 个 `metricId`），不是频次阈值。
- 迁移**幂等**：本目录迁移每次部署全量重跑 ⇒ 全部 `if not exists`。
- 写入**幂等**：`on conflict (org, kind, target) do update`；水位存 DB（`data.demand_mining_state`），**不放 `/tmp`**（occurrences 是累加量）。
- **fail-fast**：OO 源失败、DB 不可达、未知需求形态 ⇒ exit 1，不用 `|| true` 吞。
- 纯文件纪律：`demand/classify.ts` 与 `demand/tools.ts` **不得** import pg / Hono / zod / warehouse。
- manage 面工具上限 `MANAGE_FACE_MAX_TOOLS = 11`（原 9 + 2），`scripts/check-mcp-toolface.mjs` 跟随。
- **不改** W1 / W2 / W3 既有链路；**不写** `data.metric_candidates`；无新 env。
- 审计：两个新工具的调用照旧走 `mcp-pipeline-tools.ts` 的 `reply()` 单点（`tool` = 工具名）。

---

### Task 1: 迁移 036 + 需求台账存储层

**Files:**
- Create: `modules/data/migrations/036_demand_signals.sql`
- Create: `modules/data/domain/demand/store.ts`
- Test: `modules/data/domain/demand/store.test.ts`

**Interfaces:**
- Produces:
  - `type DemandKind = 'alias_gap' | 'new_metric' | 'drill_gap' | 'metric_hunt'`
  - `interface DemandRow { id: number; kind: DemandKind; target: string; detail: Record<string, unknown>; occurrences: number; firstSeen: string; lastSeen: string; evidence: unknown[]; dismissedAt: string | null; dismissedBy: string | null; dismissReason: string | null }`
  - `upsertDemand(pool, org, { kind, target, detail, evidence }): Promise<void>` —— 每次调用 `occurrences + 1`，`evidence` 新在前、滚动保留 5 条
  - `listDemands(pool, org, { kind?, includeDismissed?, limit }): Promise<DemandRow[]>`
  - `dismissDemand(pool, org, id, by, reason): Promise<{ status: 'dismissed' } | { status: 'already'; row: DemandRow } | { status: 'not_found' }>`
  - `readCursor(pool, org, source): Promise<number>`（无行 ⇒ 0）/ `writeCursor(pool, org, source, value): Promise<void>`

- [ ] **Step 1: 写迁移**

```sql
-- 036_demand_signals.sql — Phase 2 需求台账（spec 2026-11-05-demand-mining-design.md §3）。
-- 幂等：本目录迁移每次部署全量重跑 ⇒ 全部 if not exists。
create table if not exists data.demand_signals (
  id             bigserial primary key,
  org            text        not null,
  kind           text        not null,
  target         text        not null,
  detail         jsonb       not null default '{}'::jsonb,
  occurrences    integer     not null default 1,
  first_seen     timestamptz not null default now(),
  last_seen      timestamptz not null default now(),
  evidence       jsonb       not null default '[]'::jsonb,
  dismissed_at   timestamptz,
  dismissed_by   text,
  dismiss_reason text
);
create unique index if not exists demand_signals_key
  on data.demand_signals (org, kind, target);

create table if not exists data.demand_mining_state (
  org         text        not null,
  source      text        not null,
  last_cursor bigint      not null,
  updated_at  timestamptz not null default now(),
  primary key (org, source)
);
```

- [ ] **Step 2: 写存储层**

```ts
// store.ts —— 需求台账的读写（唯一 SQL 落点）。判定规则不在这里（classify.ts）。
import type { Pool } from 'pg'

export type DemandKind = 'alias_gap' | 'new_metric' | 'drill_gap' | 'metric_hunt'

export interface DemandRow {
  id: number; kind: DemandKind; target: string
  detail: Record<string, unknown>; occurrences: number
  firstSeen: string; lastSeen: string; evidence: unknown[]
  dismissedAt: string | null; dismissedBy: string | null; dismissReason: string | null
}

export interface DemandUpsert {
  kind: DemandKind; target: string
  detail: Record<string, unknown>; evidence: unknown[]
}

const toRow = (r: Record<string, unknown>): DemandRow => ({
  id: Number(r.id), kind: r.kind as DemandKind, target: String(r.target),
  detail: (r.detail ?? {}) as Record<string, unknown>, occurrences: Number(r.occurrences),
  // timestamptz 由 pg 反序列化成 Date；`String(Date)` 是本地化非 ISO 串（按字母序排序会错乱），
  // 一律归一成 ISO——与 metric-audit-store / metric-candidates 同款。
  firstSeen: new Date(r.first_seen as string | Date).toISOString(),
  lastSeen: new Date(r.last_seen as string | Date).toISOString(),
  evidence: Array.isArray(r.evidence) ? r.evidence : [],
  dismissedAt: r.dismissed_at === null || r.dismissed_at === undefined
    ? null
    : new Date(r.dismissed_at as string | Date).toISOString(),
  dismissedBy: r.dismissed_by === null || r.dismissed_by === undefined ? null : String(r.dismissed_by),
  dismissReason: r.dismiss_reason === null || r.dismiss_reason === undefined ? null : String(r.dismiss_reason),
})

/**
 * 幂等累加。`evidence` 合并后**新在前**、只留 5 条——一次挖掘的一条证据是够用的；
 * 留全量会让 jsonb 随使用量无界增长。
 */
export async function upsertDemand(pool: Pool, org: string, d: DemandUpsert): Promise<void> {
  await pool.query(
    `insert into data.demand_signals (org, kind, target, detail, occurrences, evidence)
     values ($1, $2, $3, $4::jsonb, 1, $5::jsonb)
     on conflict (org, kind, target) do update set
       occurrences = data.demand_signals.occurrences + 1,
       last_seen   = now(),
       detail      = data.demand_signals.detail || excluded.detail,
       evidence    = (
         select coalesce(jsonb_agg(e), '[]'::jsonb) from (
           select jsonb_array_elements(excluded.evidence || data.demand_signals.evidence) as e
           limit 5
         ) t
       )`,
    [org, d.kind, d.target, JSON.stringify(d.detail), JSON.stringify(d.evidence)],
  )
}

export async function listDemands(
  pool: Pool, org: string,
  opts: { kind?: DemandKind; includeDismissed?: boolean; limit: number },
): Promise<DemandRow[]> {
  const { rows } = await pool.query(
    `select * from data.demand_signals
      where org = $1
        and ($2::text is null or kind = $2)
        and ($3::boolean or dismissed_at is null)
      order by occurrences desc, last_seen desc
      limit $4`,
    [org, opts.kind ?? null, opts.includeDismissed === true, opts.limit],
  )
  return rows.map(toRow)
}

export async function getDemand(pool: Pool, org: string, id: number): Promise<DemandRow | null> {
  const { rows } = await pool.query(
    'select * from data.demand_signals where org = $1 and id = $2', [org, id],
  )
  return rows.length === 0 ? null : toRow(rows[0])
}

/** 否决幂等：已否决 ⇒ `already`（回原否决信息），不存在 ⇒ `not_found`。 */
export async function dismissDemand(
  pool: Pool, org: string, id: number, by: string, reason: string,
): Promise<{ status: 'dismissed' } | { status: 'already'; row: DemandRow } | { status: 'not_found' }> {
  const cur = await getDemand(pool, org, id)
  if (cur === null) return { status: 'not_found' }
  if (cur.dismissedAt !== null) return { status: 'already', row: cur }
  await pool.query(
    `update data.demand_signals set dismissed_at = now(), dismissed_by = $3, dismiss_reason = $4
      where org = $1 and id = $2`,
    [org, id, by, reason],
  )
  return { status: 'dismissed' }
}

const SOURCES = ['query_audit', 'askdata_conv'] as const
export type CursorSource = (typeof SOURCES)[number]

export async function readCursor(pool: Pool, org: string, source: CursorSource): Promise<number> {
  const { rows } = await pool.query(
    'select last_cursor from data.demand_mining_state where org = $1 and source = $2', [org, source],
  )
  return rows.length === 0 ? 0 : Number(rows[0].last_cursor)
}

export async function writeCursor(pool: Pool, org: string, source: CursorSource, value: number): Promise<void> {
  await pool.query(
    `insert into data.demand_mining_state (org, source, last_cursor, updated_at)
     values ($1, $2, $3, now())
     on conflict (org, source) do update set last_cursor = excluded.last_cursor, updated_at = now()`,
    [org, source, value],
  )
}
```

- [ ] **Step 3: 写测试（DB 门控，与仓内既有 DB 测试同形）**

```ts
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { dismissDemand, listDemands, readCursor, upsertDemand, writeCursor } from './store'

const dsn = process.env.DATABASE_URL
const ORG = 'demand-store-test'

describe.skipIf(dsn === undefined)('demand store（真库）', () => {
  const pool = new pg.Pool({ connectionString: dsn })

  it('同一 (org,kind,target) 累加而不是新建；evidence 只留 5 条且新在前', async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG])
    for (let i = 1; i <= 7; i += 1) {
      await upsertDemand(pool, ORG, { kind: 'new_metric', target: 'm:a:b', detail: {}, evidence: [{ i }] })
    }
    const rows = await listDemands(pool, ORG, { limit: 10 })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.occurrences).toBe(7)
    expect((rows[0]?.evidence as { i: number }[]).map((e) => e.i)).toEqual([7, 6, 5, 4, 3])
  })

  it('否决幂等：第一次 dismissed，第二次 already，且默认列表不再返回', async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG])
    await upsertDemand(pool, ORG, { kind: 'drill_gap', target: 'm:x', detail: { dimensions: ['branch_num'] }, evidence: [] })
    const [row] = await listDemands(pool, ORG, { limit: 1 })
    expect(await dismissDemand(pool, ORG, row!.id, 'u1', '不需要')).toEqual({ status: 'dismissed' })
    expect((await dismissDemand(pool, ORG, row!.id, 'u2', 'x')).status).toBe('already')
    expect(await listDemands(pool, ORG, { limit: 10 })).toHaveLength(0)
    expect(await listDemands(pool, ORG, { limit: 10, includeDismissed: true })).toHaveLength(1)
  })

  it('水位读写', async () => {
    await pool.query('delete from data.demand_mining_state where org = $1', [ORG])
    expect(await readCursor(pool, ORG, 'query_audit')).toBe(0)
    await writeCursor(pool, ORG, 'query_audit', 42)
    await writeCursor(pool, ORG, 'query_audit', 99)
    expect(await readCursor(pool, ORG, 'query_audit')).toBe(99)
  })

  it('org 隔离：读不到别的 org', async () => {
    await pool.query('delete from data.demand_signals where org = $1', [ORG])
    await upsertDemand(pool, ORG, { kind: 'new_metric', target: 'm:o:1', detail: {}, evidence: [] })
    expect(await listDemands(pool, `${ORG}-other`, { limit: 10 })).toHaveLength(0)
  })
})
```

- [ ] **Step 4: 跑测试**

Run: `cd modules/data && DATABASE_URL=postgres://localhost/ma_dev pnpm exec vitest run domain/demand/store.test.ts`
Expected: PASS（4 个）

- [ ] **Step 5: 提交**

```bash
git add modules/data/migrations/036_demand_signals.sql modules/data/domain/demand/store.ts modules/data/domain/demand/store.test.ts
git commit -m "feat(data): 需求台账表与存储层（Phase 2，#1404）"
```

---

### Task 2: 四类判定器（纯函数）

**Files:**
- Create: `modules/data/domain/demand/classify.ts`
- Test: `modules/data/domain/demand/classify.test.ts`

**Interfaces:**
- Consumes: `DemandKind`（Task 1）
- Produces:
  - `interface AuditRow { id: number | string; metric_id: string; reason: string | null; params: unknown }`
  - `interface ConvRow { session_id: string; seq: number | string; tool_name: string | null; tool_args: string | null }`
  - `interface DemandDraft { kind: DemandKind; target: string; detail: Record<string, unknown>; evidence: unknown[] }`
  - `isProbeTarget(t: string): boolean`
  - `classifyAudit(row: AuditRow, catalogIds: readonly string[]): DemandDraft | null`
  - `huntFromConvs(rows: readonly ConvRow[], stuckBySession: ReadonlyMap<string, unknown[]>): DemandDraft[]`

- [ ] **Step 1: 写失败测试（**用生产真实案例做 fixture**）**

```ts
import { describe, expect, it } from 'vitest'
import { classifyAudit, huntFromConvs, isProbeTarget } from './classify'

const CATALOG = ['lemeng:retail:net_sales', 'lemeng:outbound:line_count']
const audit = (metric_id: string, reason: string, params: unknown = {}) => ({ id: 1, metric_id, reason, params })

describe('classifyAudit', () => {
  it('裸名撞末段 ⇒ alias_gap（net_sales ↔ lemeng:retail:net_sales）', () => {
    const d = classifyAudit(audit('net_sales', 'metric_not_declared'), CATALOG)
    expect(d).toMatchObject({ kind: 'alias_gap', target: 'net_sales', detail: { matchedMetricId: 'lemeng:retail:net_sales' } })
  })

  it('两段名撞末段 ⇒ alias_gap（retail:net_sales）', () => {
    expect(classifyAudit(audit('retail:net_sales', 'metric_not_declared'), CATALOG)?.kind).toBe('alias_gap')
  })

  it('三段齐全但无精确匹配 ⇒ new_metric（域不同，末段撞名不算别名）', () => {
    expect(classifyAudit(audit('lemeng:retail:line_count', 'metric_not_declared'), CATALOG)?.kind).toBe('new_metric')
    expect(classifyAudit(audit('lemeng:retail:target', 'metric_not_declared'), CATALOG)?.kind).toBe('new_metric')
  })

  it('no_detail_binding ⇒ drill_gap，dimensions 进 detail', () => {
    const d = classifyAudit(
      audit('lemeng:outbound:net_amount', 'no_detail_binding', { dimensions: ['branch_num'] }), CATALOG,
    )
    expect(d).toMatchObject({ kind: 'drill_gap', target: 'lemeng:outbound:net_amount', detail: { dimensions: ['branch_num'] } })
  })

  it('其它 reason 不产出需求（bad_param / tool_error / warehouse_error / mutating_disabled）', () => {
    for (const r of ['bad_param', 'tool_error', 'warehouse_error', 'mutating_disabled', 'unknown_tool']) {
      expect(classifyAudit(audit('m:a:b', r), CATALOG)).toBeNull()
    }
  })

  it('测试探针前缀一律排除', () => {
    for (const t of ['verify-20261007:net_sales:by-bizday', 'mcp-probe-20261007:net_sales:by-bizday', 'w1:test:by_branch', 'test-abc']) {
      expect(isProbeTarget(t)).toBe(true)
      expect(classifyAudit(audit(t, 'metric_not_declared'), CATALOG)).toBeNull()
    }
  })
})

describe('huntFromConvs', () => {
  const row = (session: string, seq: number, metricId: string, from: string, to: string) => ({
    session_id: session, seq, tool_name: 'query_data',
    tool_args: JSON.stringify({ metricId, args: { bizday: { from, to } } }),
  })

  it('同会话同时间窗 ≥2 个 metricId ⇒ metric_hunt', () => {
    const out = huntFromConvs([
      row('s1', 1, 'lemeng:retail:net_sales', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'lemeng:retail:sale_money', '2026-10-10', '2026-10-16'),
    ], new Map())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'metric_hunt', target: 's1|2026-10-10..2026-10-16',
      detail: { metricIds: ['lemeng:retail:net_sales', 'lemeng:retail:sale_money'] },
    })
  })

  it('只查了 1 个 metricId ⇒ 不产出', () => {
    expect(huntFromConvs([row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16')], new Map())).toHaveLength(0)
  })

  it('同 (session_id, seq) 重复行只算一次；不同时间窗分开成组', () => {
    const dup = [row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'), row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16')]
    expect(huntFromConvs(dup, new Map())).toHaveLength(0)
    const two = [
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'm:c:d', '2026-10-17', '2026-10-17'),
    ]
    expect(huntFromConvs(two, new Map())).toHaveLength(0)
  })

  it('stuck 证据按会话挂上', () => {
    const stuck = new Map([['s1', [{ rule: 'same_tool_retry', seq: 9 }]]])
    const out = huntFromConvs([
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'm:c:d', '2026-10-10', '2026-10-16'),
    ], stuck)
    expect(out[0]?.evidence).toEqual([{ rule: 'same_tool_retry', seq: 9 }])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/demand/classify.test.ts`
Expected: FAIL（`Cannot find module './classify'`）

- [ ] **Step 3: 实现**

```ts
// classify.ts —— 四类需求的**纯判定**：零 IO、零阈值、零 NLP。
// target 必须跨轮稳定（它是表唯一键的一部分）：audit 行取 metric_id；hunt 取 `会话|时间窗`。
import type { DemandKind } from './store'

export interface AuditRow { id: number | string; metric_id: string; reason: string | null; params: unknown }
export interface ConvRow { session_id: string; seq: number | string; tool_name: string | null; tool_args: string | null }
export interface DemandDraft {
  kind: DemandKind; target: string
  detail: Record<string, unknown>; evidence: unknown[]
}

/** 测试探针前缀（实测 4 条假需求混在生产数据里，2026-11-05）。 */
const PROBE_PREFIXES = ['verify-', 'mcp-probe-', 'w1:test', 'test-'] as const

export const isProbeTarget = (t: string): boolean => {
  const s = t.trim().toLowerCase()
  return PROBE_PREFIXES.some((p) => s.startsWith(p))
}

const segments = (id: string): string[] => id.split(':').filter((s) => s !== '')
const lastSegment = (id: string): string => segments(id).pop() ?? id

const dimsOf = (params: unknown): string[] => {
  if (params === null || typeof params !== 'object') return []
  const d = (params as Record<string, unknown>).dimensions
  return Array.isArray(d) ? d.map(String) : []
}

/**
 * 一行审计 → 一条需求（或 null）。
 * - `metric_not_declared` + 请求不足三段 + 末段命中词表 ⇒ `alias_gap`（补 synonyms）
 * - `metric_not_declared` 其余 ⇒ `new_metric`（三段齐全却无精确匹配 = 用户指定了域，末段撞名不算别名）
 * - `no_detail_binding` ⇒ `drill_gap`（该指标未声明下钻绑定）
 * - 其它 reason 不产出（bad_param/tool_error/warehouse_error 归 #741 撞墙回路）
 */
export function classifyAudit(row: AuditRow, catalogIds: readonly string[]): DemandDraft | null {
  const target = String(row.metric_id ?? '').trim()
  if (target === '' || isProbeTarget(target)) return null
  const evidence = [{ auditId: row.id, reason: row.reason, params: row.params ?? {} }]

  if (row.reason === 'metric_not_declared') {
    const matched = segments(target).length < 3
      ? catalogIds.find((id) => lastSegment(id) === lastSegment(target))
      : undefined
    return matched === undefined
      ? { kind: 'new_metric', target, detail: {}, evidence }
      : { kind: 'alias_gap', target, detail: { matchedMetricId: matched }, evidence }
  }
  if (row.reason === 'no_detail_binding') {
    return { kind: 'drill_gap', target, detail: { dimensions: dimsOf(row.params) }, evidence }
  }
  return null
}

/**
 * 会话口径寻路：同一会话 + 同一 bizday 时间窗出现 ≥2 个不同 `metricId` ⇒ 该问题在词表里
 * **没有唯一答案**。这是结构判据（≥2），不是频次阈值——9 个会话下没有可校准阈值的案例。
 */
export function huntFromConvs(
  rows: readonly ConvRow[],
  stuckBySession: ReadonlyMap<string, unknown[]>,
): DemandDraft[] {
  const seen = new Set<string>()
  const groups = new Map<string, { session: string; window: string; metrics: Set<string> }>()
  for (const r of rows) {
    const key = `${r.session_id}#${String(r.seq)}`
    if (seen.has(key)) continue   // conv 里同一 (session_id, seq) 有 call/result 两行
    seen.add(key)
    if (r.tool_name !== 'query_data' || r.tool_args === null) continue
    let parsed: unknown
    try { parsed = JSON.parse(r.tool_args) } catch { continue }
    const p = parsed as { metricId?: unknown; args?: { bizday?: { from?: unknown; to?: unknown } } }
    const metricId = typeof p?.metricId === 'string' ? p.metricId : null
    const from = typeof p?.args?.bizday?.from === 'string' ? p.args.bizday.from : null
    const to = typeof p?.args?.bizday?.to === 'string' ? p.args.bizday.to : null
    if (metricId === null || from === null || to === null || isProbeTarget(metricId)) continue
    const gk = `${r.session_id}|${from}..${to}`
    const g = groups.get(gk) ?? { session: r.session_id, window: `${from}..${to}`, metrics: new Set<string>() }
    g.metrics.add(metricId)
    groups.set(gk, g)
  }
  const out: DemandDraft[] = []
  for (const [gk, g] of groups) {
    if (g.metrics.size < 2) continue
    out.push({
      kind: 'metric_hunt', target: gk,
      detail: { sessionId: g.session, bizday: g.window, metricIds: [...g.metrics].sort() },
      evidence: stuckBySession.get(g.session) ?? [],
    })
  }
  return out
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/demand/classify.test.ts`
Expected: PASS（10 个）

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/demand/classify.ts modules/data/domain/demand/classify.test.ts
git commit -m "feat(data): 四类需求判定器（零阈值，真实案例 fixture）（Phase 2，#1404）"
```

---

### Task 3: 挖掘编排 + CLI 脚本

**Files:**
- Create: `modules/data/domain/demand/mine.ts`
- Create: `scripts/demand-mining.mjs`
- Test: `modules/data/domain/demand/mine.test.ts`

**Interfaces:**
- Consumes: `classifyAudit` / `huntFromConvs`（Task 2）、`upsertDemand` / `readCursor` / `writeCursor`（Task 1）
- Produces:
  - `interface MineIo { readCursor; writeCursor; readAudit(org, sinceId) → { rows, maxId }; readConv(org, sinceUs) → ConvRow[]; readStuck(org, sessionIds) → Map; catalogIds(org) → string[]; upsert(org, draft) → void }`
  - `interface MineSummary { scanned: number; alias: number; newMetric: number; drill: number; hunt: number; skippedProbe: number; cursorAudit: number; cursorConv: number }`
  - `mineOnce(io: MineIo, org: string, nowUs: number): Promise<MineSummary>`

- [ ] **Step 1: 写失败测试（全注入，不连网不连库）**

```ts
import { describe, expect, it } from 'vitest'
import { mineOnce } from './mine'
import type { MineIo } from './mine'

const fakeIo = (over: Partial<MineIo> = {}) => {
  const upserts: unknown[] = []
  const cursors = new Map<string, number>()
  const io: MineIo = {
    readCursor: async (_o, s) => cursors.get(s) ?? 0,
    writeCursor: async (_o, s, v) => { cursors.set(s, v) },
    readAudit: async () => ({ rows: [], maxId: 0 }),
    readConv: async () => [],
    readStuck: async () => new Map(),
    catalogIds: async () => [],
    upsert: async (_o, d) => { upserts.push(d) },
    ...over,
  }
  return { io, upserts, cursors }
}

describe('mineOnce', () => {
  it('审计行分类后 upsert，并推进两个水位', async () => {
    const { io, upserts, cursors } = fakeIo({
      readAudit: async () => ({
        rows: [
          { id: 10, metric_id: 'net_sales', reason: 'metric_not_declared', params: {} },
          { id: 11, metric_id: 'm:a:b', reason: 'bad_param', params: {} },
        ],
        maxId: 11,
      }),
      readConv: async () => [{ session_id: 's1', seq: 1, tool_name: 'query_data', tool_args: '{"metricId":"m:a:b","args":{"bizday":{"from":"2026-10-10","to":"2026-10-16"}}}' }],
      catalogIds: async () => ['lemeng:retail:net_sales'],
    })
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out).toMatchObject({ scanned: 2, alias: 1, newMetric: 0, drill: 0, hunt: 0, cursorAudit: 11 })
    expect(upserts).toHaveLength(1)
    expect(cursors.get('query_audit')).toBe(11)
  })

  it('同批重复运行不重复计数（水位已推进 ⇒ 审计源无新行）', async () => {
    let calls = 0
    const { io, upserts } = fakeIo({
      readAudit: async (_o, since) => {
        calls += 1
        return since === 0
          ? { rows: [{ id: 5, metric_id: 'm:a:b', reason: 'metric_not_declared', params: {} }], maxId: 5 }
          : { rows: [], maxId: since }
      },
    })
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(calls).toBe(2)
    expect(upserts).toHaveLength(1)
  })

  it('空数据 ⇒ 全 0 且不报错', async () => {
    const { io } = fakeIo()
    const out = await mineOnce(io, 'org1', 1_800_000_000_000_000)
    expect(out).toMatchObject({ scanned: 0, alias: 0, newMetric: 0, drill: 0, hunt: 0 })
  })

  it('任一源抛错 ⇒ 向上抛（fail-fast，不吞）', async () => {
    const { io } = fakeIo({ readConv: async () => { throw new Error('OO _search HTTP 503') } })
    await expect(mineOnce(io, 'org1', 1_800_000_000_000_000)).rejects.toThrow('OO _search HTTP 503')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd modules/data && pnpm exec vitest run domain/demand/mine.test.ts`
Expected: FAIL（`Cannot find module './mine'`）

- [ ] **Step 3: 实现编排**

```ts
// mine.ts —— 一轮挖掘：读水位 → 拉两源 → 判定 → upsert → 成功后推进水位。
// 全部 IO 注入（MineIo），因此单测不连库不连网；CLI 组装真实现（scripts/demand-mining.mjs）。
import { classifyAudit, huntFromConvs, isProbeTarget } from './classify'
import type { AuditRow, ConvRow, DemandDraft } from './classify'
import type { CursorSource } from './store'

export interface MineIo {
  readCursor(org: string, source: CursorSource): Promise<number>
  writeCursor(org: string, source: CursorSource, value: number): Promise<void>
  readAudit(org: string, sinceId: number): Promise<{ rows: AuditRow[]; maxId: number }>
  readConv(org: string, sinceUs: number): Promise<ConvRow[]>
  readStuck(org: string, sessionIds: readonly string[]): Promise<Map<string, unknown[]>>
  catalogIds(org: string): Promise<string[]>
  upsert(org: string, draft: DemandDraft): Promise<void>
}

export interface MineSummary {
  scanned: number; alias: number; newMetric: number; drill: number; hunt: number
  skippedProbe: number; cursorAudit: number; cursorConv: number
}

/**
 * 一轮。顺序：先审计（驱动 skip 计数），再 conv（要会话 → 拉 stuck 证据）。
 * 水位**在对应源全部 upsert 成功后**推进——中途抛错则水位不动，下轮重读（upsert 幂等吸收）。
 */
export async function mineOnce(io: MineIo, org: string, nowUs: number): Promise<MineSummary> {
  const catalog = await io.catalogIds(org)
  const summary: MineSummary = {
    scanned: 0, alias: 0, newMetric: 0, drill: 0, hunt: 0, skippedProbe: 0,
    cursorAudit: await io.readCursor(org, 'query_audit'),
    cursorConv: await io.readCursor(org, 'askdata_conv'),
  }

  const audit = await io.readAudit(org, summary.cursorAudit)
  summary.scanned += audit.rows.length
  for (const row of audit.rows) {
    const draft = classifyAudit(row, catalog)
    if (draft === null) {
      // 只统计「本该是需求、但被探针前缀挡掉」的行；bad_param 等本来就不是需求，不计。
      const t = String(row.metric_id ?? '')
      if ((row.reason === 'metric_not_declared' || row.reason === 'no_detail_binding') && isProbeTarget(t)) {
        summary.skippedProbe += 1
      }
      continue
    }
    await io.upsert(org, draft)
    if (draft.kind === 'alias_gap') summary.alias += 1
    else if (draft.kind === 'new_metric') summary.newMetric += 1
    else summary.drill += 1
  }
  summary.cursorAudit = audit.maxId

  const conv = await io.readConv(org, summary.cursorConv)
  const sessionIds = [...new Set(conv.map((r) => r.session_id))]
  const stuck = sessionIds.length === 0 ? new Map<string, unknown[]>() : await io.readStuck(org, sessionIds)
  for (const draft of huntFromConvs(conv, stuck)) {
    await io.upsert(org, draft)
    summary.hunt += 1
  }
  const maxConv = conv.reduce((m, r) => Math.max(m, Number((r as { _timestamp?: number })._timestamp ?? 0)), 0)
  summary.cursorConv = maxConv > 0 ? maxConv : summary.cursorConv

  await io.writeCursor(org, 'query_audit', summary.cursorAudit)
  await io.writeCursor(org, 'askdata_conv', summary.cursorConv)
  return summary
}
```

>

- [ ] **Step 4: 跑测试确认通过**

Run: `cd modules/data && pnpm exec vitest run domain/demand/mine.test.ts`
Expected: PASS（4 个）

- [ ] **Step 5: 写 CLI 脚本**

```js
#!/usr/bin/env node
// demand-mining.mjs —— Phase 2 每日挖掘（openship job 经 docker exec 在 server 容器内跑）。
// 复用容器既有 env：DATABASE_URL + OO_READ_URL/OO_READ_ORG/OO_READ_TOKEN（无新凭据）。
// 退出码：0 = 成功（含 0 条）；1 = 环境/链路失败（缺 env、DB 不可达、OO 失败）——不吞。
import pg from 'pg'
import { mineOnce } from '../modules/data/domain/demand/mine.ts'
import { readCursor, upsertDemand, writeCursor } from '../modules/data/domain/demand/store.ts'
import { loadPlatformCatalog } from '../modules/data/domain/metric-store.ts'

const DAY_US = 86_400_000_000

const need = (k) => {
  const v = String(process.env[k] ?? '').trim()
  if (v === '') throw new Error(`demand-mining: 缺 ${k}`)
  return v
}

const authHeader = (raw) => {
  const t = raw.trim()
  return /^(Basic|Bearer)\s/i.test(t) ? t : `Basic ${t}`
}

function ooSearch(opts) {
  const base = opts.url.replace(/\/+$/, '')
  return async (stream, sinceUs, endUs, from, size) => {
    const body = {
      query: {
        sql: `select * from "${stream}" where _timestamp >= ${Math.trunc(sinceUs)} order by _timestamp asc, seq asc, sessionid asc`,
        start_time: sinceUs > 0 ? sinceUs : endUs - 7 * DAY_US,   // OO 拒绝 start_time=0
        end_time: endUs, from, size,
      },
    }
    const res = await fetch(`${base}/api/${encodeURIComponent(opts.org)}/_search`, {
      method: 'POST',
      headers: { Authorization: authHeader(opts.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`demand-mining: OO _search HTTP ${res.status} — ${(await res.text()).slice(0, 300)}`)
    const data = await res.json()
    if (data === null || typeof data !== 'object' || !Array.isArray(data.hits)) {
      throw new Error('demand-mining: OO _search 响应缺 hits 数组（不静默当空结果）')
    }
    return data.hits
  }
}

async function main() {
  const org = need('PLATFORM_ORG')
  const dsn = need('DATABASE_URL')
  const oo = ooSearch({ url: need('OO_READ_URL'), org: need('OO_READ_ORG'), token: need('OO_READ_TOKEN') })
  const pool = new pg.Pool({ connectionString: dsn })
  try {
    const endUs = Date.now() * 1000
    const summary = await mineOnce({
      readCursor: (o, s) => readCursor(pool, o, s),
      writeCursor: (o, s, v) => writeCursor(pool, o, s, v),
      readAudit: async (o, sinceId) => {
        const { rows } = await pool.query(
          `select id, metric_id, reason, params from data.query_audit
            where org = $1 and id > $2 and reason in ('metric_not_declared','no_detail_binding')
            order by id asc limit 1000`, [o, sinceId],
        )
        const { rows: maxRows } = await pool.query(
          'select coalesce(max(id), $2) as max from data.query_audit where org = $1', [o, sinceId],
        )
        return { rows, maxId: Number(maxRows[0].max) }
      },
      readConv: (_o, sinceUs) => oo('askdata_conv', sinceUs, endUs, 0, 5000),
      readStuck: async (_o, sessions) => {
        const want = new Set(sessions)
        if (want.size === 0) return new Map()
        const hits = await oo('askdata_stuck', endUs - 30 * DAY_US, endUs, 0, 5000)
        const byKey = new Map()   // (session,seq) → 版本号最大的一条
        for (const h of hits) {
          const sid = String(h.session_id ?? '')
          if (!want.has(sid)) continue
          const key = `${sid}#${h.seq}`
          const ver = Number(h.rule_ver ?? 0)
          if ((byKey.get(key)?.ruleVer ?? -1) >= ver) continue
          byKey.set(key, { rule: h.rule, seq: h.seq, ruleVer: ver, text: String(h.evidence ?? '').slice(0, 200) })
        }
        const bySession = new Map()
        for (const [key, ev] of byKey) {
          const sid = key.slice(0, key.lastIndexOf('#'))
          const arr = bySession.get(sid) ?? []
          arr.push(ev)
          bySession.set(sid, arr)
        }
        return bySession
      },
      catalogIds: async (o) => (await loadPlatformCatalog(pool)).map((m) => m.id),
      upsert: (o, d) => upsertDemand(pool, o, d),
    }, org, endUs)
    console.log(
      `demand-mining: scanned=${summary.scanned} alias=${summary.alias} new_metric=${summary.newMetric} ` +
      `drill=${summary.drill} hunt=${summary.hunt} skipped_probe=${summary.skippedProbe} ` +
      `cursor_audit=${summary.cursorAudit} cursor_conv=${summary.cursorConv}`,
    )
  } finally {
    await pool.end()
  }
}

main().catch((e) => { console.error(`demand-mining: FAIL ${e instanceof Error ? e.message : String(e)}`); process.exitCode = 1 })
```

- [ ] **Step 6: 本地干跑（本地 pg + 生产 OO 只读凭据）**

Run: `DATABASE_URL=postgres://localhost/ma_dev PLATFORM_ORG=demand-smoke OO_READ_URL=… OO_READ_ORG=… OO_READ_TOKEN=… npx tsx scripts/demand-mining.mjs`
Expected: 打印 `demand-mining: scanned=… ` 且 exit 0；`data.demand_signals` 出现 `demand-smoke` 的行；再跑一次 ⇒ `scanned` 增量（不重复计数），`occurrences` 不变。

- [ ] **Step 7: 提交**

```bash
git add modules/data/domain/demand/mine.ts modules/data/domain/demand/mine.test.ts scripts/demand-mining.mjs
git commit -m "feat(data): 需求挖掘编排与 CLI（水位入 DB，fail-fast）（Phase 2，#1404）"
```

---

### Task 4: manage 面两个 MCP 工具

**Files:**
- Create: `modules/data/domain/demand/tools.ts`（纯元数据）
- Create: `modules/data/domain/demand/handlers.ts`
- Create: `modules/data/domain/manage-face.ts`（合并面清单 + 预算）
- Modify: `modules/data/domain/pipelines/tools.ts`（删 `PIPELINE_FACE_MAX_TOOLS`，改由 manage-face 给总预算）
- Modify: `modules/data/domain/pipelines/tools.test.ts`（工具数断言改为 `PIPELINE_TOOLS.length === 9`）
- Modify: `modules/data/routes/mcp-pipeline-tools.ts`（合并清单 / 分派 / 装载期断言）
- Modify: `scripts/check-mcp-toolface.mjs`（改用 `MANAGE_TOOLS` + `MANAGE_FACE_MAX_TOOLS`）
- Test: `modules/data/domain/demand/handlers.test.ts`、`scripts/check-mcp-toolface.test.mjs`（若已存在则补一条断言）

**Interfaces:**
- Produces:
  - `DEMAND_TOOLS: readonly DemandToolMeta[]`（2 条：`list_demand_signals` / `dismiss_demand_signal`）
  - `MANAGE_TOOLS`（= PIPELINE_TOOLS + DEMAND_TOOLS）、`MANAGE_FACE_MAX_TOOLS = 11`、`manageToolMeta(name)`
  - `callDemandTool(d: McpDeps, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>`

- [ ] **Step 1: 写工具元数据**

```ts
// tools.ts —— 需求台账工具的**静态元数据**（纯：不 import pg / Hono / zod）。
// 与提案面工具（pipelines/tools.ts）分开：这里是治理读面，不是管线提案。
import type { ToolAnnotations } from '../toolbox/registry'

export interface DemandToolMeta {
  name: string; group: 'demand'; title: string; description: string
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>
  requiredScope: string | null; mutating: boolean; annotations: ToolAnnotations
}

const MANAGE_SCOPE = 'data:manage'
const anyObject = { type: 'object' }

export const DEMAND_TOOLS: readonly DemandToolMeta[] = [
  {
    name: 'list_demand_signals', group: 'demand', title: '需求台账清单',
    description: '列出从真实用法挖出的「想要但词表没有」的需求（alias_gap 别名缺口 / new_metric 真缺指标 / drill_gap 下钻缺口 / metric_hunt 口径寻路），按出现次数降序。每条带 resolved 自动判定：词表已补齐的条目标 resolved=true（metric_hunt 永不自动消解，只能人工否决）。默认不含已否决条目。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['alias_gap', 'new_metric', 'drill_gap', 'metric_hunt'] },
        includeResolved: { type: 'boolean', description: '缺省 false：不返回已自动消解的条目' },
        includeDismissed: { type: 'boolean', description: '缺省 false：不返回已否决的条目' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '缺省 20' },
      },
      required: [],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: { readOnlyHint: true },
  },
  {
    name: 'dismiss_demand_signal', group: 'demand', title: '否决一条需求',
    description: '把一条需求标记为「不建」（写 dismissed_at/by/reason），此后默认不再出现在清单里。重复否决幂等（回原否决信息）。受写总闸 DATA_MCP_ALLOW_MUTATING 门控。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['id', 'reason'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: { readOnlyHint: false },
  },
]
```

- [ ] **Step 2: 写 handlers（resolved 判定在这里）**

```ts
// handlers.ts —— 需求台账工具的 impl。payload 形状与其它 MCP 工具一致（status/reason）。
//
// ⚠️ 依赖面刻意用**本文件自带的最小窄类型**，不从 `../../routes/mcp-rpc` import `McpDeps`：
//   domain 层不得反向依赖路由层（路由只是调用方之一）。`McpDeps` 在结构上可赋给本类型。
import type { Pool } from 'pg'
import { loadPlatformCatalog } from '../metric-store'
import type { MetricRow } from '../metric-store'
import { dismissDemand, listDemands } from './store'
import type { DemandKind, DemandRow } from './store'

/** 本文件需要的那部分 deps（结构窄类型；`McpDeps` / 测试桩都能直接传）。 */
export interface DemandToolDeps {
  pool: Pool
  org: string
  requester: { userId: string } | null
}

const KINDS: readonly DemandKind[] = ['alias_gap', 'new_metric', 'drill_gap', 'metric_hunt']

/**
 * 取数扫描上限（**安全上限，不是分页**）：`resolved` 是词表快照上的运行期判定，SQL 里没有
 * 这一列 ⇒ 必须先取一批、判完再按 `limit` 截。若把 `limit` 直接压给 SQL，累积 20+ 条已被
 * 词表自动消解（但没人 dismiss）的高 occurrence 行会把窗口占满，默认清单看起来是空的，
 * 真正未消解的新需求排在窗口外且无 offset 可翻。
 *
 * 500 行的量级足够覆盖单租户台账的活跃面；**命中上限时回包带 `truncated: true`**，
 * 不静默——让人知道还有没扫到的（再要就给 kind 过滤，而不是假装扫全了）。
 */
export const LIST_SCAN_LIMIT = 500

/**
 * resolved：词表快照上的自动判定（不写回）。`metric_hunt` 永不自动消解——口径是人决。
 */
export function resolvedOf(row: DemandRow, byId: ReadonlyMap<string, MetricRow>): { resolved: boolean; resolvedBy: string | null } {
  if (row.kind === 'alias_gap') {
    const t = row.target.toLowerCase()
    for (const m of byId.values()) {
      if (m.synonyms.some((s) => s.toLowerCase() === t)) return { resolved: true, resolvedBy: `synonym@${m.id}` }
    }
    return { resolved: false, resolvedBy: null }
  }
  if (row.kind === 'new_metric') {
    return byId.has(row.target)
      ? { resolved: true, resolvedBy: `metric@${row.target}` }
      : { resolved: false, resolvedBy: null }
  }
  if (row.kind === 'drill_gap') {
    return byId.get(row.target)?.drill !== undefined
      ? { resolved: true, resolvedBy: `drill@${row.target}` }
      : { resolved: false, resolvedBy: null }
  }
  return { resolved: false, resolvedBy: null }
}

export async function callDemandTool(
  d: DemandToolDeps, name: string, args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === 'list_demand_signals') {
    const kind = typeof args.kind === 'string' && KINDS.includes(args.kind as DemandKind) ? args.kind as DemandKind : undefined
    if (args.kind !== undefined && kind === undefined) return { status: 'refused', reason: 'bad_kind' }
    const limit = Number.isInteger(args.limit) ? Math.min(50, Math.max(1, Number(args.limit))) : 20
    // **先取后过滤**：resolved 只存在于词表判定里，SQL 无法先滤；limit 压给 SQL 会被
    // 已消解的高 occurrence 行占满窗口（见 LIST_SCAN_LIMIT 头注）。
    const rows = await listDemands(d.pool, d.org, {
      ...(kind === undefined ? {} : { kind }),
      includeDismissed: args.includeDismissed === true,
      limit: LIST_SCAN_LIMIT,
    })
    const catalog = await loadPlatformCatalog(d.pool)
    const byId = new Map(catalog.map((m) => [m.id, m]))
    const items = rows.map((r) => ({ ...r, ...resolvedOf(r, byId) }))
      .filter((r) => args.includeResolved === true || !r.resolved)
      .slice(0, limit)
    return { status: 'ok', count: items.length, items, truncated: rows.length >= LIST_SCAN_LIMIT }
  }
  if (name === 'dismiss_demand_signal') {
    const id = Number(args.id)
    const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
    if (!Number.isInteger(id) || id <= 0 || reason === '') return { status: 'refused', reason: 'invalid_args' }
    const out = await dismissDemand(d.pool, d.org, id, d.requester?.userId ?? '(anonymous)', reason)
    if (out.status === 'not_found') return { status: 'not_found', reason: 'demand_not_found', id }
    if (out.status === 'already') {
      return { status: 'ok', reason: 'already_dismissed', id, dismissedBy: out.row.dismissedBy, dismissReason: out.row.dismissReason }
    }
    return { status: 'ok', id }
  }
  return { status: 'refused', reason: 'unknown_tool', name }
}
```

- [ ] **Step 3: 合并面清单**

```ts
// manage-face.ts —— manage 面（/mcp-manage）的工具总清单与预算。
import type { ToolAnnotations } from './toolbox/registry'
import { PIPELINE_TOOLS } from './pipelines/tools'
import { DEMAND_TOOLS } from './demand/tools'

export interface ManageToolMeta {
  name: string; group: string; title: string; description: string
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>
  requiredScope: string | null; mutating: boolean; annotations: ToolAnnotations
}

/** 9（提案面）+ 2（需求台账）= 11。超了 tools/list 的 10KB 预算会先炸门禁。 */
export const MANAGE_FACE_MAX_TOOLS = 11

export const MANAGE_TOOLS: readonly ManageToolMeta[] = [...PIPELINE_TOOLS, ...DEMAND_TOOLS]

export function manageToolMeta(name: string): ManageToolMeta | undefined {
  return MANAGE_TOOLS.find((t) => t.name === name)
}
```

`pipelines/tools.ts`：删除 `export const PIPELINE_FACE_MAX_TOOLS = 9`，头注改为「本文件是提案片；manage 面总清单与预算见 `manage-face.ts`」。`tools.test.ts` 的 `expect(PIPELINE_TOOLS.length).toBe(PIPELINE_FACE_MAX_TOOLS)` 改为 `toBe(9)`；新增 `packages` 里对 `MANAGE_TOOLS.length === MANAGE_FACE_MAX_TOOLS` 的断言（放 `manage-face.test.ts`）。

- [ ] **Step 4: 改路由分派**

`mcp-pipeline-tools.ts` 的改动点（逐条）：

```ts
import { MANAGE_TOOLS, MANAGE_FACE_MAX_TOOLS, manageToolMeta } from '../domain/manage-face'
import { callDemandTool } from '../domain/demand/handlers'
// 原 imports 里的 PIPELINE_TOOLS / pipelineToolMeta 可保留（IMPLS 断言仍按 PIPELINE_TOOLS）……

// 装载期断言：两份清单都要有实现
for (const t of MANAGE_TOOLS) {
  const hasImpl = typeof IMPLS[t.name] === 'function' || t.name.startsWith('list_demand') || t.name.startsWith('dismiss_demand')
  if (!hasImpl) throw new Error(`manage tools: 「${t.name}」没有实现（IMPLS / callDemandTool 漏登记）`)
}

// list() 返回 MANAGE_TOOLS；call() 先用 manageToolMeta 判归属，再分两条路：
const meta = manageToolMeta(name)
if (meta === undefined) return null
if (d.requester === null) return reply(d, name, args, { status: 'denied', reason: 'unauthenticated' }, true, null)
if (meta.mutating && !mutatingAllowed(wiring.env)) {
  return reply(d, name, args, { status: 'denied', reason: 'mutating_disabled', name }, true, null)
}
const payload = meta.group === 'demand'
  ? await callDemandTool(d, name, args)
  : await IMPLS[name]!(depsOf(d), args)
```

（`verdictOf` / `reply` 不动；审计行 `tool` = 工具名。）

- [ ] **Step 5: 改门禁**

`check-mcp-toolface.mjs`：

```js
import { MANAGE_FACE_MAX_TOOLS, MANAGE_TOOLS } from '../modules/data/domain/manage-face.ts'
// main 里：
...checkToolface(MANAGE_TOOLS, { maxTools: MANAGE_FACE_MAX_TOOLS }),
```

- [ ] **Step 6: 写 handlers 测试（注入假 pool/词表）**

```ts
import { describe, expect, it } from 'vitest'
import { resolvedOf } from './handlers'
import type { DemandRow } from './store'

const row = (kind: DemandRow['kind'], target: string): DemandRow => ({
  id: 1, kind, target, detail: {}, occurrences: 1, firstSeen: '', lastSeen: '', evidence: [],
  dismissedAt: null, dismissedBy: null, dismissReason: null,
})
const metric = (id: string, synonyms: string[] = [], drill = false) => ({
  id, synonyms, ...(drill ? { drill: { expr: 'x', dims: [], detail: { relation: 'r' } } } : {}),
}) as never

describe('resolvedOf', () => {
  it('alias_gap：synonyms 已含该说法 ⇒ resolved', () => {
    const byId = new Map([['lemeng:retail:net_sales', metric('lemeng:retail:net_sales', ['净销售额'])]])
    expect(resolvedOf(row('alias_gap', '净销售额'), byId)).toEqual({ resolved: true, resolvedBy: 'synonym@lemeng:retail:net_sales' })
    expect(resolvedOf(row('alias_gap', 'net_sales'), byId).resolved).toBe(false)
  })
  it('new_metric：id 已存在 ⇒ resolved', () => {
    expect(resolvedOf(row('new_metric', 'lemeng:retail:target'), new Map([['lemeng:retail:target', metric('lemeng:retail:target')]])).resolved).toBe(true)
  })
  it('drill_gap：指标已有 drill ⇒ resolved', () => {
    const byId = new Map([['lemeng:outbound:net_amount', metric('lemeng:outbound:net_amount', [], true)]])
    expect(resolvedOf(row('drill_gap', 'lemeng:outbound:net_amount'), byId).resolved).toBe(true)
  })
  it('metric_hunt 永不自动消解', () => {
    expect(resolvedOf(row('metric_hunt', 's1|2026-10-10..2026-10-16'), new Map())).toEqual({ resolved: false, resolvedBy: null })
  })
})
```

- [ ] **Step 7: 跑测试与门禁**

Run:
```bash
cd modules/data && pnpm exec vitest run domain/demand domain/pipelines/tools.test.ts domain/manage-face.test.ts
cd ../.. && pnpm exec tsx scripts/check-mcp-toolface.mjs
```
Expected: 全 PASS；门禁输出 `check-mcp-toolface: OK`。

- [ ] **Step 8: 提交**

```bash
git add modules/data/domain/demand/tools.ts modules/data/domain/demand/handlers.ts \
  modules/data/domain/demand/handlers.test.ts modules/data/domain/manage-face.ts \
  modules/data/domain/manage-face.test.ts modules/data/domain/pipelines/tools.ts \
  modules/data/domain/pipelines/tools.test.ts modules/data/routes/mcp-pipeline-tools.ts \
  scripts/check-mcp-toolface.mjs
git commit -m "feat(data): manage 面需求台账工具（list/dismiss，预算 9→11）（Phase 2，#1404）"
```

---

### Task 5: 收口（全量验证 + 台账 + 部署 + 真机）

**Files:**
- Modify: `docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md`（§5 台账 Phase 2 行）

- [ ] **Step 1: 全量验证**

```bash
cd modules/data && DATABASE_URL=postgres://localhost/ma_dev pnpm test        # 期望 exit 0
cd ../.. && pnpm run test:guard                                              # 期望 exit 0
pnpm run typecheck                                                           # apps/web 既有红不算本波（台账同款）
pnpm run typecheck:scripts
pnpm exec tsx scripts/check-mcp-toolface.mjs                                 # OK
```

- [ ] **Step 2: 更新路线图台账**

Phase 2 行改为：状态 `已完成`、开始/完成日期、PR / 证据（沿用 §5 的写法：commit 列表 + 本地测试证据 + 真机证据）、偏离与备注（四类判定、探针排除、水位入 DB、`metric_hunt` 结构判据、已知边界 §8 的六条）。

- [ ] **Step 3: 开 PR 并等 CI**

```bash
git add docs/superpowers/plans/2026-11-04-auto-metric-derivation-roadmap.md
git commit -m "docs(plans): Phase 2 台账置为已完成（#1404）"
```
PR body 带 `Closes #1404`（feat 类 change 需先有 issue——#1404 已存在）。CI 全绿后合并。

- [ ] **Step 4: 部署后建 job（控制器执行，openship MCP）**

job 定义（每 CST 05:10 = UTC 21:10）：

```json
{
  "label": "demand-mining-shanhai",
  "command": "CID=$(docker ps -q --filter 'name=openship-platform-core-shanhai-server' | head -1); if [ -z \"$CID\" ]; then echo 'NO_SERVER_CONTAINER'; exit 1; fi; docker exec \"$CID\" sh -lc 'cd /app && npx tsx scripts/demand-mining.mjs'",
  "serverId": "8281d598-af73-4d0b-99dd-bc8681fcc8bb",
  "cronExpression": "10 21 * * *",
  "scheduleType": "recurring",
  "timeoutMs": 300000,
  "notifyConfig": { "states": ["failed"], "channels": ["nch_XBUs425hd_KsA_lt"] }
}
```

- [ ] **Step 5: 真机验收**

1. 手动 `POST /jobs/<key>/run` ⇒ run `success`，output 含 `demand-mining: scanned=… alias=… new_metric=… drill=… hunt=…`。
2. 生产库查 `select kind, count(*) from data.demand_signals group by 1` ⇒ `alias_gap` / `new_metric` / `drill_gap` 各 ≥1（`metric_hunt` 视 conv 数据）。
3. 用 manage 面 MCP 调 `list_demand_signals` ⇒ 返回可读清单，`resolved` 判定与词表一致。
4. 调 `dismiss_demand_signal` 否决一条 ⇒ 再调 `list_demand_signals` 不再出现；重复否决回 `already_dismissed`。
5. 再跑一次 job ⇒ `occurrences` 不重复增长（水位入 DB 生效）。

## Self-Review

- Spec 覆盖：§2 四类判定（Task 2）· §3 表与水位（Task 1）· §4 挖掘器与失败语义（Task 3）· §5 两工具与预算（Task 4）· §7 验收（Task 5）· §8 已知边界（Task 5 台账登记）✅
- 无占位符：所有代码块可直接落盘（`mine.ts` 的 `skippedProbe` 用 `isProbeTarget` 判，stuck 证据按会话累加而非覆盖）。
- 类型一致性：`DemandKind`/`DemandRow`/`DemandDraft`/`MineIo` 在 Task 1/2/3/4 之间一致；`CursorSource` 只在 store 与 mine 之间使用。
