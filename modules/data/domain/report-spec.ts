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

export const CHART_TYPES = ['line', 'bar', 'table', 'kpi', 'text', 'ai_text'] as const
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

/**
 * table 的**渲染期列投影**（设计 §7.3.1）：只影响展示，不进 `/query`。
 * 非可加指标不能做子集聚合（`authorize` 拒），但原始 grain 明细会把内部列摊给用户；
 * 用这个只读投影收口。列名唯一、1..32 个。
 */
const TableColumnsSchema = z.array(z.string().trim().min(1).max(64)).min(1).max(32)
  .refine((cols) => new Set(cols).size === cols.length, { message: 'DUPLICATE_COLUMN' })

const TablePanel = z.object({
  chart: z.literal('table'), ...metricBase,
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  slice: SliceSchema.optional(),
  columns: TableColumnsSchema.optional(),
}).strict()

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

/**
 * `ai_text`：观看时按当前期间/门店**服务端生成**的分析文本（结论/异常/行动）。
 *
 * ⚠️ 只声明「生成什么」，不声明「说什么」——没有 `content`（那是静态 `text` 的事），
 *    写侧也不接受任何自由文本键：`.strict()` 下多一个 `content` 即 INVALID_SPEC。
 * ⚠️ `focus` 是**代码常量白名单**（v1 只有 `overview`）：加口径 = 改这里 + 事实包 + 提示词，走 PR。
 */
const AiTextPanel = z.object({
  chart: z.literal('ai_text'),
  title: z.string().trim().min(1).max(120).default('AI 分析'),
  focus: z.enum(['overview']),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

export const ReportSpecSchema = z.object({
  period: PeriodSchema.optional(),
  panels: z.array(z.discriminatedUnion('chart', [LinePanel, BarPanel, TablePanel, KpiPanel, TextPanel, AiTextPanel])).max(MAX_PANELS),
}).strict()

export type ReportSpec = z.infer<typeof ReportSpecSchema>
export type PeriodSpec = z.infer<typeof PeriodSchema>
export type MetricPanel = z.infer<typeof LinePanel> | z.infer<typeof BarPanel> | z.infer<typeof TablePanel>
export type KpiPanel = z.infer<typeof KpiPanel>
export type TextPanel = z.infer<typeof TextPanel>
export type AiTextPanel = z.infer<typeof AiTextPanel>
export type SpecErrorCode = 'INVALID_SPEC' | 'UNKNOWN_CHART_TYPE' | 'UNKNOWN_AI_FOCUS' | 'SPEC_TOO_LARGE'

export function parseReportSpec(input: unknown): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode } {
  const panels = (input as { panels?: unknown })?.panels
  if (Array.isArray(panels) && panels.length > MAX_PANELS) return { ok: false, code: 'SPEC_TOO_LARGE' }
  const parsed = ReportSpecSchema.safeParse(input)
  if (parsed.success) return { ok: true, spec: parsed.data }
  const bad = parsed.error.issues.find((i) => i.path.at(-1) === 'chart')
  if (bad !== undefined) return { ok: false, code: 'UNKNOWN_CHART_TYPE' }
  // focus 越界单列一码：这是「图型认得、口径不认得」（前端出人话：可选值有哪些），
  // 与未知图型/白名单外键混成一个码会让人去改图型。
  const badFocus = parsed.error.issues.find((i) => i.path.at(-1) === 'focus' && i.code === 'invalid_enum_value')
  if (badFocus !== undefined) return { ok: false, code: 'UNKNOWN_AI_FOCUS' }
  return { ok: false, code: 'INVALID_SPEC' }
}
