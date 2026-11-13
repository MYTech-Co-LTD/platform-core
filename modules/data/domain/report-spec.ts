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

export const CHART_TYPES = ['line', 'bar', 'table', 'cross_table', 'waterfall', 'kpi', 'text', 'ai_text'] as const
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
  mode: z.enum(['month', 'last_7_days', 'custom', 'day']),
  month: MonthStr.optional(),
  day: DateStr.optional(),
  from: DateStr.optional(),
  to: DateStr.optional(),
}).strict().superRefine((p, ctx) => {
  if (p.mode === 'month' && p.month === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['month'], message: 'mode=month 需要 month' })
  }
  if (p.mode === 'day' && p.day === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['day'], message: 'mode=day 需要 day' })
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

/** 图表的对比基线：`prev_*` 一条曲线，另可用 `compareYoY` 再叠去年同期。 */
const ChartCompare = z.enum(['none', 'prev_period', 'prev_month', 'prev_year']).optional()

const LinePanel = z.object({
  chart: z.literal('line'), ...metricBase,
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  slice: SliceSchema.optional(),
  compare: ChartCompare,
  compareYoY: z.boolean().optional(),
}).strict()
const BarPanel = z.object({
  chart: z.literal('bar'), ...metricBase,
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  slice: SliceSchema.optional(),
  compare: ChartCompare,
  compareYoY: z.boolean().optional(),
}).strict()

/**
 * table 的**渲染期列投影**（设计 §7.3.1）：只影响展示，不进 `/query`。
 * 非可加指标不能做子集聚合（`authorize` 拒），但原始 grain 明细会把内部列摊给用户；
 * 用这个只读投影收口。列名唯一、1..32 个。
 */
const TableColumnsSchema = z.array(z.string().trim().min(1).max(64)).min(1).max(32)
  .refine((cols) => new Set(cols).size === cols.length, { message: 'DUPLICATE_COLUMN' })

/** 交叉表（R3 组件①）：行维度（1–2）+ 列维度（1），单元格 = 指标合计。 */
const CrossTablePanel = z.object({
  chart: z.literal('cross_table'),
  title: z.string().trim().min(1).max(120),
  metricId: z.string().min(1).max(128),
  args: ArgsSchema,
  /** 行维度：1–2 个（多值时按 ` / ` 连接成行标签）。 */
  rows: z.array(z.string().min(1).max(64)).min(1).max(2),
  /** 列维度：1 个。 */
  columns: z.string().min(1).max(64),
  format: z.enum(['currency', 'number', 'percent']).default('number'),
  span: z.number().int().min(1).max(24).default(24),
  timeScoped: z.boolean().default(true),
}).strict()

/**
 * 瀑布图（R3 组件②）：**环比的差异分解**。每根 = 某维度值对「本期 − 上期」的贡献，
 * 最后一根 = 合计变化（校验位）。维度固定 1 个（多维度会让贡献不可读）。
 */
const WaterfallPanel = z.object({
  chart: z.literal('waterfall'),
  title: z.string().trim().min(1).max(120),
  metricId: z.string().min(1).max(128),
  args: ArgsSchema,
  dims: z.array(z.string().min(1).max(64)).length(1),
  compare: z.enum(['prev_period', 'prev_month']).default('prev_period'),
  format: z.enum(['currency', 'number', 'percent']).default('number'),
  span: z.number().int().min(1).max(24).default(24),
  timeScoped: z.boolean().default(true),
}).strict()

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
  /** 额外展示「去年同期」对比（同比）；默认关闭，避免所有 KPI 多一倍查询。 */
  compareYoY: z.boolean().optional(),
  goodDirection: z.enum(['up', 'down', 'none']).default('none'),
  span: z.number().int().min(1).max(24).default(12),
  timeScoped: z.boolean().default(true),
}).strict()

const TextPanel = z.object({
  chart: z.literal('text'),
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().min(1).max(MAX_TEXT),
  /** 渲染格式（R3）：plain = 原样纯文本；markdown = 受限富文本（粗体/斜体/代码/链接/列表/小标题）。 */
  format: z.enum(['plain', 'markdown']).default('plain'),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

/**
 * `ai_text`：观看时按当前期间/门店**服务端生成**的分析文本（结论/异常/行动）。
 *
 * ⚠️ 只声明「生成什么」，不声明「说什么」——没有 `content`（那是静态 `text` 的事），
 *    写侧也不接受任何自由文本键：`.strict()` 下多一个 `content` 即 INVALID_SPEC。
 * ⚠️ `focus` 是**代码常量白名单**：加口径 = 改这里 + 事实包 + 提示词，走 PR。
 *   · `overview`：结论/异常/行动（既有行为）；
 *   · `root_cause`：在事实包之外跑确定性的下钻/配方探针，输出「根因」段（不做对话）；
 *   · `daily_review`：目标日 + 昨天/MTD 日均/去年同月日均 + 毛利/净毛利/MTD 驱动与建议。
 */
const AiTextPanel = z.object({
  chart: z.literal('ai_text'),
  title: z.string().trim().min(1).max(120).default('AI 分析'),
  focus: z.enum(['overview', 'root_cause', 'daily_review']),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

/** 报表级共享筛选（R3 V4）：声明一次，运行时把值并入每个面板的 args（面板 args 会被覆盖）。 */
export const ReportFilterSchema = z.object({
  key: z.string().min(1).max(64),
  column: z.string().min(1).max(128),
  label: z.string().trim().min(1).max(64),
  type: z.enum(['string', 'number', 'date_range']),
}).strict()

export type ReportFilter = z.infer<typeof ReportFilterSchema>

/** 库里可能存的两种形态（V5 起新写入保留 v2）。读面必须用 `parseStoredSpec` 归一。 */
export type StoredReportSpec = ReportSpec | ReportSpecV2

export const ReportSpecSchema = z.object({
  period: PeriodSchema.optional(),
  filters: z.array(ReportFilterSchema).max(20).optional(),
  panels: z.array(z.discriminatedUnion('chart', [LinePanel, BarPanel, TablePanel, CrossTablePanel, WaterfallPanel, KpiPanel, TextPanel, AiTextPanel])).max(MAX_PANELS),
}).strict()



// ── IR v2（R3 / V1）：datasets + blocks（+ filters，V4 前不支持非空）─────────────────
// 存储仍写**规范化后的 v1**（flattenV2）：渲染/facts/版本通路在 V2/V3 迁移前零改动。
// 判别唯一：`ir === 2` ⇒ v2；否则按 v1。两套键同时出现 ⇒ INVALID_SPEC（v1 的 strict 会拒）。

const V2Dataset = z.object({
  key: z.string().min(1).max(64),
  metricId: z.string().min(1).max(128),
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).default([]),
  args: ArgsSchema,
  timeScoped: z.boolean().default(true),
}).strict()

const V2KpiBlock = z.object({
  type: z.literal('kpi'), dataset: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  format: z.enum(['currency', 'number', 'percent']),
  compare: z.enum(['auto', 'prev_period', 'prev_month', 'none']).default('auto'),
  compareYoY: z.boolean().optional(),
  goodDirection: z.enum(['up', 'down', 'none']).default('none'),
  span: z.number().int().min(1).max(24).default(12),
}).strict()

const V2ChartBlock = z.object({
  type: z.literal('chart'), chart: z.enum(['line', 'bar']), dataset: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  slice: SliceSchema.optional(),
  compare: z.enum(['none', 'prev_period', 'prev_month', 'prev_year']).optional(),
  compareYoY: z.boolean().optional(),
  span: z.number().int().min(1).max(24).default(12),
}).strict()

const V2TableBlock = z.object({
  type: z.literal('table'), dataset: z.string().min(1).max(64),
  title: z.string().trim().min(1).max(120),
  dims: z.array(z.string().min(1).max(64)).max(MAX_DIMS).optional(),
  columns: TableColumnsSchema.optional(),
  span: z.number().int().min(1).max(24).default(12),
}).strict()

const V2TextBlock = z.object({
  type: z.literal('text'),
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().min(1).max(MAX_TEXT),
  format: z.enum(['plain', 'markdown']).default('plain'),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

const V2AiTextBlock = z.object({
  type: z.literal('ai_text'),
  title: z.string().trim().min(1).max(120).default('AI 分析'),
  focus: z.enum(['overview', 'root_cause', 'daily_review']),
  dataset: z.string().min(1).max(64).optional(),
  span: z.number().int().min(1).max(24).default(24),
}).strict()

export const ReportSpecV2Schema = z.object({
  ir: z.literal(2),
  period: PeriodSchema.optional(),
  filters: z.array(ReportFilterSchema).max(20).optional(),
  datasets: z.array(V2Dataset).min(1).max(MAX_PANELS),
  blocks: z.array(z.discriminatedUnion('type', [
    V2KpiBlock, V2ChartBlock, V2TableBlock, V2TextBlock, V2AiTextBlock,
  ])).min(1).max(MAX_PANELS),
}).strict()

export type ReportSpecV2 = z.infer<typeof ReportSpecV2Schema>

/** v2 → v1 扁平化（存储/渲染的统一形态）。数据集字段内联进面板，块顺序即面板顺序。 */
export function flattenReportSpecV2(v2: ReportSpecV2): { ok: true; spec: ReportSpec } | { ok: false; code: SpecErrorCode } {
  const datasets = new Map(v2.datasets.map((d) => [d.key, d]))
  const panels: unknown[] = []
  for (const b of v2.blocks) {
    if (b.type === 'text') {
      panels.push({ chart: 'text', title: b.title, content: b.content, format: b.format, span: b.span })
      continue
    }
    if (b.type === 'ai_text') {
      panels.push({ chart: 'ai_text', title: b.title, focus: b.focus, span: b.span })
      continue
    }
    const dataset = datasets.get(b.dataset)
    if (dataset === undefined) return { ok: false, code: 'INVALID_SPEC' }
    const base = {
      title: b.title, metricId: dataset.metricId, args: dataset.args,
      span: b.span, timeScoped: dataset.timeScoped,
    }
    if (b.type === 'kpi') {
      panels.push({
        ...base, chart: 'kpi', format: b.format, compare: b.compare,
        ...(b.compareYoY === undefined ? {} : { compareYoY: b.compareYoY }),
        goodDirection: b.goodDirection,
      })
    } else if (b.type === 'chart') {
      panels.push({
        ...base, chart: b.chart, dims: dataset.dims,
        ...(b.slice === undefined ? {} : { slice: b.slice }),
        ...(b.compare === undefined ? {} : { compare: b.compare }),
        ...(b.compareYoY === undefined ? {} : { compareYoY: b.compareYoY }),
      })
    } else {
      panels.push({
        ...base, chart: 'table', dims: b.dims ?? dataset.dims,
        ...(b.columns === undefined ? {} : { columns: b.columns }),
      })
    }
  }
  return parseReportSpec({
    ...(v2.period === undefined ? {} : { period: v2.period }),
    ...(v2.filters === undefined ? {} : { filters: v2.filters }),
    panels,
  })
}

/**
 * 写入侧统一入口：v1 原样、v2 扁平化后按 v1 校验。
 * `ir` 只用于观测/审计，存储与下游消费在 V2/V3 迁移前一概是 v1。
 */
/** 读已存储的 spec（v1 或 v2）⇒ 统一 v1 规范形态。读面专用：挂库数据可能是 v2。 */
export function parseStoredSpec(input: unknown): { ok: true; spec: ReportSpec; ir: 1 | 2; raw: StoredReportSpec } | { ok: false; code: SpecErrorCode } {
  return parseReportInput(input)
}

export function parseReportInput(input: unknown): { ok: true; spec: ReportSpec; ir: 1 | 2; raw: StoredReportSpec } | { ok: false; code: SpecErrorCode } {
  const ir = (input as { ir?: unknown } | null)?.ir
  if (ir === 2) {
    const parsed = ReportSpecV2Schema.safeParse(input)
    if (!parsed.success) return { ok: false, code: 'INVALID_SPEC' }
    const flat = flattenReportSpecV2(parsed.data)
    return flat.ok ? { ok: true, spec: flat.spec, ir: 2, raw: parsed.data } : flat
  }
  const v1 = parseReportSpec(input)
  return v1.ok ? { ok: true, spec: v1.spec, ir: 1, raw: v1.spec } : v1
}

export type ReportSpec = z.infer<typeof ReportSpecSchema>
export type PeriodSpec = z.infer<typeof PeriodSchema>
export type MetricPanel = z.infer<typeof LinePanel> | z.infer<typeof BarPanel> | z.infer<typeof TablePanel>
export type KpiPanel = z.infer<typeof KpiPanel>
export type TextPanel = z.infer<typeof TextPanel>
export type AiTextPanel = z.infer<typeof AiTextPanel>
export type SpecErrorCode = 'INVALID_SPEC' | 'UNKNOWN_CHART_TYPE' | 'UNKNOWN_AI_FOCUS' | 'SPEC_TOO_LARGE' | 'IR_V2_FILTERS_UNSUPPORTED'

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
