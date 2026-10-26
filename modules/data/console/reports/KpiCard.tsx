// KpiCard.tsx — 报表 KPI 卡（计划 2026-10-26 Task 6）。
//
// 语义纪律（与 domain/report-spec.ts 的写入侧校验一一对应，前端不另行放宽）：
//  · **比率 = 两个可加 L1 相除**：分子/分母各自走**显式合计**查询（`args.total === true`
//    → /query 回包 `total` 字段），**不在前端对明细行求和**——明细可能被 LIMIT 截断，
//    前端求和就是错数。写入侧已保证 kpi 的指标 `totalable === true`。
//  · **历史不足显示 `-`**：无数据 / 对比期无数据 / 零分母 / 对比基数为 0，一律 `-`，
//    不显示 0、∞、空白（spec 全局约束）。
//  · 对比段（`compareRange`）由调用方算好：`prev_period` / `prev_month` 的取法在
//    domain/report-period.ts，本组件只管「当前段 vs 对比段」。
//  · `goodDirection` 只影响**颜色**，不影响数值与文案。
import { useEffect, useState } from 'react'
import { Card, Typography } from 'antd'
import { apiSend } from '../lib/api'
import type { DateRange } from '../../domain/report-period'
import type { KpiPanel } from '../../domain/report-spec'

/** 单个指标的显式合计。回包没有 `total` 字段（不可加 / 空集为 null）⇒ 一律 null。 */
async function totalOf(metricId: string, args: Record<string, unknown>): Promise<number | null> {
  const body = await apiSend('/query', 'POST', { metricId, args: { ...args, total: true } }) as {
    total?: number | string | null
  }
  if (body.total === undefined || body.total === null) return null
  const n = Number(body.total) // pg numeric 常以字符串回来
  return Number.isFinite(n) ? n : null
}

/** KPI 值：单指标 = 合计；比率 = 分子 ÷ 分母（任一环节缺数 ⇒ null）。 */
async function valueOf(panel: KpiPanel, args: Record<string, unknown>): Promise<number | null> {
  const numerator = await totalOf(panel.metricId, args)
  if (numerator === null) return null
  if (panel.denominatorMetricId === undefined) return numerator
  const denominator = await totalOf(panel.denominatorMetricId, args)
  if (denominator === null || denominator === 0) return null
  return numerator / denominator
}

function formatValue(v: number | null, format: KpiPanel['format']): string {
  if (v === null) return '-'
  if (format === 'percent') return `${(v * 100).toFixed(2)}%`
  if (format === 'currency') return `¥${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  return v.toLocaleString('zh-CN')
}

/**
 * 对比差值：百分比型指标给**百分点**（pp，避免「率的增长率」这种二级歧义）；
 * 其余给相对变化率。对比基数为 0 ⇒ `-`（增长率无定义，不显示 ∞）。
 */
function formatDelta(current: number, previous: number, format: KpiPanel['format']): string {
  if (format === 'percent') {
    const d = (current - previous) * 100
    return `${d >= 0 ? '+' : ''}${d.toFixed(2)}pp`
  }
  if (previous === 0) return '-'
  const d = ((current - previous) / previous) * 100
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`
}

/** 颜色只由 goodDirection 决定；无方向/持平 ⇒ 中性（别把「持平」染成失败）。 */
function toneOf(panel: KpiPanel, current: number, previous: number): 'success' | 'danger' | 'secondary' {
  if (panel.goodDirection === 'none' || current === previous) return 'secondary'
  const rose = current > previous
  const good = panel.goodDirection === 'up' ? rose : !rose
  return good ? 'success' : 'danger'
}

export function KpiCard({
  panel, args, compareRange,
}: {
  panel: KpiPanel
  args: Record<string, unknown>
  compareRange: DateRange | null
}) {
  // undefined = 还没回来（渲染 …）；null = 已知没有数（渲染 -）。两者不可混：缺点面要可辨。
  const [current, setCurrent] = useState<number | null | undefined>(undefined)
  const [previous, setPrevious] = useState<number | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    setCurrent(undefined)
    setPrevious(undefined)
    async function load() {
      try {
        const cur = await valueOf(panel, args)
        if (!alive) return
        setCurrent(cur)
        if (compareRange !== null) {
          const prev = await valueOf(panel, { ...args, bizday: compareRange })
          if (alive) setPrevious(prev)
        }
      } catch {
        // denied / 上游错误与「没有数」同呈现（-）：KPI 卡不承担错误详情，
        // 面板级的错误面由同报表的 line/table 面板承担。
        if (alive) {
          setCurrent(null)
          if (compareRange !== null) setPrevious(null)
        }
      }
    }
    void load()
    return () => { alive = false }
    // args/compareRange 是每次渲染的新对象：按内容（JSON）比对，避免父级重渲染触发重查。
    // panel 的身份字段参与依赖；format/goodDirection 只影响呈现，不触发取数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.metricId, panel.denominatorMetricId, JSON.stringify(args), JSON.stringify(compareRange)])

  const delta = current === undefined || current === null || previous === undefined || previous === null
    ? '-'
    : formatDelta(current, previous, panel.format)
  const tone = current === undefined || current === null || previous === undefined || previous === null
    ? 'secondary'
    : toneOf(panel, current, previous)

  return (
    <Card size="small" title={panel.title}>
      <Typography.Title level={3} style={{ margin: 0 }} data-testid="kpi-value">
        {current === undefined ? '…' : formatValue(current, panel.format)}
      </Typography.Title>
      {compareRange !== null && (
        <Typography.Text data-testid="kpi-delta" type={tone} style={{ fontSize: 12 }}>
          {previous === undefined ? '…' : delta}
        </Typography.Text>
      )}
    </Card>
  )
}

export default KpiCard
