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
//  · 值与差值的格式化 / 颜色语义在 domain/report-format.ts（AI 文本事实包与模板共用同一套，
//    两处数字文案才逐字一致）；本组件只管取数与呈现。
import { useEffect, useState } from 'react'
import { Card, Typography } from 'antd'
import { apiSend } from '../lib/api'
import type { DateRange } from '../../domain/report-period'
import {
  comparisonCovered, coverageOfQueryResult, coverageQueryBodyOf, type CoverageInfo,
} from '../../domain/report-query'
import { formatDelta, formatValue, toneOf } from '../../domain/report-format'
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

/**
 * 指标的数据覆盖（issue #1078）：最早有数日 + 水位。走 `/query` 的明细形态
 * （`orderBy bizday asc` + `limit 1`），同一授权/掩码/审计通道；探测失败 ⇒ null。
 *
 * 缓存（#1093）：一张报表 8 张 KPI 会复用同一批指标（销售额/订单数各被多张卡使用），
 * 每卡各探一次会把首屏请求翻倍。60s TTL + in-flight 去重；**失败不缓存**（下次重试）。
 */
const COVERAGE_TTL_MS = 60_000
const coverageCache = new Map<string, { at: number; value: Promise<CoverageInfo | null> }>()

/** 测试钩子：清空覆盖探测缓存（用例之间 mock 结果不同）。 */
export function resetCoverageCache(): void {
  coverageCache.clear()
}

async function coverageOf(metricId: string, args: Record<string, unknown>): Promise<CoverageInfo | null> {
  const body = coverageQueryBodyOf(metricId, args)
  const key = JSON.stringify(body)
  const hit = coverageCache.get(key)
  if (hit !== undefined && Date.now() - hit.at < COVERAGE_TTL_MS) return hit.value
  const value = (async (): Promise<CoverageInfo | null> => {
    try {
      return coverageOfQueryResult(await apiSend('/query', 'POST', body))
    } catch {
      // 探测失败与「覆盖未知」同呈现：不出对比（宁可不出，不出假数）。
      return null
    }
  })().then((v) => {
    if (v === null) coverageCache.delete(key)
    return v
  })
  coverageCache.set(key, { at: Date.now(), value })
  return value
}

export function KpiCard({
  panel, args, compareRange, yoyRange = null,
}: {
  panel: KpiPanel
  args: Record<string, unknown>
  compareRange: DateRange | null
  /** 去年同期区间（同比）；null = 不展示同比。 */
  yoyRange?: DateRange | null
}) {
  // undefined = 还没回来（渲染 …）；null = 已知没有数（渲染 -）。两者不可混：缺点面要可辨。
  const [current, setCurrent] = useState<number | null | undefined>(undefined)
  const [previous, setPrevious] = useState<number | null | undefined>(undefined)
  const [yoy, setYoy] = useState<number | null | undefined>(undefined)
  // `-` 的原因（#1085）：覆盖不足 / 覆盖未知 / 对比期无数据，别让用户以为坏了。
  const [compareNote, setCompareNote] = useState<string | null>(null)
  const [yoyNote, setYoyNote] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setCurrent(undefined)
    setPrevious(undefined)
    setYoy(undefined)
    setCompareNote(null)
    setYoyNote(null)
    /** 取一个对比区间的值；整段落在覆盖内才返回数（否则 note 说明原因）。 */
    async function baselineOf(range: DateRange, label: string): Promise<{ value: number | null; note: string | null }> {
      const [cov, denCov] = await Promise.all([
        coverageOf(panel.metricId, args),
        panel.denominatorMetricId === undefined
          ? Promise.resolve<CoverageInfo | null>(null)
          : coverageOf(panel.denominatorMetricId, args),
      ])
      const numCovered = comparisonCovered(range, cov)
      const denCovered = panel.denominatorMetricId === undefined || comparisonCovered(range, denCov)
      if (!numCovered || !denCovered) {
        const unknown = cov === null || (panel.denominatorMetricId !== undefined && denCov === null)
        const from = !numCovered ? cov?.from : denCov?.from
        return {
          value: null,
          note: unknown
            ? `对比期数据覆盖未知，暂不展示${label}`
            : from === undefined
              ? `对比期数据覆盖不足，暂不展示${label}`
              : `对比期数据覆盖不足（数据自 ${from} 起）`,
        }
      }
      const value = await valueOf(panel, { ...args, bizday: range })
      return { value, note: value === null ? '对比期无数据或基数无定义' : null }
    }
    async function load() {
      try {
        const cur = await valueOf(panel, args)
        if (!alive) return
        setCurrent(cur)
        if (compareRange !== null) {
          const prev = await baselineOf(compareRange, '环比')
          if (!alive) return
          setPrevious(prev.value)
          setCompareNote(prev.note)
        }
        if (yoyRange !== null) {
          const y = await baselineOf(yoyRange, '同比')
          if (!alive) return
          setYoy(y.value)
          setYoyNote(y.note)
        }
      } catch {
        // denied / 上游错误与「没有数」同呈现（-）：KPI 卡不承担错误详情，
        // 面板级的错误面由同报表的 line/table 面板承担。
        if (alive) {
          setCurrent(null)
          if (compareRange !== null) setPrevious(null)
          if (yoyRange !== null) setYoy(null)
        }
      }
    }
    void load()
    return () => { alive = false }
    // args/compareRange 是每次渲染的新对象：按内容（JSON）比对，避免父级重渲染触发重查。
    // panel 的身份字段参与依赖；format/goodDirection 只影响呈现，不触发取数。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel.metricId, panel.denominatorMetricId, JSON.stringify(args), JSON.stringify(compareRange), JSON.stringify(yoyRange)])

  const deltaOf = (v: number | null | undefined): string =>
    current === undefined || current === null || v === undefined || v === null
      ? '-'
      : formatDelta(current, v, panel.format)
  const toneOfValue = (v: number | null | undefined): 'secondary' | 'success' | 'danger' =>
    current === undefined || current === null || v === undefined || v === null
      ? 'secondary'
      : toneOf(panel, current, v)

  return (
    <Card size="small" title={panel.title}>
      <Typography.Title level={3} style={{ margin: 0 }} data-testid="kpi-value">
        {current === undefined ? '…' : formatValue(current, panel.format)}
      </Typography.Title>
      {compareRange !== null && (
        <div>
          <Typography.Text
            data-testid="kpi-delta"
            type={toneOfValue(previous)}
            style={{ fontSize: 12 }}
            title={compareNote ?? undefined}
          >
            环比 {previous === undefined ? '…' : deltaOf(previous)}
          </Typography.Text>
        </div>
      )}
      {yoyRange !== null && (
        <div>
          <Typography.Text
            data-testid="kpi-yoy"
            type={toneOfValue(yoy)}
            style={{ fontSize: 12 }}
            title={yoyNote ?? undefined}
          >
            同比 {yoy === undefined ? '…' : deltaOf(yoy)}
          </Typography.Text>
        </div>
      )}
    </Card>
  )
}

export default KpiCard
