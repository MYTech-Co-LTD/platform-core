# 月度经营报表重做实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把熊喵店92 月报从「7 条查询的并列」改造成店长 1 分钟能读完的月度体检：A 先止血，B+C 加时间预设/自动对比/KPI/文本/服务端分组，最后加报表版本管理与无导航独立链接。

**Architecture:** 报表仍是严格白名单的声明式 spec（`parseReportSpec` 唯一入口）；新增报表级 `period`、`kpi`/`text` 面板、`slice` 服务端分组与 `compare`；取数仍走 `/query`/`runQuery` 的授权核心。版本管理用 `report_versions` 不可变快照 + `data.reports.published_version_id`；独立链接 `/r/:id` 是 `ConsoleShell` 之外的裸路由，走登录态。

**Tech Stack:** TypeScript / Hono / zod / PostgreSQL(pg_duckdb) / React 19 / antd / echarts / vitest / pnpm。

## Global Constraints

- **严格白名单**：`parseReportSpec` 是报表 spec 的唯一入口；每层 `.strict()`；图型白名单是代码常量，加图型走 PR。
- **禁止裸 SQL**：报表只能选词表指标/维度/参数；取数只经 `/query`/`runQuery`；主体由平台按身份钉死。
- **非可加不求和**：`line`/`bar` 与 `kpi` 的指标必须 `totalable === true`；`table` 可看原始行。写入侧校验，不靠前端提示词。
- **历史不足显示 `-`**：无数据/对比期无数据/零分母，一律 `-`，不显示 0、∞、空白。
- **版本 = 定义版本**：`report_versions` 存 spec/title/页门；`?v=N` 用旧定义查当前湖数据；不是数据快照。
- **独立链接只走登录态**：平台会话/企微免登；不做公开链接、不做签名 token。
- **租户隔离**：所有版本读写带 `org`；跨租户恒 404。
- **迁移幂等**：DDL 全 `if not exists`；回填 `on conflict do nothing`；部署会全量重跑。
- **能提不能发**：agent 只建草稿/改未发布草稿；发布/下线/回滚仅 `data:manage` 的人。
- **提交纪律**：Conventional Commits；每 Task 一次提交；可见变更走 PR。

---

## Part 0：A 止血（今天，零改码）

### Task 0: 重写线上熊喵月报 spec（10 个面板）

**Files:**
- 无代码文件；生产数据 `data.reports.spec`（报表 id `a1b2c3d4-xm92-4a10-9c26-report000001`）。
- 可把下面的 JSON 存到 `docs/superpowers/notes/2026-10-26-monthly-report-stopgap-spec.json` 供 review（可选）。

**Interfaces:**
- 沿用现有 `line`/`bar`/`table` 与 `args`（允许 `total:true`）；不依赖 Part A/B。

- [ ] **Step 1: 写 A 版 spec**

```json
{
  "panels": [
    {
      "chart": "table", "title": "总销售额", "metricId": "lemeng:retail:net_sales",
      "dims": [], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" }, "total": true },
      "span": 24
    },
    {
      "chart": "table", "title": "总订单数", "metricId": "lemeng:retail:order_count",
      "dims": [], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" }, "total": true },
      "span": 24
    },
    {
      "chart": "table", "title": "报损合计", "metricId": "lemeng:loss:branch_amount",
      "dims": [], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" }, "total": true },
      "span": 24
    },
    {
      "chart": "table", "title": "应付合计", "metricId": "lemeng:expense:branch_payable",
      "dims": [], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" }, "total": true },
      "span": 24
    },
    {
      "chart": "line", "title": "销售额日趋势", "metricId": "lemeng:retail:net_sales",
      "dims": ["bizday"], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" } },
      "span": 24
    },
    {
      "chart": "bar", "title": "会员销售（按订单类型）", "metricId": "lemeng:member:branch_vip_money",
      "dims": ["order_sale_type_name"], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" } },
      "span": 24
    },
    {
      "chart": "bar", "title": "会员订单数（按订单类型）", "metricId": "lemeng:member:branch_vip_nums",
      "dims": ["order_sale_type_name"], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" } },
      "span": 24
    },
    {
      "chart": "bar", "title": "报损金额（按原因）", "metricId": "lemeng:loss:branch_amount",
      "dims": ["cause"], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" } },
      "span": 24
    },
    {
      "chart": "bar", "title": "应付费用（按项目）", "metricId": "lemeng:expense:branch_payable",
      "dims": ["expense_type"], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" } },
      "span": 24
    },
    {
      "chart": "bar", "title": "应收费用（按项目）", "metricId": "lemeng:expense:branch_receivable",
      "dims": ["expense_type"], "args": { "system_book": "3120", "branch_num": "92", "bizday": { "from": "2026-10-01", "to": "2026-10-19" } },
      "span": 24
    }
  ]
}
```

- [ ] **Step 2: 用当前 schema 验 JSON**

Run:
```bash
cd modules/data
pnpm exec tsx -e "import { parseReportSpec } from './domain/report-spec.ts'; import fs from 'node:fs'; const j=JSON.parse(fs.readFileSync('../../docs/superpowers/notes/2026-10-26-monthly-report-stopgap-spec.json','utf8')); console.log(parseReportSpec(j))"
```
Expected: `{ ok: true, spec: ... }`。若报 `UNKNOWN_CHART_TYPE` 说明把 `kpi`/`text` 混进来了——A 版只能用 line/bar/table。

- [ ] **Step 3: 应用到生产（已发布报表，需 data:manage 的人）**

Run（`$PLATFORM_ORIGIN`/`$PLATFORM_SESSION` 由执行人提供；不要把 token 写进文件）:
```bash
curl -s -X PUT "$PLATFORM_ORIGIN/api/modules/data/reports/a1b2c3d4-xm92-4a10-9c26-report000001/spec" \
  -H "Content-Type: application/json" \
  -H "Cookie: $PLATFORM_SESSION" \
  -d "{\"spec\": $(cat docs/superpowers/notes/2026-10-26-monthly-report-stopgap-spec.json), \"expectedVersion\": 4}"
```
Expected: 200 + `version: 5`。若 409 `STALE_WRITE`：先 `GET /reports/manage` 取最新 version 再重试。

- [ ] **Step 4: 验证**

1. `GET /api/modules/data/reports/:id/spec` 回 10 个 panel。
2. 打开报表：总销售额 51,273.89、总订单数 957、报损合计 806.64、应付合计 3,028.42。
3. 会员/报损/费用柱状按类型/原因/项目各一组，不再出现「日 × 类型」明细表。
4. 折线仍是倒序（A 版限制，B+C 修）；在交付说明里注明「A 版临时」。
5. 记录：报表 version 5；无代码提交。

---

## Part A：B+C 内容能力

### Task 1: 报表 spec schema（period / kpi / text / slice / compare）

**Files:**
- Modify: `modules/data/domain/report-spec.ts`
- Test: `modules/data/domain/report-spec.test.ts`

**Interfaces:**
- Produces: `ReportSpec`（含 `period?` 与 panel union）、`PeriodSpec`、`KpiPanel`、`TextPanel`、`MetricPanel`、`MAX_TEXT = 2000`。
- Consumes: zod only.

- [ ] **Step 1: 写失败测试**

```ts
// modules/data/domain/report-spec.test.ts（追加）
import { parseReportSpec, MAX_TEXT } from './report-spec'

const base = { system_book: '3120', branch_num: '92', bizday: { from: '2026-10-01', to: '2026-10-19' } }

describe('B+C schema', () => {
  it('period 三种模式通过；month/custom 缺参拒', () => {
    const ok = { period: { mode: 'month', month: '2026-10' }, panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: base, span: 24 }] }
    expect(parseReportSpec(ok).ok).toBe(true)
    expect(parseReportSpec({ ...ok, period: { mode: 'month' } }).ok).toBe(false)
    expect(parseReportSpec({ ...ok, period: { mode: 'custom', from: '2026-10-19', to: '2026-10-01' } }).ok).toBe(false)
  })

  it('kpi 通过；compare 只能出现在 kpi', () => {
    const kpi = { chart: 'kpi', title: '客单价', metricId: 'm1', denominatorMetricId: 'm2', format: 'currency', compare: 'prev_month', span: 12 }
    const spec = { panels: [kpi] }
    expect(parseReportSpec(spec).ok).toBe(true)
    const bad = { panels: [{ chart: 'line', title: 't', metricId: 'm', dims: [], args: {}, span: 24, compare: 'prev_month' }] }
    expect(parseReportSpec(bad).ok).toBe(false)
  })

  it('text 通过；超长/带 metricId 拒', () => {
    expect(parseReportSpec({ panels: [{ chart: 'text', content: '本月结论', span: 24 }] }).ok).toBe(true)
    expect(parseReportSpec({ panels: [{ chart: 'text', content: 'x'.repeat(MAX_TEXT + 1), span: 24 }] }).ok).toBe(false)
    expect(parseReportSpec({ panels: [{ chart: 'text', content: 'x', metricId: 'm', span: 24 }] }).ok).toBe(false)
  })

  it('slice 只在 line/bar/table；kpi 带 slice 拒', () => {
    const table = { chart: 'table', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 24, slice: { dimensions: ['bizday'], orderBy: [{ column: 'bizday', dir: 'asc' }], limit: 100 } }
    expect(parseReportSpec({ panels: [table] }).ok).toBe(true)
    const kpi = { chart: 'kpi', title: 't', metricId: 'm', format: 'number', slice: {}, span: 12 }
    expect(parseReportSpec({ panels: [kpi] }).ok).toBe(false)
  })

  it('旧规格仍通过（默认值补齐）', () => {
    const old = { panels: [{ chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: {}, span: 12 }] }
    expect(parseReportSpec(old).ok).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认红**

Run: `cd modules/data && pnpm exec vitest run domain/report-spec.test.ts`
Expected: FAIL（schema 还不认 period/kpi/text/slice）。

- [ ] **Step 3: 实现 schema**

```ts
// modules/data/domain/report-spec.ts（整体替换）
import { z } from 'zod'

export const CHART_TYPES = ['line', 'bar', 'table', 'kpi', 'text'] as const
export const MAX_PANELS = 24
export const MAX_DIMS = 4
export const MAX_TEXT = 2000

const RangeValueSchema = z.object({
  from: z.string().min(1).max(32),
  to: z.string().min(1).max(32),
}).strict()
const ArgValue = z.union([z.string(), z.number(), z.boolean(), RangeValueSchema])
const ArgsSchema = z.record(ArgValue).default({})
const DateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const MonthStr = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)

export const PeriodSchema = z.object({
  mode: z.enum(['month', 'last_7_days', 'custom']),
  month: MonthStr.optional(),
  from: DateStr.optional(),
  to: DateStr.optional(),
}).strict().superRefine((p, ctx) => {
  if (p.mode === 'month' && p.month === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['month'], message: 'mode=month 需要 month' })
  }
  if (p.mode === 'custom') {
    if (p.from === undefined || p.to === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['from'], message: 'mode=custom 需要 from/to' })
    } else if (p.from > p.to) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['to'], message: 'from 必须 <= to' })
    }
  }
})

const SliceSchema = z.object({
  dimensions: z.array(z.string().min(1).max(64)).max(MAX_DIMS).optional(),
  orderBy: z.array(z.object({
    column: z.string().min(1).max(64),
    dir: z.enum(['asc', 'desc']),
  }).strict()).max(4).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  total: z.boolean().optional(),
}).strict()

const metricBase = {
  title: z.string().trim().min(1).max(120),
  metricId: z.string().min(1).max(128),
  args: ArgsSchema,
  span: z.number().int().min(1).max(24).default(12),
  timeScoped: z.boolean().default(true),
}

const LinePanel = z.object({
  chart: z.literal('line'), ...metricBase,
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  slice: SliceSchema.optional(),
}).strict()
const BarPanel = z.object({ chart: z.literal('bar'), ...metricBase, dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]), slice: SliceSchema.optional() }).strict()
const TablePanel = z.object({ chart: z.literal('table'), ...metricBase, dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]), slice: SliceSchema.optional() }).strict()

const KpiPanel = z.object({
  chart: z.literal('kpi'),
  title: z.string().trim().min(1).max(120),
  metricId: z.string().min(1).max(128),
  denominatorMetricId: z.string().min(1).max(128).optional(),
  args: ArgsSchema,
  format: z.enum(['currency', 'number', 'percent']),
  compare: z.enum(['auto', 'prev_period', 'prev_month', 'none']).default('auto'),
  goodDirection: z.enum(['up', 'down', 'none']).default('none'),
  span: z.number().int().min(1).max(24).default(12),
  timeScoped: z.boolean().default(true),
}).strict()

const TextPanel = z.object({
  chart: z.literal('text'),
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().min(1).max(MAX_TEXT),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

export const ReportSpecSchema = z.object({
  period: PeriodSchema.optional(),
  panels: z.array(z.discriminatedUnion('chart', [LinePanel, BarPanel, TablePanel, KpiPanel, TextPanel])).max(MAX_PANELS),
}).strict()

export type ReportSpec = z.infer<typeof ReportSpecSchema>
export type PeriodSpec = z.infer<typeof PeriodSchema>
export type MetricPanel = z.infer<typeof LinePanel> | z.infer<typeof BarPanel> | z.infer<typeof TablePanel>
export type KpiPanel = z.infer<typeof KpiPanel>
export type TextPanel = z.infer<typeof TextPanel>
export type SpecErrorCode = 'INVALID_SPEC' | 'UNKNOWN_CHART_TYPE' | 'SPEC_TOO_LARGE'

export function parseReportSpec(input: unknown): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode } {
  const panels = (input as { panels?: unknown })?.panels
  if (Array.isArray(panels) && panels.length > MAX_PANELS) return { ok: false, code: 'SPEC_TOO_LARGE' }
  const parsed = ReportSpecSchema.safeParse(input)
  if (parsed.success) return { ok: true, spec: parsed.data }
  const bad = parsed.error.issues.find((i) => i.path.at(-1) === 'chart')
  if (bad !== undefined) return { ok: false, code: 'UNKNOWN_CHART_TYPE' }
  return { ok: false, code: 'INVALID_SPEC' }
}
```

- [ ] **Step 4: 更新旧测试夹具**

`report-spec.test.ts` 里旧的 `ok` 夹具补 `timeScoped: true`（zod 会补 default；`toEqual` 必须带全）。其它测试文件的 `ReportSpec` 夹具同样补 `timeScoped`。

- [ ] **Step 5: 跑绿 + 类型**

Run: `cd modules/data && pnpm exec vitest run domain/report-spec.test.ts && pnpm typecheck`
Expected: PASS；typecheck 会暴露 `report-scope.ts`/`SpecView.tsx` 的 union 收窄问题（Task 3/6 修）。

- [ ] **Step 6: 提交**

```bash
git add modules/data/domain/report-spec.ts modules/data/domain/report-spec.test.ts
git commit -m "feat(data-report): spec 支持 period/kpi/text/slice/compare"
```

### Task 2: 期间数学（periodRangeOf / previousRangeOf）

**Files:**
- Create: `modules/data/domain/report-period.ts`
- Test: `modules/data/domain/report-period.test.ts`

**Interfaces:**
- Consumes: `PeriodSpec` from `report-spec.ts`。
- Produces:
  - `type DateRange = { from: string; to: string }`
  - `periodRangeOf(period: PeriodSpec, now: Date): DateRange`
  - `previousRangeOf(range: DateRange, mode: 'prev_period' | 'prev_month'): DateRange`

- [ ] **Step 1: 写测试**

```ts
import { describe, expect, it } from 'vitest'
import { periodRangeOf, previousRangeOf } from './report-period'

const now = new Date('2026-10-26T12:00:00+08:00')

describe('periodRangeOf', () => {
  it('month 取整月；当月取今天', () => {
    expect(periodRangeOf({ mode: 'month', month: '2026-09' }, now)).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(periodRangeOf({ mode: 'month', month: '2026-10' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-26' })
  })
  it('last_7_days 与 custom', () => {
    expect(periodRangeOf({ mode: 'last_7_days' }, now)).toEqual({ from: '2026-10-20', to: '2026-10-26' })
    expect(periodRangeOf({ mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, now)).toEqual({ from: '2026-10-01', to: '2026-10-19' })
  })
})

describe('previousRangeOf', () => {
  it('prev_period 等长前移', () => {
    expect(previousRangeOf({ from: '2026-10-01', to: '2026-10-19' }, 'prev_period')).toEqual({ from: '2026-09-12', to: '2026-09-30' })
  })
  it('prev_month 同日期段并按月末夹取', () => {
    expect(previousRangeOf({ from: '2026-10-01', to: '2026-10-19' }, 'prev_month')).toEqual({ from: '2026-09-01', to: '2026-09-19' })
    expect(previousRangeOf({ from: '2026-03-01', to: '2026-03-31' }, 'prev_month')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
  })
})
```

- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run domain/report-period.test.ts`

- [ ] **Step 3: 实现**

```ts
import dayjs from 'dayjs'
import type { PeriodSpec } from './report-spec'

export interface DateRange { from: string; to: string }

const FMT = 'YYYY-MM-DD'

function todayShanghai(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

export function periodRangeOf(period: PeriodSpec, now: Date): DateRange {
  if (period.mode === 'custom') {
    if (period.from === undefined || period.to === undefined || period.from > period.to) {
      throw new Error('INVALID_PERIOD')
    }
    return { from: period.from, to: period.to }
  }
  if (period.mode === 'last_7_days') {
    const to = todayShanghai(now)
    return { from: dayjs(to).subtract(6, 'day').format(FMT), to }
  }
  if (period.month === undefined) throw new Error('INVALID_PERIOD')
  const start = dayjs(`${period.month}-01`)
  const end = start.endOf('month')
  const today = todayShanghai(now)
  const to = today.startsWith(period.month) ? today : end.format(FMT)
  return { from: start.format(FMT), to }
}

export function previousRangeOf(range: DateRange, mode: 'prev_period' | 'prev_month'): DateRange {
  if (mode === 'prev_period') {
    const len = dayjs(range.to).diff(dayjs(range.from), 'day') + 1
    const to = dayjs(range.from).subtract(1, 'day')
    return { from: to.subtract(len - 1, 'day').format(FMT), to: to.format(FMT) }
  }
  const start = dayjs(range.from).subtract(1, 'month')
  const len = dayjs(range.to).diff(dayjs(range.from), 'day')
  const wanted = start.add(len, 'day')
  const end = start.endOf('month')
  return { from: start.format(FMT), to: (wanted.isAfter(end) ? end : wanted).format(FMT) }
}
```

- [ ] **Step 4: 跑绿** `cd modules/data && pnpm exec vitest run domain/report-period.test.ts`

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/report-period.ts modules/data/domain/report-period.test.ts
git commit -m "feat(data-report): 报表期间与上一期间计算"
```

### Task 3: 写入侧校验（可加性 / 分母 / 源裁剪 / text 跳过）

**Files:**
- Modify: `modules/data/domain/report-scope.ts`
- Test: `modules/data/domain/report-scope.test.ts`

**Interfaces:**
- Consumes: `ReportSpec`、catalog rows `{ id, requiredScope, totalable, sourceSystem }`、`adoptedSources: ReadonlySet<string>`。
- Produces:
  - `deriveRequiredScope(spec, catalog): DeriveResult`（text 跳过；kpi 分母参与）
  - `validatePanelMetrics(spec, catalog, adoptedSources): ValidateResult`
  - `type ValidateResult = { ok: true } | { ok: false; reason: 'UNKNOWN_PANEL_METRIC' | 'METRIC_SOURCE_NOT_ADOPTED' | 'CHART_REQUIRES_ADDITIVE' | 'KPI_NOT_TOTALABLE'; metricId: string }`

- [ ] **Step 1: 写测试**

```ts
const cat = [
  { id: 'sales', requiredScope: null, totalable: true, sourceSystem: 'lemeng' },
  { id: 'ratio', requiredScope: null, totalable: false, sourceSystem: 'lemeng' },
  { id: 'cost', requiredScope: 'data:cost', totalable: true, sourceSystem: 'other' },
]
const adopted = new Set(['lemeng'])
const spec = (panels: any[]) => ({ panels })

it('text 跳过；kpi 分母参与 scope', () => {
  expect(deriveRequiredScope(spec([{ chart: 'text', content: 'x', span: 24 }]), cat)).toEqual({ ok: true, requiredScope: null })
  expect(deriveRequiredScope(spec([{ chart: 'kpi', title: 't', metricId: 'sales', denominatorMetricId: 'cost', format: 'number', span: 12 }]), cat))
    .toEqual({ ok: true, requiredScope: 'data:cost' })
})
it('line/bar 不可加拒；table 放行', () => {
  expect(validatePanelMetrics(spec([{ chart: 'line', title: 't', metricId: 'ratio', dims: [], args: {}, span: 24 }]), cat, adopted))
    .toEqual({ ok: false, reason: 'CHART_REQUIRES_ADDITIVE', metricId: 'ratio' })
  expect(validatePanelMetrics(spec([{ chart: 'table', title: 't', metricId: 'ratio', dims: [], args: {}, span: 24 }]), cat, adopted))
    .toEqual({ ok: true })
})
it('kpi 不可加拒；源未接入拒', () => {
  expect(validatePanelMetrics(spec([{ chart: 'kpi', title: 't', metricId: 'ratio', format: 'number', span: 12 }]), cat, adopted))
    .toEqual({ ok: false, reason: 'KPI_NOT_TOTALABLE', metricId: 'ratio' })
  expect(validatePanelMetrics(spec([{ chart: 'table', title: 't', metricId: 'cost', dims: [], args: {}, span: 24 }]), cat, adopted))
    .toEqual({ ok: false, reason: 'METRIC_SOURCE_NOT_ADOPTED', metricId: 'cost' })
})
```

- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run domain/report-scope.test.ts`

- [ ] **Step 3: 实现**

```ts
// report-scope.ts：在现有 deriveRequiredScope 基础上改
export interface ScopeRow { id: string; requiredScope: string | null; totalable: boolean; sourceSystem: string | null }
export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: 'UNKNOWN_PANEL_METRIC' | 'METRIC_SOURCE_NOT_ADOPTED' | 'CHART_REQUIRES_ADDITIVE' | 'KPI_NOT_TOTALABLE'; metricId: string }

function metricIdsOf(panel: ReportSpec['panels'][number]): string[] {
  if (panel.chart === 'text') return []
  if (panel.chart === 'kpi' && panel.denominatorMetricId !== undefined) return [panel.metricId, panel.denominatorMetricId]
  return [panel.metricId]
}

export function deriveRequiredScope(spec: ReportSpec, catalog: readonly ScopeRow[]): DeriveResult {
  const scopes = new Set<string>()
  for (const panel of spec.panels) {
    for (const id of metricIdsOf(panel)) {
      const metric = catalog.find((m) => m.id === id)
      if (metric === undefined) return { ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: id }
      if (metric.requiredScope !== null) scopes.add(metric.requiredScope)
    }
  }
  if (scopes.size > 1) return { ok: false, reason: 'CONFLICTING_PANEL_SCOPES', scopes: [...scopes] }
  return { ok: true, requiredScope: scopes.size === 0 ? null : [...scopes][0] }
}

export function validatePanelMetrics(
  spec: ReportSpec, catalog: readonly ScopeRow[], adoptedSources: ReadonlySet<string>,
): ValidateResult {
  for (const panel of spec.panels) {
    if (panel.chart === 'text') continue
    for (const id of metricIdsOf(panel)) {
      const metric = catalog.find((m) => m.id === id)
      if (metric === undefined) return { ok: false, reason: 'UNKNOWN_PANEL_METRIC', metricId: id }
      if (metric.sourceSystem !== null && !adoptedSources.has(metric.sourceSystem)) {
        return { ok: false, reason: 'METRIC_SOURCE_NOT_ADOPTED', metricId: id }
      }
      if ((panel.chart === 'line' || panel.chart === 'bar') && !metric.totalable) {
        return { ok: false, reason: 'CHART_REQUIRES_ADDITIVE', metricId: id }
      }
      if (panel.chart === 'kpi' && !metric.totalable) {
        return { ok: false, reason: 'KPI_NOT_TOTALABLE', metricId: id }
      }
    }
  }
  return { ok: true }
}
```

- [ ] **Step 4: 跑绿 + 修调用方**

Run: `cd modules/data && pnpm exec vitest run domain/report-scope.test.ts`
Expected: PASS。`routes/reports.ts` 的 `deriveRequiredScope` 调用仍编译（catalog 的 `MetricRow` 有新增字段）。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/report-scope.ts modules/data/domain/report-scope.test.ts
git commit -m "feat(data-report): 写入侧校验可加性/分母/源裁剪"
```

### Task 4: `/query` 支持服务端分组（dimensions/orderBy/limit/total）

**Files:**
- Modify: `modules/data/routes/query.ts`
- Test: `modules/data/routes/query.test.ts`

**Interfaces:**
- Consumes: `runQuery(deps, org, requester, metricId, args, slicing?)`。
- Produces: `POST /query` body `{metricId, args, dimensions?, orderBy?, limit?, total?}`；`total` 映射 `SlicingSpec.total`。

- [ ] **Step 1: 写失败测试**

```ts
it('dimensions/orderBy/limit 透传到 slicing（服务端分组）', async () => {
  const r = await app.request('/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ metricId: 'sales_daily', args: {}, dimensions: ['bizday'], orderBy: [{ column: 'bizday', dir: 'asc' }], limit: 10 }),
  })
  expect(r.status).toBe(200)
  // 用假 execute 捕获 SQL：应含 group by bizday / order by bizday asc / limit 10
})
it('不可加指标真子集切片 ⇒ 403 bad_param', async () => {
  const r = await app.request('/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ metricId: 'ratio', args: {}, dimensions: ['bizday'] }) })
  expect(r.status).toBe(403)
})
```

- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run routes/query.test.ts`

- [ ] **Step 3: 实现**

```ts
// routes/query.ts
const QueryBody = z.object({
  metricId: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  dimensions: z.array(z.string().min(1)).optional(),
  orderBy: z.array(z.object({
    column: z.string().min(1),
    dir: z.enum(['asc', 'desc']).optional(),
  })).optional(),
  limit: z.number().int().positive().optional(),
  total: z.boolean().optional(),
})

const body = parsed.data
const slicing = (body.dimensions !== undefined || body.orderBy !== undefined || body.limit !== undefined || body.total !== undefined)
  ? {
      ...(body.dimensions !== undefined ? { dimensions: body.dimensions } : {}),
      ...(body.orderBy !== undefined ? { orderBy: body.orderBy } : {}),
      ...(body.limit !== undefined ? { limit: body.limit } : {}),
      ...(body.total !== undefined ? { total: body.total } : {}),
    }
  : undefined
const outcome = await runQuery(
  { pool: ctx.pool, execute: ctx.execute, adoptedSources },
  org, requesterOf(c), body.metricId, body.args, slicing,
)
```

- [ ] **Step 4: 跑绿 + 类型**

Run: `cd modules/data && pnpm exec vitest run routes/query.test.ts && pnpm typecheck`

- [ ] **Step 5: 提交**

```bash
git add modules/data/routes/query.ts modules/data/routes/query.test.ts
git commit -m "feat(data): /query 支持服务端分组/排序/截断/合计"
```

### Task 5: MCP 工具面（get_report_spec / list_metrics 补 params / 提报校验）

**Files:**
- Modify: `modules/data/routes/mcp-report-tools.ts`
- Modify: `modules/data/routes/mcp-metric-tools.ts`
- Modify: `modules/data/routes/mcp-manage.test.ts`（工具名清单）
- Modify: `modules/data/routes/mcp-report-tools.test.ts`

**Interfaces:**
- Consumes: `getReport(pool, org, id)`、`loadMergedCatalog(pool, org)`、`deriveRequiredScope`、`validatePanelMetrics`。
- Produces:
  - `get_report_spec({id})` → `{id,title,renderer,requiredScope,version,spec}`
  - `list_metrics` 的 base/custom 行增加 `params: {name,type,required}[]` 与 `totalable: boolean`
  - `propose_report` / `revise_report_spec` 失败返回 `refused(code, {metricId})`

- [ ] **Step 1: 写失败测试**

```ts
it('get_report_spec 回草稿 + 版本', async () => {
  const out = await call('get_report_spec', { id: REPORT_ID })
  expect(JSON.parse(out.text)).toMatchObject({ status: 'ok', id: REPORT_ID, version: expect.any(Number), spec: expect.any(Object) })
})
it('list_metrics 回 params/totalable', async () => {
  const out = await call('list_metrics', {})
  const b = JSON.parse(out.text).bases[0]
  expect(b.params).toEqual(expect.arrayContaining([{ name: 'bizday', type: 'date_range', required: false }]))
  expect(b.totalable).toBe(true)
})
it('propose 不可加 line ⇒ CHART_REQUIRES_ADDITIVE', async () => {
  const out = await call('propose_report', { title: 'x', spec: { panels: [{ chart: 'line', title: 't', metricId: 'ratio', dims: [], args: {}, span: 24 }] } })
  expect(JSON.parse(out.text)).toMatchObject({ status: 'refused', error: 'CHART_REQUIRES_ADDITIVE' })
})
```

- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run routes/mcp-report-tools.test.ts routes/mcp-manage.test.ts`

- [ ] **Step 3: 实现**

```ts
// mcp-report-tools.ts
const NAMES = ['list_reports', 'propose_report', 'revise_report_spec', 'get_report_spec'] as const

// list() 追加：
{
  name: 'get_report_spec',
  description: '读一张报表的当前规格与版本（改报前先读，不要凭记忆重写整份 spec）。',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
}

// call() 分支：
if (name === 'get_report_spec') {
  const parsed = z.object({ id: z.string().min(1) }).strict().safeParse(args)
  if (!parsed.success) return refused('INVALID_BODY')
  const row = await getReport(deps.pool, deps.org, parsed.data.id)
  if (row === null) return refused('NOT_FOUND')
  return ok({ id: row.id, title: row.title, renderer: row.renderer, requiredScope: row.requiredScope, version: row.version, spec: row.spec })
}

// propose/revise 校验（两处都加）：
const catalog = await loadMergedCatalog(deps.pool, deps.org)
const scope = deriveRequiredScope(spec.spec, catalog)
if (!scope.ok) return refused(scope.reason, scope.reason === 'UNKNOWN_PANEL_METRIC' ? { metricId: scope.metricId } : { scopes: scope.scopes })
const v = validatePanelMetrics(spec.spec, catalog, deps.adoptedSources)
if (!v.ok) return refused(v.reason, { metricId: v.metricId })
```

```ts
// mcp-metric-tools.ts 的 view()
const view = (m: ... ) => ({
  id: m.id, title: m.title, description: m.description, dimensions: dimensionNamesOf(m),
  params: Object.entries(m.params).map(([name, p]) => ({ name, type: p.type, required: p.required === true })),
  totalable: m.totalable === true,
})
```

- [ ] **Step 4: 跑绿 + 更新工具名清单测试**

`mcp-manage.test.ts` 的 `METRIC_REPORT_TOOL_NAMES` 加 `'get_report_spec'`。

Run: `cd modules/data && pnpm exec vitest run routes/mcp-report-tools.test.ts routes/mcp-manage.test.ts && pnpm typecheck`

- [ ] **Step 5: 提交**

```bash
git add modules/data/routes/mcp-report-tools.ts modules/data/routes/mcp-metric-tools.ts modules/data/routes/mcp-report-tools.test.ts modules/data/routes/mcp-manage.test.ts
git commit -m "feat(data-mcp): get_report_spec + 词表补参数/可加 + 提报校验"
```

### Task 6: 渲染器（period 控件 / KPI / text / slice / 信任信号）

**Files:**
- Create: `modules/data/console/reports/ReportView.tsx`（承接现 `SpecView` 的面板渲染；`chrome: 'console' | 'standalone'`）
- Modify: `modules/data/console/reports/SpecView.tsx`（变薄壳：加载 spec → `<ReportView chrome="console" onClose=.../>`）
- Create: `modules/data/console/reports/KpiCard.tsx`
- Test: `modules/data/console/reports/SpecView.test.tsx`

**Interfaces:**
- Consumes: `periodRangeOf`/`previousRangeOf`、`apiGet`/`apiSend`、`ReportSpec`。
- Produces:
  - `ReportView` props `{ title: string; spec: ReportSpec; chrome: 'console' | 'standalone'; onClose?: () => void; pinnedVersion?: number | null }`
  - `KpiCard` props `{ panel: KpiPanel; args: Record<string, unknown>; compareRange: DateRange | null }`

- [ ] **Step 1: 写失败测试**

```tsx
it('period=month 时所有 timeScoped 面板带 bizday 窗口', async () => {
  render(<SpecView reportId="r1" title="t" onClose={() => {}} />)
  await waitFor(() => expect(vi.mocked(apiSend)).toHaveBeenCalledWith('/query', 'POST', expect.objectContaining({
    metricId: 'm', args: expect.objectContaining({ bizday: { from: '2026-10-01', to: '2026-10-26' } }),
  })))
})
it('kpi 有对比期就渲染差值；对比期无数据显示 -', async () => {
  render(<KpiCard panel={{ chart: 'kpi', title: '客单价', metricId: 'sales', denominatorMetricId: 'orders', format: 'currency', compare: 'prev_period', goodDirection: 'up', span: 12 }} args={{}} compareRange={{ from: '2026-09-12', to: '2026-09-30' }} />)
  await screen.findByText('-')
})
it('text 面板渲染换行，不渲染 HTML', () => {
  render(<SpecView reportId="r1" title="t" onClose={() => {}} />)
  expect(screen.getByText('第一行')).toBeTruthy()
})
```

- [ ] **Step 2: 跑红** `pnpm --filter @platform/web test -- SpecView`（或 `cd apps/web && pnpm exec vitest run ../../modules/data/console/reports/SpecView.test.tsx`；按现有测试入口跑）

- [ ] **Step 3: 实现 period 控件与参数注入**

```tsx
const [period, setPeriod] = useState<PeriodSpec | null>(spec?.period ?? null)
const range = period !== null ? periodRangeOf(period, new Date()) : null
const argsOf = (p: Panel, override: Record<string, unknown>) => ({
  ...p.args,
  ...(range !== null && p.chart !== 'text' && p.timeScoped !== false ? { bizday: range } : {}),
  ...override,
})
const compareRangeOf = (p: KpiPanel) => {
  if (range === null || p.compare === 'none') return null
  const mode = p.compare === 'auto' ? (period?.mode === 'month' ? 'prev_month' : 'prev_period') : p.compare
  return previousRangeOf(range, mode)
}
```

- [ ] **Step 4: 实现 KpiCard**

```tsx
export function KpiCard({ panel, args, compareRange }: { panel: KpiPanel; args: Record<string, unknown>; compareRange: DateRange | null }) {
  const [cur, setCur] = useState<number | null | undefined>(undefined)
  const [prev, setPrev] = useState<number | null | undefined>(undefined)
  useEffect(() => {
    let alive = true
    async function total(metricId: string, a: Record<string, unknown>) {
      const b = await apiSend('/query', 'POST', { metricId, args: { ...a, total: true } }) as { total?: number | string | null }
      return b.total === undefined || b.total === null ? null : Number(b.total)
    }
    async function load() {
      const n = await total(panel.metricId, args)
      const d = panel.denominatorMetricId === undefined ? null : await total(panel.denominatorMetricId, args)
      const value = d === null ? n : (n === null || d === null || d === 0 ? null : n / d)
      if (alive) setCur(value)
      if (compareRange !== null) {
        const n2 = await total(panel.metricId, { ...args, bizday: compareRange })
        const d2 = panel.denominatorMetricId === undefined ? null : await total(panel.denominatorMetricId, { ...args, bizday: compareRange })
        const value2 = d2 === null ? n2 : (n2 === null || d2 === null || d2 === 0 ? null : n2 / d2)
        if (alive) setPrev(value2)
      }
    }
    void load()
    return () => { alive = false }
  }, [panel.metricId, panel.denominatorMetricId, JSON.stringify(args), JSON.stringify(compareRange)])
  const fmt = (v: number | null | undefined) => v === null || v === undefined ? '-' : panel.format === 'percent' ? `${(v * 100).toFixed(2)}%` : panel.format === 'currency' ? `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : v.toLocaleString('zh-CN')
  const delta = cur === null || cur === undefined || prev === null || prev === undefined ? '-' : panel.format === 'percent' ? `${(cur - prev >= 0 ? '+' : '')}${((cur - prev) * 100).toFixed(2)}pp` : `${(cur - prev >= 0 ? '+' : '')}${(((cur - prev) / prev) * 100).toFixed(1)}%`
  return <Card size="small" title={panel.title}><Typography.Title level={3}>{fmt(cur)}</Typography.Title><Typography.Text type="secondary">{delta}</Typography.Text></Card>
}
```

- [ ] **Step 5: 实现 text / slice / 信任信号**

- `text`：`<Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{panel.content}</Typography.Paragraph>`。
- `slice`：查询 body 追加 `dimensions: p.slice?.dimensions ?? p.dims`、`orderBy`、`limit`、`total`。
- 信任信号：结果 state 存 `masking/data_as_of/freshness_line/truncated/total`；面板页脚显示一行；图表 `truncated` 也提示。
- 旧规格（无 `period`）走现有 RangePicker 分支，不改行为。

`SpecView` 变薄壳（保持现有调用方不变）：

```tsx
export default function SpecView({ reportId, title, onClose }: { reportId: string; title: string; onClose: () => void }) {
  const [spec, setSpec] = useState<ReportSpec | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    apiGet(`/reports/${reportId}/spec`).then((b) => setSpec((b as { spec: ReportSpec }).spec)).catch((e) => setFailed(messageOf(e)))
  }, [reportId])
  if (failed !== null) return <Alert type="error" message={failed} />
  if (spec === null) return <Spin />
  return <ReportView title={title} spec={spec} chrome="console" onClose={onClose} />
}
```

- [ ] **Step 6: 跑绿 + 类型 + 构建**

Run: `cd modules/data && pnpm typecheck && pnpm exec vitest run console/reports/SpecView.test.tsx`
Run: `pnpm --filter @platform/web build`
Expected: PASS。

- [ ] **Step 7: 提交**

```bash
git add modules/data/console/reports/SpecView.tsx modules/data/console/reports/KpiCard.tsx modules/data/console/reports/SpecView.test.tsx
git commit -m "feat(data-console): 报表期间控件/KPI/文本/服务端分组/信任信号"
```

### Task 7: v2 内容 spec（草稿，先不发布）

**Files:**
- Create: `docs/superpowers/notes/2026-10-26-monthly-report-v2-spec.json`
- No production write in this task（发布在 Part B 完成后）。

- [ ] **Step 1: 使用已附带的 v2 spec**

本计划已附带 `docs/superpowers/notes/2026-10-26-monthly-report-v2-spec.json`（15 个面板）：

| # | 面板 | 指标 | 关键字段 |
|---|---|---|---|
| 1–2 | 销售额 / 订单数 | `net_sales` / `order_count` | `kpi`，currency/number，`compare:auto` |
| 3 | 客单价 | `net_sales` ÷ `order_count` | `kpi`，`denominatorMetricId` |
| 4 | 会员销售占比 | `branch_vip_money` ÷ `net_sales` | `kpi`，percent |
| 5–6 | 报损金额 / 报损率 | `loss:branch_amount`（÷ `net_sales`） | `kpi`，currency/percent，`goodDirection:down` |
| 7–8 | 费用合计 / 费用率 | `expense:branch_net`（÷ `net_sales`） | `kpi`，currency/percent，`goodDirection:down` |
| 9 | 本月结论 | — | `text`，静态文本（人/agent 每期更新） |
| 10 | 销售额日趋势 | `net_sales` | `line` + `slice`（bizday asc） |
| 11–12 | 会员销售 / 会员订单 | `member_vip_money` / `vip_nums` | `bar` + `slice`（order_sale_type_name） |
| 13 | 报损（按原因） | `loss:branch_amount` | `bar` + `slice`（cause） |
| 14 | 费用（按项目，净额） | `expense:branch_net` | `bar` + `slice`（expense_type） |
| 15 | 连续无业绩天数 | `consecutive_no_sales_days` | `table`（非可加，不切片） |

`period` 默认 `{ "mode": "custom", "from": "2026-10-01", "to": "2026-10-19" }`；KPI 比率全部用两个可加 L1 相除。

- [ ] **Step 2: 用 parseReportSpec + 校验器验**

Run:
```bash
cd modules/data
pnpm exec tsx -e "import { parseReportSpec } from './domain/report-spec.ts'; import fs from 'node:fs'; const j=JSON.parse(fs.readFileSync('../../docs/superpowers/notes/2026-10-26-monthly-report-v2-spec.json','utf8')); console.log(parseReportSpec(j))"
```
Expected: `ok:true`；再用 `deriveRequiredScope`/`validatePanelMetrics` 对真词表跑一遍（用生产词表快照或 `loadMergedCatalog`）。

- [ ] **Step 3: 提交 note（不发布）**

```bash
git add docs/superpowers/notes/2026-10-26-monthly-report-v2-spec.json
git commit -m "docs(report): 熊喵月报 v2 内容 spec（草稿）"
```

---

## Part B：版本管理与独立链接

### Task 8: 迁移 022（report_versions + published_version_id + 回填）

**Files:**
- Create: `modules/data/migrations/022_report_versions.sql`
- Verify: 本地 PG / CI 迁移跑通

- [ ] **Step 1: 写迁移**

```sql
create table if not exists data.report_versions (
  id             text        not null primary key,
  org            text        not null,
  report_id      text        not null,
  version        integer     not null,
  title          text        not null,
  spec           jsonb       not null,
  required_scope text,
  draft_version  integer     not null,
  published_at   timestamptz not null default now(),
  published_by   text        not null,
  note           text        not null default '',
  unique (org, report_id, version),
  foreign key (org, report_id) references data.reports(org, id) on delete cascade
);

alter table data.reports add column if not exists published_version_id text;

-- 回填：现有“已发布”（页门 null）的平台报表 → v1
insert into data.report_versions
  (id, org, report_id, version, title, spec, required_scope, draft_version, published_at, published_by, note)
select
  md5(r.org || ':' || r.id || ':' || '1'),
  r.org, r.id, 1, r.title, r.spec, r.required_scope, r.version, r.updated_at, 'migration', ''
from data.reports r
where r.renderer = 'platform' and r.spec is not null and r.required_scope is null
on conflict (org, report_id, version) do nothing;

update data.reports r
set published_version_id = v.id
from data.report_versions v
where v.org = r.org and v.report_id = r.id and v.version = 1
  and r.published_version_id is null
  and r.renderer = 'platform' and r.spec is not null and r.required_scope is null;
```

- [ ] **Step 2: 本地验证幂等**

Run（用本地/测试 PG；不要在生产手跑）:
```bash
psql "$DATABASE_URL" -f modules/data/migrations/022_report_versions.sql
psql "$DATABASE_URL" -f modules/data/migrations/022_report_versions.sql
psql "$DATABASE_URL" -Atc "select count(*) from data.report_versions"
```
Expected: 两次都成功；count 稳定（第二次不新增）。

- [ ] **Step 3: 提交**

```bash
git add modules/data/migrations/022_report_versions.sql
git commit -m "feat(data): 报表版本表 + published_version_id + 回填 v1"
```

### Task 9: 版本存储层（发布/下线/回滚/历史）

**Files:**
- Create: `modules/data/domain/report-version.ts`
- Modify: `modules/data/domain/report-store.ts`（`ReportRow` 增 `publishedVersionId`/`publishedVersion`）
- Test: `modules/data/domain/report-version.test.ts`

**Interfaces:**
- Produces:
  - `publishVersion(pool, org, id, expectedVersion, userId, note): Promise<PublishOutcome>`
  - `unpublishVersion(pool, org, id, expectedVersion): Promise<boolean>`
  - `rollbackVersion(pool, org, id, version, expectedVersion, userId, note): Promise<PublishOutcome>`
  - `listVersions(pool, org, id): Promise<VersionRow[]>`
  - `getVersion(pool, org, id, version): Promise<VersionRow | null>`
  - `getPublishedSpec(pool, org, id, version?): Promise<{title,spec,version,requiredScope,publishedAt} | null>`

- [ ] **Step 1: 写测试**（用现有 report-store 测试的 PG 夹具）
  - 发布 v1 → 行存在、`published_version_id` 指向它。
  - 再发布无改动 → `unchanged:true`，版本数不变。
  - 改草稿再发布 → v2。
  - 回滚 v1 → v3 内容 = v1。
  - 下线 → `published_version_id=null`；`getPublishedSpec` 回 null。
  - 跨 org/不存在 → null。
- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run domain/report-version.test.ts`

- [ ] **Step 3: 实现 `publishVersion`（核心；unpublish/rollback 同构）**

```ts
// modules/data/domain/report-version.ts
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { withObjectLock } from './object-lock'
import { getReport, getReportVersion } from './report-store'
import { parseReportSpec } from './report-spec'
import { deriveRequiredScope, validatePanelMetrics } from './report-scope'
import { loadMergedCatalog } from './metric-store'

export interface PublishOutcome {
  ok: true
  publishedVersion: number
  publishedAt: string
  requiredScope: string | null
  unchanged?: boolean
}
export type PublishError =
  | { ok: false; reason: 'NOT_FOUND' | 'STALE_WRITE' | 'RENDERER_NOT_SELF_DRAWN' | 'NO_SPEC' | 'INVALID_SPEC' | 'UNKNOWN_PANEL_METRIC' | 'CONFLICTING_PANEL_SCOPES' | 'CHART_REQUIRES_ADDITIVE' | 'KPI_NOT_TOTALABLE' | 'METRIC_SOURCE_NOT_ADOPTED'; detail?: string }
export type PublishResult = PublishOutcome | PublishError

async function withTx<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect()
  try { await c.query('begin'); const out = await fn(c); await c.query('commit'); return out }
  catch (e) { await c.query('rollback'); throw e }
  finally { c.release() }
}

export async function publishVersion(
  pool: Pool, org: string, id: string, expectedVersion: number,
  userId: string, note: string, adoptedSources: ReadonlySet<string>,
): Promise<PublishResult> {
  return withObjectLock(`${org}/row:${id}`, async () => {
    const cur = await getReport(pool, org, id)
    if (cur === null) return { ok: false, reason: 'NOT_FOUND' }
    if (cur.renderer !== 'platform') return { ok: false, reason: 'RENDERER_NOT_SELF_DRAWN' }
    if (cur.spec === null) return { ok: false, reason: 'NO_SPEC' }
    if (cur.version !== expectedVersion) return { ok: false, reason: 'STALE_WRITE' }
    const parsed = parseReportSpec(cur.spec)
    if (!parsed.ok) return { ok: false, reason: 'INVALID_SPEC', detail: parsed.code }
    const catalog = await loadMergedCatalog(pool, org)
    const scope = deriveRequiredScope(parsed.spec, catalog)
    if (!scope.ok) return { ok: false, reason: scope.reason, detail: 'metricId' in scope ? scope.metricId : scope.scopes.join(',') }
    const v = validatePanelMetrics(parsed.spec, catalog, adoptedSources)
    if (!v.ok) return { ok: false, reason: v.reason, detail: v.metricId }

    return withTx(pool, async (c) => {
      const latest = await c.query(
        `select version, title, spec, required_scope, draft_version from data.report_versions
         where org=$1 and report_id=$2 order by version desc limit 1`, [org, id])
      const last = latest.rows[0] as { version: number; title: string; spec: unknown; required_scope: string | null; draft_version: number } | undefined
      if (last !== undefined && last.title === cur.title && JSON.stringify(last.spec) === JSON.stringify(cur.spec)
          && last.required_scope === scope.requiredScope && last.draft_version === cur.version) {
        return { ok: true, publishedVersion: last.version, publishedAt: new Date().toISOString(), requiredScope: scope.requiredScope, unchanged: true }
      }
      const version = (last?.version ?? 0) + 1
      const vid = randomUUID()
      await c.query(
        `insert into data.report_versions
           (id, org, report_id, version, title, spec, required_scope, draft_version, published_by, note)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [vid, org, id, version, cur.title, JSON.stringify(parsed.spec), scope.requiredScope, cur.version, userId, note.slice(0, 200)])
      await c.query(
        `update data.reports set published_version_id=$1, required_scope=$2, updated_at=now()
         where org=$3 and id=$4 and version=$5`,
        [vid, scope.requiredScope, org, id, expectedVersion])
      return { ok: true, publishedVersion: version, publishedAt: new Date().toISOString(), requiredScope: scope.requiredScope }
    })
  })
}
```

- 幂等比较用**稳定序列化**（键排序）或 spec hash；别用裸 `JSON.stringify`（JSONB 键序可能不同，会多造一个空版本）。
- `update … where version=$5` 的 `rowCount===0` ⇒ 抛 `StaleWrite` 让事务回滚，外层转 409（不能把已插入的快照提交出去）。

`unpublishVersion`：同一把锁下 `update data.reports set published_version_id=null, required_scope='data:manage', version=version+1 where org=$1 and id=$2 and version=$expected`；`rowCount===0` 再查 404/409。
`rollbackVersion`：读旧快照 → 重新 `deriveRequiredScope`/`validatePanelMetrics` → 事务内更新 `data.reports` 的 `title/spec`（`version+1`）→ 插新版本（`version=max+1`）→ 设 `published_version_id`。
`getPublishedSpec`：`select v.title, v.spec, v.version, v.required_scope, v.published_at from data.report_versions v join data.reports r on r.published_version_id=v.id where r.org=$1 and r.id=$2 [and v.version=$3]`。

- [ ] **Step 4: 跑绿 + 类型**
- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/report-version.ts modules/data/domain/report-store.ts modules/data/domain/report-version.test.ts
git commit -m "feat(data): 报表版本发布/下线/回滚/历史存储"
```

### Task 10: 路由 + manifest（publish/unpublish/rollback/versions/published-spec/draft）

**Files:**
- Modify: `modules/data/routes/reports.ts`
- Modify: `modules/data/manifest.yaml`
- Test: `modules/data/routes/reports.test.ts`

**Interfaces:**
- Endpoints per spec §5；platform `PUT /reports/:id` ⇒ 409 `USE_PUBLISH_ENDPOINT`。
- `GET /reports/:id/published-spec` 用**快照自己的** `required_scope` 判权（`?v=N` 用 vN 的门）；当前行页门只服务草稿/预览。见 Task 10b。
- `GET /reports/:id/versions` 最多 100 条。

- [ ] **Step 1: 写测试**

```ts
it('publish v1 → published-spec 可读；改草稿后 published-spec 不变', async () => {
  const changedSpec = { panels: [{ chart: 'text', content: 'changed', span: 24 }] }
  const p = await app.request(`/reports/${ID}/publish`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedVersion: 1 }) })
  expect(p.status).toBe(200)
  const v1 = await (await app.request(`/reports/${ID}/published-spec`, { headers: auth })).json()
  expect(v1.version).toBe(1)
  await app.request(`/reports/${ID}/spec`, { method: 'PUT', headers: auth, body: JSON.stringify({ spec: changedSpec, expectedVersion: 2 }) })
  const still = await (await app.request(`/reports/${ID}/published-spec`, { headers: auth })).json()
  expect(still.version).toBe(1)
})
it('unpublish → published-spec 404；?v=1 也 404', async () => {
  const u = await app.request(`/reports/${ID}/unpublish`, { method: 'POST', headers: auth, body: JSON.stringify({ expectedVersion: 3 }) })
  expect(u.status).toBe(200)
  expect((await app.request(`/reports/${ID}/published-spec`, { headers: auth })).status).toBe(404)
  expect((await app.request(`/reports/${ID}/published-spec?v=1`, { headers: auth })).status).toBe(404)
})
it('跨租户 ⇒ 404', async () => {
  const r = await app.request(`/reports/${ID}/published-spec`, { headers: otherOrgAuth })
  expect(r.status).toBe(404)
})
it('平台行 PUT /reports/:id ⇒ 409 USE_PUBLISH_ENDPOINT', async () => {
  const r = await app.request(`/reports/${ID}`, { method: 'PUT', headers: auth, body: JSON.stringify({ requiredScope: null, expectedVersion: 2 }) })
  expect(r.status).toBe(409)
})
```

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现路由 + manifest**

```ts
// routes/reports.ts（追加；沿用 reportIdOf/requesterOf/withObjectLock）
r.post('/reports/:id/publish', async (c) => {
  const requester = requesterOf(c)
  if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
  const id = reportIdOf(c.req.param('id'))
  if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
  const body = z.object({ expectedVersion: z.number().int().positive().max(2147483647), note: z.string().max(200).default('') }).strict()
    .safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
  const out = await publishVersion(ctx.pool, c.get('tenant').casdoor_org, id, body.data.expectedVersion,
    requester.userId, body.data.note, new Set(c.get(TENANT_SOURCES) ?? []))
  if (!out.ok) return c.json(out, out.reason === 'NOT_FOUND' ? 404 : out.reason === 'STALE_WRITE' ? 409 : 400)
  return c.json(out)
})

r.get('/reports/:id/published-spec', async (c) => {
  const requester = requesterOf(c)
  if (requester === null) return c.json({ error: 'UNAUTHENTICATED' }, 403)
  const id = reportIdOf(c.req.param('id'))
  if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
  const v = c.req.query('v')
  const version = v === undefined ? undefined : Number(v)
  if (version !== undefined && (!Number.isInteger(version) || version <= 0)) return c.json({ error: 'NOT_FOUND' }, 404)
  const report = await getReport(ctx.pool, c.get('tenant').casdoor_org, id)
  if (report === null) return c.json({ error: 'NOT_FOUND' }, 404)
  const row = await getPublishedSpec(ctx.pool, c.get('tenant').casdoor_org, id, version)
  if (row === null) return c.json({ error: 'NOT_PUBLISHED' }, 404)
  // 快照自己的页门；不通过 ⇒ 404（不给存在性探针）
  if (row.requiredScope !== null && !requester.hasScope(row.requiredScope)) return c.json({ error: 'NOT_FOUND' }, 404)
  return c.json(row)
})
```

manifest 追加（注册集合必须逐条一致；装载期会双向核对）：

```yaml
- { method: POST, path: /reports/:id/publish,                   scope: data:manage }
- { method: POST, path: /reports/:id/unpublish,                 scope: data:manage }
- { method: POST, path: /reports/:id/versions/:version/rollback, scope: data:manage }
- { method: GET,  path: /reports/:id/versions,                   scope: data:manage }
- { method: GET,  path: /reports/:id/versions/:version,          scope: data:manage }
- { method: GET,  path: /reports/:id/published-spec,             scope: data:query }
- { method: GET,  path: /reports/:id/draft,                      scope: data:manage }
```

`GET /published-spec` 的页门检查用**快照自己的** `required_scope`（不是当前行页门）；`?v=N` 用 vN 的门。当前行页门只服务草稿/预览（Task 10b）。平台行的 `PUT /reports/:id` 改为：

```ts
if (current.renderer === 'platform') return c.json({ error: 'USE_PUBLISH_ENDPOINT' }, 409)
```

- [ ] **Step 4: 跑绿 + 装载冒烟** `pnpm smoke`（需 DATABASE_URL）
- [ ] **Step 5: 提交**

### Task 10b: 发布态页门归快照（T10 实现中发现）

**Files:**
- Modify: `modules/data/routes/reports.ts`、`routes/reports.test.ts`

- [ ] `PUT /reports/:id/spec`：`published_version_id` 非空 ⇒ 用 `updateSpec`（只写草稿，不动 `required_scope`）；未发布 ⇒ 仍用 `updateSpecAndScope`。
- [ ] `GET /reports/:id/published-spec`：先确认报表存在 + 有已发布版本，再按**该快照的** `required_scope` 用 `requester.hasScope` 判权；不通过 404；下线总闸留在存储层。
- [ ] 测试：已发布行改草稿门不变；`?v=N` 用 vN 的门；未发布行仍同步派生门；变异验证（回退任一条即红）。
- [ ] 提交 `fix(data): 发布态页门归快照，草稿编辑不再改写线上门`。

### Task 11: MCP 字段（publishedVersion / hasUnpublishedChanges / revise 拒已发布）

**Files:**
- Modify: `modules/data/routes/mcp-report-tools.ts`
- Modify: `modules/data/routes/mcp-report-tools.test.ts`

- [ ] `list_reports` 行加 `publishedVersion` / `hasUnpublishedChanges`；`get_report_spec` 加 `publishedVersion` / `publishedAt`。

```ts
// listReports 查询加 left join；ReportRow 增 publishedVersionId/publishedVersion/publishedDraftVersion
const rows = await listReports(deps.pool, org)
return ok({ reports: rows.map((r) => ({
  id: r.id, title: r.title, renderer: r.renderer, requiredScope: r.requiredScope, version: r.version,
  panels: r.spec?.panels.length ?? null,
  publishedVersion: r.publishedVersion ?? null,
  hasUnpublishedChanges: r.publishedVersion !== null && r.version > (r.publishedDraftVersion ?? 0),
})) })
```

- [ ] `revise_report_spec` 的拒绝条件从 `requiredScope === null` 改成 `publishedVersion !== null`（`PUBLISHED_REPORT`）。

```ts
it('list_reports 带 publishedVersion/hasUnpublishedChanges', async () => {
  const out = await call('list_reports', {})
  expect(JSON.parse(out.text).reports[0]).toMatchObject({ publishedVersion: 1, hasUnpublishedChanges: false })
})
it('revise 已发布报表 ⇒ PUBLISHED_REPORT', async () => {
  const out = await call('revise_report_spec', { id: PUBLISHED_ID, spec: {}, expectedVersion: 2 })
  expect(JSON.parse(out.text)).toMatchObject({ status: 'refused', error: 'PUBLISHED_REPORT' })
})
```

- [ ] 测试 + 提交：`git commit -m "feat(data-mcp): 报表工具面带版本信息"`。

### Task 12: console 版本 UI（发布/下线/历史/独立链接）

**Files:**
- Modify: `modules/data/console/reports/index.tsx`
- Test: `modules/data/console/reports/index.test.tsx`

- [ ] 行徽标：已发布 vN / 有未发布改动 / 未发布。

```tsx
{row.publishedVersion === null
  ? <Tag>未发布</Tag>
  : row.hasUnpublishedChanges ? <Tag color="orange">v{row.publishedVersion} · 有未发布改动</Tag> : <Tag color="green">已发布 v{row.publishedVersion}</Tag>}
```

- [ ] 动作：发布（note）、下线、版本历史抽屉（查看 `/r/:id?v=N`、回滚）、复制独立链接。

```tsx
const publish = async (r: ReportRow, note: string) => {
  await apiSend(`/reports/${r.id}/publish`, 'POST', { expectedVersion: r.version, note })
  messageApi.success(`已发布 v${r.publishedVersion! + 1}`)
  await load()
}
const unpublish = async (r: ReportRow) => {
  await apiSend(`/reports/${r.id}/unpublish`, 'POST', { expectedVersion: r.version })
  messageApi.success('已下线')
  await load()
}
const copyLink = async (r: ReportRow) => {
  const url = `${window.location.origin}/r/${r.id}`
  try { await navigator.clipboard.writeText(url); messageApi.success('独立链接已复制') }
  catch { messageApi.info(url) }
}
const openVersions = async (r: ReportRow) => {
  const b = await apiGet(`/reports/${r.id}/versions`) as { versions: VersionRow[] }
  setVersions({ id: r.id, rows: b.versions })
}
const rollback = async (r: ReportRow, v: number) => {
  await apiSend(`/reports/${r.id}/versions/${v}/rollback`, 'POST', { expectedVersion: r.version, note: `rollback from v${v}` })
  await load()
}
```

- [ ] 平台行隐藏「改页门」；Metabase 行保持。

```tsx
it('点发布 → POST /reports/r1/publish', async () => {
  render(<ReportsPage />)
  await user.click(await screen.findByRole('button', { name: '发布' }))
  await user.click(screen.getByRole('button', { name: '确认发布' }))
  expect(vi.mocked(apiSend)).toHaveBeenCalledWith('/reports/r1/publish', 'POST', expect.objectContaining({ expectedVersion: expect.any(Number) }))
})
```

- [ ] 测试 + 提交：`git commit -m "feat(data-console): 报表发布/下线/版本历史/独立链接"`。

### Task 13: 抽 ReportView + 独立页 + `/r/:id` 裸路由

**Files:**
- Use: `modules/data/console/reports/ReportView.tsx`（Task 6 已建）
- Create: `modules/data/console/standalone.tsx`
- Modify: `apps/web/src/App.tsx`（`/r/:id` 顶层路由，在 `*` 兜底之前）
- Test: `modules/data/console/standalone.test.tsx`、`apps/web/src/App.test.tsx`（新）

- [ ] standalone 页面调 `/published-spec`；不回退草稿；无 Menu/ProLayout/管理按钮；`ReportView chrome="standalone"`。

```tsx
// modules/data/console/standalone.tsx
import { useEffect, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { apiGet, messageOf } from './lib/api'
import ReportView from './reports/ReportView'
import type { ReportSpec } from '../domain/report-spec'

export default function StandaloneReport() {
  const { id } = useParams()
  const [sp] = useSearchParams()
  const v = sp.get('v')
  const [data, setData] = useState<{ title: string; spec: ReportSpec; version: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!id) return
    apiGet(`/reports/${id}/published-spec${v ? `?v=${encodeURIComponent(v)}` : ''}`)
      .then((b) => setData(b as { title: string; spec: ReportSpec; version: number }))
      .catch((e) => setError(messageOf(e)))
  }, [id, v])
  if (error !== null) return <div style={{ padding: 24 }}>{error}</div>
  if (data === null) return <div style={{ padding: 24 }}>加载中…</div>
  return <ReportView title={data.title} spec={data.spec} chrome="standalone" pinnedVersion={v === null ? null : Number(v)} />
}
```

- [ ] `App.tsx` 懒加载；登录回跳保留 `?v=N`。

```tsx
import { lazy, Suspense } from 'react'
const StandaloneReport = lazy(() => import('../../../modules/data/console/standalone'))
// 放在 { path: '/' } 之后、{ path: '*' } 之前
{ path: '/r/:id', element: <Suspense fallback={null}><StandaloneReport /></Suspense> },
```

登录回跳用例：`/login?next=%2Fr%2Fabc%3Fv%3D1` 登录成功后 `location` 应为 `/r/abc?v=1`（#1060 的查询串透传；若现有 `nextTarget` 已导出可直接断言，否则通过表单提交后的 `window.location` 断言）。

- [ ] 390×844 视口走查；无横向溢出。

```tsx
it('standalone 不渲染导航/菜单', async () => {
  vi.mocked(apiGet).mockResolvedValue({ title: '月报', version: 1, spec: { panels: [{ chart: 'text', content: '结论', span: 24 }] } })
  render(<StandaloneReport />)
  await screen.findByText('结论')
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.queryByText('关闭')).toBeNull()
})
```

- [ ] 测试 + 提交：`git commit -m "feat(web): 报表独立页 /r/:id（无壳移动端）"`。

### Task 14: v2 报表发布 + 真机验收

- [ ] 用 v2 spec 建草稿（`propose_report` 或 `POST /reports`），人审后 `POST /publish`。
- [ ] 打开 `/r/:id`：无导航、KPI 8 张、期间可切、对比有数据/`-` 正确、柱状按维度汇总。
- [ ] 锚点：销售额 51,273.89、订单 957、会员 24,284.39/455、报损 806.64、应付 3,028.42、应收 415.00。
- [ ] 版本：改草稿 → 链接不变；发布 v2 → 链接变；`?v=1` 回旧版；回滚 → v3；下线 → 链接失效。
- [ ] 记录验收结果；无代码提交。

---

## Self-Review

- **Spec coverage**：B+C 的 period/compare/kpi/text/slice/写入校验/`/query`/MCP/渲染器 → Task 1–6；A 止血 → Task 0；版本管理 → Task 8–12；独立链接 → Task 13；v2 发布 → Task 7 + 14。
- **Placeholder scan**：无 TBD/TODO；UI 步骤给了组件结构与关键逻辑，执行时按现有 antd 模式补样式。
- **Type consistency**：`PeriodSpec`/`DateRange`/`ReportSpec`/`KpiPanel`/`validatePanelMetrics`/`publishVersion` 命名前后一致；`publishedVersion` 在 MCP/console 两处同义。
- **Known dependency**：Task 10 的发布校验在 Task 3 之后；Task 13 依赖 Task 10 的 `/published-spec`；Task 14 依赖 Task 7 的 v2 spec。
