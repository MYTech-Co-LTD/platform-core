# `ai_text` AI 生成文本组件实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给报表 spec 增加 `ai_text` 组件，让 agent 在提报时引用；观看时按当前期间/门店服务端流式生成「结论/异常/行动」，数字只来自报表事实包，失败回退模板。

**Architecture:** spec 内联 `ai_text`（v1 `focus=overview`）→ `POST /reports/:id/narrative/stream`（SSE，另留 JSON 端点）→ 事实包从报表自身数据面板经 `runQuery` 授权核心计算 → `completeStream` 调 `deepseek-flash` → 增量数字校验 → `report_narratives` 内容寻址缓存/审计。

**Tech Stack:** TypeScript / zod / Hono / PostgreSQL / React 19 / antd / vitest / pnpm；LLM 为 OpenAI 兼容 `DATA_LLM_*`。

## Global Constraints

- **严格白名单**：`parseReportSpec` 是唯一入口；每层 `.strict()`；`ai_text` 只能 `focus:'overview'`（v1）。
- **禁止裸 SQL**：事实只经 `runQuery`；主体钉死、指标 scope、维度/参数校验、掩码、审计与 `/query` 同源。
- **数字只来自事实包**：文本里每个数字必须在 `facts.numbers` 里；越界即 abort/replace；最终回退确定性模板。
- **流式**：SSE 事件 `phase/delta/replace/done/error`；响应头必须有 `x-accel-buffering: no`；原始 `reasoning_content` 不展示。
- **`maxTokens=1500`**：思考 token 计入预算；300 会在思考阶段耗尽、正文为空（2026-10-26 实测）。
- **首正文约 3.2s**：UI 必须有 `phase(thinking)`，不能空白。
- **缓存内容寻址**：`(org, report, specKey, panelIndex, focus, periodKey, branchKey, factsHash, promptVersion, model)`；命中不调模型。
- **租户/页门**：已发布快照用快照自己的 `required_scope`；草稿仅 `data:manage`；跨租户 404。
- **迁移幂等**：DDL 全 `if not exists`；部署会全量重跑。
- **提交纪律**：Conventional Commits；每 Task 一次提交；可见变更走 PR。

---

### Task 1: spec schema + 写侧结构闸

**Files:**
- Modify: `modules/data/domain/report-spec.ts`
- Modify: `modules/data/domain/report-scope.ts`
- Test: `modules/data/domain/report-spec.test.ts`
- Test: `modules/data/domain/report-scope.test.ts`

**Interfaces:**
- Produces:
  - `AiTextPanel = { chart:'ai_text'; title:string; focus:'overview'; span:number }`
  - `CHART_TYPES` 含 `'ai_text'`
  - `SpecErrorCode` 增 `'UNKNOWN_AI_FOCUS'`
  - `ValidateResult` 增 `'AI_TEXT_REQUIRES_DATA_PANEL' | 'AI_TEXT_REQUIRES_PERIOD'`

- [ ] **Step 1: 写失败测试（schema）**

```ts
// modules/data/domain/report-spec.test.ts（追加）
const ai = { chart: 'ai_text' as const, title: '本月结论', focus: 'overview' as const, span: 24 }
const line = {
  chart: 'line' as const, title: '趋势', metricId: 'lemeng:retail:net_sales',
  dims: ['bizday'], args: { branch_num: '92' }, span: 24,
  timeScoped: true,
}

it('ai_text 通过；focus 越界给 UNKNOWN_AI_FOCUS', () => {
  const spec = { period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, panels: [ai, line] }
  expect(parseReportSpec(spec).ok).toBe(true)
  const bad = { ...spec, panels: [{ ...ai, focus: 'cost' }, line] }
  expect(parseReportSpec(bad)).toEqual({ ok: false, code: 'UNKNOWN_AI_FOCUS' })
})

it('ai_text 带未知键 ⇒ INVALID_SPEC', () => {
  const bad = { period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, panels: [{ ...ai, content: 'x' }, line] }
  expect(parseReportSpec(bad).ok).toBe(false)
})
```

- [ ] **Step 2: 写失败测试（写侧）**

```ts
// modules/data/domain/report-scope.test.ts（追加）
const cat = [{ id: 'sales', requiredScope: null, totalable: true, sourceSystem: 'lemeng' }]
const adopted = new Set(['lemeng'])
const ai = { chart: 'ai_text' as const, title: '结论', focus: 'overview' as const, span: 24 }
const line = { chart: 'line' as const, title: '趋势', metricId: 'sales', dims: [], args: {}, span: 24, timeScoped: true }

it('ai_text 无数据面板 ⇒ AI_TEXT_REQUIRES_DATA_PANEL', () => {
  expect(validatePanelMetrics({ panels: [ai] }, cat, adopted))
    .toEqual({ ok: false, reason: 'AI_TEXT_REQUIRES_DATA_PANEL' })
})
it('ai_text 无 report period ⇒ AI_TEXT_REQUIRES_PERIOD', () => {
  expect(validatePanelMetrics({ panels: [ai, line] }, cat, adopted))
    .toEqual({ ok: false, reason: 'AI_TEXT_REQUIRES_PERIOD' })
})
it('ai_text + 数据面板 + period 通过；不引入 scope', () => {
  const spec = { period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, panels: [ai, line] }
  expect(validatePanelMetrics(spec, cat, adopted)).toEqual({ ok: true })
  expect(deriveRequiredScope(spec, cat)).toEqual({ ok: true, requiredScope: null })
})
```

- [ ] **Step 3: 跑红**

Run: `cd modules/data && pnpm exec vitest run domain/report-spec.test.ts domain/report-scope.test.ts`
Expected: FAIL（`ai_text` 未知图型/未知 reason）。

- [ ] **Step 4: 实现 schema**

```ts
// report-spec.ts
export const CHART_TYPES = ['line', 'bar', 'table', 'kpi', 'text', 'ai_text'] as const

const AiTextPanel = z.object({
  chart: z.literal('ai_text'),
  title: z.string().trim().min(1).max(120).default('AI 分析'),
  focus: z.enum(['overview']),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

export const ReportSpecSchema = z.object({
  period: PeriodSchema.optional(),
  panels: z.array(z.discriminatedUnion('chart', [
    LinePanel, BarPanel, TablePanel, KpiPanel, TextPanel, AiTextPanel,
  ])).max(MAX_PANELS),
}).strict()
export type AiTextPanel = z.infer<typeof AiTextPanel>
export type SpecErrorCode = 'INVALID_SPEC' | 'UNKNOWN_CHART_TYPE' | 'UNKNOWN_AI_FOCUS' | 'SPEC_TOO_LARGE'

export function parseReportSpec(input: unknown): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode } {
  const panels = (input as { panels?: unknown })?.panels
  if (Array.isArray(panels) && panels.length > MAX_PANELS) return { ok: false, code: 'SPEC_TOO_LARGE' }
  const parsed = ReportSpecSchema.safeParse(input)
  if (parsed.success) return { ok: true, spec: parsed.data }
  const badChart = parsed.error.issues.find((i) => i.path.at(-1) === 'chart')
  if (badChart !== undefined) return { ok: false, code: 'UNKNOWN_CHART_TYPE' }
  const badFocus = parsed.error.issues.find((i) => i.path.at(-1) === 'focus' && i.code === 'invalid_enum_value')
  if (badFocus !== undefined) return { ok: false, code: 'UNKNOWN_AI_FOCUS' }
  return { ok: false, code: 'INVALID_SPEC' }
}
```

- [ ] **Step 5: 实现写侧闸**

```ts
// report-scope.ts
export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: 'UNKNOWN_PANEL_METRIC' | 'METRIC_SOURCE_NOT_ADOPTED' | 'CHART_REQUIRES_ADDITIVE' | 'KPI_NOT_TOTALABLE'; metricId: string }
  | { ok: false; reason: 'AI_TEXT_REQUIRES_DATA_PANEL' | 'AI_TEXT_REQUIRES_PERIOD' }

function metricIdsOf(panel: ReportSpec['panels'][number]): string[] {
  if (panel.chart === 'text' || panel.chart === 'ai_text') return []
  if (panel.chart === 'kpi' && panel.denominatorMetricId !== undefined) {
    return [panel.metricId, panel.denominatorMetricId]
  }
  return [panel.metricId]
}

export function validatePanelMetrics(spec, catalog, adoptedSources): ValidateResult {
  const hasAi = spec.panels.some((p) => p.chart === 'ai_text')
  const hasData = spec.panels.some((p) => p.chart === 'line' || p.chart === 'bar' || p.chart === 'table' || p.chart === 'kpi')
  if (hasAi && !hasData) return { ok: false, reason: 'AI_TEXT_REQUIRES_DATA_PANEL' }
  if (hasAi && spec.period === undefined) return { ok: false, reason: 'AI_TEXT_REQUIRES_PERIOD' }

  for (const panel of spec.panels) {
    if (panel.chart === 'text' || panel.chart === 'ai_text') continue
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

- [ ] **Step 6: 跑绿 + 类型**

Run: `cd modules/data && pnpm exec vitest run domain/report-spec.test.ts domain/report-scope.test.ts && pnpm typecheck`
Expected: PASS；调用方（MCP/HTTP）会因新增 reason 出现类型收窄，Task 8 一并收口。

- [ ] **Step 7: 提交**

```bash
git add modules/data/domain/report-spec.ts modules/data/domain/report-scope.ts modules/data/domain/report-spec.test.ts modules/data/domain/report-scope.test.ts
git commit -m "feat(data-report): ai_text 组件 schema 与写侧结构闸"
```

### Task 2: 抽共享的 args / query body / 格式化纯函数

**Files:**
- Create: `modules/data/domain/report-query.ts`
- Create: `modules/data/domain/report-format.ts`
- Modify: `modules/data/console/reports/ReportView.tsx`
- Modify: `modules/data/console/reports/KpiCard.tsx`
- Test: `modules/data/domain/report-query.test.ts`
- Test: `modules/data/domain/report-format.test.ts`

**Interfaces:**
- `type DataPanel = Exclude<ReportSpec['panels'][number], { chart: 'text' } | { chart: 'ai_text' }>`
- `panelArgsOf(panel, range: DateRange | null, branchNum?: string): Record<string, unknown>`
- `panelQueryBodyOf(panel, args): Record<string, unknown>`
- `compareRangeOf(panel: KpiPanel, periodMode: PeriodSpec['mode'] | undefined, range: DateRange | null): DateRange | null`
- `formatValue`, `formatDelta`, `toneOf`（从 `KpiCard` 原样搬）

- [ ] **Step 1: 写测试**

```ts
import { panelArgsOf, panelQueryBodyOf, compareRangeOf } from './report-query'
import { formatValue, formatDelta } from './report-format'

it('期间窗口最后写入；timeScoped=false 不注入；branch 只覆盖声明过的面板', () => {
  const p = { chart: 'line', title: 't', metricId: 'm', dims: ['bizday'], args: { branch_num: '92' }, span: 24, timeScoped: true }
  expect(panelArgsOf(p, { from: '2026-10-01', to: '2026-10-19' }, '93'))
    .toEqual({ branch_num: '93', bizday: { from: '2026-10-01', to: '2026-10-19' } })
  const fixed = { ...p, timeScoped: false }
  expect(panelArgsOf(fixed, { from: '2026-10-01', to: '2026-10-19' }, '93'))
    .toEqual({ branch_num: '93' })
})

it('slice → query body；kpi → total:true', () => {
  const bar = { chart: 'bar', title: 't', metricId: 'm', dims: ['cause'], args: {}, span: 24, timeScoped: true, slice: { dimensions: ['cause'], orderBy: [{ column: 'cause', dir: 'asc' }], limit: 10 } }
  expect(panelQueryBodyOf(bar, {})).toEqual({ metricId: 'm', args: {}, dimensions: ['cause'], orderBy: [{ column: 'cause', dir: 'asc' }], limit: 10 })
  const kpi = { chart: 'kpi', title: 't', metricId: 'm', format: 'number', span: 12, timeScoped: true, compare: 'auto', goodDirection: 'none', args: {} }
  expect(panelQueryBodyOf(kpi, { branch_num: '92' })).toEqual({ metricId: 'm', args: { branch_num: '92', total: true } })
})

it('格式化：currency/number/percent；对比零基数/比率 pp', () => {
  expect(formatValue(51273.89, 'currency')).toBe('¥51,273.89')
  expect(formatValue(0.4736, 'percent')).toBe('47.36%')
  expect(formatDelta(50, 0, 'currency')).toBe('-')
  expect(formatDelta(0.5, 0.47, 'percent')).toBe('+3.00pp')
})
```

- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run domain/report-query.test.ts domain/report-format.test.ts`

- [ ] **Step 3: 实现并改 import**

```ts
// report-query.ts
export type DataPanel = Exclude<ReportSpec['panels'][number], { chart: 'text' } | { chart: 'ai_text' }>

export function panelArgsOf(p: DataPanel, range: DateRange | null, branchNum?: string) {
  const args: Record<string, unknown> = { ...(p.args ?? {}) }
  if (branchNum !== undefined && Object.hasOwn(p.args ?? {}, 'branch_num')) args.branch_num = branchNum
  if (range !== null && p.timeScoped !== false) args.bizday = range
  return args
}

export function panelQueryBodyOf(p: DataPanel, args: Record<string, unknown>) {
  if (p.chart === 'kpi') return { metricId: p.metricId, args: { ...args, total: true } }
  return {
    metricId: p.metricId,
    args,
    ...(p.slice === undefined ? {} : {
      ...(p.slice.dimensions !== undefined ? { dimensions: p.slice.dimensions } : {}),
      ...(p.slice.orderBy !== undefined ? { orderBy: p.slice.orderBy } : {}),
      ...(p.slice.limit !== undefined ? { limit: p.slice.limit } : {}),
      ...(p.slice.total !== undefined ? { total: p.slice.total } : {}),
    }),
  }
}

export function compareRangeOf(p: KpiPanel, periodMode: PeriodSpec['mode'] | undefined, range: DateRange | null) {
  if (range === null || p.compare === 'none') return null
  const mode = p.compare === 'auto' ? (periodMode === 'month' ? 'prev_month' : 'prev_period') : p.compare
  return previousRangeOf(range, mode)
}
```

`ReportView` 用 `panelArgsOf`/`compareRangeOf`；`KpiCard` 用 `formatValue`/`formatDelta`/`toneOf`。现有 `SpecView.test.tsx` 必须全绿。

- [ ] **Step 4: 跑绿 + 类型 + web 测试**

Run: `cd modules/data && pnpm exec vitest run domain/report-query.test.ts domain/report-format.test.ts console/reports/SpecView.test.tsx && pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/report-query.ts modules/data/domain/report-format.ts modules/data/domain/report-query.test.ts modules/data/domain/report-format.test.ts modules/data/console/reports/ReportView.tsx modules/data/console/reports/KpiCard.tsx
git commit -m "refactor(data-report): 抽报表 args/query body/格式化纯函数"
```

### Task 3: 迁移 023 `report_narratives`

**Files:**
- Create: `modules/data/migrations/023_report_narratives.sql`

- [ ] **Step 1: 写迁移**

```sql
create table if not exists data.report_narratives (
  id             text        not null primary key,
  org            text        not null,
  report_id      text        not null,
  spec_key       text        not null,
  panel_index    integer     not null,
  focus          text        not null,
  period_key     text        not null,
  branch_key     text        not null,
  facts_hash     text        not null,
  prompt_version text        not null,
  model          text        not null,
  text           text        not null,
  fallback       boolean     not null default false,
  created_at     timestamptz not null default now(),
  created_by     text        not null,
  unique (org, report_id, spec_key, panel_index, focus, period_key, branch_key, facts_hash, prompt_version, model)
);
create index if not exists report_narratives_org_report_idx
  on data.report_narratives(org, report_id, spec_key, created_at);
```

- [ ] **Step 2: 本地幂等验证**

Run（测试库；不要在生产手跑）:
```bash
psql "$DATABASE_URL" -f modules/data/migrations/023_report_narratives.sql
psql "$DATABASE_URL" -f modules/data/migrations/023_report_narratives.sql
psql "$DATABASE_URL" -Atc "select count(*) from data.report_narratives"
```
Expected: 两次都成功；count 稳定。

- [ ] **Step 3: 提交**

```bash
git add modules/data/migrations/023_report_narratives.sql
git commit -m "feat(data): 报表 AI 文本缓存/审计表"
```

### Task 4: `completeStream`（真流式）

**Files:**
- Modify: `modules/data/domain/llm.ts`
- Test: `modules/data/domain/llm.test.ts`（新建或追加）

**Interfaces:**
- `interface StreamingChatModel extends ChatModel { completeStream(messages, tools, opts?): AsyncGenerator<{ content?: string; reasoning?: string }> }`
- `openAiCompatModel(cfg): StreamingChatModel`
- `opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal }`

- [ ] **Step 1: 写测试（本地 SSE 流，不连外网）**

```ts
import { openAiCompatModel } from './llm'

it('解析 reasoning 与 content 两种 delta，遇 [DONE] 结束', async () => {
  const body = new ReadableStream({
    start(c) {
      const enc = new TextEncoder()
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n'))
      c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"结论"}}]}\n\n'))
      c.enqueue(enc.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })))
  const model = openAiCompatModel({ baseUrl: 'http://x', apiKey: 'k', model: 'm' })
  const out: Array<{ content?: string; reasoning?: string }> = []
  for await (const d of model.completeStream([{ role: 'user', content: 'x' }], [], { maxTokens: 10 })) out.push(d)
  expect(out).toEqual([{ reasoning: '思考' }, { content: '结论' }])
})

it('非 SSE ⇒ LLM_NOT_STREAMING', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
  const model = openAiCompatModel({ baseUrl: 'http://x', apiKey: 'k', model: 'm' })
  await expect(async () => { for await (const _ of model.completeStream([{ role: 'user', content: 'x' }], [])) void _ }).rejects.toThrow('LLM_NOT_STREAMING')
})
```

- [ ] **Step 2: 跑红** `cd modules/data && pnpm exec vitest run domain/llm.test.ts`

- [ ] **Step 3: 实现**

在现有 `openAiCompatModel` 的返回对象里**保留 `complete` 一行不改**，只追加 `completeStream`。下面只给新增方法：

```ts
export interface StreamingChatModel extends ChatModel {
  completeStream(
    messages: ChatMessage[], tools: ToolSpec[],
    opts?: { temperature?: number; maxTokens?: number; signal?: AbortSignal },
  ): AsyncGenerator<{ content?: string; reasoning?: string }>
}

export function openAiCompatModel(cfg: LlmConfig): StreamingChatModel {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    // 现有 complete() 原样保留（本 Task 不改它）
    async *completeStream(messages, tools, opts) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model, messages: messages.map(toWireMessage), tools: [],
          stream: true,
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        }),
        signal: opts?.signal,
      })
      if (!res.ok) throw new LlmError(`LLM_HTTP_${res.status}`)
      if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        throw new LlmError('LLM_NOT_STREAMING')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const raw of lines) {
            const line = raw.trim()
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') return
            let json: any
            try { json = JSON.parse(data) } catch { continue }
            const delta = json?.choices?.[0]?.delta
            if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') yield { reasoning: delta.reasoning_content }
            if (typeof delta?.content === 'string' && delta.content !== '') yield { content: delta.content }
          }
        }
      } finally {
        await reader.cancel().catch(() => {})
      }
    },
  }
}
```

- [ ] **Step 4: 跑绿 + 类型**

Run: `cd modules/data && pnpm exec vitest run domain/llm.test.ts && pnpm typecheck`
Expected: PASS；`agent-loop` 仍用 `complete`，不受影响。

- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/llm.ts modules/data/domain/llm.test.ts
git commit -m "feat(data-llm): 新增流式 completeStream（reasoning/content）"
```

### Task 5: 事实包 `report-facts.ts`

**Files:**
- Create: `modules/data/domain/report-facts.ts`
- Test: `modules/data/domain/report-facts.test.ts`

**Interfaces:**
- `buildFacts(deps, spec, panelIndex, period, branchNum): Promise<FactBundle>`
- `deps: { pool; org; requester; adoptedSources; execute?: SqlExecutor }`
- `FactBundle` 含 `reportTitle/specKey/focus/period/branchNum/dataAsOf/kpis/breakdowns/daily/missing/numbers/factsHash`

- [ ] **Step 1: 写测试（假 executor）**

```ts
it('KPI 合计/比率 + 拆解 + 日最高最低 + dataAsOf + numbers', async () => {
  const exec = async (sql: string) => {
    // 注意顺序：日趋势查询也含 net_amount，必须先于 KPI 合计分支匹配
    if (sql.includes('net_amount') && sql.includes('bizday')) return { columns: ['bizday', 'value'], rows: [['2026-10-13', 875.59], ['2026-10-16', 3564.8]], truncated: false }
    if (sql.includes('net_amount')) return { columns: ['value'], rows: [[51273.89]], truncated: false, data_as_of: '2026-10-25 06:00' }
    if (sql.includes('order_count')) return { columns: ['value'], rows: [[957]], truncated: false }
    if (sql.includes('vip_money')) return { columns: ['value'], rows: [[24284.39]], truncated: false }
    if (sql.includes('loss_money')) return { columns: ['cause', 'value'], rows: [['自然损', 387.64]], truncated: false }
    return { columns: ['value'], rows: [[0]], truncated: false }
  }
  const facts = await buildFacts({ pool: fakePool, org: 'o', requester: fakeRequester, adoptedSources: new Set(['lemeng']), execute: exec }, spec, 8, period, '92')
  expect(facts.kpis.find((k) => k.panel === '销售额')?.current).toBe('51,273.89')
  expect(facts.daily).toEqual({ min: { day: '2026-10-13', value: '875.59' }, max: { day: '2026-10-16', value: '3,564.80' } })
  expect(facts.numbers).toContain('51,273.89')
  expect(facts.dataAsOf).toBe('2026-10-25 06:00')
})
```

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现**

```ts
import { createHash } from 'node:crypto'
import { runQuery } from './query-service'
import { periodRangeOf } from './report-period'
import { compareRangeOf, panelArgsOf, type DataPanel } from './report-query'
import { formatDelta, formatValue } from './report-format'
import type { ReportSpec, AiTextPanel, PeriodSpec, KpiPanel } from './report-spec'

export interface FactsDeps {
  pool: Pool
  org: string
  requester: Requester
  adoptedSources: ReadonlySet<string>
  execute?: SqlExecutor
  reportTitle: string
  specKey: string
}

export interface FactKpi {
  panel: string; metricId: string; format: KpiPanel['format']
  current: string; previous: string | null; delta: string
}
export interface FactBreakdown { panel: string; dimension: string; rows: Array<{ label: string; value: string }> }
export interface FactBundle {
  reportTitle: string; specKey: string; focus: AiTextPanel['focus']
  period: { from: string; to: string; label: string }
  branchNum: string | null; dataAsOf: string | null
  kpis: FactKpi[]; breakdowns: FactBreakdown[]
  daily: { min: { day: string; value: string } | null; max: { day: string; value: string } | null }
  missing: string[]; numbers: string[]; dates: string[]
  factsHash: string
}

const slicingOf = (p: DataPanel) => p.chart === 'kpi' || p.slice === undefined ? undefined : ({
  ...(p.slice.dimensions !== undefined ? { dimensions: p.slice.dimensions } : {}),
  ...(p.slice.orderBy !== undefined ? { orderBy: p.slice.orderBy } : {}),
  ...(p.slice.limit !== undefined ? { limit: p.slice.limit } : {}),
  ...(p.slice.total !== undefined ? { total: p.slice.total } : {}),
})

async function totalOf(deps: FactsDeps, metricId: string, args: Record<string, unknown>): Promise<number | null> {
  const out = await runQuery(
    { pool: deps.pool, execute: deps.execute, warehouseExec: deps.execute, adoptedSources: deps.adoptedSources },
    deps.org, deps.requester, metricId, { ...args, total: true },
  )
  if (out.status !== 'ok') return null
  const t = (out as { total?: string | number | null }).total
  if (t === undefined || t === null) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

async function valueAt(deps: FactsDeps, p: KpiPanel, args: Record<string, unknown>): Promise<number | null> {
  const cur = await totalOf(deps, p.metricId, args)
  if (cur === null) return null
  if (p.denominatorMetricId === undefined) return cur
  const den = await totalOf(deps, p.denominatorMetricId, args)
  return den === null || den === 0 ? null : cur / den
}

export async function buildFacts(
  deps: FactsDeps, spec: ReportSpec, panelIndex: number, period: PeriodSpec, branchNum?: string,
): Promise<FactBundle> {
  const ai = spec.panels[panelIndex]
  if (ai === undefined || ai.chart !== 'ai_text') throw new Error('NOT_AI_TEXT_PANEL')
  const range = periodRangeOf(period, new Date())
  const dataPanels = spec.panels.filter(
    (p): p is DataPanel => p.chart !== 'text' && p.chart !== 'ai_text',
  )
  const dates: string[] = [range.from, range.to]
  const dataAsOfList: string[] = []
  const kpis: FactKpi[] = []
  const breakdowns: FactBreakdown[] = []
  let minRaw: { day: string; value: number } | null = null
  let maxRaw: { day: string; value: number } | null = null
  const missing: string[] = []

  for (const p of dataPanels) {
    const args = panelArgsOf(p, range, branchNum)
    if (p.chart === 'kpi') {
      const cur = await valueAt(deps, p, args)
      const prevRange = compareRangeOf(p, period.mode, range)
      const prev = prevRange === null ? null : await valueAt(deps, p, { ...args, bizday: prevRange })
      kpis.push({
        panel: p.title, metricId: p.metricId, format: p.format,
        current: cur === null ? '-' : formatValue(cur, p.format),
        previous: prev === null ? null : formatValue(prev, p.format),
        delta: cur === null || prev === null ? '-' : formatDelta(cur, prev, p.format),
      })
      continue
    }
    const out = await runQuery(
      { pool: deps.pool, execute: deps.execute, warehouseExec: deps.execute, adoptedSources: deps.adoptedSources },
      deps.org, deps.requester, p.metricId, args, slicingOf(p),
    )
    if (out.status !== 'ok') { missing.push(p.title); continue }
    if (typeof out.data_as_of === 'string') dataAsOfList.push(out.data_as_of)
    if (p.chart === 'line') {
      const xCol = (p.slice?.dimensions ?? p.dims)[0]
      const xi = xCol === undefined ? -1 : out.columns.indexOf(xCol)
      const vi = out.columns.indexOf('value')
      if (xi >= 0 && vi >= 0) {
        for (const row of out.rows) {
          const v = Number(row[vi]); if (!Number.isFinite(v)) continue
          const day = String(row[xi])
          if (minRaw === null || v < minRaw.value) minRaw = { day, value: v }
          if (maxRaw === null || v > maxRaw.value) maxRaw = { day, value: v }
        }
      }
    } else {
      const dims = p.slice?.dimensions ?? p.dims
      const vi = out.columns.indexOf('value')
      const rows = out.rows.map((row) => ({
        label: dims.map((d) => String(row[out.columns.indexOf(d)] ?? '')).join(' / '),
        value: vi < 0 ? '-' : formatValue(Number(row[vi]), p.chart === 'bar' ? 'number' : 'number'),
      }))
      breakdowns.push({ panel: p.title, dimension: dims.join('/'), rows })
    }
  }

  const numbers = new Set<string>(dates)
  for (const k of kpis) {
    for (const v of [k.current, k.previous]) if (v !== null && v !== '-') numbers.add(v)
    if (k.delta !== '-') numbers.add(k.delta)
  }
  for (const b of breakdowns) for (const r of b.rows) numbers.add(r.value)
  if (daily.min !== null) numbers.add(daily.min.value)
  if (daily.max !== null) numbers.add(daily.max.value)

  const daily: FactBundle['daily'] = {
    min: minRaw === null ? null : { day: minRaw.day, value: formatValue(minRaw.value, 'currency') },
    max: maxRaw === null ? null : { day: maxRaw.day, value: formatValue(maxRaw.value, 'currency') },
  }
  const facts: Omit<FactBundle, 'factsHash'> = {
    reportTitle: deps.reportTitle, specKey: deps.specKey, focus: ai.focus,
    period: { ...range, label: `${range.from} ~ ${range.to}` },
    branchNum: branchNum ?? null,
    dataAsOf: earliestDate(dataAsOfList),
    kpis, breakdowns, daily, missing, numbers: [...numbers], dates,
  }
  const factsHash = createHash('sha256').update(canonicalJson(facts)).digest('hex')
  return { ...facts, factsHash }
}

function earliestDate(xs: string[]): string | null {
  const sorted = [...xs].sort()
  return sorted[0] ?? null
}
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}
```

- [ ] **Step 4: 跑绿 + 类型**
- [ ] **Step 5: 提交**

```bash
git add modules/data/domain/report-facts.ts modules/data/domain/report-facts.test.ts
git commit -m "feat(data-report): 报表事实包（KPI/拆解/日极值/数据截止）"
```

### Task 6: narrative 核心（提示词 / 校验 / 模板 / 缓存）

**Files:**
- Create: `modules/data/domain/narrative.ts`
- Create: `modules/data/domain/report-narrative-store.ts`
- Test: `modules/data/domain/narrative.test.ts`

**Interfaces:**
- `NARRATIVE_PROMPT_VERSION = 'narrative-v1'`
- `type NarrativeEvent`（与 spec §4.1 同形）
- `generateNarrative(deps): Promise<NarrativeResult>`（JSON）
- `streamNarrative(deps): AsyncGenerator<NarrativeEvent>`（SSE）
- `deps: { pool; org; reportId; specKey; facts; focus; userId; model: StreamingChatModel; log? }`

- [ ] **Step 1: 写测试（假流式 model）**

```ts
it('流式输出 phase → delta → done；数字合法', async () => {
  const model = fakeModel([{ reasoning: '思考' }, { content: '结论：销售额 51,273.89。' }, { content: '\n异常：无。\n行动：核对明细。' }])
  const evs = []
  for await (const e of streamNarrative({ ...deps, model, facts })) evs.push(e)
  expect(evs[0]).toMatchObject({ type: 'phase', phase: 'thinking' })
  expect(evs.some((e) => e.type === 'delta')).toBe(true)
  expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: false })
})

it('越界数字 ⇒ replace 模板', async () => {
  const model = fakeModel([{ content: '结论：销售额 99,999.99。' }])
  const evs = []
  for await (const e of streamNarrative({ ...deps, model, facts })) evs.push(e)
  expect(evs.some((e) => e.type === 'replace' && e.reason === 'number_check')).toBe(true)
  expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: true })
})

it('未配模型 ⇒ 直接模板', async () => {
  const evs = []
  for await (const e of streamNarrative({ ...deps, model: null, facts })) evs.push(e)
  expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: true })
})
```

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现提示词/校验/模板**

```ts
const SYSTEM = [
  '你是门店经营分析助手。只能使用 facts 中的数字和项目名；不得编造、不得做 facts 之外的算术；缺失写 "-"。',
  '输出三段，纯文本，不要 Markdown 表格/HTML：',
  '结论：…', '异常：…', '行动：…',
  '全文不超过 400 个汉字；末尾单独一行写：数据截至 <dataAsOf>（缺失写「新鲜度未知」）。',
  '不要推测外部原因（天气/竞品/促销），只写数据内可见的构成与需要核对的事项。',
].join('\n')

function allowedNumbers(facts: FactBundle): Set<string> {
  const out = new Set<string>(['1', '2', '3', '-'])
  for (const n of [...facts.numbers, ...facts.dates]) {
    out.add(n)
    out.add(n.replace(/^¥/, ''))                 // 模型常写 51,273.89 而不是 ¥51,273.89
    out.add(n.replaceAll(',', ''))               // 也常不带千分位
    out.add(n.replace(/^¥/, '').replaceAll(',', ''))
    out.add(n.replace(/(%|pp)$/, ''))            // 模型可能只写数字、不写单位
    out.add(n.replace(/^¥/, '').replaceAll(',', '').replace(/(%|pp)$/, ''))
    out.add(n.replace(/^\+/, ''))                 // 模型可能不写正号
    out.add(n.replace(/^\+/, '').replaceAll(',', ''))
  }
  return out
}
function normalizeNum(s: string) { return s.replaceAll(',', '').replace(/^\+/, '') }
function badNumbers(text: string, allowed: Set<string>): string[] {
  // 先把完整日期抹掉，避免 `2026-10-01` 被拆成 2026/-10/-01 误报
  const noDates = text.replace(/\d{4}-\d{2}-\d{2}|\d{2}-\d{2}/g, ' ')
  const out: string[] = []
  for (const m of noDates.matchAll(/-?\d[\d,]*(?:\.\d+)?(?:%|pp)?/g)) {
    const raw = m[0]
    if (!allowed.has(raw) && !allowed.has(normalizeNum(raw))) out.push(raw)
  }
  return out
}

function userPrompt(facts: FactBundle, strictNote = ''): string {
  return [
    `focus=${facts.focus}。请严格按 system 约束写三段。`,
    '重点：结论先销售额/订单/客单价与对比；异常写最低销售日、报损最大原因、费用最大两项（有数才写）；行动 2-3 条，带金额/项目名。',
    ...(strictNote === '' ? [] : [strictNote]),
    `facts=${JSON.stringify(facts)}`,
  ].join('\n')
}

function templateOf(f: FactBundle): string {
  const k = (name: string) => f.kpis.find((x) => x.panel === name)
  const loss = f.breakdowns.find((b) => b.panel.includes('报损'))
  const expense = f.breakdowns.find((b) => b.panel.includes('费用'))
  const lossTop = loss?.rows[0]
  const expTop = expense?.rows.slice(0, 2).map((r) => r.label).join('、')
  return [
    `结论：本期销售额 ${k('销售额')?.current ?? '-'}，订单 ${k('订单数')?.current ?? '-'}，客单价 ${k('客单价')?.current ?? '-'}；会员销售占比 ${k('会员销售占比')?.current ?? '-'}。`,
    `异常：最低销售日 ${f.daily.min?.day ?? '-'}（${f.daily.min?.value ?? '-'}）；报损 ${k('报损金额')?.current ?? '-'}（${lossTop?.label ?? '-'} ${lossTop?.value ?? '-'}）；费用 ${k('费用合计（净费用）')?.current ?? k('费用合计')?.current ?? '-'}（${expTop ?? '-'}）。`,
    '行动：① 核对最低销售日是否采集缺口/闭店；② 复盘报损最大原因明细；③ 复盘费用最大两项的投放产出。',
    `数据截至 ${f.dataAsOf ?? '新鲜度未知'}。`,
  ].join('\n')
}

type NarrativeResult = {
  text: string; fallback: boolean; dataAsOf: string | null; generatedAt: string; cached: boolean
}
function doneEvent(text: string, fallback: boolean, facts: FactBundle, cached = false): NarrativeEvent {
  return { type: 'done', text, fallback, dataAsOf: facts.dataAsOf, generatedAt: new Date().toISOString(), cached }
}
```

**缓存存储 `report-narrative-store.ts`**：

```ts
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export interface NarrativeKey {
  org: string; reportId: string; specKey: string; panelIndex: number; focus: string
  periodKey: string; branchKey: string; factsHash: string; promptVersion: string; model: string
}
// narrativeKeyOf 放 narrative.ts（它依赖 NarrativeDeps / NARRATIVE_PROMPT_VERSION；
// 放 store 会形成 store ↔ narrative 循环依赖）。
export async function getCachedNarrative(pool: Pool, k: NarrativeKey) {
  const r = await pool.query(
    `select text, fallback, created_at from data.report_narratives
      where org=$1 and report_id=$2 and spec_key=$3 and panel_index=$4 and focus=$5
        and period_key=$6 and branch_key=$7 and facts_hash=$8 and prompt_version=$9 and model=$10`,
    [k.org, k.reportId, k.specKey, k.panelIndex, k.focus, k.periodKey, k.branchKey, k.factsHash, k.promptVersion, k.model],
  )
  if (r.rowCount === 0) return null
  return { text: String(r.rows[0].text), fallback: r.rows[0].fallback === true, createdAt: new Date(r.rows[0].created_at).toISOString() }
}
export async function putNarrative(pool: Pool, k: NarrativeKey, text: string, fallback: boolean, createdBy: string) {
  await pool.query(
    `insert into data.report_narratives
       (id, org, report_id, spec_key, panel_index, focus, period_key, branch_key, facts_hash, prompt_version, model, text, fallback, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     on conflict (org, report_id, spec_key, panel_index, focus, period_key, branch_key, facts_hash, prompt_version, model) do nothing`,
    [randomUUID(), k.org, k.reportId, k.specKey, k.panelIndex, k.focus, k.periodKey, k.branchKey, k.factsHash, k.promptVersion, k.model, text, fallback, createdBy],
  )
}
```

`NarrativeDeps`：

```ts
export interface NarrativeDeps {
  pool: Pool; org: string; reportId: string; specKey: string; panelIndex: number
  facts: FactBundle; focus: AiTextPanel['focus']; userId: string
  model: (StreamingChatModel & { id?: string }) | null
}
function narrativeKeyOf(deps: NarrativeDeps): NarrativeKey {
  return {
    org: deps.org, reportId: deps.reportId, specKey: deps.specKey,
    panelIndex: deps.panelIndex, focus: deps.focus,
    periodKey: `${deps.facts.period.from}..${deps.facts.period.to}`,
    branchKey: deps.facts.branchNum ?? '*', factsHash: deps.facts.factsHash,
    promptVersion: NARRATIVE_PROMPT_VERSION, model: deps.model?.id ?? 'none',
  }
}
```

`generateNarrative`（JSON；一次重试）：

```ts
export async function generateNarrative(deps: NarrativeDeps): Promise<NarrativeResult> {
  const key = narrativeKeyOf(deps)
  const cached = await getCachedNarrative(deps.pool, key)
  if (cached !== null) return { text: cached.text, fallback: cached.fallback, dataAsOf: deps.facts.dataAsOf, generatedAt: cached.createdAt, cached: true }
  if (deps.model === null) {
    const text = templateOf(deps.facts)
    await putNarrative(deps.pool, key, text, true, deps.userId)
    return { text, fallback: true, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
  }
  const allowed = allowedNumbers(deps.facts)
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = ''
    for await (const d of deps.model.completeStream(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(deps.facts, attempt === 0 ? '' : '上一次输出包含 facts 之外的数字；只允许复制 facts 的 formatted 值。') }], [],
      { temperature: 0.2, maxTokens: 1500, signal: AbortSignal.timeout(30000) },
    )) if (d.content !== undefined) text += d.content
    if (badNumbers(text, allowed).length === 0) {
      await putNarrative(deps.pool, key, text, false, deps.userId)
      return { text, fallback: false, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
    }
  }
  const text = templateOf(deps.facts)
  await putNarrative(deps.pool, key, text, true, deps.userId)
  return { text, fallback: true, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
}
```

> **SSE 不做第二次生成**：内容已经流给用户，越界只能 `replace` 模板（不能静默回滚）；JSON 端点做一次重试。两者最终都保证“错数不留在屏幕上”。

- [ ] **Step 4: 实现流式循环（增量校验 + 缓存）**

```ts
export type NarrativeEvent =
  | { type: 'phase'; phase: 'facts' | 'thinking' | 'writing'; label: string }
  | { type: 'delta'; text: string }
  | { type: 'replace'; text: string; reason: 'number_check' | 'llm_failed' }
  | { type: 'done'; text: string; fallback: boolean; dataAsOf: string | null; generatedAt: string; cached: boolean }
  | { type: 'error'; reason: string }

export async function* streamNarrative(deps: NarrativeDeps): AsyncGenerator<NarrativeEvent> {
  const key = narrativeKeyOf(deps)
  const cached = await getCachedNarrative(deps.pool, key)
  if (cached !== null) {
    yield { type: 'phase', phase: 'writing', label: '读取缓存' }
    yield { type: 'delta', text: cached.text }
    yield { type: 'done', text: cached.text, fallback: cached.fallback, dataAsOf: deps.facts.dataAsOf, generatedAt: cached.createdAt, cached: true }
    return
  }
  yield { type: 'phase', phase: 'thinking', label: '正在分析…' }
  if (deps.model === null) {
    const text = templateOf(deps.facts)
    await putNarrative(deps.pool, key, text, true, deps.userId)
    yield doneEvent(text, true, deps.facts)
    return
  }
  const allowed = allowedNumbers(deps.facts)
  let full = ''
  let pending = ''      // 未闭合数字缓冲
  let sawContent = false
  const controller = new AbortController()
  try {
    for await (const d of deps.model.completeStream(
      [{ role: 'system', content: SYSTEM }, { role: 'user', content: userPrompt(deps.facts) }], [],
      { temperature: 0.2, maxTokens: 1500, signal: controller.signal },
    )) {
      if (d.reasoning !== undefined) continue
      if (d.content === undefined) continue
      if (!sawContent) { sawContent = true; yield { type: 'phase', phase: 'writing', label: '正在生成…' } }
      full += d.content
      pending += d.content
      // 只校验已闭合数字：以非数字/非逗号/非点结尾时结算
      if (!/[0-9,.]$/.test(pending)) {
        const bad = badNumbers(pending, allowed)
        pending = ''
        if (bad.length > 0) {
          controller.abort()
          const text = templateOf(deps.facts)
          yield { type: 'replace', text, reason: 'number_check' }
          yield { type: 'done', text, fallback: true, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
          await putNarrative(deps.pool, key, text, true, deps.userId)
          return
        }
      }
      yield { type: 'delta', text: d.content }
    }
    const bad = badNumbers(full, allowed)
    if (bad.length > 0) {
      const text = templateOf(deps.facts)
      yield { type: 'replace', text, reason: 'number_check' }
      yield { type: 'done', text, fallback: true, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
      await putNarrative(deps.pool, key, text, true, deps.userId)
      return
    }
    await putNarrative(deps.pool, key, full, false, deps.userId)
    yield { type: 'done', text: full, fallback: false, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
  } catch {
    const text = templateOf(deps.facts)
    yield { type: 'replace', text, reason: 'llm_failed' }
    yield { type: 'done', text, fallback: true, dataAsOf: deps.facts.dataAsOf, generatedAt: new Date().toISOString(), cached: false }
    await putNarrative(deps.pool, key, text, true, deps.userId)
  }
}
```

`generateNarrative` 复用同一提示词/校验/模板，只是不流式（收集 `content` 后校验）。

- [ ] **Step 5: 跑绿 + 类型**
- [ ] **Step 6: 提交**

```bash
git add modules/data/domain/narrative.ts modules/data/domain/report-narrative-store.ts modules/data/domain/narrative.test.ts
git commit -m "feat(data-report): AI 文本生成/校验/模板/缓存"
```

### Task 7: JSON + SSE 路由 + manifest

**Files:**
- Modify: `modules/data/routes/reports.ts`
- Modify: `modules/data/routes/context.ts`（加 `llm?` 测试 seam）
- Modify: `modules/data/manifest.yaml`
- Test: `modules/data/routes/reports.test.ts`

**Interfaces:**
- `POST /reports/:id/narrative`（JSON）
- `POST /reports/:id/narrative/stream`（SSE）
- `NarrativeBody`（spec §4.1）
- `RouteCtx.llm?: () => StreamingChatModel | null`（缺省 `llmFromEnv` + `openAiCompatModel`）

- [ ] **Step 1: 写测试**

```ts
it('published 快照生成 JSON 文本；缓存命中 cached:true', async () => {
  const r1 = await app.request(`/reports/${ID}/narrative`, { method: 'POST', headers: auth, body: JSON.stringify({ panelIndex: 8, period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' } }) })
  expect(r1.status).toBe(200)
  const b1 = await r1.json()
  expect(b1).toMatchObject({ fallback: false, cached: false })
  const r2 = await app.request(`/reports/${ID}/narrative`, { method: 'POST', headers: auth, body: JSON.stringify({ panelIndex: 8, period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' } }) })
  expect((await r2.json()).cached).toBe(true)
})

it('SSE：phase → delta → done；headers 含 x-accel-buffering:no', async () => {
  const res = await app.request(`/reports/${ID}/narrative/stream`, { method: 'POST', headers: auth, body: JSON.stringify({ panelIndex: 8, period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' } }) })
  expect(res.headers.get('content-type')).toContain('text/event-stream')
  expect(res.headers.get('x-accel-buffering')).toBe('no')
  const text = await res.text()
  expect(text).toContain('"type":"phase"')
  expect(text).toContain('"type":"delta"')
  expect(text).toContain('"type":"done"')
})

it('panelIndex 非 ai_text ⇒ 400 NOT_AI_TEXT_PANEL', async () => {
  const r = await app.request(`/reports/${ID}/narrative`, { method: 'POST', headers: auth, body: JSON.stringify({ panelIndex: 0, period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' } }) })
  expect(r.status).toBe(400)
  expect(await r.json()).toMatchObject({ error: 'NOT_AI_TEXT_PANEL' })
})
it('跨租户 ⇒ 404；无页门 ⇒ 404', async () => {
  const body = JSON.stringify({ panelIndex: 8, period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' } })
  expect((await app.request(`/reports/${ID}/narrative`, { method: 'POST', headers: otherOrgAuth, body })).status).toBe(404)
  expect((await app.request(`/reports/${ID}/narrative`, { method: 'POST', headers: noGateAuth, body })).status).toBe(404)
})
```

- [ ] **Step 2: 跑红**

- [ ] **Step 3: 实现路由**

```ts
const NarrativeBody = z.object({
  panelIndex: z.number().int().min(0),
  period: PeriodSchema,
  branchNum: z.string().min(1).max(64).optional(),
  version: z.number().int().positive().optional(),
  preview: z.literal('draft').optional(),
}).strict()

```ts
type NarrativeContextOk = {
  requester: Requester; facts: FactBundle; focus: AiTextPanel['focus']; specKey: string
  model: (StreamingChatModel & { id?: string }) | null
}
type NarrativeContextErr = { error: 'UNAUTHENTICATED' | 'NOT_FOUND' | 'RENDERER_NOT_SELF_DRAWN' | 'NO_SPEC' | 'NOT_PUBLISHED' | 'NOT_AI_TEXT_PANEL' }

async function loadNarrativeContext(
  c: Context<ModuleVars>, id: string, body: z.infer<typeof NarrativeBody>,
): Promise<NarrativeContextOk | NarrativeContextErr> {
  const requester = requesterOf(c)
  if (requester === null) return { error: 'UNAUTHENTICATED' }
  const org = c.get('tenant').casdoor_org
  const report = await getReport(ctx.pool, org, id)
  if (report === null) return { error: 'NOT_FOUND' }
  if (report.renderer !== 'platform') return { error: 'RENDERER_NOT_SELF_DRAWN' }

  let spec: ReportSpec
  let specKey: string
  let title: string
  if (body.preview === 'draft') {
    if (!requester.hasScope('data:manage')) return { error: 'NOT_FOUND' }
    if (report.spec === null) return { error: 'NO_SPEC' }
    spec = report.spec
    specKey = `draft:${report.version}`
    title = report.title
  } else {
    const snapshot = body.version !== undefined
      ? await getPublishedSpec(ctx.pool, org, id, body.version)
      : await getPublishedSpec(ctx.pool, org, id)
    if (snapshot === null) return { error: 'NOT_PUBLISHED' }
    if (snapshot.requiredScope !== null && !requester.hasScope(snapshot.requiredScope)) return { error: 'NOT_FOUND' }
    spec = snapshot.spec
    specKey = `published:${snapshot.version}`
    title = snapshot.title
  }

  const panel = spec.panels[body.panelIndex]
  if (panel === undefined || panel.chart !== 'ai_text') return { error: 'NOT_AI_TEXT_PANEL' }

  const facts = await buildFacts(
    {
      pool: ctx.pool, org, requester,
      adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
      execute: ctx.execute, reportTitle: title, specKey,
    },
    spec, body.panelIndex, body.period, body.branchNum,
  )
  const cfg = llmFromEnv()
  const model = ctx.llm !== undefined
    ? ctx.llm()
    : cfg === null ? null : { ...openAiCompatModel(cfg), id: cfg.model }
  return { requester, facts, focus: panel.focus, specKey, model }
}

function errorStatus(e: NarrativeContextErr): 400 | 403 | 404 {
  if (e.error === 'UNAUTHENTICATED') return 403
  if (e.error === 'NOT_FOUND' || e.error === 'NOT_PUBLISHED') return 404
  return 400
}

r.post('/reports/:id/narrative', async (c) => {
  const id = reportIdOf(c.req.param('id'))
  if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
  const body = NarrativeBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
  try {
    const n = await loadNarrativeContext(c, id, body.data)
    if ('error' in n) return c.json(n, errorStatus(n))
    const out = await generateNarrative({
      pool: ctx.pool, org: c.get('tenant').casdoor_org, reportId: id,
      specKey: n.specKey, panelIndex: body.data.panelIndex, facts: n.facts,
      focus: n.focus, userId: n.requester.userId, model: n.model,
    })
    return c.json(out)
  } catch (e) {
    return c.json({ error: 'NARRATIVE_FAILED', detail: e instanceof Error ? e.message.slice(0, 200) : undefined }, 502)
  }
})

r.post('/reports/:id/narrative/stream', async (c) => {
  const id = reportIdOf(c.req.param('id'))
  if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)
  const body = NarrativeBody.safeParse(await c.req.json().catch(() => null))
  if (!body.success) return c.json({ error: 'INVALID_BODY' }, 400)
  let n: NarrativeContextOk | NarrativeContextErr
  try {
    n = await loadNarrativeContext(c, id, body.data)
  } catch (e) {
    return c.json({ error: 'NARRATIVE_FAILED', detail: e instanceof Error ? e.message.slice(0, 200) : undefined }, 502)
  }
  if ('error' in n) return c.json(n, errorStatus(n))

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (ev: NarrativeEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(ev)}\n\n`))
      try {
        for await (const ev of streamNarrative({
          pool: ctx.pool, org: c.get('tenant').casdoor_org, reportId: id,
          specKey: n.specKey, panelIndex: body.data.panelIndex, facts: n.facts,
          focus: n.focus, userId: n.requester.userId, model: n.model,
        })) send(ev)
      } catch {
        send({ type: 'error', reason: 'NARRATIVE_FAILED' })
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
})

manifest 追加：

```yaml
- { method: POST, path: /reports/:id/narrative,        scope: data:query }
- { method: POST, path: /reports/:id/narrative/stream, scope: data:query }
```

- [ ] **Step 4: 跑绿 + 装载冒烟**
- [ ] **Step 5: 提交**

```bash
git add modules/data/routes/reports.ts modules/data/routes/context.ts modules/data/manifest.yaml modules/data/routes/reports.test.ts
git commit -m "feat(data-report): AI 文本 JSON/SSE 端点"
```

### Task 8: Agent 工具面 + 写侧错误映射

**Files:**
- Modify: `modules/data/routes/mcp-report-tools.ts`
- Modify: `modules/data/routes/reports.ts`（`POST /reports` / `PUT /spec` 的 `validatePanelMetrics` 分支）
- Test: `modules/data/routes/mcp-report-tools.test.ts`
- Test: `modules/data/routes/reports.test.ts`

- [ ] **Step 1: 写测试**

```ts
it('propose_report 接受 ai_text；无数据面板 ⇒ AI_TEXT_REQUIRES_DATA_PANEL', async () => {
  const ok = await call('propose_report', { title: 'x', spec: { period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, panels: [ai, line] } })
  expect(JSON.parse(ok.text).status).toBe('ok')
  const bad = await call('propose_report', { title: 'y', spec: { period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }, panels: [ai] } })
  expect(JSON.parse(bad.text)).toMatchObject({ status: 'refused', error: 'AI_TEXT_REQUIRES_DATA_PANEL' })
})
```

- [ ] **Step 2: 实现**

- `propose_report` / `revise_report_spec` 描述追加 `ai_text` 说明；
- `validatePanelMetrics` 的新 reason 映射：
  - `AI_TEXT_REQUIRES_DATA_PANEL` / `AI_TEXT_REQUIRES_PERIOD` ⇒ 400（MCP `refused`，HTTP `{error: reason}`）；
  - 其余 reason 仍带 `metricId`。
- `get_report_spec` 无需改（原样回 spec）。

- [ ] **Step 3: 跑绿 + 类型**
- [ ] **Step 4: 提交**

```bash
git add modules/data/routes/mcp-report-tools.ts modules/data/routes/reports.ts modules/data/routes/mcp-report-tools.test.ts modules/data/routes/reports.test.ts
git commit -m "feat(data-mcp): ai_text 工具面与写侧错误映射"
```

### Task 9: 前端 `AiTextPanel`（SSE + AI 感）

**Files:**
- Create: `modules/data/console/reports/AiTextPanel.tsx`
- Modify: `modules/data/console/lib/api.ts`（加 `streamPost`）
- Modify: `modules/data/console/reports/ReportView.tsx`（`reportId` prop、`ai_text` 分支、跳过查询循环）
- Modify: `modules/data/console/reports/SpecView.tsx`、`modules/data/console/standalone.tsx`（传 `reportId`）
- Test: `modules/data/console/reports/AiTextPanel.test.tsx`
- Test: `modules/data/console/reports/SpecView.test.tsx`

- [ ] **Step 1: 写测试（mock SSE）**

```tsx
it('phase → delta → done；切换期间会重新请求', async () => {
  const stream = new ReadableStream({ start(c) { const e = new TextEncoder(); c.enqueue(e.encode('data: {"type":"phase","phase":"thinking","label":"正在分析…"}\n\n')); c.enqueue(e.encode('data: {"type":"delta","text":"结论："}\n\n')); c.enqueue(e.encode('data: {"type":"delta","text":"好"}\n\n')); c.enqueue(e.encode('data: {"type":"done","text":"结论：好","fallback":false,"dataAsOf":"2026-10-25","generatedAt":"x","cached":false}\n\n')); c.close() } })
  vi.mocked(streamPost).mockResolvedValue(new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }))
  render(<AiTextPanel reportId="r1" panelIndex={8} focus="overview" period={{ mode: 'custom', from: '2026-10-01', to: '2026-10-19' }} branchNum="92" />)
  expect(await screen.findByText('正在分析…')).toBeTruthy()
  expect(await screen.findByText('结论：好')).toBeTruthy()
})
```

- [ ] **Step 2: 实现 `streamPost`**

```ts
export async function streamPost(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const res = await platformFetch(PREFIX + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) throw await toError(res)
  return res
}
```

- [ ] **Step 3: 实现 `AiTextPanel`**

```tsx
type Phase = 'facts' | 'thinking' | 'writing' | 'done'
type Ev = { type: 'phase'; phase: Phase; label: string } | { type: 'delta'; text: string } | { type: 'replace'; text: string; reason: string } | { type: 'done'; text: string; fallback: boolean; dataAsOf: string | null; generatedAt: string; cached: boolean } | { type: 'error'; reason: string }
type Props = {
  reportId: string
  panelIndex: number
  focus: 'overview'
  period: PeriodSpec | null
  branchNum?: string
  version?: number
}

export default function AiTextPanel({ reportId, panelIndex, focus, period, branchNum, version }: Props) {
  const [phase, setPhase] = useState<Phase>('facts')
  const [label, setLabel] = useState('正在核对指标…')
  const [text, setText] = useState('')
  const [fallback, setFallback] = useState(false)
  const [dataAsOf, setDataAsOf] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (period === null) { setError('报表未声明期间'); return }
    const ac = new AbortController()
    const timer = setTimeout(async () => {
      setPhase('facts'); setLabel('正在核对指标…'); setText(''); setFallback(false); setError(null); setCached(false)
      try {
        const res = await streamPost(`/reports/${reportId}/narrative/stream`, { panelIndex, period, ...(branchNum !== undefined ? { branchNum } : {}), ...(version !== undefined ? { version } : {}) }, ac.signal)
        const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = ''
        while (true) {
          const { done, value } = await reader.read(); if (done) break
          buf += dec.decode(value, { stream: true }); const lines = buf.split('\n\n'); buf = lines.pop() ?? ''
          for (const chunk of lines) {
            const line = chunk.split('\n').find((l) => l.startsWith('data: ')); if (!line) continue
            const ev = JSON.parse(line.slice(6)) as Ev
            if (ev.type === 'phase') { setPhase(ev.phase); setLabel(ev.label) }
            else if (ev.type === 'delta') setText((t) => t + ev.text)
            else if (ev.type === 'replace') { setText(ev.text); setFallback(true) }
            else if (ev.type === 'done') { setText(ev.text); setFallback(ev.fallback); setDataAsOf(ev.dataAsOf); setCached(ev.cached); setPhase('done') }
            else if (ev.type === 'error') setError('AI 分析暂不可用')
          }
        }
      } catch (e) {
        if (!ac.signal.aborted) setError('AI 分析暂不可用')
      }
    }, 500)
    return () => { clearTimeout(timer); ac.abort() }
  }, [reportId, panelIndex, focus, JSON.stringify(period), branchNum, version])

  return (
    <div data-testid="ai-text">
      {error !== null ? <Alert type="warning" showIcon message={error} /> : (
        <>
          <Typography.Text type="secondary">{phase === 'done' ? (fallback ? '模板摘要（AI 暂不可用）' : 'AI 分析') : label}</Typography.Text>
          <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
            {text}{phase !== 'done' && text !== '' ? '▍' : ''}
          </Typography.Paragraph>
          {phase === 'done' && <Typography.Text type="secondary" style={{ fontSize: 12 }}>数据截至 {dataAsOf ?? '新鲜度未知'}{cached ? ' · 已缓存' : ''}</Typography.Text>}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 4: 接 `ReportView`**

```tsx
export default function ReportView({ reportId, title, spec, chrome, onClose, pinnedVersion }: { reportId: string; ... }) {
  // defaults / 查询循环都跳过 text 与 ai_text
  // 渲染：
  {p.chart === 'ai_text' ? (
    <Card size="small" title={<Space>{p.title}<Tag color="blue">AI</Tag></Space>}>
      <AiTextPanel reportId={reportId} panelIndex={i} focus={p.focus} period={period}
        branchNum={typeof override.branch_num === 'string' ? override.branch_num : (typeof defaults.branch_num === 'string' ? defaults.branch_num : undefined)}
        version={pinnedVersion ?? undefined} />
    </Card>
  ) : p.chart === 'kpi' ? (
    <KpiCard ... />
  ) : (
    <Card ...><PanelBody .../></Card>
  )}
}
```

`SpecView` 传 `reportId`；`standalone` 传 `id`。

- [ ] **Step 5: 跑绿 + web 构建**

Run: `cd modules/data && pnpm typecheck && pnpm exec vitest run console/reports/AiTextPanel.test.tsx console/reports/SpecView.test.tsx`
Run: `pnpm --filter @platform/web build`
Expected: PASS；390×844 无横向溢出（T13 的移动走查复跑）。

- [ ] **Step 6: 提交**

```bash
git add modules/data/console/lib/api.ts modules/data/console/reports/AiTextPanel.tsx modules/data/console/reports/ReportView.tsx modules/data/console/reports/SpecView.tsx modules/data/console/standalone.tsx modules/data/console/reports/AiTextPanel.test.tsx modules/data/console/reports/SpecView.test.tsx
git commit -m "feat(data-console): ai_text 流式面板（阶段/增量/回退）"
```

### Task 10: v2 月报发 v3（首个真实案例）

**Files:**
- Create: `docs/superpowers/notes/2026-10-26-monthly-report-v3-ai-text-spec.json`（可 review 的目标 spec）
- Production: `data.reports.spec` + `report_versions` v3

- [ ] **Step 1: 改 spec**

把 v2 spec 的静态 `text` 面板（0-based panel index 8）替换为：

```json
{ "chart": "ai_text", "title": "本月结论", "focus": "overview", "span": 24 }
```

其余 14 个面板不变；`period` 保持 `custom 2026-10-01..19`。用命令生成 note 文件：

```bash
jq '.panels[8] = {"chart":"ai_text","title":"本月结论","focus":"overview","span":24}' \
  docs/superpowers/notes/2026-10-26-monthly-report-v2-spec.json \
  > docs/superpowers/notes/2026-10-26-monthly-report-v3-ai-text-spec.json
jq '.panels | length, .panels[8].chart' docs/superpowers/notes/2026-10-26-monthly-report-v3-ai-text-spec.json
# 期望：15 / "ai_text"
```

- [ ] **Step 2: 提草稿 + 发布 v3**

用生产 `data:manage` 会话（人或 server 容器内自签会话；不打印密钥）：

```bash
RESP=$(curl -sS -X POST "$PLATFORM_ORIGIN/api/modules/data/reports" \
  -H "Content-Type: application/json" -H "Cookie: $PLATFORM_SESSION" \
  --data-binary "$(jq -n --arg t '熊喵曲靖沾益2店 · 2026年10月经营月报（10-01..19）' --slurpfile spec docs/superpowers/notes/2026-10-26-monthly-report-v3-ai-text-spec.json \
    '{title:$t, renderer:"platform", spec:$spec[0], requiredScope:"data:manage"}')")
ID=$(echo "$RESP" | jq -r .id); VER=$(echo "$RESP" | jq -r .version)
curl -sS -X POST "$PLATFORM_ORIGIN/api/modules/data/reports/$ID/publish" \
  -H "Content-Type: application/json" -H "Cookie: $PLATFORM_SESSION" \
  -d "{\"expectedVersion\":$VER,\"note\":\"v3：AI 文本组件\"}" | jq .
```

- [ ] **Step 3: 真机验收**

1. 打开 `/r/<ID>`：文本框先「正在核对指标…」→「正在分析…」→ 正文逐字出现；
2. 10-01..19 / 店 92：文本数字与 KPI 一致（销售额 51,273.89、订单 957、客单价 53.58、会员占比 47.36%、报损 806.64、自然损 387.64、净费用 2,613.42）；
3. 切「近 7 天」：文本变 10-13..19 的数（17,115.29 / 372 / 46.01）；切另一门店：文本随门店变；
4. 同一期间重复打开：`cached:true`（页脚「已缓存」），不再调模型；
5. 数字校验：单测注入编造数字的 fake 模型 ⇒ `replace` + 模板；
6. 未配 LLM（测试环境）：模板 + 回退标签；
7. 390×844：光标/换行/标签正常，无横向溢出。

- [ ] **Step 4: 记录证据并提交 note**

```bash
git add docs/superpowers/notes/2026-10-26-monthly-report-v3-ai-text-spec.json
git commit -m "docs(report): 熊喵月报 v3（ai_text）目标 spec"
```

---

## Self-Review

- **Spec coverage**：§2 组件/写侧 → Task 1/8；§4 端点/SSE → Task 7；§4.3 事实 → Task 5；§5/§6 LLM/校验/模板 → Task 4/6；§7 缓存 → Task 3/6；§8 权限 → Task 7；§9 版本 → Task 7/10；§10 前端 → Task 9；§12 测试 → 各 Task；§13 文件 → 各 Task；§14 边界 → 设计已列。
- **Placeholder scan**：无 TODO/TBD；每个 Task 有代码、命令、提交。
- **Type consistency**：`AiTextPanel`、`NarrativeEvent`、`FactBundle`、`StreamingChatModel`、`panelArgsOf`/`panelQueryBodyOf`/`compareRangeOf`、`buildFacts`、`streamNarrative`/`generateNarrative` 命名前后一致。
- **Known dependency**：Task 5 依赖 Task 2；Task 6 依赖 Task 4/5；Task 7 依赖 Task 3/6；Task 9 依赖 Task 1/7；Task 10 依赖 Task 7/9。
