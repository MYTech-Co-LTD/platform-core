# 报表写入面：非破坏性发布 + 三件套绑定 + 内容指纹（实施计划 1/3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「平台侧发布一张 Metabase 报表」这件事**不破坏已有内容**、**把租户绑定做全三件**、并且**有可用的内容指纹**（供后续的写保护用）。

**Architecture:** 报表内容在 Metabase、登记在平台（既有双写面）。本计划把「发布」从**裸 PUT** 改成**读全量 → 合并 → 写回**，并在同一次里做全三件（声明 `tenant` 参数 / 只映射真用到该模板标签的卡 / 锁参）。内容指纹由**平台现算**（不落库）——它必须覆盖**卡片层**的改动，而 Metabase 的 `updated_at` 实测**不反映**那一层。

**Tech Stack:** Hono + zod + node-postgres（`pg`）+ vitest；dbt/pg_duckdb 无关；Metabase 走 HTTP（测里用内存桩）。

## Global Constraints

- **唯一事实源**：报表口径与租户绑定的判据在平台；Metabase 只当渲染与内容存储。
- **租户隔离键一律 `org text not null`**，读写一律 `where org = $1`（正典 `docs/module-protocol.md`「租户数据隔离」；机器判据 `scripts/check-tenant-isolation.mjs`）。
- **迁移必须幂等**：部署脚本每次全量重跑全部迁移（团队规则 `db-migration` §1）。DDL 用 `if not exists`；加约束用 `do $$ … exception when duplicate_object then null; end $$;`（PG 无 `add constraint if not exists`）。
- **外部系统来的字段一律 `text`**，不用 `varchar`（团队规则 `db-migration` §2）。
- **门禁由宿主施加**：模块**不写** `requireScope`，路由的 scope 在 `manifest.yaml` 的 `api.internal` 里声明；**改路由必须同一提交改 manifest**（装载期双向核对，任一方向差集 ⇒ 装载失败）。
- **`data.metrics` 的 `select_sql` 只能由两个入口写**（L1 sync / L2 编译器），本计划**不碰**它。
- ⚠️ **本计划按 spec §7 的两条「建议」写**（它们是「实施前必须定」的待拍项）：
  - 待拍 1 → **指纹现算、不落库**；若改判为「存库」，改 Task 5/6 与迁移。
  - 待拍 2 → **乐观比对 + 每对象一把锁**（不做单写队列）；若改判，改 Task 5。
- **不在本计划范围**：console 管理面（计划 2）、反代编辑页（计划 2）、agent 工具面与语义写入面（计划 3）。

---

### Task 1: 给报表登记加 `renderer` 列

**Files:**
- Create: `modules/data/migrations/004_report_renderer.sql`
- Modify: `modules/data/module.test.ts`（迁移断言）

**Interfaces:**
- Consumes: 既有 `data.reports`（`002_reports.sql`）
- Produces: 列 `data.reports.renderer text not null default 'metabase'`，取值域 `('metabase','platform')`

- [ ] **Step 1: 写迁移**

创建 `modules/data/migrations/004_report_renderer.sql`：

```sql
-- 004_report_renderer.sql — 报表的**渲染器**维度（modules/data，spec §2 / §4）。
--
-- 纪律（与 001/002/003 同源，别按口味改）：
--   · 幂等：add column if not exists（整句在列已存在时 no-op，含 default 与 not null 子句）
--     —— 部署脚本会每次全量重跑全部迁移（团队规则 db-migration §1）
--   · 值是**自己控制的枚举**（不是外部输入）⇒ text + check 约束，不用 varchar
--   · 隔离面无新增：本文件不含 create table，data.reports 的 org not null 由 002 建立
--
-- ── 这一列解决什么（spec §2）────────────────────────────────────────────────────
-- 报表可以有两类渲染器：Metabase 标准图（`metabase`）/ 平台自绘（`platform`）。
-- 它**只影响「点开时谁渲染」**，不影响任何管理动作（页门 / 发布 / 回收对两类语义相同）
-- ⇒ 所以它不能改变主键、也不能成为第二个管理面（spec §2 的裁决）。
--
-- ── 为什么 default 是 'metabase' ────────────────────────────────────────────────
-- 存量行（002/003 时期登记的）全部是 Metabase 报表 ⇒ default 必须与事实一致。
-- 若写成 'platform'，存量行会被静默改标成"平台自绘"，而没有渲染器实现 ⇒ 点开是空白，
-- 且**从库里看不出它们标错了**。
--
-- ⚠️ 与 003 的 `default 'l2'` 不同，本列 default **不会**造成「未治理的行被盖章」：
--    'metabase' 是**存量事实**，不是"最宽松的选项"（两类渲染器在管理面上等权）。

alter table data.reports
  add column if not exists renderer text not null default 'metabase';

do $$
begin
  alter table data.reports
    add constraint data_reports_renderer_check check (renderer in ('metabase', 'platform'));
exception
  when duplicate_object then null;
end $$;

-- 管理面按渲染器筛（"哪些报表是平台自绘的"）
create index if not exists data_reports_renderer_idx on data.reports(renderer);
```

- [ ] **Step 2: 给迁移断言加一条（列存在 + 取值域）**

在 `modules/data/module.test.ts` 的 `describePg('迁移（需要 DATABASE_URL）')` 里，**追加**一个用例（放在既有「四张表建成」用例之后）：

```ts
  it('004：data.reports.renderer 列存在、非空、且取值域含 metabase/platform', async () => {
    await applyMigrations(pool)
    // 判据面：列存在、not null、**且 default 值正确**。
    // ⚠️ default 必须断言：它是本迁移的核心语义（'metabase' = 存量行的事实），
    //    而"不断言它"会让「把 default 改成 'platform'」这种**静默改标**回归全绿通过。
    //    （初稿曾以"重读 default 会假红"为由省略——那条理由是错的：这一列由本迁移建，
    //    在本套件里不可能不带 default 存在。）
    const c = await pool.query(
      `select column_name, is_nullable, column_default from information_schema.columns
        where table_schema = 'data' and table_name = 'reports' and column_name = 'renderer'`,
    )
    expect(c.rows).toEqual([
      { column_name: 'renderer', is_nullable: 'NO', column_default: "'metabase'::text" },
    ])

    // 取值域由 check 约束兜（与 003 的 source 同一口径：枚举写错一个字母会走另一条渲染路径）
    const k = await pool.query(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conname = 'data_reports_renderer_check'`,
    )
    expect(k.rowCount).toBe(1)
    expect(k.rows[0].def).toContain('metabase')
    expect(k.rows[0].def).toContain('platform')
  })
```

- [ ] **Step 3: 跑测试（需要库）**

Run: `DATABASE_URL=postgres://platform:platform@127.0.0.1:5432/platform pnpm --filter data exec vitest run module.test.ts`
（这是本机与 CI 的实际口径；**别用 `postgres:postgres`**，那个角色在本机不存在）
Expected: PASS（先确认 `docker compose -f deploy/docker-compose.yml up -d postgres` 已起，或本地有库）

- [ ] **Step 4: 跑**没有**库时也应全绿**

Run: `pnpm --filter data exec vitest run module.test.ts`
Expected: PASS（`describePg` 在无 `DATABASE_URL` 时 skip；**不许**因为没库而红）

- [ ] **Step 5: Commit**

```bash
git add modules/data/migrations/004_report_renderer.sql modules/data/module.test.ts
git commit -m "feat(data): 报表登记加 renderer 列（Metabase 标准图 / 平台自绘）"
```

---

### Task 2: `report-store` 带上 `renderer`

**Files:**
- Modify: `modules/data/domain/report-store.ts`
- Test: `modules/data/domain/report-store.test.ts`（若不存在则新建；先看同目录既有测试文件的脚手架）

**Interfaces:**
- Consumes: Task 1 的列
- Produces:
  - `type ReportRenderer = 'metabase' | 'platform'`
  - `interface ReportRow { id; title; metabaseId: number; embedParams; requiredScope; renderer: ReportRenderer }`
    （`renderer='platform'` 的行 `metabaseId` 为 **0**，即哨兵——本任务**不改列**）
  - `upsertReport(pool, org, input: { title; metabaseId: number; embedParams; requiredScope; renderer?: ReportRenderer }): Promise<string>`
    （**注意**：这里也是 `number`，不是 `number | null`——`renderer='platform'` 用 0 哨兵，本任务**不改列**）
  - `listReports` / `getReport` / `listAllReports` 的投影都带 `renderer`

`renderer='platform'` 的行**没有** Metabase dashboard。迁移里 `metabase_id` 是 `integer not null`
⇒ 本任务**不改列**，平台自绘行先写 `0`（哨兵），
并在写路径上禁止把 `0` 当成真 dashboard id 用（Task 3 起，凡读 `metabaseId` 前先判 `renderer`）。
（**为什么不现在就加迁移放宽它为 null**：放宽需 `drop not null`——那是一条独立的破坏性 DDL，
而当前**没有任何** platform 行；等计划 3 真写第一行时一起做，避免本轮动存量列。）

- [ ] **Step 1: 写失败测试**

在 `modules/data/domain/report-store.test.ts` 追加（**沿用同目录既有测试的库脚手架**；若本文件是新建的，照 `routes/reports.test.ts` 的 `describePg` 写法起头）：

```ts
describePg('renderer', () => {
  it('upsert 不带 renderer ⇒ 落 metabase；显式 platform ⇒ 读回来是 platform', async () => {
    await applyMigrations(pool)
    const org = 'org-renderer-store'
    await pool.query('delete from data.reports where org = $1', [org])

    const idA = await upsertReport(pool, org, {
      title: 'A', metabaseId: 11, embedParams: {}, requiredScope: null,
    })
    const idB = await upsertReport(pool, org, {
      title: 'B', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })

    expect((await getReport(pool, org, idA))!.renderer).toBe('metabase')
    expect((await getReport(pool, org, idB))!.renderer).toBe('platform')
  })

  it('二次 upsert 覆盖 renderer（同 title 幂等路径也要带上它）', async () => {
    const org = 'org-renderer-store-2'
    await pool.query('delete from data.reports where org = $1', [org])
    await upsertReport(pool, org, { title: 'C', metabaseId: 12, embedParams: {}, requiredScope: null })
    const id = await upsertReport(pool, org, {
      title: 'C', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })
    expect((await getReport(pool, org, id))!.renderer).toBe('platform')
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

Run: `DATABASE_URL=… pnpm --filter data exec vitest run report-store.test.ts`
Expected: FAIL —— `renderer` 不在返回对象上（`undefined`）

- [ ] **Step 3: 改实现**

在 `modules/data/domain/report-store.ts` 里：

```ts
export type ReportRenderer = 'metabase' | 'platform'

export interface ReportRow {
  id: string
  title: string
  /** `renderer='platform'` 的行为 0（哨兵）——凡用它之前先判 renderer。 */
  metabaseId: number
  embedParams: Record<string, string>
  requiredScope: string | null
  renderer: ReportRenderer
}
```

`toReportRow` 加一行：`renderer: row.renderer as ReportRenderer,`
三个 `select` 的列表里都加 `renderer`（`listReports` / `getReport` / `listAllReports`）。

`upsertReport` 的签名与 SQL 改成：

```ts
export async function upsertReport(
  pool: Pool,
  org: string,
  input: {
    title: string; metabaseId: number; embedParams: Record<string, string>
    requiredScope: string | null; renderer?: ReportRenderer
  },
): Promise<string> {
  const r = await pool.query(
    `insert into data.reports (org, id, title, metabase_id, embed_params, required_scope, renderer)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (org, title) do update set
       metabase_id    = excluded.metabase_id,
       embed_params   = excluded.embed_params,
       required_scope = excluded.required_scope,
       renderer       = excluded.renderer,
       updated_at     = now()
     returning id`,
    [org, randomUUID(), input.title, input.metabaseId,
      JSON.stringify(input.embedParams), input.requiredScope, input.renderer ?? 'metabase'],
  )
  return r.rows[0].id as string
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `DATABASE_URL=… pnpm --filter data exec vitest run report-store.test.ts`
Expected: PASS

- [ ] **Step 5: 跑全模块，确认没有别的调用方被签名变更打破**

Run: `pnpm --filter data test`
Expected: PASS（`reports.ts` 现在是唯一调用 `upsertReport` 的地方，`renderer` 是可选参数 ⇒ 不改也对）

- [ ] **Step 6: Commit**

```bash
git add modules/data/domain/report-store.ts modules/data/domain/report-store.test.ts
git commit -m "feat(data): report-store 带 renderer（缺省 metabase，platform 行用 metabase_id=0 哨兵）"
```

---

### Task 3: Metabase 客户端：**读全量** + `PUT` 改成非破坏性

**Files:**
- Modify: `modules/data/domain/metabase.ts`
- Test: `modules/data/domain/metabase.test.ts`（**已存在**，在其中追加）

**Interfaces:**
- Consumes: `call` / `MetabaseDeps` / `MetabaseError`（本文件私有/既有）
- Produces:
  - `interface DashcardRef { id: number; cardId: number; row: number; col: number; sizeX: number; sizeY: number }`
  - `interface DashboardFull { id: number; name: string; dashcards: DashcardRef[]; parameters: Record<string, unknown>[]; embeddingParams: Record<string,string> }`
    （`parameters` **原样**——Task 3 实测：窄化成 `{slug}` 回写会被 Metabase 拒收）
  - `getDashboardFull(deps, dashboardId): Promise<DashboardFull>`
  - `putDashboardMerged(deps, dashboardId, patch: { name?; parameters?; dashcards?; enable_embedding?; embedding_type?; embedding_params? }): Promise<void>`
  - `getCardTemplateTags(deps, cardId): Promise<string[]>`（返回该卡原生查询里的模板标签名）

**为什么必须改（这是本计划的核心 bug）**：既有 `upsertDashboard` 对已存在的 dashboard 发的是
`PUT /api/dashboard/{id}`，body **只有 `{name}`**（`metabase.ts:161`）；`setEmbedding` 也只发
`{enable_embedding, embedding_type, embedding_params}`（`:186`）。**Metabase 的 PUT 是会替换卡片表列的**
——发一个不带 `dashcards` 的 body **可能把已建好的卡片清掉**。
实测（本机实验室，同版本镜像）：平台侧 `POST /reports` 重跑后，人手动加的两张卡**消失**。
⇒ 凡 PUT 一律**先 GET 全量、再合并、再 PUT**。

- [ ] **Step 1: 写失败测试（先钉住"不清卡"）**

在 `modules/data/domain/metabase.test.ts` 追加：

```ts
describe('putDashboardMerged：PUT 不得清掉已存在的卡片', () => {
  it('对已有 2 张卡的 dashboard 只改 name，卡片仍为 2', async () => {
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 7, name: 'o/a', dashcards: [{ id: 1, card_id: 11, row: 0, col: 0, size_x: 12, size_y: 6 }] },
      { id: 7, name: 'o/a', dashcards: [{ id: 2, card_id: 12, row: 6, col: 0, size_x: 6, size_y: 4 }] },
    ])
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    await putDashboardMerged(deps, 7, { name: 'o/a-renamed' })
    expect(state.dashboards[0].name).toBe('o/a-renamed')
    expect(state.dashboards[0].dashcards).toHaveLength(2)  // ← 关键断言
  })

  it('patch 里给了 dashcards ⇒ 用 patch 的；没给 ⇒ 保留 GET 回来的', async () => {
    const { state, fetcher } = fakeMetabaseWithCards([
      { id: 8, name: 'o/b', dashcards: [{ id: 1, card_id: 21, row: 0, col: 0, size_x: 12, size_y: 6 }] },
    ])
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    await putDashboardMerged(deps, 8, { dashcards: [{ id: 1, cardId: 21, row: 0, col: 0, sizeX: 6, sizeY: 6 }] })
    expect(state.dashboards[0].dashcards[0].size_x).toBe(6)
  })
})
```

**注意**：本文件既有的 `fakeMetabase` 是 `routes/reports.test.ts` 里的（模块壳用），
`domain/metabase.test.ts` 用的是**另一个更薄的桩**。**照本文件既有桩的写法**加
`fakeMetabaseWithCards`（它至少要实现 `GET /api/dashboard/{id}` 与 `PUT /api/dashboard/{id}`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/metabase.test.ts`
Expected: FAIL —— `putDashboardMerged is not a function`

- [ ] **Step 3: 实现**

在 `modules/data/domain/metabase.ts` 追加：

```ts
export interface DashcardRef {
  id: number
  /** `null` = **非 card 的 dashcard**（Metabase 的文本/虚拟卡，实测 `card_id=None`）。 */
  cardId: number | null
  row: number; col: number; sizeX: number; sizeY: number
  /**
   * 该 dashcard **有 ≥1 条** `parameter_mappings` —— **不是**「已映射到 tenant」。
   * 命名如实：Task 6 判「锁了但绑不到」要用 `parameterMappings` 自己比 tenant 的参数 id，
   * 因为 `metabase.ts` 是纯 HTTP 客户端，**不该知道平台的参数命名约定**。
   */
  /** **可选**：读侧派生字段；缺省即「未映射」（安全侧）。只关心布局的测试字面量可省略。 */
  hasParameterMappings?: boolean
  /** 映射明细，**原样透传**（不解释结构——它是 Metabase 的字段，不是我们的契约）。 */
  parameterMappings?: unknown[]
  /** 可视化设置，**原样透传**：文本卡的内容就在 `visualization_settings.text`，不回写就把它清掉了。 */
  visualizationSettings?: unknown
}

export interface DashboardFull {
  id: number
  name: string
  dashcards: DashcardRef[]
  /** **原样**（不窄化——窄化后回写会被 Metabase 拒收，见 `getDashboardFull` 的注）。 */
  parameters: Record<string, unknown>[]
  embeddingParams: Record<string, string>
}

/** 回读一张 dashboard 的**全量**内容。形状不对 ⇒ 抛（读不出就是读不出，不回落到 `{}`）。 */
export async function getDashboardFull(deps: MetabaseDeps, dashboardId: number): Promise<DashboardFull> {
  const body = await call(deps, 'GET', `/api/dashboard/${dashboardId}`)
  const rec = body as {
    id?: unknown; name?: unknown; dashcards?: unknown
    parameters?: unknown; embedding_params?: unknown
  } | null
  if (typeof rec?.id !== 'number' || typeof rec.name !== 'string' || !Array.isArray(rec.dashcards)) {
    throw new MetabaseError(200, SHAPE_ERROR)
  }
  const dashcards = rec.dashcards.map((dc): DashcardRef => {
    const d = dc as Record<string, unknown> | null
    if (typeof d?.id !== 'number') throw new MetabaseError(200, SHAPE_ERROR)
    // ⚠️ `card_id` 的三种情况要分开：
    //    · `number` = 真卡
    //    · `null`   = **Metabase 的文本/虚拟卡**（实测 `type=NoneType`）⇒ 必须允许，
    //                 否则人一加文本卡，那张报表的发布就**恒 502**
    //    · **缺键** = 形状不认识 ⇒ **仍抛**（别容忍成 null）：把缺键回写成 null 会把**真卡改成
    //                 文本卡**，那是**静默改写**，比响亮 502 更坏
    const cid = d.card_id
    if (cid === undefined) throw new MetabaseError(200, SHAPE_ERROR)
    if (cid !== null && typeof cid !== 'number') throw new MetabaseError(200, SHAPE_ERROR)
    const pm = d.parameter_mappings
    return {
      id: d.id,
      cardId: typeof cid === 'number' ? cid : null,
      row: Number(d.row ?? 0), col: Number(d.col ?? 0),
      sizeX: Number(d.size_x ?? 12), sizeY: Number(d.size_y ?? 6),
      hasParameterMappings: Array.isArray(pm) && pm.length > 0,
      // 原样留着：发布时要**写回去**（丢了就等于把已有映射/文本卡内容清掉）
      parameterMappings: Array.isArray(pm) ? pm : undefined,
      visualizationSettings: d.visualization_settings,
    }
  })
  // ⚠️ **别窄化**：Metabase 对参数对象有 schema 校验，窄化成 `{slug}` 回写会被**拒收**
  //    （实测 `400 parameters[0].id: missing required key`）⇒ 只要 dashboard 有参数，发布就恒 400。
  //    原样保留（需要 slug 的地方读 `.slug`）。
  const params = Array.isArray(rec.parameters) ? (rec.parameters as Record<string, unknown>[]) : []
  const ep = (rec.embedding_params ?? {}) as Record<string, string>
  return { id: rec.id, name: rec.name, dashcards, parameters: params, embeddingParams: ep }
}

/**
 * **非破坏性**的 dashboard 更新：先 GET 全量，把 patch 合并进去，再 PUT。
 *
 * ⚠️ 为什么不是"直接 PUT patch"：Metabase 的 PUT 会替换卡片表列 ⇒ 不带 `dashcards` 的 PUT
 * 会把别人（人手动 / agent）刚加的卡清掉。实测过。
 * `dashcards` 的字段名在这里做一次转换（内部用 camelCase，线上契约是 snake_case）。
 */
export async function putDashboardMerged(
  deps: MetabaseDeps,
  dashboardId: number,
  patch: {
    name?: string
    parameters?: Record<string, unknown>[]
    dashcards?: DashcardRef[]
    enable_embedding?: boolean
    embedding_type?: 'signed'
    embedding_params?: Record<string, string>
  },
): Promise<void> {
  const cur = await getDashboardFull(deps, dashboardId)
  const body: Record<string, unknown> = {
    name: patch.name ?? cur.name,
    parameters: patch.parameters ?? cur.parameters,
    dashcards: (patch.dashcards ?? cur.dashcards).map((d) => ({
      id: d.id, card_id: d.cardId, row: d.row, col: d.col, size_x: d.sizeX, size_y: d.sizeY,
      // 已有映射必须**写回去**：漏了它，一次发布就把之前映射好的卡解绑了（静默失效）
      ...(d.parameterMappings ? { parameter_mappings: d.parameterMappings } : {}),
      // 可视化设置也必须写回：**文本卡的内容就在这里**，不回写 = 把人的文字清掉
      ...(d.visualizationSettings !== undefined ? { visualization_settings: d.visualizationSettings } : {}),
    })),
  }
  if (patch.enable_embedding !== undefined) body.enable_embedding = patch.enable_embedding
  if (patch.embedding_type !== undefined) body.embedding_type = patch.embedding_type
  if (patch.embedding_params !== undefined) body.embedding_params = patch.embedding_params
  // `collection_id`：**保留** upsertDashboard 命中同名时的既有语义（把 dashboard 移进集合）。
  // 不保留它 = 把这条语义**静默丢掉**（未给该参数时与上面逐字一致，所以这是个超集）。
  if (patch.collection_id !== undefined) body.collection_id = patch.collection_id
  await call(deps, 'PUT', `/api/dashboard/${dashboardId}`, body)
}

/** 该卡原生查询里的模板标签名（v0.63 的 MBQL stages 形态）。取不到 ⇒ 抛。 */
export async function getCardTemplateTags(deps: MetabaseDeps, cardId: number): Promise<string[]> {
  const body = await call(deps, 'GET', `/api/card/${cardId}`)
  const stages = ((body as { dataset_query?: { stages?: unknown } } | null)?.dataset_query?.stages)
  if (!Array.isArray(stages)) throw new MetabaseError(200, SHAPE_ERROR)
  const first = stages[0] as { 'template-tags'?: unknown } | undefined
  const tags = first?.['template-tags']
  if (tags === undefined || tags === null) return []
  if (typeof tags !== 'object') throw new MetabaseError(200, SHAPE_ERROR)
  // 数组形态（我们编译产的）与字典形态（Metabase UI 产的）都要认
  const names = Array.isArray(tags)
    ? (tags as { name?: unknown }[]).map((t) => String(t?.name ?? ''))
    : Object.keys(tags as Record<string, unknown>)
  return names.filter((n) => n.length > 0)
}
```

**⚠️ `upsertDashboard` 也必须改（本条是 Task 3 首轮漏掉的，实现者当场指出）**：
`POST /reports` 的路径是 `upsertDashboard` → `setEmbedding`，而 `upsertDashboard` 对**已存在**的
dashboard 发的也是**裸 `PUT {name}`**（`metabase.ts:161`）⇒ 它**排在前面**，等 `setEmbedding`
去 GET 时卡片**已经被它清掉了**。只修 `setEmbedding` ⇒ Goal（"发布不破坏已有内容"）**没达成**。
改法同上：对已存在的那条路径也走 `putDashboardMerged(deps, id, { name })`（签名不变）。
并**补一条测试**：*已存在的 dashboard 上重跑 upsert，`dashcards` 不变* ——
这条是 Goal 的判据，不能只留在 Task 5。既有 5 条 upsert 单测若断言了裸 PUT 的形状，按新形态更新。

同样把 `setEmbedding` 的**实现**改成走 `putDashboardMerged`（保持签名不变，调用方不用改）：

```ts
export async function setEmbedding(
  deps: MetabaseDeps, dashboardId: number, params: EmbedParamSpec[],
): Promise<void> {
  const embedding_params: Record<string, EmbedParamSpec['mode']> = {}
  for (const p of params) embedding_params[p.name] = p.mode
  await putDashboardMerged(deps, dashboardId, {
    enable_embedding: true, embedding_type: 'signed', embedding_params,
  })
}
```

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter data exec vitest run domain/metabase.test.ts routes/reports.test.ts`
Expected: **先红后绿**——`routes/reports.test.ts` 的既有用例会红，因为它的 `fakeMetabase` 桩的
`GET /api/dashboard/{id}` **只回 `{id, name, embedding_params}`**，而 `getDashboardFull` 在 `dashcards`
不是数组时**抛 SHAPE_ERROR**（这是有意的：读不出就是读不出）。
⇒ **必须扩桩**：给 `FakeDash` 加 `dashcards?: ...` 与 `parameters?: ...` 两个可选字段，
在 `GET` 分支回 `dashcards: d.dashcards ?? []`、`parameters: d.parameters ?? []`，
并在 `PUT` 分支把 `body.dashcards` / `body.parameters` **存回去**（否则「不清卡」那条断言测不出来）。
改完再跑，两条文件都应 PASS。（`domain/metabase.test.ts` 的薄桩同样要补。）

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/metabase.ts modules/data/domain/metabase.test.ts
git commit -m "fix(data): dashboard 更新改为「读全量→合并→写回」——裸 PUT 会静默清掉已建卡片"
```

---

### Task 4: 内容指纹（现算）

**Files:**
- Create: `modules/data/domain/report-content.ts`
- Test: `modules/data/domain/report-content.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `getDashboardFull` / `getCardTemplateTags`
- Produces:
  - `interface DashboardContent extends DashboardFull { fingerprint: string; cardTags: Record<number, string[]> }`
  - `readDashboardContent(deps, dashboardId): Promise<DashboardContent>`
  - `fingerprintOf(input: { dashcards; parameters; embeddingParams; cardSqlDigests }): string`

**为什么指纹要覆盖"每张卡的 SQL"**：Metabase 的 `dashboard.updated_at` 实测**不反映卡片层改动**
（改卡片 SQL / 加卡 / 删卡 / 移动卡都不动它；只有改 name/description 才动）
⇒ 拿它当"被改过"的信号**会漏**。

⚠️ **已知成本**：算一次指纹要 1 次 dashboard 读 + N 次卡片读（N = 卡片数）。它**只在写路径上**算，
不在读路径上（spec §7 待拍 1 的取舍）。若将来写变频繁，再考虑缓存。

- [ ] **Step 1: 写失败测试**

创建 `modules/data/domain/report-content.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { fingerprintOf } from './report-content'

const base = {
  dashcards: [{ id: 1, cardId: 11, row: 0, col: 0, sizeX: 12, sizeY: 6 }],
  parameters: [{ slug: 'tenant' }],
  embeddingParams: { tenant: 'locked' } as Record<string, string>,
  cardSqlDigests: { 11: 'aaaa' } as Record<number, string>,
}

describe('fingerprintOf', () => {
  it('同样输入 ⇒ 同样指纹（稳定性）', () => {
    expect(fingerprintOf(base)).toBe(fingerprintOf({ ...base }))
  })

  it('dashcard 布局变 ⇒ 指纹变（人挪了图）', () => {
    const moved = { ...base, dashcards: [{ ...base.dashcards[0], sizeX: 6 }] }
    expect(fingerprintOf(moved)).not.toBe(fingerprintOf(base))
  })

  it('卡片 SQL 变 ⇒ 指纹变（updated_at 抓不到的那一层）', () => {
    const edited = { ...base, cardSqlDigests: { 11: 'bbbb' } }
    expect(fingerprintOf(edited)).not.toBe(fingerprintOf(base))
  })

  it('文本卡内容变 ⇒ 指纹变（内容在 visualization_settings，cardId=null）', () => {
    const textCard = { id: 2, cardId: null, row: 6, col: 0, sizeX: 12, sizeY: 4,
                       visualizationSettings: { text: '说明' } }
    const withText = { ...base, dashcards: [...base.dashcards, textCard] }
    const textEdited = { ...withText, dashcards: [
      ...base.dashcards, { ...textCard, visualizationSettings: { text: '改了' } }] }
    expect(fingerprintOf(withText)).not.toBe(fingerprintOf(textEdited))
  })

  it('参数映射变 ⇒ 指纹变（映射是 Task 5 要写的东西）', () => {
    const mapped = { ...base, dashcards: [
      { ...base.dashcards[0], parameterMappings: [{ parameter_id: 'p1' }] }] }
    expect(fingerprintOf(mapped)).not.toBe(fingerprintOf(base))
  })

  it('锁参状态变 ⇒ 指纹变', () => {
    const unlocked = { ...base, embeddingParams: {} as Record<string, string> }
    expect(fingerprintOf(unlocked)).not.toBe(fingerprintOf(base))
  })

  it('dashcards 顺序不影响（同一集合不同序 ⇒ 同指纹）', () => {
    const two = { id: 2, cardId: 12, row: 6, col: 0, sizeX: 6, sizeY: 4 }
    const one = { id: 1, cardId: 11, row: 0, col: 0, sizeX: 12, sizeY: 6 }
    const a = { ...base, dashcards: [one, two], cardSqlDigests: { 11: 'aaaa', 12: 'cccc' } }
    const b = { ...base, dashcards: [two, one], cardSqlDigests: { 11: 'aaaa', 12: 'cccc' } }
    expect(fingerprintOf(a)).toBe(fingerprintOf(b))
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/report-content.test.ts`
Expected: FAIL —— 模块不存在

- [ ] **Step 3: 实现**

创建 `modules/data/domain/report-content.ts`：

```ts
// report-content.ts — 报表**内容**的读-改-写与指纹（modules/data，spec §3③）。
//
// 一个职责：把「平台怎么读一份报表的真实内容、怎么算它的指纹」收在一处。
// 不碰路由、不碰登记表（那是 report-store）、不碰 Metabase 的 HTTP（那是 metabase.ts）。
import { createHash } from 'node:crypto'
import {
  getCardTemplateTags, getDashboardFull,
} from './metabase'
import type { DashcardRef, DashboardFull, MetabaseDeps } from './metabase'

export interface DashboardContent extends DashboardFull {
  /** 内容指纹（现算）。**覆盖卡片层**——那是 updated_at 抓不到的一层。 */
  fingerprint: string
  /** cardId → 该卡原生查询里的模板标签名 */
  cardTags: Record<number, string[]>
}

/**
 * 指纹的输入与算法。**顺序无关**（dashcards 先按 id 排序、对象键排序后序列化）——
 * 否则同一份内容因返回顺序不同会算出不同指纹，冲突判定就成了随机数。
 */
export function fingerprintOf(input: {
  dashcards: DashcardRef[]
  /** **原样**（与 `DashboardFull.parameters` 同形——窄化会与 Task 3 的类型冲突，且实测会 400）。 */
  parameters: Record<string, unknown>[]
  embeddingParams: Record<string, string>
  cardSqlDigests: Record<number, string>
}): string {
  const canonical = {
    dashcards: [...input.dashcards]
      .sort((a, b) => a.id - b.id)
      // ⚠️ 投影带 `visualizationSettings` + `parameterMappings`（人裁 2026-09-29）：前者是文本卡
      // （cardId=null）内容的唯一居所——丢了它，"人改文本卡文字"指纹不动；后者是 Task 5 要写的
      // 东西——丢了它，人手动改映射指纹也不动。两类都是写保护该看见的改动。
      .map((d) => [d.id, d.cardId, d.row, d.col, d.sizeX, d.sizeY,
                   d.visualizationSettings, d.parameterMappings]),
    parameters: [...input.parameters].map((p) => String(p['slug'] ?? '')).sort(),
    embeddingParams: Object.entries(input.embeddingParams).sort(([a], [b]) => (a < b ? -1 : 1)),
    cardSqlDigests: Object.entries(input.cardSqlDigests).sort(([a], [b]) => Number(a) - Number(b)),
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 24)
}

/** 读一份报表的真实内容 + 指纹。卡片读失败 ⇒ 抛（不静默当成"没卡"）。 */
export async function readDashboardContent(
  deps: MetabaseDeps, dashboardId: number,
): Promise<DashboardContent> {
  const full = await getDashboardFull(deps, dashboardId)
  const cardTags: Record<number, string[]> = {}
  const cardSqlDigests: Record<number, string> = {}
  const seen = new Set<number>()
  for (const dc of full.dashcards) {
    // ⚠️ 文本/虚拟卡没有 card ⇒ 没有模板标签也没有 SQL 可摘要。**跳过**（而不是当 id=null 去查）。
    if (dc.cardId === null) continue
    if (seen.has(dc.cardId)) continue
    seen.add(dc.cardId)
    const tags = await getCardTemplateTags(deps, dc.cardId)
    cardTags[dc.cardId] = tags
    // SQL 摘要：模板标签名参与不了"人改了 SQL 但标签没变"那种改动 ⇒ 摘要要覆盖查询正文
    cardSqlDigests[dc.cardId] = createHash('sha256')
      .update(JSON.stringify(tags))          // 占位：真实实现还要取 SQL 正文（见 Step 3 的注）
      .digest('hex').slice(0, 16)
  }
  return {
    ...full, cardTags,
    fingerprint: fingerprintOf({
      dashcards: full.dashcards, parameters: full.parameters,
      embeddingParams: full.embeddingParams, cardSqlDigests,
    }),
  }
}
```

⚠️ **Step 3 的注（必须处理，别跳过）**：上面的 `cardSqlDigests` 只摘要了**模板标签名**，
覆盖不了"人改了查询但不改标签"。

⚠️⚠️ **摘要必须覆盖「整个查询定义」，不能只取 native SQL 字符串**：Metabase **UI 建的卡是 MBQL**
（`dataset_query.stages[0].native` **不存在**）⇒ 只摘要 native 会让这类卡的摘要**恒为空串** ⇒
人改了它的查询，指纹**不动**，写保护就漏了——而"**人在编辑器里改**"正是本设计的前提。

⇒ 在 `metabase.ts` 加**一个**函数，**一次 GET 取两份快照**：

```ts
/** 一次读回该卡的模板标签与**整个查询定义**（规范化 JSON）。形状不对 ⇒ 抛。 */
export async function getCard(
  deps: MetabaseDeps, cardId: number,
): Promise<{ tags: string[]; queryJson: string }> {
  const body = await call(deps, 'GET', `/api/card/${cardId}`)
  const dq = (body as { dataset_query?: unknown } | null)?.dataset_query
  if (dq === undefined) throw new MetabaseError(200, SHAPE_ERROR)
  // tags 的取法见既有 getCardTemplateTags（数组/字典两种形态都要认）——把它改成基于本函数的投影
  return { tags: tagsOf(dq), queryJson: JSON.stringify(dq) }
}
```

`getCardTemplateTags` **保留为它的投影**（契约不变、既有测试继续管它）。

**为什么是一个函数、一次 GET，不是一个取标签一个取 SQL**：每张卡读两次会让一次指纹的请求数翻倍
（Task 5 每次发布要算两次 `readDashboardContent` ⇒ **2N vs 4N**），且两次响应之间可能是**撕裂读**
（同一张卡的两份快照来自不同时刻）。

摘要那一行随之改成：

```ts
    const card = await getCard(deps, dc.cardId)   // 循环开头已 `if (dc.cardId === null) continue`
    cardTags[dc.cardId] = card.tags
    cardSqlDigests[dc.cardId] = createHash('sha256').update(card.queryJson).digest('hex').slice(0, 16)
```

并**补一条测试**：同一张卡，SQL 从 `select 1` 改成 `select 2` ⇒ 指纹变。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter data exec vitest run domain/report-content.test.ts domain/metabase.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add modules/data/domain/report-content.ts modules/data/domain/report-content.test.ts modules/data/domain/metabase.ts
git commit -m "feat(data): 报表内容指纹（现算、覆盖卡片层，补 updated_at 抓不到的那一层）"
```

---

### Task 5: 发布路径做全**三件套**（spec §3②）

**Files:**
- Modify: `modules/data/domain/report-content.ts`（加 `publishWithTenantBinding`）
- Modify: `modules/data/routes/reports.ts`（`POST /reports` 改走它）
- Test: `modules/data/domain/report-content.test.ts` + `modules/data/routes/reports.test.ts`

**Interfaces:**
- Consumes: Task 3/4
- Produces:
  - `const TENANT_SLUG = 'tenant'`
  - `publishWithTenantBinding(deps, dashboardId): Promise<{ mapped: number; fingerprint: string; embeddingParams: Record<string,string> }>`

**为什么三件缺一不可（实测）**：只把 `embedding_params.tenant` 设成 `locked` 而**不声明** dashboard 级参数、
**不映射**卡片 ⇒ 取嵌入图数据时报「找不到匹配的参数」；**更坏的形态是页面照常显示未过滤的数据**。
而只回读 `embedding_params` 的对账**会把它判成 OK**（静默失效）。
⇒ 发布时**一次做全**，且**只映射真正用到该模板标签的卡**（映射一张没有该标签的卡会报错）。

- [ ] **Step 1: 写失败测试（三件套 + 只映射该映射的）**

在 `modules/data/domain/report-content.test.ts` 追加：

```ts
describe('publishWithTenantBinding', () => {
  it('三件：声明参数 / 只映射带 tenant 标签的卡 / 锁参', async () => {
    const { state, fetcher } = fakeMetabaseWithContent({
      id: 20, name: 'o/r', dashcards: [
        { id: 1, card_id: 101, row: 0, col: 0, size_x: 12, size_y: 6 },  // 有 tenant 标签
        { id: 2, card_id: 102, row: 6, col: 0, size_x: 6, size_y: 4 },   // 没有
      ],
      cardTags: { 101: ['tenant'], 102: [] },
      cardSql: { 101: 'select 1 where x = {{tenant}}', 102: 'select 2' },
    })
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    const r = await publishWithTenantBinding(deps, 20)

    expect(r.mapped).toBe(1)                                    // ← 只映射一张
    expect(state.dashboards[0].parameters.map((p) => p.slug)).toContain('tenant')
    expect(state.dashboards[0].embedding_params).toEqual({ tenant: 'locked' })
    expect(state.dashboards[0].dashcards).toHaveLength(2)        // ← 卡片没被清
    expect(state.dashboards[0].dashcards[0].parameter_mappings)
      .toEqual([{ parameter_id: 'tenant-param', card_id: 101, target: ['variable', ['template-tag', 'tenant']] }])
    expect(state.dashboards[0].dashcards[1].parameter_mappings ?? []).toEqual([])
  })

  it('重发布保留人声明的其它参数（合并不替换，人裁 2026-09-29）', async () => {
    // fixture 需支持预置 parameters（fakeMetabaseWithContent 不支持就扩它）
    const { state, fetcher } = fakeMetabaseWithContent({
      id: 21, name: 'o/r2',
      parameters: [{ id: 'human-1', slug: 'region', name: 'region', type: 'category' }],
      dashcards: [], cardTags: {}, cardSql: {},
    })
    const deps = { fetcher, baseUrl: 'http://mb', apiKey: 'k' }
    await publishWithTenantBinding(deps, 21)

    const slugs = state.dashboards[0].parameters.map((p: { slug?: unknown }) => p.slug)
    expect(slugs).toContain('tenant')
    expect(slugs).toContain('region')   // ← 人的参数没被抹
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run domain/report-content.test.ts`
Expected: FAIL —— `publishWithTenantBinding is not a function`

- [ ] **Step 3: 实现**

在 `modules/data/domain/report-content.ts` 追加：

```ts
/** 平台保留的锁定参数名（与 routes/reports.ts 的 TENANT_PARAM 同值；两处必须一致）。 */
export const TENANT_SLUG = 'tenant'
const TENANT_PARAM_ID = 'tenant-param'

/**
 * 发布：**一次做全三件**（spec §3②）。
 *   ① 声明 dashboard 级 `tenant` 参数（缺它 ⇒ 锁住的值**绑不到任何东西**）
 *   ② 把**真正用到** `{{tenant}}` 模板标签的卡片映射到它（不带的别映射，映射了会报错）
 *   ③ 设 `embedding_params.tenant = 'locked'`
 * 全程走 `putDashboardMerged`（非破坏性）。
 */
export async function publishWithTenantBinding(
  deps: MetabaseDeps, dashboardId: number,
): Promise<{ mapped: number; fingerprint: string; embeddingParams: Record<string, string> }> {
  const cur = await readDashboardContent(deps, dashboardId)
  let mapped = 0
  // 逐卡决定：**带 tenant 模板标签的**才映射（不带的映射了会报错），布局与已有映射原样保留
  const dashcards = cur.dashcards.map((d) => {
    const hasTenant = d.cardId !== null && (cur.cardTags[d.cardId] ?? []).includes(TENANT_SLUG)
    if (hasTenant) mapped += 1
    return {
      ...d,
      ...(hasTenant
        ? { parameterMappings: [{ parameter_id: TENANT_PARAM_ID, card_id: d.cardId,
                                  target: ['variable', ['template-tag', TENANT_SLUG]] }] }
        : {}),
    }
  })
  // ⚠️ 参数是**合并保留**不是整表替换（人裁 2026-09-29）：putDashboardMerged 对 parameters 是
  // `patch.parameters ?? cur.parameters` 整表替换——单元素列表会把人在 Metabase 手动声明的其它
  // 参数静默抹掉（与 Task 3「裸 PUT 清卡」同构，作用在参数维度）。先剔旧 tenant 项再追加。
  const tenantParam = { id: TENANT_PARAM_ID, name: TENANT_SLUG, slug: TENANT_SLUG, type: 'category', sectionId: 'string' }
  const otherParams = cur.parameters.filter(
    (p) => p['id'] !== TENANT_PARAM_ID && p['slug'] !== TENANT_SLUG)
  await putDashboardMerged(deps, dashboardId, {
    parameters: [...otherParams, tenantParam],
    dashcards,
    enable_embedding: true, embedding_type: 'signed',
    embedding_params: { [TENANT_SLUG]: 'locked' },
  })
  const after = await readDashboardContent(deps, dashboardId)
  return { mapped, fingerprint: after.fingerprint, embeddingParams: after.embeddingParams }
}
```

**实现注**：`parameterMappings` 是 `DashcardRef` 上的字段（Task 3 定义），由 `putDashboardMerged`
**原样透传**到 PUT body 的 `parameter_mappings`；不带的卡不写该键 ⇒ 不会清掉 Metabase 侧的既有映射。

- [ ] **Step 4: 改路由**

`modules/data/routes/reports.ts` 的 `POST /reports`：把

```ts
      await setEmbedding(deps, up.id, [
        { name: TENANT_PARAM, mode: 'locked' },
        ...Object.keys(parsed.data.lockedParams).map((name) => ({ name, mode: 'locked' as const })),
      ])
```

改成

```ts
      // 一次做全三件（声明参数 / 只映射带标签的卡 / 锁参）；额外的 lockedParams 由 setEmbedding 合并
      await publishWithTenantBinding(deps, up.id)
      if (Object.keys(parsed.data.lockedParams).length > 0) {
        await setEmbedding(deps, up.id, [
          { name: TENANT_PARAM, mode: 'locked' },
          ...Object.keys(parsed.data.lockedParams).map((name) => ({ name, mode: 'locked' as const })),
        ])
      }
```

并在 `reports.test.ts` 里加一条**路由级**回归：**已存在的 dashboard 上重跑 `POST /reports`，卡片数不变**。

- [ ] **Step 5: 跑测试**

Run: `pnpm --filter data exec vitest run domain/report-content.test.ts routes/reports.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add modules/data/domain/report-content.ts modules/data/routes/reports.ts modules/data/routes/reports.test.ts
git commit -m "feat(data): 发布一次做全三件套（声明参数/只映射带标签的卡/锁参）——少一步是静默失效"
```

---

### Task 6: 对账判据加厚（spec §7 待办 2）

**Files:**
- Modify: `modules/data/routes/reports.ts`（`POST /reports/reconcile`）
- Test: `modules/data/routes/reports.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `readDashboardContent`（拿到 `cardTags`）、Task 5 的 `TENANT_SLUG`
- Produces: reconcile 响应新增字段 `tenantUnbound: { id; title; metabaseId }[]`

**为什么加**：现在只断言 `embedding_params.tenant === 'locked'`，**看不见**
「参数没声明 / 卡片没映射 / 锁了但绑不到」这一族**静默失效**——而它们表现为"页面照常显示未过滤的数据"。

- [ ] **Step 1: 写失败测试**

在 `modules/data/routes/reports.test.ts` 追加：

```ts
  it('reconcile 报出「锁了但绑不到」：有 locked 但卡片未映射 ⇒ tenantUnbound 非空、ok=false', async () => {
    // 造一张"只锁了参、没映射"的 dashboard（桩里 parameters 为空、dashcards 无 mappings）
    const { state, fetcher } = fakeMetabase([{
      id: 300, name: `${ORG}/未绑定`, embeddable: true, archived: false,
      enable_embedding: true, embedding_params: { tenant: 'locked' },
    }])
    state.dashboards[0].dashcards = [{ id: 9, card_id: 900, row: 0, col: 0, size_x: 12, size_y: 6 }]
    state.dashboards[0].parameters = []
    vi.stubGlobal('fetch', fetcher)
    const id = await upsertReport(pool, ORG, {
      title: '未绑定', metabaseId: 300, embedParams: {}, requiredScope: null,
    })
    const res = await app.request('/reports/reconcile', { method: 'POST' })
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.tenantUnbound.map((r: { id: string }) => r.id)).toContain(id)
  })

  it('reconcile 半绑定也报：两张 tenant 卡只映射一张 ⇒ tenantUnbound 非空（单卡粒度，人裁 2026-09-29）', async () => {
    // 参数已声明（①不触发）；两张卡都带 tenant 标签，只映射了一张 ⇒ ②单卡粒度必须报
    const { state, fetcher } = fakeMetabase([{
      id: 301, name: `${ORG}/半绑定`, embeddable: true, archived: false,
      enable_embedding: true, embedding_params: { tenant: 'locked' },
    }])
    state.dashboards[0].dashcards = [
      { id: 11, card_id: 901, row: 0, col: 0, size_x: 6, size_y: 6,
        parameter_mappings: [{ parameter_id: 'tenant-param', card_id: 901,
                               target: ['variable', ['template-tag', 'tenant']] }] },
      { id: 12, card_id: 902, row: 0, col: 6, size_x: 6, size_y: 6 },
    ]
    state.dashboards[0].parameters = [{ id: 'tenant-param', name: 'tenant', slug: 'tenant',
                                        type: 'category', sectionId: 'string' }]
    // 桩的 cards 若无 901/902，按现有 fakeMetabase 形状 seed（template tags 含 'tenant'）
    vi.stubGlobal('fetch', fetcher)
    const id = await upsertReport(pool, ORG, {
      title: '半绑定', metabaseId: 301, embedParams: {}, requiredScope: null,
    })
    const res = await app.request('/reports/reconcile', { method: 'POST' })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.ok).toBe(false)
    expect(body.tenantUnbound.map((r: { id: string }) => r.id)).toContain(id)
  })
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter data exec vitest run routes/reports.test.ts`
Expected: FAIL —— 第一条：`tenantUnbound` 是 `undefined`；第二条：dashboard 粒度旧判据下半绑定不报（`ok` 仍 true / `tenantUnbound` 不含该行）

- [ ] **Step 3: 实现**

在 `reconcile` 里，把既有的 `tenantUnlocked` 循环**扩成两判**（同一次回读里做，别多发请求）：

```ts
  const tenantUnbound: { id: string; title: string; metabaseId: number }[] = []
  for (const r of rows) {
    if (!embeddableIds.has(r.metabaseId)) continue
    const content = await readDashboardContent(deps, r.metabaseId)
    const params = content.embeddingParams
    if (params[TENANT_SLUG] !== 'locked') {
      tenantUnlocked.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
      continue
    }
    // ① 参数没声明 或 ② 任一卡带 tenant 标签但**没映射** ⇒ 锁了但绑不到。
    //    ② 是**单卡粒度**（人裁 2026-09-29）：半绑定——两张 tenant 卡只映射一张——也要报；
    //    dashboard 粒度的 anyMapped（"有一张映射了就不报"）会漏检它，未映射那张卡在嵌入语境
    //    拿不到 tenant 值、静默显示未过滤数据——正是本任务要抓的失效家族。
    const declared = content.parameters.some((p) => p['slug'] === TENANT_SLUG)
    // 「映射到 tenant」**在这里判**（不在 metabase.ts）：比 parameter_id，而不是"有没有映射"
    const isTenantMapped = (d: { parameterMappings?: unknown[] }) =>
      (d.parameterMappings ?? []).some(
        (m) => (m as { parameter_id?: unknown }).parameter_id === TENANT_PARAM_ID,
      )
    const unboundCards = content.dashcards.filter(
      (d) => d.cardId !== null && (content.cardTags[d.cardId] ?? []).includes(TENANT_SLUG) && !isTenantMapped(d),
    )
    if (!declared || unboundCards.length > 0) {
      tenantUnbound.push({ id: r.id, title: r.title, metabaseId: r.metabaseId })
    }
  }
```

⚠️ 这一段用到的 `TENANT_PARAM_ID` 在 `report-content.ts`（Task 5 定义）——**从那里 import**，
别在本文件再写一份字面量（否则两处会漂）。
⚠️ 「映射到 tenant」是**在这里判**的（比 `parameter_id`），**不是**在 `metabase.ts` 里判——
后者是纯 HTTP 客户端，不该知道平台的参数命名约定（它只如实报 `hasParameterMappings`）。
⚠️ 指纹的输入要不要带映射状态：**要**（映射变了指纹就该变）——**Task 4 已落实**（人裁
2026-09-29：投影元组含 `parameterMappings` 与 `visualizationSettings`，后者让文本卡改字也被
指纹看见）。Task 5 无需再加列，直接依赖 `fingerprintOf` 的现行为。

`ok` 的判据加上 `&& tenantUnbound.length === 0`，响应体带上 `tenantUnbound`。

- [ ] **Step 4: 跑测试**

Run: `pnpm --filter data test`
Expected: PASS

- [ ] **Step 5: 跑门禁（改了 manifest 吗？——没有，但本模块有静态门禁）**

Run: `pnpm exec tsx scripts/check-data-models.mjs && pnpm exec tsx scripts/check-tenant-isolation.mjs`
Expected: 两条都 OK

- [ ] **Step 6: Commit**

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts modules/data/domain/report-content.ts modules/data/domain/metabase.ts
git commit -m "fix(data): 对账加厚——报出「锁了但绑不到」（参数未声明 / 卡片未映射）"
```

---

## Self-Review（写完后自查，已过）

**1. Spec 覆盖**：本计划覆盖 spec §3②（三件套）、§3③ 的**指纹基础设施**（写保护本身归计划 3）、§7 待办 2（对账加厚）。
**未覆盖且有意为之**：§3①（报表 SQL 由语义层编译——归计划 3）、§3④（凭据面收口——归计划 3）、
§3⑤–⑧（管理面 / 反代 / 自绘 / 源维度——归计划 2 与 3）、§7 待办 6（租户↔源——**待拍**，无计划可写）。

**2. 占位符扫描**：无 TBD/TODO。两处 ⚠️ 注（Task 4 Step 3、Task 5 Step 3）是**必须处理的设计岔路**，
各给了明确选择与推荐，不是留空。

**3. 类型一致性**：`DashcardRef`（Task 3 产，含 `cardId: number | null` / `hasParameterMappings` /
`parameterMappings` / `visualizationSettings`）在 Task 4/5/6 一致使用；
`TENANT_SLUG`（Task 5 产）在 Task 6 用它；`readDashboardContent`（Task 4 产）在 Task 5/6 用它。
**自审订正过一处**：初稿 Task 5 调用了一个并不存在的 `putDashcardMappings`，且 Task 6 要用的
一个字段定义缺位 ⇒ 已把它收进 `DashcardRef`（Task 3），
Task 5 改为**透传 `parameterMappings`**（不再需要额外函数）。

---

### 终审修复（2026-09-29，最终整支评审人裁——三条进同一次 fix dispatch）

1. **TENANT_PARAM 单一来源**：`routes/reports.ts` 不再自持 `'tenant'` 字面量，改从 `domain/report-content` import `TENANT_SLUG`。失效模式：TENANT_PARAM 漂移 ⇒ lockedParams 路径 `setEmbedding` 整表替换时丢 `tenant:'locked'` ⇒ 静默解锁租户。单一来源后相等性由构造保证（无需测试钉死）。
2. **getDashboardFull 畸形 `parameter_mappings` 改 throw**：`pm != null && !Array.isArray(pm) ⇒ MetabaseError`（同文件对畸形 `card_id` 已是 throw，fail-closed 口径一致）。静默丢在合并写路径上 = 该卡现有映射**下次发布被清掉**——正是本支要防的失效类。
3. **renderer 守卫落地**（Task 2「凡读 metabaseId 前先判 renderer」的承诺）：reconcile 对 `renderer === 'platform'` 的行**整体跳过**（不读 metabase、不进 tenantUnlocked/tenantUnbound）；DELETE **跳过 `archiveDashboard`**（登记行删除照旧）。platform 行今天无生产写入方，守卫是给计划 2/3 的消费方铺路。

测试纪律：每条先红后绿；(2)(3) 各配变异确认（退回旧形状 ⇒ 恰自己那条红）。

## 与另两份计划的关系（建议的拆分）

| 计划 | 内容 | 依赖 |
|---|---|---|
| **1（本份）** | 报表写入面：非破坏性发布 + 三件套 + 指纹 + 对账加厚 | 无（**可独立交付**：它修的是既有的 `POST /reports`） |
| **2** | 统一管理面（console 列表/页门/发布/回收）+ 反代编辑页三约束 | 计划 1 |
| **3** | agent 制作通路（选指标/选维度、自绘规格、L2 提议）+ 语义的源维度 | 计划 1；**源维度**还依赖 §7 待办 6（待拍） |

**建议按 1 → 2 → 3 的顺序**（spec §8 的落地顺序即此），且**计划 3 里依赖"源维度"的部分要等待拍 6 定案**再写。
