# 平台自绘 实施计划（报表制作域 6/7）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落 spec §3⑥（agent 出**声明式规格**、不出代码；**严格字段白名单是机检落点**）与 §5（**平台自绘**这条渲染路：直连物化层、按调用者身份注入主体值；两条实测渲染坑）。

**Architecture:**
- **规格 = 严格白名单的声明式 JSON**：`domain/report-spec.ts` 用 zod 写 schema，**每个对象都 `.strict()`**（仓内已有 4 处同款先例，`metrics.ts` 那句注释把理由写死了：「`.strict()` 是『禁任意 SQL』的**机检落点**，不是风格——用默认 strip 会让调用方传 `selectSql` 时**静默无效**」）。
- **图型白名单是代码常量**（人裁 2026-09-30）：写在 `report-spec.ts` 里，**走 PR 加**；租户与 agent 只能**选**，不能扩。理由与 `.strict()` 一致：白名单是机检落点，不是配置（落库可配会让「渲染器能力」与「平台代码」脱钩 ⇒ 库里加了图型而渲染器不认 = 静默空白）。
- **存储 = `data.reports.spec` 一列**（不另开表）：这样**规格写保护免费复用** plan 4 的登记表版本守卫（`PUT /reports/:id/spec` 带 `expectedVersion`），且与既有裁决「不为发布另加状态列」一致。
- **数据通路 = 既有 `POST /query`，一个面板一次**（不新造数据端点）：`runQuery` 已经做全了三件——语义裁剪、授权、**按调用者身份注入主体值**，并把每次结局写进 `data.query_audit`。自绘因此**不依赖 Metabase 的锁定参数**，与 Metabase 那条路**判据同源**（spec §5）。
- **渲染器质量归我们**（spec §5 明写）：本期交付两类图 + 两条实测坑的修法（分组数据用**透视数据集**而非把点塞进系列；画布收 `overflow`）。

**Tech Stack:** zod（严格白名单）+ node-postgres（迁移 007）+ Hono（三个端点）+ **echarts**（人裁 2026-09-30；按需模块导入控体积）+ React/antd + vitest（含真 PG 组）。

## Global Constraints

1. **规格里不许出现可执行内容**：白名单外的键一律 400（`.strict()`，**不是** strip）。这条是 spec §3⑥ 的实测结论：**没有白名单时，规格里多塞一个可执行字段会被照单接受**（当时渲染器恰好不读它才没出事）。
2. **图型白名单是代码常量**，加图型 = 改常量 + 加渲染分支 + 测试，**走 PR**；**不许**做成 env / DB 可配。
3. **迁移号 007**（模块侧；现有 001–006，**实施前再 `ls` 确认一次**）；幂等。
4. **`renderer='platform'` 的行今天没有任何渲染通路**（只有守卫与展示）⇒ 本计划要把「打开」从置灰改成真入口，并**同时**把 `GET /reports/:id/spec` 的**页门**判上（照 `embed-url` 的 `visibleTo`）。
5. **`platform` 行的内容版本 = 登记表 `version`**（它没有 Metabase 内容 ⇒ 没有指纹）；规格写入**必带 `expectedVersion`**（复用 plan 4 的失败形态：不符 ⇒ 409 `STALE_WRITE` 带 `currentVersion`）。
6. **不新增数据端点**：面板数据走既有 `POST /query`（`data:query`）；**别**为了省一次往返造一个「整报表数据」端点——那会把 N 次授权/审计合成一次，削弱既有的逐查询留痕。
7. **B1**：只动 `modules/data/**`（schema `data`）；`platform.` 不出现。**零新后端依赖**；前端只加 `echarts`。
8. **提交**：Conventional Commits，**单 scope**（`feat(data)` / `feat(data,web)` 之类**不许带逗号**——多 scope 会被 `check-dev-discipline` 拦），每任务一提交。
9. **测试口径**：`DATABASE_URL` 由 shell 提供；数据侧真 PG 组用既有 `describe.skipIf(!dbUrl)` 壳；前端用 `console/` 既有的 `createMemoryRouter` + Outlet 壳（antd **6.6.3** 惯用法：中文按钮名用容空白正则、Popconfirm 显式 `okText` + `findByRole`）。
10. **不在本计划范围**：**提议/确认流**（§4.3 的「提议≠新建」「强制搜词表查重」）、**`tier` 的落库与人评门**、**「未声明口径」的可见性**（§4.3.3，需要新的「报表↔图」映射）⇒ 全部归**计划 7**；agent 工具面本身（`list_metrics`/`query_metric`/MCP）**已存在**，本计划不加工具。

---

### Task 1: 迁移 007 —— `data.reports.spec` + 存储层带上规格

**Files:**
- Create: `modules/data/migrations/007_report_spec.sql`（**先 `ls modules/data/migrations/` 确认号段**）
- Modify: `modules/data/domain/report-store.ts`（`ReportRow` 加 `spec: ReportSpec | null`；`upsertReport` 写入；新 `updateSpec(...)` 条件更新）
- Test: `modules/data/domain/report-store.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `REPORT_COLS` 常量、`toReportRow`、plan 4 的 `version` 列与条件更新范式。
- Produces:
  - `data.reports.spec jsonb`（**可空**）+ 一条跨列 check（`renderer='platform'` ⇒ `spec` 非空）。
  - `updateSpec(pool, org, id, spec, expectedVersion): Promise<ReportRow | null>`（与 `updateRequiredScope` 同款条件更新，`version = version + 1`）。

- [ ] **Step 1: 写迁移**（幂等）

```sql
-- 007_report_spec.sql — 平台自绘报表的**声明式规格**（spec §3⑥；计划 6）。
-- 存成一列而非另开表：这样规格写保护**免费复用**登记表版本守卫（plan 4），
-- 且与既有裁决「不为发布另开状态列」一致。
alter table data.reports add column if not exists spec jsonb;
-- 跨列约束：自绘行必须有规格（Metabase 行必须没有——两边都不许半吊子）
do $$ begin
  alter table data.reports add constraint data_reports_spec_by_renderer check (
    (renderer = 'platform' and spec is not null) or (renderer = 'metabase' and spec is null)
  );
exception when duplicate_object then null; end $$;
```

- [ ] **Step 2: 写失败测试**（`report-store.test.ts` 的 `describePg` 内）

```ts
  it('★ spec：自绘行必须带规格；条件更新（陈旧版本不落）', async () => {
    const org = 'org-spec-store'
    await pool.query('delete from data.reports where org = $1', [org])
    // 自绘行没有 spec ⇒ 库侧直接拒（跨列 check）
    await expect(upsertReport(pool, org, {
      title: 'S', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
    })).rejects.toThrow()

    const id = await upsertReport(pool, org, {
      title: 'S', metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform',
      spec: { panels: [] },
    })
    expect((await getReport(pool, org, id))!.spec).toEqual({ panels: [] })
    expect((await getReport(pool, org, id))!.version).toBe(1)

    expect(await updateSpec(pool, org, id, { panels: [] }, 99)).toBeNull()          // 陈旧 ⇒ null
    const ok = await updateSpec(pool, org, id, { panels: [] }, 1)
    expect(ok).toMatchObject({ version: 2 })
  })
```

- [ ] **Step 3: 跑测试确认红** → `DATABASE_URL='postgres://platform:platform@127.0.0.1:5432/platform' pnpm --filter data exec vitest run domain/report-store.test.ts`

- [ ] **Step 4: 实现**（`REPORT_COLS` 加 `spec`；`ReportRow.spec: ReportSpec | null`；`upsertReport` 的 insert/冲突分支都写 `spec`；新增 `updateSpec` 照 `updateRequiredScope` 的条件更新写）

- [ ] **Step 5: 跑测试确认绿 + 全模块** → `DATABASE_URL=… pnpm --filter data test`

- [ ] **Step 6: Commit**

```bash
git add modules/data/migrations/007_report_spec.sql modules/data/domain/report-store.ts modules/data/domain/report-store.test.ts
git commit -m "feat(data): 自绘规格落 data.reports.spec（跨列 check + 条件更新）"
```

---

### Task 2: 规格 schema + 图型白名单（严格白名单 = 机检落点）

**Files:**
- Create: `modules/data/domain/report-spec.ts`、`modules/data/domain/report-spec.test.ts`
- Modify: `modules/data/console/lib/api.ts`（`MESSAGES` 加规格相关码）

**Interfaces:**
- Produces:
  - `CHART_TYPES = ['line', 'bar', 'table'] as const`——**图型白名单（代码常量；加图型必须同时加渲染分支 + 测试，走 PR）**。
  - `ReportSpec` 类型 + `ReportSpecSchema`（zod，**每一层 `.strict()`**）。
  - `parseReportSpec(input: unknown): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode }`，`SpecErrorCode ∈ {'INVALID_SPEC','UNKNOWN_CHART_TYPE','SPEC_TOO_LARGE'}`。

- [ ] **Step 1: 写失败测试**（**先写「多塞可执行字段」这条**——它是 spec §3⑥ 的实测回归）

```ts
import { describe, expect, it } from 'vitest'
import { parseReportSpec, MAX_PANELS } from './report-spec'

const ok = {
  panels: [{
    chart: 'line', title: '净销售额趋势', metricId: 'lemeng:retail:net_sales',
    dims: ['bizday'], args: { system_book: '3120' }, span: 12,
  }],
}

describe('报表规格（严格白名单）', () => {
  it('合法规格通过', () => {
    // ⚠️ 夹具必须**把 zod 默认值写全**（dims/args/span）：schema 里它们有 `.default()`，
    //    解析结果会补齐 ⇒ 拿一个缺省的夹具去做 `toEqual` 必红（这是实施时最容易踩的一步）。
    expect(parseReportSpec(ok)).toEqual({ ok: true, spec: ok })
  })

  it('★ 白名单外的键一律拒（含可执行字段）——spec §3⑥ 的实测回归', () => {
    for (const extra of [
      { selectSql: 'select 1' },                    // 可执行内容
      { panels: [{ ...ok.panels[0], script: 'alert(1)' }] },
      { panels: [{ ...ok.panels[0], args: { x: 1 } }], extra: true },
    ]) {
      const out = parseReportSpec({ ...ok, ...extra })
      expect(out.ok).toBe(false)
      expect(out.ok === false && out.code).toBe('INVALID_SPEC')
    }
  })

  it('★ 图型必须在白名单里（未知图型给专门码，便于前端出人话）', () => {
    const out = parseReportSpec({ panels: [{ ...ok.panels[0], chart: 'sankey3d' }] })
    expect(out).toEqual({ ok: false, code: 'UNKNOWN_CHART_TYPE' })
  })

  it('面板数与字段长度有上限（体量闸）', () => {
    const many = { panels: Array.from({ length: MAX_PANELS + 1 }, () => ok.panels[0]) }
    expect(parseReportSpec(many)).toEqual({ ok: false, code: 'SPEC_TOO_LARGE' })
  })
})
```

- [ ] **Step 2: 跑测试确认红** → `pnpm --filter data exec vitest run domain/report-spec.test.ts`

- [ ] **Step 3: 实现 `report-spec.ts`**

```ts
// report-spec.ts — 平台自绘的**声明式规格**（spec §3⑥；计划 6）。
//
// 两条硬约束写在类型里，不写在提示词里：
//  ① **每一层 `.strict()`**：白名单外的键一律 400。理由与 routes/metrics.ts 那句同款——
//     `.strict()` 是「禁任意 SQL」的**机检落点**：用 zod 默认的 strip，调用方塞一个 `selectSql`
//     会**静默无效**（spec §3⑥ 实测过：没有白名单时，规格里多塞一个可执行字段被**照单接受**）。
//  ② **图型白名单是代码常量**（人裁 2026-09-30）：租户与 agent 只能选、不能扩；
//     加图型 = 改这个常量 + 加渲染分支 + 测试，**走 PR**。做成 env/DB 可配会让
//     「渲染器能力」与「平台代码」脱钩 ⇒ 库里加了图型而渲染器不认 = **静默空白**。
import { z } from 'zod'

export const CHART_TYPES = ['line', 'bar', 'table'] as const
export const MAX_PANELS = 24
export const MAX_DIMS = 4

const PanelSchema = z.object({
  chart: z.enum(CHART_TYPES),
  title: z.string().trim().min(1).max(120),
  metricId: z.string().min(1).max(128),                  // 语义 id；合法性由 runQuery 判（同源判据）
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  args: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),   // 等值过滤，与 /query 同形
  span: z.number().int().min(1).max(24).default(12),     // 24 栅格
}).strict()

export const ReportSpecSchema = z.object({ panels: z.array(PanelSchema).max(MAX_PANELS) }).strict()

export type ReportSpec = z.infer<typeof ReportSpecSchema>
export type SpecErrorCode = 'INVALID_SPEC' | 'UNKNOWN_CHART_TYPE' | 'SPEC_TOO_LARGE'

export function parseReportSpec(input: unknown): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode } {
  // 体量闸先判（避免超大体量先被逐字段解析）
  const panels = (input as { panels?: unknown })?.panels
  if (Array.isArray(panels) && panels.length > MAX_PANELS) return { ok: false, code: 'SPEC_TOO_LARGE' }
  const parsed = ReportSpecSchema.safeParse(input)
  if (parsed.success) return { ok: true, spec: parsed.data }
  // 未知图型单独给码：前端要能说「这个图型平台还不支持」，而不是笼统的「规格不合法」
  const bad = parsed.error.issues.find((i) => i.path.at(-1) === 'chart')
  if (bad) return { ok: false, code: 'UNKNOWN_CHART_TYPE' }
  return { ok: false, code: 'INVALID_SPEC' }
}
```

- [ ] **Step 4: `MESSAGES` 加文案**（`console/lib/api.ts`）

```ts
  INVALID_SPEC: '报表规格不合法（含不支持的字段或取值）',
  UNKNOWN_CHART_TYPE: '这个图型平台还不支持（图型白名单由平台代码维护）',
  SPEC_TOO_LARGE: '报表规格过大（面板数超出上限）',
```

- [ ] **Step 5: 跑测试确认绿** → `pnpm --filter data exec vitest run domain/report-spec.test.ts`；另 `pnpm typecheck`

- [ ] **Step 6: Commit**

```bash
git add modules/data/domain/report-spec.ts modules/data/domain/report-spec.test.ts modules/data/console/lib/api.ts
git commit -m "feat(data): 自绘规格 schema + 图型白名单（严格白名单=机检落点）"
```

---

### Task 3: 写入与读取面（三个端点 + manifest 同提交）

**Files:**
- Modify: `modules/data/routes/reports.ts`（`POST /reports` 加 `renderer`/`spec` 分支；新增 `PUT /reports/:id/spec` 与 `GET /reports/:id/spec`）
- Modify: `modules/data/manifest.yaml`（`api.internal` 加两行，**同一提交**）
- Test: `modules/data/routes/reports.test.ts`（追加 + 声明用例 19 → 21）

**Interfaces:**
- Consumes: Task 2 的 `parseReportSpec`；Task 1 的 `updateSpec`；既有 `visibleTo`（页门）。
- Produces:
  - `POST /reports` body 加 **`renderer: 'metabase' | 'platform'`（默认 `metabase`）** 与 **`spec: object | null`（默认 `null`）**；`renderer='platform'` 时：**完全不碰 Metabase**（不 `upsertDashboard`、不 `publish`、不 `setEmbedding`），`metabaseId` 写哨兵 `0`，规格经 `parseReportSpec` 校验（不合法 ⇒ 400 带专门码）。
  - `PUT /reports/:id/spec`（`data:manage`）：body `{ spec, expectedVersion }`（**`.strict()`**）⇒ 200 `{version}`；行不存在/跨租户 ⇒ 404；版本不符 ⇒ 409 `STALE_WRITE` + `currentVersion`；非自绘行 ⇒ **409 `RENDERER_NOT_SELF_DRAWN`**。
  - `GET /reports/:id/spec`（`data:query`）：**先 `visibleTo`**（页门未放行的行 ⇒ 403，照 `embed-url` 的口径）⇒ 200 `{spec, version}`；非自绘行 ⇒ 409 `RENDERER_NOT_SELF_DRAWN`。

- [ ] **Step 1: 写失败测试**（含声明用例改成 21 个端点）

```ts
  it('★ 自绘报表：创建完全不碰 Metabase，规格经白名单校验', async () => {
    const { app } = manage()
    mb.state.calls.length = 0
    const res = await post(app, {
      title: '自绘大盘', renderer: 'platform', spec: { panels: [] },
    })
    expect(res.status).toBe(201)
    expect(mb.state.calls).toHaveLength(0)         // 一条 Metabase 调用都没有
    expect((await res.json()).metabaseId).toBe(0)  // 哨兵

    const bad = await post(app, {
      title: '坏规格', renderer: 'platform', spec: { panels: [], selectSql: 'select 1' },
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('INVALID_SPEC')
  })

  it('★ 规格读写：页门先判（403）、版本必带（409）、非自绘行 409', async () => {
    // 自绘行（requiredScope='sales:read'）+ 本 org 无该 scope 的 viewer
    // GET /spec ⇒ 403 { error:'FORBIDDEN', need:'sales:read' }
    // PUT /spec 缺 expectedVersion ⇒ 400；陈旧 ⇒ 409 STALE_WRITE + currentVersion；命中 ⇒ 200 且 version+1
    // 对 metabase 行 PUT /spec ⇒ 409 RENDERER_NOT_SELF_DRAWN
  })
```

- [ ] **Step 2: 跑测试确认红**

- [ ] **Step 3: 实现**（两新端点 + `POST /reports` 分支）

> ⚠️ **分支位置是硬要求**：`renderer==='platform'` 的分支必须在 **`metabaseFromEnv()` 那次检查之前**
> （现有实现在 requester 检查之后立刻判 `if (!cfg) return 503 METABASE_UNCONFIGURED`）——
> **自绘报表不该因为「Metabase 没配」而建不出来**（自绘本来就不碰 Metabase）。顺序反了会在
> "平台自绘可用、Metabase 未配"的环境里**误报 503**。
> 另外 `manifest.yaml` 加 `GET /reports/:id/spec`（`data:query`）与 `PUT /reports/:id/spec`（`data:manage`），
> **注册序：字面量路径在前、param 在后**（#145 口径）。

- [ ] **Step 4: 跑测试确认绿 + 全模块**（含装载期双向核对：声明 21 条与注册集合逐条一致）

- [ ] **Step 5: Commit**（路由 + manifest **同一提交**）

```bash
git add modules/data/routes/reports.ts modules/data/routes/reports.test.ts modules/data/manifest.yaml
git commit -m "feat(data): 自绘报表创建 + 规格读写端点（页门先判、版本必带）"
```

---

### Task 4: 渲染器（前端 eccharts 最小集 + 两条实测坑）

**Files:**
- Modify: `modules/data/package.json`（加 `echarts`）
- Create: `modules/data/console/reports/SpecView.tsx`、`modules/data/console/reports/SpecView.test.tsx`
- Modify: `modules/data/console/reports/index.tsx`（platform 行的「打开」从置灰改为打开自绘视图）

**Interfaces:**
- Consumes: `GET /reports/:id/spec`（Task 3）、既有 `POST /query`（**面板数据唯一通路**，不新造端点）。
- Produces: `<SpecView reportId title onClose />`——拉规格 → 逐面板 `POST /query` → 渲染。

- [ ] **Step 1: 加依赖**（`pnpm --filter data add echarts`，按需引入，别 `import * as echarts`）

- [ ] **Step 2: 写失败测试**（照 console 既有 `createMemoryRouter` + Outlet 壳；`platformFetch` 桩）

```tsx
  it('★ 打开自绘行 ⇒ 拉规格 + 逐面板查数据（走既有 /query）', async () => {
    // 桩：GET /reports/r9/spec ⇒ {spec:{panels:[{chart:'line',metricId:'m1',dims:['bizday'],args:{},...}]}, version:1}
    //      POST /query ⇒ {status:'ok', columns:['bizday','value'], rows:[['2026-09-01', 1234]]}
    // 断言：两条请求都发出；页面出现面板标题；query 的 body 里含该面板的 metricId/dims/args 逐字
  })

  it('★ 面板查询被拒（denied）⇒ 该面板出人话，不拖垮整页', async () => {
    // POST /query ⇒ {status:'denied', reason:'metric_not_declared'}
    // 断言：该面板显示"这条口径当前不可用"，其余面板照常渲染
  })
```

- [ ] **Step 3: 跑测试确认红 → 实现 `SpecView.tsx`**，**两条实测坑写进代码注释并落到实现**：
  - **分组数据要透视**：多系列时把「维度×系列」做成**透视数据集**（每个系列一个 `data` 数组、`xAxis.data` 用维度值），**不要**把多出来的点直接塞进一个系列——spec §5 实测：「按『过滤同组』塞进系列会把多出来的点**连成一条线**」。
  - **画布收 `overflow`**：容器 `overflow: 'hidden'` + echarts `grid` 显式留白——spec §5 实测：「图表画布会**溢出到隔壁格子**」。
  - 每面板 `span` 走 24 栅格（antd `Row/Col`）；`chart==='table'` 用 antd `Table`（不引 echarts）。

- [ ] **Step 4: 报表页接线**：platform 行的「打开」不再置灰（Tooltip 文案改为「打开自绘视图」），点击 ⇒ `setSelfDrawn({ title, id })` 渲染 `<SpecView/>`；**保留** `打开` 对 metabase 行的既有行为（embed-url 那条路不变）。

- [ ] **Step 5: 跑测试确认绿 + 回归** → `pnpm --filter data exec vitest run console/` → `pnpm --filter data test` → `pnpm --filter web test` → `pnpm typecheck` → `pnpm --filter web build`（**确认 echarts 打进 console 分包、体积可接受**，把构建输出的 chunk 尺寸摘录进报告）

- [ ] **Step 6: Commit**

```bash
git add modules/data/package.json pnpm-lock.yaml modules/data/console/reports/SpecView.tsx modules/data/console/reports/SpecView.test.tsx modules/data/console/reports/index.tsx
git commit -m "feat(data): 自绘渲染器（echarts 最小集 + 透视数据集与 overflow 两条实测修法）"
```

---

### Task 5: 数据通路与判据同源（验证而非新造）

**Files:**
- Test: `modules/data/routes/query.test.ts`（或既有 query 测试文件）追加两条
- Modify: `modules/data/README.md`（「自绘」小节，见 Task 6 一并写）

**Interfaces:** 无新接口——本任务**证明**既有通路满足 spec §5 的要求。

- [ ] **Step 1: 写两条断言**（证明自绘的数据通路与 Metabase 那条**判据同源**、且身份注入成立）

```ts
  it('★ 自绘面板的数据走 /query：语言裁剪 + 按调用者身份注入主体值（与 Metabase 那条判据同源）', async () => {
    // 同一 metricId：A 租户的 requester ⇒ 只见 A 的主体值；B 租户 ⇒ 只见 B 的（断言 SQL 的 subject 注入逐字）
  })

  it('★ 每次面板查询都落 data.query_audit（逐查询留痕，不因"一个报表 N 个面板"而合并）', async () => {
    // 连打 3 个不同面板的 /query ⇒ data.query_audit 多 3 行（按 metric_id 逐条断言）
  })
```

- [ ] **Step 2: 跑测试确认红 → 若无红则说明既有通路已满足**（评审要看到「这条是**验证**不是新造」的证据：报告里写清「无需改实现」或「改了 X」）

- [ ] **Step 3: Commit**

```bash
git add modules/data/routes/query.test.ts
git commit -m "test(data): 自绘数据通路与 Metabase 判据同源 + 逐查询留痕的回归断言"
```

---

### Task 6: 文档与 spec 结案

**Files:**
- Modify: `modules/data/README.md`（「报表面」小节加「平台自绘」子节）
- Modify: `docs/superpowers/specs/2026-09-28-report-authoring-design.md`（§7 待办 4 结案）

- [ ] **Step 1: README 补「平台自绘」子节**（逐字要点）

````markdown
### 平台自绘：声明式规格 + 代码常量白名单（spec §3⑥/§5）

- **规格存 `data.reports.spec`（jsonb）**，只对 `renderer='platform'` 的行非空（跨列 check 兜着）；
  **规格写保护复用登记表版本守卫**（`PUT /reports/:id/spec` 必带 `expectedVersion`，不符 ⇒ 409 `STALE_WRITE`）。
- **严格白名单是机检落点**：规格每层 `.strict()`，白名单外的键一律 400——**不是** strip
  （spec §3⑥ 实测：没有白名单时，规格里多塞一个可执行字段会被**照单接受**）。
- **图型白名单是代码常量**（`domain/report-spec.ts` 的 `CHART_TYPES`）：**加图型 = 改常量 + 加渲染分支 + 测试，走 PR**；
  **不做** env/DB 可配（那会让「渲染器能力」与「平台代码」脱钩 ⇒ 库里加了图型而渲染器不认 = 静默空白）。
- **数据通路 = 既有 `POST /query`，一个面板一次**：语义裁剪、授权、**按调用者身份注入主体值**、逐查询落
  `data.query_audit`，全部复用 ⇒ 自绘**不依赖 Metabase 锁定参数**，与 Metabase 那条路**判据同源**。
  别为了省往返造「整报表数据」端点——那会把 N 次授权/审计合并成一次。
- **两条实测渲染坑（spec §5）**：多系列要**透视数据集**（否则多出来的点会被连成一条线）；画布要收 `overflow`
  （否则溢出到隔壁格子）。**渲染器质量归我们**，这两条是渲染层的活、不是数据问题。
````

- [ ] **Step 2: spec 待办 4 结案**

```markdown
4. ~~自绘那面的 **规格 schema** 与渲染器边界（哪些图型进白名单、由谁定、怎么加）~~
   → ✅ **已定（2026-09-30 人裁 + 计划 6 落地）**：规格 = **严格白名单的声明式 JSON**（每层 `.strict()`，
   白名单外一律 400）；**图型白名单 = 代码常量，走 PR 加**（不做 env/DB 可配：白名单是机检落点，不是配置）；
   渲染器用 **echarts**；**渲染器质量归我们**（spec §5 的两条实测坑由本计划修）。
```

- [ ] **Step 3: Commit**

```bash
git add modules/data/README.md docs/superpowers/specs/2026-09-28-report-authoring-design.md
git commit -m "docs(data): 平台自绘的接线与边界 + spec 待办 4 结案"
```

---

## Self-Review（写完后自查）

**1. spec 覆盖**：§3⑥ 的三条（agent 出**声明式规格**不出代码 → 整份计划；**严格字段白名单是机检落点** → Task 2 的「多塞可执行字段 ⇒ 400」回归；渲染器边界/图型白名单 → Task 2 常量 + Task 4 渲染分支）；§5 的两条路边界（**自绘直连物化层、按身份注入主体值** → Task 5 的验证断言）与两条实测坑（Task 4）。§7 **待办 4** → Task 6 结案。
**2. 占位符扫描**：无 TBD；`…` 只用于命令里的 `DATABASE_URL` 重复前缀与「同款条件更新」这类**已在本仓存在的范式**指代（范式在 Task 1 里给了逐字实现）。
**3. 类型一致性**：`ReportSpec`（Task 2 产）在 Task 1/3/4 一致；`parseReportSpec` 的三个错误码（Task 2 产）在 Task 3 的路由与 Task 2 的 `MESSAGES` 同码；`updateSpec(pool, org, id, spec, expectedVersion)`（Task 1 产，Task 3 消）；`RENDERER_NOT_SELF_DRAWN` 在 Task 3 产出、Task 4 消费（`MESSAGES` 补文案）。

## 已定裁决（人裁 2026-09-30，实施前不要再翻）

| # | 问题 | 裁决 | 依据 |
|---|---|---|---|
| 1 | 计划 6 的范围 | **只做自绘**；提议/确认流 + `tier` + 「未声明口径」可见性 → **计划 7** | 两者风险面不同（渲染器与前端依赖 vs 词表治理与审批） |
| 2 | 图表库 | **echarts**（按需模块导入） | 能力面最宽（大屏/特殊图形/强联动 = 自绘存在的理由）；公司另一报表项目已在用 |
| 3 | 图型白名单治理 | **代码常量 + 走 PR**；不做 env/DB 可配 | 与仓内 4 处 `.strict()` 同源价值：白名单是**机检落点**，落库可配会让渲染器能力与代码脱钩 ⇒ 静默空白 |
| 4 | 自绘规格存哪 | **`data.reports.spec` 一列**（不另开表） | 写保护免费复用登记表版本守卫；与「不为发布另开状态列」的既有裁决一致 |
| 5 | 面板数据通路 | **既有 `POST /query`，一个面板一次**（不新造数据端点） | 授权/审计/主体注入全部复用；合并成一次会削弱逐查询留痕 |

## 与另几份计划的关系

| 计划 | 内容 | 状态 |
|---|---|---|
| 1–5 | 底座 / 写保护 / 管理面 / 反代会话 / 源维度 | 已交付（#329 / #385 / #338 / #366+#372 / #390） |
| **6（本份）** | **平台自绘**（§3⑥ 规格 + §5 渲染器与数据通路） | 待实施 |
| 7 | **词表治理面**：提议≠新建（工具面结构而非提示词）、强制搜词表查重、`tier` 落库与人评门、**「未声明口径」可见性**（§4.3.3，需新建「报表↔图」映射，因为平台侧今天没有这张关系表）| 待写 |
