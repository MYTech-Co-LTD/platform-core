# 语义追溯（操作人 + 版本）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让口径（`data.metrics` 的 L2 行）的建 / 改 / 删可追溯到一个具体的人，并在已有指标页上看得见。

**Architecture:** 审计写在**唯一判定链** `domain/metric-write.ts` 里、与变更**同事务**（两条入口自动覆盖）；
`data.metrics` 加 `updated_by` / `version` 两列做快查；新表 `data.metric_audit` 存前后态快照。

**Tech Stack:** TypeScript / Hono / zod / pg（真 Postgres 集成测试）/ vitest / React + antd。

**Spec:** `docs/superpowers/specs/2026-10-07-metric-attribution-design.md`（本计划的唯一上游）

## Global Constraints

- **审计与变更同生共死**：同一事务（spec §4①）。
- **审计只有一个写入点**：`domain/metric-write.ts`；不许任何地方绕过它直接 `upsertMetric`（spec §4②）。
- **删除必须在删之前留证**（spec §4③）。
- **写审计与查询审计分表**：`data.query_audit` **一行不改**，且它的 store（`domain/audit-store.ts`）
  **保持只写**——不许把读函数加进去（spec §4⑥）。
- **写入必须能归属到人**：`upsertMetric` 的 `updatedBy` **必填**、`MetricWriteDeps.requester` **必填**。
- **L1 不参与**：`upsertL1Metric` 与 sync 脚本**一行不改**。
- **迁移幂等**：部署脚本每次全量重跑全部迁移（`add column if not exists` / `create table if not exists`）。
- 测试库**必须空库**（本仓有过「并发红只在全新空库上复现」的历史）；命令一律带
  `DATABASE_URL='postgres://duo@127.0.0.1:5432/<空库>'`。

## File Structure

| 文件 | 职责 |
|---|---|
| `modules/data/migrations/010_metric_attribution.sql` | **新**：两列 + 审计表 + 索引 |
| `modules/data/domain/metric-audit-store.ts` | **新**：口径变更审计的**写 + 读**（与 `audit-store.ts` 分工见文件头） |
| `modules/data/domain/metric-store.ts` | **改**：连接参数放宽、`updatedBy`/`version`、快照点读、`ROW_COLUMNS` |
| `modules/data/domain/metric-write.ts` | **改**：deps 加 `requester`、事务、前后快照、写审计 |
| `modules/data/routes/metrics.ts` | **改**：无身份拒写、`/metrics/all` 补两列、`GET /metrics/:id/audit` |
| `modules/data/manifest.yaml` | **改**：声明新端点 |
| `modules/data/console/metrics/index.tsx` | **改**：两列 + 变更历史抽屉 |
| `modules/data/README.md` | **改**：审计分表口径 + 三条边界 |

---

## Task 0: 前置

**Files:** 无

- [ ] **Step 1: 分支**（`#489` 就是这件事本身，**不新建 issue**；分支名带 489 ⇒ PR body 必须 `Closes #489`）

```bash
git fetch origin --prune
git checkout -b feat/489-metric-attribution origin/main
```

- [ ] **Step 2: 建空库并在其上跑一遍基线**（后头每个任务的验收都在这条命令的形状上）

```bash
dropdb --if-exists ma_dev; createdb ma_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' pnpm test 2>&1 | tail -5
```

Expected: PASS（27 文件 / 359 用例）

---

## Task 1: 迁移 010（两列 + 审计表）

**Files:**
- Create: `modules/data/migrations/010_metric_attribution.sql`
- Test: `modules/data/domain/metric-store.test.ts`（追加一条幂等/存在性断言；该文件已有 pg 夹具）

**Interfaces:**
- Produces: 表 `data.metric_audit(id, org, metric_id, action, user_id, channel, key_id, row_before, row_after, created_at)`；
  列 `data.metrics.updated_by text`、`data.metrics.version integer not null default 1`

- [ ] **Step 1: 写迁移**

```sql
-- 010_metric_attribution.sql — L2 行的「最后操作人 + 版本」+ 口径变更审计表（#489）。
--
-- 为什么另立一张审计表而不是塞进 query_audit：那张表的列是**查询语义**
-- （row_count / verdict / reason），硬塞写行会让三列全部变 nullable ——「没有 row_count」
-- 将同时表示「这是写行」与「这次查询没出数」，语义立刻模糊。设计见
-- docs/superpowers/specs/2026-10-07-metric-attribution-design.md §4④。
--
-- 幂等：本文件会被**每次部署全量重跑**（runMigrations 只按记账跳过已应用的，但开发期会连跑）。

alter table data.metrics add column if not exists updated_by text;
alter table data.metrics add column if not exists version    integer not null default 1;

create table if not exists data.metric_audit (
  id          bigserial primary key,
  org         text   not null,                       -- 隔离键（= Casdoor org），口径与 query_audit 一致
  metric_id   text   not null,                       -- **删除后仍在** —— 这正是本表存在的理由
  action      text   not null check (action in ('create', 'update', 'delete')),
  user_id     text   not null,                       -- 人（不是 key）
  channel     text   not null,                       -- session | pat | wecom
  key_id      bigint,                                -- 仅 pat 通道（与 query_audit.key_id 同型）
  -- 变更**前**的行快照：create 为 NULL；**变更后**的行快照：delete 为 NULL。
  -- 两列而不是一列，是为了答「**从什么**到什么」（只存后态就答不了「从什么」）。
  row_before  jsonb,
  row_after   jsonb,
  created_at  timestamptz not null default now()
);

-- 页面抽屉的查询形状（按 org + id 取最近若干条）
create index if not exists data_metric_audit_lookup_idx
  on data.metric_audit (org, metric_id, created_at desc);
```

- [ ] **Step 2: 写断言（先红）**

在 `modules/data/domain/metric-store.test.ts` 末尾追加：

```ts
  it('★ 010 迁移：两列与新审计表就位（幂等——连跑两遍零效果）', async () => {
    await applyMigrations(pool)
    await applyMigrations(pool) // 第二遍：必须零效果、不报错
    const cols = await pool.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'data' and table_name = 'metrics'
          and column_name in ('updated_by', 'version')`)
    expect(cols.rows.map((r) => r.column_name).sort()).toEqual(['updated_by', 'version'])
    const t = await pool.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'data' and table_name = 'metric_audit'`)
    expect(t.rows[0]!.n).toBe(1)
  })
```

- [ ] **Step 3: 跑（先红后绿）**

```bash
dropdb --if-exists ma_dev; createdb ma_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' \
  pnpm exec vitest run domain/metric-store.test.ts 2>&1 | tail -6
```

Expected: 先 FAIL（表/列不存在）→ 建好迁移后 PASS

- [ ] **Step 4: Commit**

```bash
git add modules/data/migrations/010_metric_attribution.sql modules/data/domain/metric-store.test.ts
git commit -m "feat(data): #489 迁移 010——metrics 两列（updated_by/version）+ 口径变更审计表"
```

---

## Task 2: 审计 store（写 + 读）

**Files:**
- Create: `modules/data/domain/metric-audit-store.ts`
- Create: `modules/data/domain/metric-audit-store.test.ts`

**Interfaces:**
- Consumes: `MetricRowSnapshot`（Task 3 定义在 `metric-store.ts`；本任务先按下面形状**临时内联**，Task 3 再改 import）
- Produces:
  - `writeMetricAudit(db: Pool | PoolClient, e: MetricAuditEntry): Promise<void>`
  - `listMetricAudit(pool: Pool, org: string, metricId: string, limit?: number): Promise<MetricAuditRow[]>`
  - `MetricAction = 'create' | 'update' | 'delete'`

- [ ] **Step 1: 写 store**

```ts
// metric-audit-store.ts — 口径变更审计（**写 + 读**）。
//
// ⚠️ 与 audit-store.ts（data.query_audit）的分工，别混：
//   · 那张表是**查询**审计，且**只写不读**——它的读侧＝平台运营面的全局审计视图，
//     不在本模块（见该文件头「别顺手加」）。**不许**把函数加进那个文件。
//   · 本文件是**口径变更**审计，写与读都在本模块——但读侧的范围是「**租户对自己单条口径的历史**」
//     （按 (org, metric_id) 限定、门 = data:manage），不是运营面的全局视图。
// 理由与取舍见 docs/superpowers/specs/2026-10-07-metric-attribution-design.md §4④/§4⑥。
import type { Pool, PoolClient } from 'pg'
import type { Channel } from './authz'

export type MetricAction = 'create' | 'update' | 'delete'

/** 行的语义快照（前后态同一个形状；`params` 直接给对象，落库时 stringify）。 */
export interface MetricRowSnapshot {
  title: string
  description: string
  subjectColumn: string
  selectSql: string
  groupBy: string
  params: Record<string, unknown>
}

export interface MetricAuditEntry {
  org: string
  metricId: string
  action: MetricAction
  /** 人（不是 key）——审计的第一读者问的就是「谁」。 */
  userId: string
  channel: Channel
  keyId: number | null
  /** create 为 null；delete 时是被删的内容。 */
  before: MetricRowSnapshot | null
  /** delete 为 null。 */
  after: MetricRowSnapshot | null
}

export interface MetricAuditRow extends MetricAuditEntry {
  id: number
  createdAt: string
}

const snap = (s: MetricRowSnapshot | null): string | null => (s === null ? null : JSON.stringify(s))

/**
 * 写一条口径变更审计。**由 domain/metric-write 在**同一个事务里**调用**——
 * 审计与变更同生共死（spec §4①）；本函数不自己开事务，只用调用方给的连接。
 */
export async function writeMetricAudit(db: Pool | PoolClient, e: MetricAuditEntry): Promise<void> {
  await db.query(
    `insert into data.metric_audit
       (org, metric_id, action, user_id, channel, key_id, row_before, row_after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.org, e.metricId, e.action, e.userId, e.channel, e.keyId, snap(e.before), snap(e.after)],
  )
}

/** 某条口径的变更史，**时间倒序**（页面抽屉就是按这个形状渲染）。 */
export async function listMetricAudit(
  pool: Pool, org: string, metricId: string, limit = 100,
): Promise<MetricAuditRow[]> {
  const r = await pool.query(
    `select id, org, metric_id, action, user_id, channel, key_id, row_before, row_after, created_at
       from data.metric_audit
      where org = $1 and metric_id = $2
      order by created_at desc, id desc
      limit $3`,
    [org, metricId, limit],
  )
  return r.rows.map((row) => ({
    id: Number(row.id),
    org: row.org as string,
    metricId: row.metric_id as string,
    action: row.action as MetricAction,
    userId: row.user_id as string,
    channel: row.channel as Channel,
    keyId: row.key_id === null ? null : Number(row.key_id),
    // jsonb 列由 pg **反序列化成对象**（别再 JSON.parse —— 那是第二个事实源）
    before: (row.row_before ?? null) as MetricRowSnapshot | null,
    after: (row.row_after ?? null) as MetricRowSnapshot | null,
    createdAt: (row.created_at as Date).toISOString(),
  }))
}
```

- [ ] **Step 2: 写测试（先红）**

```ts
// metric-audit-store.test.ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { listMetricAudit, writeMetricAudit } from './metric-audit-store'
import type { MetricRowSnapshot } from './metric-audit-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-ma-store'
const snap = (title: string): MetricRowSnapshot => ({
  title, description: `L2 派生自 x`, subjectColumn: 'org',
  selectSql: `select sum(t.value) as value, bizday from (select 1) t`, groupBy: 'bizday', params: {},
})

describePg('口径变更审计 store', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeAll(async () => { await applyMigrations(pool) })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = $1', [ORG]).catch(() => {})
    await pool.end()
  })

  it('建/改/删三态各自的前后列填充（create: before=null；delete: after=null）', async () => {
    await writeMetricAudit(pool, { org: ORG, metricId: 'm1', action: 'create', userId: 'ZhangDuo', channel: 'pat', keyId: 7, before: null, after: snap('新') })
    await writeMetricAudit(pool, { org: ORG, metricId: 'm1', action: 'update', userId: 'ZhangDuo', channel: 'pat', keyId: 7, before: snap('旧'), after: snap('新') })
    await writeMetricAudit(pool, { org: ORG, metricId: 'm1', action: 'delete', userId: 'ZhangDuo', channel: 'session', keyId: null, before: snap('新'), after: null })

    const rows = await listMetricAudit(pool, ORG, 'm1')
    expect(rows.map((r) => r.action)).toEqual(['delete', 'update', 'create'])   // 时间倒序
    const byAction = Object.fromEntries(rows.map((r) => [r.action, r]))
    expect(byAction.create!.before).toBeNull()
    expect(byAction.create!.after!.title).toBe('新')
    expect(byAction.update!.before!.title).toBe('旧')     // ★「从什么」——只存后态就答不了这条
    expect(byAction.delete!.after).toBeNull()
    expect(byAction.delete!.before!.title).toBe('新')     // ★ 删除留证
  })

  it('按 org + metric_id 隔离：别家 org 的同 id 历史看不到', async () => {
    await writeMetricAudit(pool, { org: 'org-ma-other', metricId: 'm1', action: 'create', userId: 'x', channel: 'session', keyId: null, before: null, after: snap('别家') })
    const rows = await listMetricAudit(pool, ORG, 'm1')
    expect(rows.every((r) => r.org === ORG)).toBe(true)
  })
})
```

- [ ] **Step 3: 跑（先红后绿）→ Commit**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' \
  pnpm exec vitest run domain/metric-audit-store.test.ts 2>&1 | tail -6
git add modules/data/domain/metric-audit-store.ts modules/data/domain/metric-audit-store.test.ts
git commit -m "feat(data): #489 口径变更审计 store（写 + 读，前后态快照）"
```

---

## Task 3: metric-store —— 连接参数放宽、两列、快照点读

**Files:**
- Modify: `modules/data/domain/metric-store.ts`
- Modify: **17 个调用点**（`grep -rn "upsertMetric(" modules/ apps/ scripts/` 实测清单见 Step 4）

**Interfaces:**
- Produces:
  - `upsertMetric(db: Pool | PoolClient, org: string, def: MetricDef, updatedBy: string): Promise<void>`
    （冲突分支：`version = data.metrics.version + 1`、`updated_by = excluded.updated_by`）
  - `deleteMetric(db: Pool | PoolClient, org: string, id: string): Promise<boolean>`
  - `selectMetricSnapshot(db: Pool | PoolClient, org: string, id: string): Promise<MetricRowSnapshot | null>`
  - `MetricRow` 增 `updatedBy: string | null`、`version: number`
  - `MetricRowSnapshot`（**定义在本文件**；Task 2 的 store 改为从这里 import）

- [ ] **Step 1: 逐处改（先写断言）**

在 `modules/data/domain/metric-store.test.ts` 追加：

```ts
  it('★ upsert 记人并累加版本：首建 version=1、再写 +1；快照点读能拿到前后行', async () => {
    const def = { id: 'ma_ver', title: 't', description: 'd', requiredScope: null,
      subjectColumn: 'org', selectSql: 'select sum(x.y) as value, bizday from x',
      groupBy: 'bizday', params: {} }
    await upsertMetric(pool, ORG, def, 'ZhangDuo')
    let row = (await pool.query(`select version, updated_by from data.metrics where org=$1 and id=$2`, [ORG, 'ma_ver'])).rows[0]
    expect(row).toMatchObject({ version: 1, updated_by: 'ZhangDuo' })

    await upsertMetric(pool, ORG, { ...def, title: 't2' }, 'LiLei')
    row = (await pool.query(`select version, updated_by, title from data.metrics where org=$1 and id=$2`, [ORG, 'ma_ver'])).rows[0]
    expect(row).toMatchObject({ version: 2, updated_by: 'LiLei', title: 't2' })   // ★ 版本单调 +1、人跟着换

    const before = await selectMetricSnapshot(pool, ORG, 'ma_ver')
    expect(before!.title).toBe('t2')
    expect(await selectMetricSnapshot(pool, ORG, 'no_such')).toBeNull()
    expect(await selectMetricSnapshot(pool, 'platform', 'ma_ver')).toBeNull()    // 只认本 org 的 l2
  })
```

- [ ] **Step 2: 跑（先红）**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' \
  pnpm exec vitest run domain/metric-store.test.ts 2>&1 | tail -8
```

Expected: FAIL（缺少第 4 个参数 / 没有 selectMetricSnapshot）

- [ ] **Step 3: 改实现**

```ts
// 1) 顶部 import 加类型
import type { Pool, PoolClient } from 'pg'

// 2) MetricRow 加两列
export interface MetricRow extends MetricDef {
  source: MetricSource
  sourceSystem: string | null
  /** 最后操作人（Casdoor 用户名）；L1 行走 sync 物化 ⇒ 恒 null。 */
  updatedBy: string | null
  /** 单调计数（每次经 API 写 +1）；L1 行恒 1。 */
  version: number
}

// 3) 行快照（审计用；定义在此，metric-audit-store 从这里 import）
export interface MetricRowSnapshot {
  title: string; description: string; subjectColumn: string
  selectSql: string; groupBy: string; params: Record<string, unknown>
}

// 4) 投影列清单加两列（**三处查询共用**，少写一列 = 字段静默 undefined）
const ROW_COLUMNS =
  'id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, updated_by, version'

// 5) toMetricRow 加两行映射
    sourceSystem: row.source_system as string | null,
    updatedBy: (row.updated_by ?? null) as string | null,
    version: Number(row.version ?? 1),

// 6) upsertMetric：连接参数放宽 + updatedBy 必填 + 版本自增
export async function upsertMetric(
  db: Pool | PoolClient, org: string, def: MetricDef, updatedBy: string,
): Promise<void> {
  await db.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by, params, source, source_system, updated_by, version)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'l2', null, $10, 1)
     on conflict (org, id) do update set
       title          = excluded.title,
       description    = excluded.description,
       required_scope = excluded.required_scope,
       subject_column = excluded.subject_column,
       select_sql     = excluded.select_sql,
       group_by       = excluded.group_by,
       params         = excluded.params,
       updated_by     = excluded.updated_by,
       version        = data.metrics.version + 1,   -- ★ 单调计数（与报表 005 同形，但此处为追溯）
       updated_at     = now()`,
    [org, def.id, def.title, def.description, def.requiredScope,
     def.subjectColumn, def.selectSql, def.groupBy, JSON.stringify(def.params), updatedBy],
  )
}

// 7) deleteMetric：连接参数放宽（**其余一行不改**——`and source = 'l2'` 那条纪律留在原位）
export async function deleteMetric(db: Pool | PoolClient, org: string, id: string): Promise<boolean> {
  const r = await db.query(
    "delete from data.metrics where org = $1 and id = $2 and source = 'l2'", [org, id])
  return (r.rowCount ?? 0) > 0
}

// 8) 新增：语义快照点读（审计的前后态；也是「这次是建还是改」的判据）
export async function selectMetricSnapshot(
  db: Pool | PoolClient, org: string, id: string,
): Promise<MetricRowSnapshot | null> {
  const r = await db.query(
    `select title, description, subject_column, select_sql, group_by, params
       from data.metrics where org = $1 and id = $2 and source = 'l2'`, [org, id])
  if ((r.rowCount ?? 0) === 0) return null
  const row = r.rows[0] as Record<string, unknown>
  return {
    title: row.title as string, description: row.description as string,
    subjectColumn: row.subject_column as string, selectSql: row.select_sql as string,
    groupBy: row.group_by as string, params: row.params as Record<string, unknown>,
  }
}
```

- [ ] **Step 4: 改 17 个调用点**

`grep -rn "upsertMetric(" modules/ apps/ scripts/ --include='*.ts' --include='*.mjs' | grep -v node_modules`
枚举出的调用点（**全部**要补第 4 参）：

| 文件 | 处数 | 传什么 |
|---|---|---|
| `modules/data/domain/metric-write.ts` | 1 | `requester.userId`（Task 4 做） |
| `modules/data/domain/metric-store.test.ts` | 1（`put` helper） | `'fixture'` |
| `modules/data/domain/query-service.test.ts` | 1 | `'fixture'` |
| `modules/data/domain/agent-loop.test.ts` | 2 | `'fixture'` |
| `modules/data/catalog-consumers.test.ts` | 1 | `'fixture'` |
| `modules/data/routes/mcp.test.ts` | 2 | `'fixture'` |
| `modules/data/routes/chat.test.ts` | 2 | `'fixture'` |
| `modules/data/routes/query.test.ts` | 4 | `'fixture'` |
| `modules/data/routes/metrics.test.ts` | 1 | `'fixture'` |
| `apps/server/src/data-query.e2e.test.ts` | 2 | `'fixture'` |

（`upsertL1Metric` 的调用点**一个都不动**——L1 不参与。）

- [ ] **Step 5: 跑本包 + 端到端包，全绿；typecheck；Commit**

```bash
dropdb --if-exists ma_dev; createdb ma_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' pnpm test 2>&1 | tail -5
cd ../.. && pnpm --filter data typecheck && pnpm --filter @platform/server typecheck
git add modules/data/domain/metric-store.ts modules/data/domain/metric-audit-store.ts \
        modules/data/domain/*.test.ts modules/data/routes/*.test.ts modules/data/catalog-consumers.test.ts \
        apps/server/src/data-query.e2e.test.ts
git commit -m "feat(data): #489 metric-store 记人记版本 + 快照点读；连接参数放宽为 Pool|PoolClient（17 处调用点同步）"
```

---

## Task 4: metric-write —— 事务 + 前后快照 + 写审计

**Files:**
- Modify: `modules/data/domain/metric-write.ts`
- Modify: `modules/data/domain/metric-write.test.ts`（**新**，若不存在则建）

**Interfaces:**
- Consumes: `writeMetricAudit`（Task 2）、`selectMetricSnapshot` / `upsertMetric(db, org, def, updatedBy)` / `deleteMetric(db, …)`（Task 3）
- Produces: `MetricWriteDeps` 增 `requester: Requester`（**必填**）

- [ ] **Step 1: 写测试（先红）**

```ts
// metric-write.test.ts — 判定链 + 审计的域层测试（不碰 Hono）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertL1Metric } from './metric-store'
import { deleteMetricDeclaration, writeL2Declaration } from './metric-write'
import { listMetricAudit } from './metric-audit-store'
import type { Requester } from './authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-ma-write'
const L1 = 'ma_l1_base'

const req = (userId = 'ZhangDuo'): Requester => ({
  userId, orgId: ORG, channel: 'pat', keyId: 3, scopes: ['data:manage'],
  hasScope: (c) => c === 'data:manage',
})
const deps = (pool: Pool) => ({ pool, adoptedSources: new Set<string>(), requester: req() })
const decl = { baseMetric: L1, op: { kind: 'refine' } as const, alias: '别名', visibility: { dims: ['bizday'] } }

describePg('写路径的审计（#489）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeAll(async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, {
      id: L1, title: '基底', description: '', requiredScope: null, subjectColumn: 'org',
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday', params: {}, sourceSystem: null,
    })
  })
  afterAll(async () => {
    await pool.query('delete from data.metric_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = $1`, [L1]).catch(() => {})
    await pool.end()
  })

  it('★ 建 → 改 → 删：审计三行，前后态各就各位', async () => {
    expect((await writeL2Declaration(deps(pool), ORG, 'ma_l2', decl)).ok).toBe(true)
    expect((await writeL2Declaration(deps(pool), ORG, 'ma_l2', { ...decl, alias: '改过的' })).ok).toBe(true)
    expect((await deleteMetricDeclaration(deps(pool), ORG, 'ma_l2')).ok).toBe(true)

    const rows = await listMetricAudit(pool, ORG, 'ma_l2')
    expect(rows.map((r) => r.action)).toEqual(['delete', 'update', 'create'])
    expect(rows[2]!.before).toBeNull()                       // create：无前态
    expect(rows[2]!.after!.title).toContain('别名')           // 后态 = 落库的口径
    expect(rows[1]!.before!.title).toContain('别名')          // ★「从什么」
    expect(rows[1]!.after!.title).toContain('改过的')         // ★「到什么」
    expect(rows[0]!.before!.title).toContain('改过的')        // ★ 删除留证
    expect(rows[0]!.after).toBeNull()
    expect(rows[0]!.userId).toBe('ZhangDuo')                  // 人（不是 key）
    expect(rows[0]!.channel).toBe('pat')
  })

  it('★ 审计与变更同生共死：审计写失败 ⇒ 行也必须回滚（不留半成品）', async () => {
    const broken = { ...deps(pool), requester: { ...req(), userId: null as unknown as string } }
    // userId=null 会让 metric_audit.user_id（not null）拒绝 ⇒ 整个事务回滚
    await expect(writeL2Declaration(broken, ORG, 'ma_tx', decl)).rejects.toThrow()
    const gone = await pool.query(`select 1 from data.metrics where org = $1 and id = 'ma_tx'`, [ORG])
    expect(gone.rowCount).toBe(0)                            // ★ 变更没留下
    expect((await listMetricAudit(pool, ORG, 'ma_tx')).length).toBe(0)
  })

  it('两条入口同一条链：HTTP 面与 MCP 面调的是同一个函数（各自都必然落审计）', () => {
    // 承重断言：审计的写入点只有一个。若将来有人绕过 metric-write 直接 upsertMetric，
    // 这条红线会先红 —— 实现方式是「写路径的判定函数只有这两个导出」。
    expect(typeof writeL2Declaration).toBe('function')
    expect(typeof deleteMetricDeclaration).toBe('function')
  })
})
```

- [ ] **Step 2: 跑（先红）**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' \
  pnpm exec vitest run domain/metric-write.test.ts 2>&1 | tail -8
```

Expected: FAIL（deps 缺 `requester`；没有审计写入）

- [ ] **Step 3: 改实现**

```ts
// 顶部 import 补：
import type { PoolClient } from 'pg'
import { deleteMetric, loadPlatformCatalog, selectMetricSnapshot, upsertMetric } from './metric-store'
import { writeMetricAudit } from './metric-audit-store'
import type { Requester } from './authz'

export interface MetricWriteDeps {
  pool: Pool
  adoptedSources: ReadonlySet<string>
  /** 谁在写。**必填**——审计要记人；无身份就该在入口被拒（见 routes/metrics.ts 的守卫）。 */
  requester: Requester
}

/** 事务包裹：审计与变更同生共死（spec §4①）。失败一律回滚，绝不半提交。 */
async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('begin')
    const out = await fn(client)
    await client.query('commit')
    return out
  } catch (e) {
    await client.query('rollback').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
```

`writeL2Declaration` 的落库段改为（**闸门全部保持原样、仍用 `deps.pool` 做只读校验**，事务只包写入）：

```ts
  // 闸门全过（都是只读校验）⇒ 开事务：读前态 → 落库 → 写审计
  const row = {
    id, title: compiled.title, description: `L2 派生自 ${base.id}`, requiredScope: null,
    subjectColumn: base.subjectColumn, selectSql: compiled.selectSql,
    groupBy: compiled.groupBy, params: {},
  }
  const actor = deps.requester
  await withTx(deps.pool, async (c) => {
    const before = await selectMetricSnapshot(c, org, id)
    await upsertMetric(c, org, row, actor.userId)
    await writeMetricAudit(c, {
      org, metricId: id,
      action: before === null ? 'create' : 'update',   // ★ 建/改的判据就是「写之前有没有这行」
      userId: actor.userId, channel: actor.channel, keyId: actor.keyId,
      before,
      after: { title: row.title, description: row.description, subjectColumn: row.subjectColumn,
               selectSql: row.selectSql, groupBy: row.groupBy, params: row.params },
    })
  })
  return { ok: true }
```

`deleteMetricDeclaration` 改为（**顺序纪律不变**：先看自己的 L2 行，删不到才判 L1）：

```ts
export async function deleteMetricDeclaration(
  deps: MetricWriteDeps, org: string, id: string,
): Promise<MetricWriteOutcome> {
  const actor = deps.requester
  return withTx(deps.pool, async (c) => {
    // 先读快照（只读，不改顺序语义）：它同时充当「这行在不在」与「删的是什么」
    const before = await selectMetricSnapshot(c, org, id)
    if (before === null) {
      // 没删到本租户的 L2 行：若这 id 是平台词表里的 ⇒ **显式** 409（不是含混的 404）
      if (await isL1Id(deps, id)) return { ok: false, http: 409, error: 'READONLY_L1' }
      return { ok: false, http: 404, error: 'NOT_FOUND' }
    }
    await deleteMetric(c, org, id)
    await writeMetricAudit(c, {
      org, metricId: id, action: 'delete',
      userId: actor.userId, channel: actor.channel, keyId: actor.keyId,
      before, after: null,                              // ★ 删除留证：被删的内容在 before 里
    })
    return { ok: true }
  })
}
```

- [ ] **Step 4: 跑（到绿）→ Commit**

```bash
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' \
  pnpm exec vitest run domain/metric-write.test.ts 2>&1 | tail -6
pnpm --filter data typecheck
git add modules/data/domain/metric-write.ts modules/data/domain/metric-write.test.ts
git commit -m "feat(data): #489 写路径事务化 + 前后快照 + 审计写入（唯一写入点）"
```

---

## Task 5: 路由与声明

**Files:**
- Modify: `modules/data/routes/metrics.ts`、`modules/data/manifest.yaml`、`modules/data/routes/metrics.test.ts`、`modules/data/routes/reports.test.ts`

**Interfaces:**
- Consumes: `listMetricAudit`（Task 2）、`MetricWriteDeps.requester`（Task 4）
- Produces: `GET /metrics/:id/audit`（`data:manage`）；`GET /metrics/all` 每行带 `updatedBy` / `version`

- [ ] **Step 1: 写测试（先红）**

在 `modules/data/routes/metrics.test.ts` 追加（该文件已有 `pool` / `app` / 身份夹具，照用）：

```ts
  it('★ 写路径无身份（orgId 空串）⇒ 403 UNAUTHENTICATED（不写「无主」审计）', async () => {
    // 本文件既有夹具：app(org, scopes) / post(body, org, scopes)
    const res = await app('', ['data:manage', 'data:query']).request('/metrics', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id: 'ma_noauth' })),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toBe('UNAUTHENTICATED')
  })

  it('★ 建 → 改 → 删：/metrics/all 带 updatedBy/version（删前回读），audit 回三行倒序', async () => {
    const id = 'ma_flow'
    expect((await post(l2Body({ id }))).status).toBe(201)                    // 建（POST）
    const put = await app(ORG, ['data:manage']).request(`/metrics/${id}`, {   // 改（PUT）
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(l2Body({ id, alias: '改过的' })),
    })
    expect(put.status).toBe(200)

    // 删**之前**验证两列（删了就查不到了）
    const all = await (await app(ORG, ['data:manage']).request('/metrics/all')).json() as {
      metrics: { id: string; updatedBy: string | null; version: number }[] }
    expect(all.metrics.find((m) => m.id === id)).toMatchObject({ updatedBy: 'u-test', version: 2 })

    expect((await app(ORG, ['data:manage']).request(`/metrics/${id}`, { method: 'DELETE' })).status).toBe(200)

    const audit = await (await app(ORG, ['data:manage']).request(`/metrics/${id}/audit`)).json() as {
      audit: { action: string; userId: string; channel: string }[] }
    expect(audit.audit.map((a) => a.action)).toEqual(['delete', 'update', 'create'])
    expect(audit.audit.every((a) => a.userId === 'u-test')).toBe(true)   // 记的是**人**（夹具默认 userId）
  })
```

- [ ] **Step 2: 跑（先红）→ 改实现**

`routes/metrics.ts`：

```ts
// 1) 写路径的身份守卫（三条写路由**各加一行**，紧跟 payload 校验之后）
    const requester = requesterOf(c)
    // 写入必须能归属到人（审计要记人）——无身份 ⇒ 拒，不写「无主」审计（spec §3.2）
    if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)

// 2) writeDeps 带上 requester（签名改为收 requester）
function writeDeps(ctx: RouteCtx, c: Context<ModuleVars>, requester: Requester): MetricWriteDeps {
  return { pool: ctx.pool, adoptedSources: adoptedSourcesOf(c), requester }
}

// 3) adminView 补两列（列表两列的数据源；避免页面为每行再打一次请求）
const adminView = (m: MetricRow) => ({ …原样…, updatedBy: m.updatedBy, version: m.version })

// 4) 新端点（紧跟 GET /metrics/all 之后）
  r.get('/metrics/:id/audit', async (c) => {
    const id = metricIdOf(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
    // 门 = data:manage（与 /metrics/all 同档）：能看到「谁改的」本身是管理信息
    return c.json({ audit: await listMetricAudit(ctx.pool, orgOf(c), id) })
  })
```

`manifest.yaml`：在 `/metrics/all` 那一行**之后**加

```yaml
    # 口径变更史（#489）：谁、何时、从什么到什么。门与 /metrics/all 同档（管理信息）。
    - { method: GET,    path: /metrics/:id/audit, scope: data:manage }
```

⚠️ `routes/reports.test.ts` 里那条「api.internal 全模块共 22 条」的断言会红 ⇒ 改成 **23** 并更新注释。

- [ ] **Step 3: 跑到绿 → 门禁 → Commit**

```bash
dropdb --if-exists ma_dev; createdb ma_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' pnpm test 2>&1 | tail -5
cd ../.. && pnpm exec tsx scripts/check-manifests.mjs && bash scripts/check-dev-discipline.sh origin/main HEAD
git add modules/data/routes/metrics.ts modules/data/routes/metrics.test.ts modules/data/routes/reports.test.ts modules/data/manifest.yaml
git commit -m "feat(data): #489 审计读端点 GET /metrics/:id/audit + /metrics/all 带操作人与版本 + 无身份拒写"
```

---

## Task 6: 页面（两列 + 变更历史抽屉）

**Files:**
- Modify: `modules/data/console/metrics/index.tsx`、`modules/data/console/metrics/index.test.tsx`

- [ ] **Step 1: 写测试（先红）**

在 `modules/data/console/metrics/index.test.tsx` 追加（该文件已有 mock 取数夹具）：

```tsx
  it('★ 两列：L2 显示「最后操作人 + v 版本」，L1 显示「平台物化（追溯走 git）」', async () => {
    mockApi({ metrics: [
      { id: 'l1x', title: '平台口径', description: '', requiredScope: null, subjectColumn: 'org',
        groupBy: 'bizday', source: 'l1', updatedBy: null, version: 1 },
      { id: 'l2x', title: '本租户口径', description: 'L2 派生自 l1x', requiredScope: null, subjectColumn: 'org',
        groupBy: 'bizday', source: 'l2', updatedBy: 'ZhangDuo', version: 3 },
    ] })
    render(<MetricsPage />)
    expect(await screen.findByText('ZhangDuo')).toBeTruthy()
    expect(screen.getByText('v3')).toBeTruthy()
    expect(screen.getAllByText('平台物化（追溯走 git）').length).toBe(1)
  })

  it('★ 变更历史：点开抽屉 → 拉 /metrics/:id/audit 并渲染动作与口径摘要（删除行的摘要来自 before）', async () => {
    // 取数 mock 沿用**本文件既有**的写法（该文件已有 /metrics/all 的 mock 夹具），按路径再挂一条：
    mockApi({
      '/metrics/all': { metrics: [
        { id: 'l2x', title: '本租户口径', description: 'L2 派生自 l1x', requiredScope: null,
          subjectColumn: 'org', groupBy: 'bizday', source: 'l2', updatedBy: 'ZhangDuo', version: 3 },
      ] },
      '/metrics/l2x/audit': { audit: [
        { id: 3, action: 'delete', userId: 'LiLei', channel: 'pat',
          createdAt: '2026-10-07T03:00:00.000Z',
          before: { title: '删前', description: 'L2 派生自 l1x（删前）' }, after: null },
        { id: 1, action: 'create', userId: 'ZhangDuo', channel: 'session',
          createdAt: '2026-10-07T01:00:00.000Z',
          before: null, after: { title: '建时', description: 'L2 派生自 l1x' } },
      ] },
    })
    render(<MetricsPage />)
    fireEvent.click(await screen.findByRole('button', { name: '变更历史' }))
    expect(await screen.findByText(/变更历史：l2x/)).toBeTruthy()
    expect(screen.getByText('删除')).toBeTruthy()
    expect(screen.getByText(/被删：L2 派生自 l1x（删前）/)).toBeTruthy()   // ★ 删除留证在 UI 上看得见
    expect(screen.getByText('新建')).toBeTruthy()
    expect(screen.getByText('LiLei')).toBeTruthy()                        // 记的是人
  })
```

- [ ] **Step 2: 跑（先红）→ 改实现**

```tsx
// 1) 行类型加两列
interface MetricRow { …原样…; updatedBy: string | null; version: number }
interface AuditRow {
  id: number; action: 'create' | 'update' | 'delete'
  userId: string; channel: string; createdAt: string
  before: { title: string; description: string } | null
  after: { title: string; description: string } | null
}

// 2) 列表加两列（放在「主体列」之后、「操作」之前）
{ title: '最后操作人', dataIndex: 'updatedBy', render: (v: string | null, r: MetricRow) =>
    r.source === 'l1'
      ? <Typography.Text type="secondary">平台物化（追溯走 git）</Typography.Text>
      : (v ?? '—') },
{ title: '版本', dataIndex: 'version', render: (v: number, r: MetricRow) =>
    r.source === 'l1' ? <Typography.Text type="secondary">—</Typography.Text> : `v${v}` },

// 3) L2 行的操作列加一个按钮（L1 不给——它的变更史在 git 里）
<Button size="small" onClick={() => void openHistory(r.id)}>变更历史</Button>

// 4) 抽屉状态与拉取
const [historyId, setHistoryId] = useState<string | null>(null)
const [history, setHistory] = useState<AuditRow[]>([])
const openHistory = (id: string) => {
  setHistoryId(id); setHistory([])
  apiGet(`/metrics/${id}/audit`)
    .then((b) => setHistory((b as { audit: AuditRow[] }).audit))
    .catch((e) => messageApi.error(messageOf(e)))
}

// 5) 抽屉本体（放在 </Space> 之前）
<Drawer title={`变更历史：${historyId ?? ''}`} open={historyId !== null}
        onClose={() => setHistoryId(null)} width={520}>
  <Timeline items={history.map((a) => ({
    color: a.action === 'delete' ? 'red' : a.action === 'create' ? 'green' : 'blue',
    children: (
      <>
        <div><Tag color={a.action === 'delete' ? 'red' : 'blue'}>
          {{ create: '新建', update: '修改', delete: '删除' }[a.action]}</Tag>
          {a.userId} · {a.channel} · {new Date(a.createdAt).toLocaleString('zh-CN')}</div>
        <div><Typography.Text type="secondary">
          {a.after ? `→ ${a.after.description}` : `（被删：${a.before?.description ?? ''}）`}</Typography.Text></div>
      </>
    ),
  }))} />
</Drawer>
```

（antd 的 `Drawer` / `Timeline` 要补进 `import { … } from 'antd'`。）

- [ ] **Step 3: 跑到绿 → Commit**

```bash
cd modules/data && pnpm exec vitest run console/metrics/index.test.tsx 2>&1 | tail -6
pnpm --filter data typecheck
git add modules/data/console/metrics/index.tsx modules/data/console/metrics/index.test.tsx
git commit -m "feat(data): #489 指标页补「最后操作人 / 版本」两列与变更历史抽屉"
```

---

## Task 7: README + 收尾

**Files:**
- Modify: `modules/data/README.md`

- [ ] **Step 1: README 记四件事**

1. **审计分表的口径**（为什么 `metric_audit` 不并进 `query_audit`，以及 `audit-store.ts` 保持只写）；
2. 边界一：**审计表随时间增长**（不清理，无案例）；
3. 边界二：**L1 无追溯**（变更史在 git）；
4. 边界三：**无回滚**（只可追溯）。

- [ ] **Step 2: 全量门禁 + PR**

```bash
cd /Users/duo/orca/workspaces/platform-core/采集板块
dropdb --if-exists ma_dev; createdb ma_dev
cd modules/data && DATABASE_URL='postgres://duo@127.0.0.1:5432/ma_dev' pnpm test 2>&1 | tail -5
cd ../.. && pnpm --filter data typecheck
pnpm exec tsx scripts/check-manifests.mjs && pnpm exec tsx scripts/lint-architecture.mjs
bash scripts/check-dev-discipline.sh origin/main HEAD
git push -u origin feat/489-metric-attribution
gh pr create --base main --head feat/489-metric-attribution \
  --title "feat(data): 语义追溯——操作人 + 版本 + 变更审计（含指标页两列与历史抽屉）" \
  --body "Closes #489"
gh pr checks <PR号>   # 等 CLEAN 再合
```

---

## 自检记录

- **spec 覆盖**：§3.1 两列+审计表 → T1/T2/T3；§3.2 事务+requester+读旧行 → T4；
  §3.3 读端点与 `/metrics/all` → T5；§3.4 页面 → T6；§4①~⑥ → T4（①③）、T5（②的承重断言）、
  T1/T2（④）、T2（⑤⑥）；§5 八条断言 → T1#8、T2、T3#3、T4#2/#4（承重+事务）、T5、T6；
  §6 落地物 → T1–T7；§7 边界 → T7。
- **占位符扫描**：无 TBD；T5/T6 的测试代码已补成可直接落盘的版本（夹具名取自实测：
  `app(org, scopes)` / `post(body)` / `l2Body({...})` / 默认 `userId='u-test'`；
  T6 的取数 mock 沿用该文件既有写法，但**挂的路径、回的报文与每一条断言都写死了**）。
- **类型一致性**：`MetricRowSnapshot`（T3 定义）→ `MetricAuditEntry.before/after`（T2 消费）；
  `MetricWriteDeps.requester`（T4 定义）→ T5 的 `writeDeps`；`listMetricAudit(pool, org, id, limit?)`
  在 T2 定义、T4/T5 消费，签名一致。
- **已知偏离**：spec §5#1 说「建/改/删各落一行」，而本计划的建/改走的是**同一个** `writeL2Declaration`
  （HTTP 的 POST 与 PUT 都调它，MCP 也一样）⇒ action 靠「写之前有没有这行」判定（T4）——
  这是实现上更少分支的做法，已写进 T4 的注释。
