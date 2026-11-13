// cross-table.ts — 交叉表透视（R3 组件①）：服务端已按 (行维…, 列维) 分组，这里只做摆放。
//
// 契约：结果列为 `[rows..., columns, 'value']`；行标签 = 行维值按 ` / ` 连接，
// 列标签 = 列维值；缺组合的格子写 `-`（不补 0：缺数 ≠ 0）。排序按**首次出现**，保留服务端顺序。
import type { KpiPanel } from '../../domain/report-spec'
import { formatValue } from '../../domain/report-format'

export interface CrossTableData {
  rowLabels: string[]
  colLabels: string[]
  /** row → col → 展示值 */
  cells: Map<string, Map<string, string>>
}

export function pivotOf(
  result: { columns: string[]; rows: unknown[][] },
  rows: readonly string[],
  column: string,
  format: KpiPanel['format'],
): CrossTableData {
  const rowLabels: string[] = []
  const colLabels: string[] = []
  const cells = new Map<string, Map<string, string>>()
  const rIdx = rows.map((d) => result.columns.indexOf(d))
  const cIdx = result.columns.indexOf(column)
  const vIdx = result.columns.indexOf('value')
  if (cIdx < 0 || vIdx < 0 || rIdx.some((i) => i < 0)) return { rowLabels, colLabels, cells }

  for (const row of result.rows) {
    if (!Array.isArray(row)) continue
    const rowLabel = rIdx.map((i) => String(row[i] ?? '')).join(' / ')
    const colLabel = String(row[cIdx] ?? '')
    const n = Number(row[vIdx])
    if (rowLabel === '' || colLabel === '') continue
    if (!rowLabels.includes(rowLabel)) rowLabels.push(rowLabel)
    if (!colLabels.includes(colLabel)) colLabels.push(colLabel)
    let line = cells.get(rowLabel)
    if (line === undefined) {
      line = new Map<string, string>()
      cells.set(rowLabel, line)
    }
    line.set(colLabel, Number.isFinite(n) ? formatValue(n, format) : '-')
  }
  return { rowLabels, colLabels, cells }
}
