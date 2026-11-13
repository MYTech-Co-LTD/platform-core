// report-plan.ts — 报表规范化执行计划（R3 / IR v2 V0）。
//
// 定位：渲染、facts、lint、审阅都只消费这一份 plan，不再各自遍历 `spec.panels`。
// 本轮（V0）只做 **v1 → plan** 的规范化：行为与逐面板读取**逐字段一致**，不改变任何输出。
// v2（datasets/blocks/filters）的解析在 V1 加入；判别与优先级见
// `docs/superpowers/plans/2026-11-13-report-ir-v2.md` §2/§3。
import type { PeriodSpec, ReportSpec } from './report-spec'

/** 数据集：一次取数所需的全部输入（v1 下每个数据面板一个匿名数据集）。 */
export interface PlanDataset {
  key: string
  metricId: string
  dims: string[]
  args: Record<string, unknown>
  timeScoped: boolean
}

/** 与 blocks/panels 一一对应；`index` 即对外 `panelIndex`（叙事缓存键、审计、前端都沿用它）。 */
export interface PlanPanel {
  index: number
  kind: ReportSpec['panels'][number]['chart']
  title: string
  datasetKey: string | null
  /** 原始面板（呈现字段：format/compare/slice/focus/content…）。 */
  panel: ReportSpec['panels'][number]
}

export interface ReportPlan {
  period: PeriodSpec | null
  /** v2 才有；v1 恒空数组。 */
  filters: []
  datasets: PlanDataset[]
  panels: PlanPanel[]
}

const isDataPanel = (p: ReportSpec['panels'][number]): boolean =>
  p.chart !== 'text' && p.chart !== 'ai_text'

/** v1 → plan（V0）。纯函数，无 IO。 */
export function toReportPlan(spec: ReportSpec): ReportPlan {
  const datasets: PlanDataset[] = []
  const panels: PlanPanel[] = spec.panels.map((panel, index) => {
    const title = 'title' in panel && typeof panel.title === 'string' ? panel.title : ''
    if (!isDataPanel(panel) || !('metricId' in panel)) {
      return { index, kind: panel.chart, title, datasetKey: null, panel }
    }
    const key = `p${index}`
    datasets.push({
      key,
      metricId: panel.metricId,
      dims: 'dims' in panel ? (panel.dims ?? []) : [],
      args: panel.args ?? {},
      timeScoped: panel.timeScoped !== false,
    })
    return { index, kind: panel.chart, title, datasetKey: key, panel }
  })
  return { period: spec.period ?? null, filters: [], datasets, panels }
}
