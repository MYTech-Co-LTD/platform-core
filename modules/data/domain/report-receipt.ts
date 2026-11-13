// report-receipt.ts — 报表「计算凭证」（R1）：让业务人员能**自己算一遍**。
//
// 为什么需要：指标可信度能靠对账证明，但业务人员判断的是「这数跟我的账对不对」。凭证把
// 一个 KPI 的**口径 / 窗口 / 范围 / 数据截至 / 按日组成**摊开，且组成合计与页面值必须自洽
// （`consistent`）。这是「人工复算」从口号变成动作的最小形态（路线图 R1）。
//
// 边界（硬约束）：
//  · 只经 `runQuery` 取数——授权、掩码、审计、行上限全部同 `/query`，不新开 SQL 通道；
//  · 只做**可加且按日**的指标（`totalable` + groupBy 含 bizday + 非比率）：比率指标的
//    「按日合计」没有意义，宁可不给，也不给一个误导性的组成；
//  · 不给「差异原因」猜结论：差异分解只报可验证的事实（窗口、截至、掩码），原因由 R1 的
//    差异分解专门做，不在这一层编。
import type { Requester } from './authz'
import type { DateRange } from './report-period'
import type { MetricRow } from './metric-store'
import { runQuery, type QueryDeps } from './query-service'
import { formatValue } from './report-format'
import type { KpiPanel } from './report-spec'

export interface ReceiptSeriesRow {
  /** 业务日（YYYY-MM-DD）。 */
  day: string
  value: number
  /** 与页面同格式的展示值。 */
  formatted: string
}

export interface ReportReceipt {
  metric: {
    id: string
    title: string
    /** 口径原文（L1 声明 / L2 描述）；未声明为 null。 */
    definition: string | null
    unit: string | null
    /** 口径射程与排除项（L1 的 scope_note）；未声明为 null。 */
    scopeNote: string | null
    caliber: 'certified' | 'draft'
  }
  window: { from: string; to: string; mode: 'day' | 'range' }
  scope: { branchNum: string | null; args: Record<string, unknown> }
  /** 与页面同格式的合计值。 */
  value: string
  rawValue: number | null
  dataAsOf: string | null
  watermark: string | null
  freshness: { status: string | null; line: string | null }
  /** 按日组成；不可加/无 bizday/比率指标 ⇒ null（不给误导性组成）。 */
  series: ReceiptSeriesRow[] | null
  /** 按日合计（与 value 同格式）；series 为 null 时同样为 null。 */
  seriesSum: string | null
  /** 按日合计是否与页面值一致（差额 ≤0.01）；无法校验时为 null。 */
  consistent: boolean | null
  /** 供人读的事实说明（不含推测）。 */
  notes: string[]
}

export interface ReceiptInput {
  panel: KpiPanel
  range: DateRange
  /** `panelArgsOf` 产出的参数（已含期间窗口）。 */
  args: Record<string, unknown>
  branchNum?: string
  metric: MetricRow
}

export type ReceiptOutcome =
  | { ok: true; receipt: ReportReceipt }
  | { ok: false; reason: 'denied' | 'error'; detail?: string }

function numeric(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** 合计查询的回包取值：显式合计恒单行 `columns:['total']`；回退到 `total` 字段。 */
function totalOf(out: { columns: string[]; rows: unknown[][]; total?: string | number | null }): number | null {
  const idx = out.columns.indexOf('total')
  if (idx >= 0 && out.rows.length > 0) {
    const row = out.rows[0]
    if (Array.isArray(row)) return numeric(row[idx])
  }
  return numeric(out.total ?? null)
}

function seriesOf(out: { columns: string[]; rows: unknown[][] }, format: KpiPanel['format']): ReceiptSeriesRow[] {
  const dayIdx = out.columns.indexOf('bizday')
  const valueIdx = out.columns.indexOf('value')
  if (dayIdx < 0 || valueIdx < 0) return []
  const rows: ReceiptSeriesRow[] = []
  for (const row of out.rows) {
    if (!Array.isArray(row)) continue
    const day = typeof row[dayIdx] === 'string' ? row[dayIdx] as string : null
    const value = numeric(row[valueIdx])
    if (day === null || value === null) continue
    rows.push({ day: day.slice(0, 10), value, formatted: formatValue(value, format) })
  }
  rows.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))
  return rows
}

/** 凭证的按日组成是否可用：可加、非比率、声明了 bizday 粒度。 */
export function seriesSupported(panel: KpiPanel, metric: MetricRow): boolean {
  if (panel.denominatorMetricId !== undefined) return false
  if (!metric.totalable) return false
  return metric.groupBy.split(',').map((d) => d.trim()).includes('bizday')
}

/**
 * 构建凭证。**只经 runQuery**（与页面同一条授权/掩码/审计链）。
 * 调用方负责：报表 ACL、面板类型（kpi）、range 合法性、指标存在性。
 */
export async function buildReportReceipt(
  deps: QueryDeps,
  org: string,
  requester: Requester,
  input: ReceiptInput,
): Promise<ReceiptOutcome> {
  const { panel, metric, range, args } = input
  const total = await runQuery(deps, org, requester, panel.metricId, { ...args, total: true })
  if (total.status === 'denied') return { ok: false, reason: 'denied', detail: total.reason }
  if (total.status !== 'ok') return { ok: false, reason: 'error', detail: total.reason }

  const rawValue = totalOf(total)
  const notes: string[] = []
  if (total.watermark !== undefined) notes.push(`数据水位 ${total.watermark}`)
  if (total.data_as_of !== undefined) notes.push(`最近物化 ${String(total.data_as_of)}`)
  if (total.masking !== undefined) notes.push('本响应含脱敏值，按日合计只能与页面同样精度核对')

  let series: ReceiptSeriesRow[] | null = null
  if (seriesSupported(panel, metric)) {
    const out = await runQuery(deps, org, requester, panel.metricId, args, {
      dimensions: ['bizday'],
      orderBy: [{ column: 'bizday', dir: 'asc' }],
    })
    // 组成查询失败不拖垮凭证：主值仍可交付，只标注「组成不可用」。
    if (out.status === 'ok') {
      series = seriesOf(out, panel.format)
      if (series.length === 0) series = null
    } else {
      notes.push('按日组成暂不可用（组成查询失败），请以合计与明细导出核对')
    }
  } else {
    notes.push('该指标不可加或未声明 bizday 粒度，不提供按日合计校验')
  }

  const seriesSumRaw = series === null ? null : series.reduce((s, r) => s + r.value, 0)
  const consistent = rawValue !== null && seriesSumRaw !== null
    ? Math.abs(seriesSumRaw - rawValue) <= 0.01
    : null
  if (consistent === false && rawValue !== null && seriesSumRaw !== null) {
    notes.push(`按日合计与合计值不一致（差额 ${(seriesSumRaw - rawValue).toFixed(2)}），请勿据此复算`)
  }

  return {
    ok: true,
    receipt: {
      metric: {
        id: metric.id,
        title: metric.title,
        definition: metric.description ?? metric.bizDescription ?? null,
        unit: metric.unit ?? null,
        scopeNote: metric.scopeNote ?? null,
        caliber: metric.certified === 'certified' ? 'certified' : 'draft',
      },
      window: {
        from: range.from,
        to: range.to,
        mode: range.from === range.to ? 'day' : 'range',
      },
      scope: {
        branchNum: input.branchNum ?? null,
        // 回显参数时去掉期间窗口：它是顶层的 window，不再混在过滤条件里。
        args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'bizday')),
      },
      value: formatValue(rawValue, panel.format),
      rawValue,
      dataAsOf: total.data_as_of === undefined ? null : String(total.data_as_of),
      watermark: total.watermark ?? null,
      freshness: {
        status: total.freshness_status ?? null,
        line: total.freshness_line ?? null,
      },
      series,
      seriesSum: seriesSumRaw === null ? null : formatValue(seriesSumRaw, panel.format),
      consistent,
      notes,
    },
  }
}

/** 凭证转 CSV（按日组成）。无组成 ⇒ 只有表头；调用方应先拦住。 */
export function receiptCsv(receipt: ReportReceipt): string {
  const header = 'bizday,value'
  const lines = receipt.series === null ? [] : receipt.series.map((r) => `${r.day},${r.value}`)
  return [header, ...lines].join('\n') + '\n'
}
