// report-lint.ts — 报表语义 lint（R2 第一块）：**静态**检查报表结构是否自洽。
//
// 为什么需要：schema 只能保证「字段合法」，保证不了「这份报表说得通」。四类真实问题：
//   · 面板在 period 之外又硬写 bizday ⇒ 被报表期间**静默覆盖**，读者看到的窗口与声明不符；
//   · 有 ai_text 却没有任何数据面板 ⇒ 叙事没有事实可讲，只能空转；
//   · 同一页两个同名 KPI 指向不同指标 ⇒ 读者无法分辨；
//   · 非时间面板声明了对比 ⇒ 对比无定义。
//
// 边界：这里只做**结构判据**，不查数据、不查权限（覆盖不足要真机查库，属运行期，另案）。
// 判据全部来自 spec 自身，因此可同时用于「写入草稿」「发布前」与「agent 自检」。
import type { ReportSpec } from './report-spec'

export type LintLevel = 'error' | 'warn'

export interface LintIssue {
  level: LintLevel
  code: string
  message: string
  /** 相关面板下标（0 基）；与整份报表有关时缺席。 */
  panelIndexes?: number[]
}

type Panel = ReportSpec['panels'][number]
type DataPanel = Exclude<Panel, { chart: 'text' } | { chart: 'ai_text' }>

const isDataPanel = (p: Panel): p is DataPanel => p.chart !== 'text' && p.chart !== 'ai_text'
const hasMetric = (p: Panel): p is Extract<Panel, { metricId: string }> =>
  p.chart !== 'text' && p.chart !== 'ai_text'

/** 一条报表的语义 lint。返回空数组 = 无问题。 */
export function lintReportSpec(spec: ReportSpec): LintIssue[] {
  const issues: LintIssue[] = []
  const hasPeriod = spec.period !== undefined
  const dataPanels: Array<{ panel: DataPanel; index: number }> = []
  spec.panels.forEach((panel, index) => {
    if (isDataPanel(panel)) dataPanels.push({ panel, index })
  })

  // ① 面板自带 bizday 会被报表期间覆盖：声明了一个窗口却算出另一个 → 静默错数。
  if (hasPeriod) {
    const overridden = dataPanels
      .filter(({ panel }) => panel.timeScoped !== false && panel.args.bizday !== undefined)
      .map(({ index }) => index)
    if (overridden.length > 0) {
      issues.push({
        level: 'error',
        code: 'PANEL_BIZDAY_OVERRIDDEN',
        message: '面板自带 bizday 会被报表期间覆盖；请删掉面板的 bizday 或去掉报表 period',
        panelIndexes: overridden,
      })
    }
  }

  // ② ai_text 必须至少有一个数据面板：没有事实，叙事只能空转。
  const aiPanels = spec.panels
    .map((panel, index) => ({ panel, index }))
    .filter(({ panel }) => panel.chart === 'ai_text')
  if (aiPanels.length > 0 && dataPanels.length === 0) {
    issues.push({
      level: 'error',
      code: 'AI_WITHOUT_DATA',
      message: 'AI 文本面板需要至少一个数据面板提供事实',
      panelIndexes: aiPanels.map(({ index }) => index),
    })
  }

  // ③ 同名 KPI 指向不同指标 ⇒ 读者无法分辨「哪个才是营业额」。
  const kpiByTitle = new Map<string, { metricId: string; indexes: number[] }>()
  spec.panels.forEach((panel, index) => {
    if (panel.chart !== 'kpi') return
    const title = panel.title.trim()
    const cur = kpiByTitle.get(title)
    if (cur === undefined) kpiByTitle.set(title, { metricId: panel.metricId, indexes: [index] })
    else cur.indexes.push(index)
  })
  for (const [title, entry] of kpiByTitle) {
    const metricIds = new Set(
      entry.indexes.map((i) => {
        const p = spec.panels[i]!
        return p.chart === 'kpi' ? p.metricId : ''
      }),
    )
    if (metricIds.size > 1) {
      issues.push({
        level: 'warn',
        code: 'DUPLICATE_KPI_TITLE',
        message: `同名 KPI「${title}」指向 ${metricIds.size} 个不同指标，读者无法分辨`,
        panelIndexes: entry.indexes,
      })
    }
  }

  // ④ 非时间面板声明对比：对比没有定义。
  const compareOnStatic = dataPanels
    .filter(({ panel }) => panel.timeScoped === false && 'compare' in panel && panel.compare !== 'none')
    .map(({ index }) => index)
  if (compareOnStatic.length > 0) {
    issues.push({
      level: 'error',
      code: 'COMPARE_ON_NON_TIME_SCOPED',
      message: '声明为 timeScoped=false 的面板不能做期间对比',
      panelIndexes: compareOnStatic,
    })
  }

  // ⑤ 没有声明期间却有按时间取数的面板：前端会兜底成「昨天」，与作者意图可能不符。
  if (!hasPeriod && dataPanels.some(({ panel }) => panel.timeScoped !== false)) {
    issues.push({
      level: 'warn',
      code: 'MISSING_PERIOD',
      message: '报表未声明 period，观看时按「昨天」兜底；建议显式声明默认期间',
    })
  }

  return issues
}

/** 发布/写入的收口判据：有 error 即拒；warn 放行但回传。 */
export function lintBlocksPublish(issues: readonly LintIssue[]): boolean {
  return issues.some((i) => i.level === 'error')
}
