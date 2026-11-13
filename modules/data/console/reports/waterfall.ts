// waterfall.ts — 瀑布图数据（R3 组件②）：环比的差异分解。
//
// 语义（用户已确认）：每根柱 = 某维度值对「本期 − 上期」的贡献；最后一根 = 合计变化（校验位）。
// 只做**连接与排序**：维度值以 label 对齐（` / ` 连接），缺一侧按 0 计；贡献按绝对值降序。
export interface WaterfallBar {
  label: string
  delta: number
  kind: 'delta' | 'total'
}

export function waterfallBarsOf(
  current: { columns: string[]; rows: unknown[][] },
  previous: { columns: string[]; rows: unknown[][] },
  dims: readonly string[],
): WaterfallBar[] {
  const idx = (cols: string[]) => ({
    keys: dims.map((d) => cols.indexOf(d)),
    v: cols.indexOf('value'),
  })
  const c = idx(current.columns)
  const p = idx(previous.columns)
  if (c.v < 0 || p.v < 0 || c.keys.some((i) => i < 0) || p.keys.some((i) => i < 0)) return []

  const collect = (r: { columns: string[]; rows: unknown[][] }, vIdx: number, kIdx: number[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const row of r.rows) {
      if (!Array.isArray(row)) continue
      const label = kIdx.map((i) => String(row[i] ?? '')).join(' / ')
      const n = Number(row[vIdx])
      if (label === '' || !Number.isFinite(n)) continue
      m.set(label, (m.get(label) ?? 0) + n)
    }
    return m
  }
  const cur = collect(current, c.v, c.keys)
  const prev = collect(previous, p.v, p.keys)
  const labels = [...new Set([...cur.keys(), ...prev.keys()])]
  if (labels.length === 0) return []

  const bars: WaterfallBar[] = labels
    .map((label) => ({ label, delta: (cur.get(label) ?? 0) - (prev.get(label) ?? 0), kind: 'delta' as const }))
    // 贡献为 0 的不画（噪音）；保留非零项
    .filter((b) => Math.abs(b.delta) > 1e-9)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  if (bars.length === 0) return []
  // 维度值过多时只画贡献最大的 10 项，其余合并成一根（合并后合计不变，仍可校验）。
  const MAX_DELTAS = 10
  if (bars.length > MAX_DELTAS) {
    const head = bars.slice(0, MAX_DELTAS)
    const rest = bars.slice(MAX_DELTAS)
    head.push({
      label: `其他（${rest.length} 项）`,
      delta: rest.reduce((sum, b) => sum + b.delta, 0),
      kind: 'delta',
    })
    bars.splice(0, bars.length, ...head)
  }
  const total = bars.reduce((s, b) => s + b.delta, 0)
  bars.push({ label: '合计变化', delta: total, kind: 'total' })
  return bars
}
