// report-templates.ts — 报表模板与槽位（R2）：把「agent 自由写 spec」收窄成「选模板 + 填指标」。
//
// 为什么：自由 spec 的自由度太大，agent 容易产出「图表汤」；模板把**版式与分析结构**固定下来，
// 只把「用哪条指标」留给 agent/业务人员选。模板与槽位是**仓内数据**（不是 DB 配置）：
// 改模板走 PR、可评审、可回滚；租户差异用「选哪条指标」表达，而不是各自一份模板。
//
// 边界：模板只产出 **spec**，不落库、不发布（创建仍走 `POST /reports` 的既有校验/权限链）。
import { parseReportSpec, type PeriodSpec, type ReportSpec } from './report-spec'

export type TemplateChart = 'kpi' | 'line' | 'bar' | 'table' | 'ai_text'

export interface TemplateSlot {
  /** 槽位键：调用方按它传 metricId（ai_text 槽不需要）。 */
  key: string
  label: string
  chart: TemplateChart
  /** 必填槽：缺指标 ⇒ 编译失败（而不是产出一份残缺报表）。 */
  required?: boolean
  /** 面板标题（缺省用 label）。 */
  title?: string
  format?: 'currency' | 'number' | 'percent'
  compare?: 'none' | 'auto' | 'prev_period' | 'prev_month'
  compareYoY?: boolean
  dims?: string[]
  focus?: 'overview' | 'root_cause' | 'daily_review'
  span: number
}

export interface ReportTemplate {
  id: string
  title: string
  description: string
  period?: PeriodSpec
  slots: TemplateSlot[]
}

/**
 * 内置模板（仓内数据）。刻意少而稳：先覆盖「经营日报 / 门店对比 / 品类分析」三类，
 * 新增模板必须有真实使用案例（本仓规矩：无案例不立标准）。
 */
export const REPORT_TEMPLATES: readonly ReportTemplate[] = [
  {
    id: 'daily_ops',
    title: '门店经营日报',
    description: '营业额/订单/客单三卡 + 日趋势 + 经营分析；对比上一区间与去年同期。',
    period: { mode: 'last_7_days' },
    slots: [
      { key: 'revenue', label: '营业额', chart: 'kpi', required: true, format: 'currency', compare: 'auto', compareYoY: true, span: 8 },
      { key: 'orders', label: '订单数', chart: 'kpi', required: true, format: 'number', compare: 'auto', compareYoY: true, span: 8 },
      { key: 'aov', label: '客单价', chart: 'kpi', required: false, format: 'currency', compare: 'auto', compareYoY: true, span: 8 },
      { key: 'trend', label: '营业额趋势', chart: 'line', required: true, dims: ['bizday'], compare: 'prev_period', compareYoY: true, span: 24 },
      { key: 'analysis', label: '经营分析', chart: 'ai_text', title: '经营分析', focus: 'daily_review', span: 24 },
    ],
  },
  {
    id: 'store_compare',
    title: '门店对比',
    description: '按门店看营业额与订单，并给出结论；适合周会/月度复盘。',
    period: { mode: 'last_7_days' },
    slots: [
      { key: 'revenue', label: '销售额', chart: 'bar', required: true, dims: ['branch_num'], span: 12 },
      { key: 'orders', label: '订单数', chart: 'bar', required: true, dims: ['branch_num'], span: 12 },
      { key: 'analysis', label: '结论', chart: 'ai_text', title: '结论', focus: 'overview', span: 24 },
    ],
  },
  {
    id: 'category_analysis',
    title: '品类分析',
    description: '按品类看销售额与毛利，识别结构问题。',
    period: { mode: 'last_7_days' },
    slots: [
      { key: 'revenue', label: '销售额', chart: 'bar', required: true, dims: ['category_name'], span: 12 },
      { key: 'gross', label: '毛利', chart: 'bar', required: false, dims: ['category_name'], span: 12 },
      { key: 'detail', label: '品类明细', chart: 'table', required: true, dims: ['category_name'], span: 24 },
    ],
  },
]

export function templateById(id: string): ReportTemplate | undefined {
  return REPORT_TEMPLATES.find((t) => t.id === id)
}

export type CompileResult =
  | { ok: true; spec: ReportSpec }
  | { ok: false; reason: 'MISSING_REQUIRED_SLOT' | 'INVALID_SPEC' | 'UNKNOWN_SLOT'; keys?: string[]; detail?: string }

/**
 * 槽位填充 → spec。只做组装与 schema 校验；指标是否存在/可加/权限仍由写入侧与查询侧判。
 * 指标缺失的**可选槽**直接省略该面板（不给残缺面板），必填槽缺失则失败并列出键。
 */
export function compileTemplate(
  template: ReportTemplate,
  values: Readonly<Record<string, string>>,
): CompileResult {
  const known = new Set(template.slots.filter((s) => s.chart !== 'ai_text').map((s) => s.key))
  const unknown = Object.keys(values).filter((k) => !known.has(k))
  if (unknown.length > 0) return { ok: false, reason: 'UNKNOWN_SLOT', keys: unknown }

  const missing = template.slots
    .filter((s) => s.chart !== 'ai_text' && s.required === true && (values[s.key] ?? '') === '')
    .map((s) => s.key)
  if (missing.length > 0) return { ok: false, reason: 'MISSING_REQUIRED_SLOT', keys: missing }

  const panels: unknown[] = []
  for (const slot of template.slots) {
    if (slot.chart === 'ai_text') {
      panels.push({ chart: 'ai_text', title: slot.title ?? slot.label, focus: slot.focus ?? 'overview', span: slot.span })
      continue
    }
    const metricId = values[slot.key]
    if (metricId === undefined || metricId === '') continue // 可选槽留空 ⇒ 省略面板
    const base = { title: slot.title ?? slot.label, metricId, span: slot.span }
    if (slot.chart === 'kpi') {
      panels.push({
        ...base, chart: 'kpi', format: slot.format ?? 'number',
        compare: slot.compare ?? 'auto', ...(slot.compareYoY === undefined ? {} : { compareYoY: slot.compareYoY }),
      })
    } else {
      panels.push({
        ...base, chart: slot.chart, dims: slot.dims ?? [],
        ...(slot.compare === undefined ? {} : { compare: slot.compare }),
        ...(slot.compareYoY === undefined ? {} : { compareYoY: slot.compareYoY }),
      })
    }
  }

  const parsed = parseReportSpec({
    ...(template.period === undefined ? {} : { period: template.period }),
    panels,
  })
  if (!parsed.ok) return { ok: false, reason: 'INVALID_SPEC', detail: parsed.code }
  return { ok: true, spec: parsed.spec }
}
