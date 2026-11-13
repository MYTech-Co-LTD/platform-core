// report-review.ts — 报表审阅面（R2）：草稿 vs 已发布 + 说明书 + lint，纯函数组装。
//
// 为什么需要：agent 起草的报表要**人审制品**而不是「看结果猜」。审阅面回答三件事：
//   ① 这次改了什么（结构化 diff，不是整份 spec 甩给人）；
//   ② 这份报表用了哪些口径（说明书：指标/定义/单位/可信度）；
//   ③ 结构上有没有问题（lint，与发布门同一份判据）。
//
// 边界：只读 spec 与词表，**不查数**（覆盖/对账属运行期，另案）。因此可随写随看，成本为零。
import type { ReportSpec } from './report-spec'
import type { MetricRow } from './metric-store'
import type { LintIssue } from './report-lint'
import { lintReportSpec } from './report-lint'

export interface ReviewCanvasMetric {
  id: string
  title: string
  /** 口径原文（L1 声明 / L2 描述）；未声明为 null。 */
  definition: string | null
  unit: string | null
  caliber: 'certified' | 'draft'
  /** 用到该指标的面板下标。 */
  panels: number[]
}

export interface ReviewPanel {
  index: number
  chart: string
  title: string
  metricId: string | null
  metricTitle: string | null
}

export interface ReviewPanelChange {
  index: number
  change: 'added' | 'removed' | 'changed'
  /** 变化的顶层字段名（仅 changed 时在场）。 */
  fields?: string[]
}

export interface ReviewDiff {
  unchanged: boolean
  titleChanged?: { from: string; to: string }
  periodChanged?: { from: unknown; to: unknown }
  panels: ReviewPanelChange[]
}

export interface ReportReview {
  doc: {
    title: string
    panelCount: number
    period: unknown
    panels: ReviewPanel[]
    metrics: ReviewCanvasMetric[]
  }
  /** 无已发布基线时 null（首次发布前）。 */
  diff: ReviewDiff | null
  lint: LintIssue[]
}

/** 稳定序列化：键排序，用于结构相等/字段级差异（不引入第三方 diff 库）。 */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`
}

function diffPanels(draft: ReportSpec, published: ReportSpec | null): ReviewDiff | null {
  if (published === null) return null
  const a = published.panels
  const b = draft.panels
  const out: ReviewPanelChange[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const before = a[i]
    const after = b[i]
    if (before === undefined) {
      out.push({ index: i, change: 'added' })
      continue
    }
    if (after === undefined) {
      out.push({ index: i, change: 'removed' })
      continue
    }
    if (stable(before) === stable(after)) continue
    const keys = new Set([...Object.keys(before), ...Object.keys(after)])
    const fields = [...keys].filter((k) =>
      stable((before as Record<string, unknown>)[k]) !== stable((after as Record<string, unknown>)[k]))
    out.push({ index: i, change: 'changed', fields: fields.sort() })
  }
  return {
    unchanged: out.length === 0,
    ...(stable(draft.period) === stable(published.period)
      ? {}
      : { periodChanged: { from: published.period ?? null, to: draft.period ?? null } }),
    panels: out,
  }
}

/** 组装审阅面。`published === null` ⇒ diff 为 null（首次发布前没有基线）。 */
export function buildReportReview(
  draft: ReportSpec,
  published: ReportSpec | null,
  catalog: readonly MetricRow[],
  title: string,
  publishedTitle: string | null = null,
): ReportReview {
  const byId = new Map(catalog.map((m) => [m.id, m]))
  const used = new Map<string, number[]>()
  const panels: ReviewPanel[] = draft.panels.map((p, index) => {
    const metricId = 'metricId' in p ? p.metricId : null
    if (metricId !== null) {
      const list = used.get(metricId)
      if (list === undefined) used.set(metricId, [index])
      else list.push(index)
    }
    return {
      index,
      chart: p.chart,
      title: (p as { title?: string }).title ?? '',
      metricId,
      metricTitle: metricId === null ? null : byId.get(metricId)?.title ?? null,
    }
  })

  const metrics: ReviewCanvasMetric[] = [...used.entries()].map(([id, indexes]) => {
    const m = byId.get(id)
    return {
      id,
      title: m?.title ?? id,
      definition: m ? (m.description ?? m.bizDescription ?? null) : null,
      unit: m?.unit ?? null,
      caliber: m?.certified === 'certified' ? 'certified' : 'draft',
      panels: indexes,
    }
  })

  const diff = diffPanels(draft, published)
  const titleDiff = published !== null && publishedTitle !== null && publishedTitle !== title
    ? { titleChanged: { from: publishedTitle, to: title } }
    : {}
  return {
    doc: { title, panelCount: draft.panels.length, period: draft.period ?? null, panels, metrics },
    diff: diff === null ? null : { ...diff, ...titleDiff, unchanged: diff.unchanged && titleDiff.titleChanged === undefined },
    lint: lintReportSpec(draft),
  }
}
