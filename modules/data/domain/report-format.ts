// report-format.ts — KPI 值与差值的格式化 / 颜色语义（计划 2026-10-26 Task 2 从 KpiCard 原样抽出）。
//
// 抽出来的原因：AI 文本的事实包与模板（domain/narrative.ts）要产出**与 KPI 卡逐字一致**的
// 数字/差值文案；两处各写一份格式化，模型看到的数和卡片上的数就可能对不上。
//
// 纪律（与 domain/report-spec.ts 的写入侧校验一一对应，前端不另行放宽）：
//  · 无数据 / 零分母 / 对比基数为 0 ⇒ `-`，不显示 0、∞、空白（spec 全局约束）；
//  · 比率型对比给**百分点**（pp），避免「率的增长率」这种二级歧义；其余给相对变化率；
//  · 颜色只由 `goodDirection` 决定，不影响数值与文案；持平 / 无方向 ⇒ 中性
//    （别把「持平」染成失败）。
import type { KpiPanel } from './report-spec'

/** 值：null（无数据）⇒ `-`；比率按百分比两位小数；金额带 ¥ 与千分位两位小数。 */
export function formatValue(v: number | null, format: KpiPanel['format']): string {
  if (v === null) return '-'
  if (format === 'percent') return `${(v * 100).toFixed(2)}%`
  if (format === 'currency') return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v.toLocaleString('zh-CN')
}

/**
 * 对比差值：百分比型指标给**百分点**（pp，避免「率的增长率」这种二级歧义）；
 * 其余给相对变化率。对比基数为 0 ⇒ `-`（增长率无定义，不显示 ∞）。
 */
export function formatDelta(current: number, previous: number, format: KpiPanel['format']): string {
  if (format === 'percent') {
    const d = (current - previous) * 100
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)}pp`
  }
  if (previous === 0) return '-'
  const d = ((current - previous) / previous) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

/** 颜色只由 goodDirection 决定；无方向 / 持平 ⇒ 中性（别把「持平」染成失败）。 */
export function toneOf(panel: KpiPanel, current: number, previous: number): 'success' | 'danger' | 'secondary' {
  if (panel.goodDirection === 'none' || current === previous) return 'secondary'
  const rose = current > previous
  const good = panel.goodDirection === 'up' ? rose : !rose
  return good ? 'success' : 'danger'
}
