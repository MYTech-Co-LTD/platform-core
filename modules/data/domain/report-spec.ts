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
