// ReportView.tsx — 平台自绘报表的**壳无关**渲染器（计划 2026-10-26 Task 6 从 SpecView 抽出）。
//
// 分工（Task 6 的边界）：
//  · `SpecView.tsx` 只剩「按 id 拉规格」的薄壳（console 内嵌用，行为与 Task 4 一致）；
//  · 本文件收全部渲染：期间控件 / KPI / 文本 / 服务端分组（slice）/ 信任信号；
//  · `chrome` 决定壳：`console` = 标题 + 关闭按钮（ProLayout 内嵌），`standalone` = 无关闭按钮
//    （Task 13 的 `/r/:id` 裸路由复用同一渲染器，本期**不**建独立页）。
//
// 数据纪律（Task 4 起就有的硬要求，抽壳时原样保留）：
//  **面板 args 只来自「规格声明 + 筛选栏覆盖」两个源头，绝不做第三种加工**——args 的开放键名
//  （租户自定义过滤参数）安全性全押在服务端 `authorize` 那条链上（unknown_param 拒绝 +
//  保留键闸 + literal/rangeLiteral 转义）。筛选栏（#1047）：覆盖键**只能是面板 args 里已存在的键**，
//  值仍是查询面的合法参数形状（{from,to} / 标量）。
//
// 本期新增的三个参数源头，各自都是**规格声明**、不是渲染器自作主张：
//  ① `period`（规格级）：把当前期间算出的 `bizday` 窗口覆盖进每个 `timeScoped !== false` 的面板；
//     无 `period` 的旧规格**一字不变**（仍是 RangePicker 覆盖 + 面板 args）。
//  ② `slice`（面板级）：服务端分组/排序/截断/合计，body 追加 `dimensions/orderBy/limit/total`；
//     无 `slice` 时不追加任何键（旧规格的 body 仍是 `{metricId, args}` 逐字节一致）。
//  ③ `kpi` 的 `compare`：对比段由 `previousRangeOf` 算好交给 KpiCard；KpiCard 只发显式合计查询。
//
// 信任信号（spec §10 + 掩码）：/query 回包的 `masking/data_as_of/freshness_line/truncated/total`
// 收进结果 state，面板页脚一行展示——**如实转述，缺席就是没有**（不编「数据新鲜」）。
//
// 渲染质量归我们（spec §5「代价明写」），实测坑的修法：
//  ① 多系列要**透视数据集**（buildOption）：每个系列一个 `data` 数组、`xAxis.data` 用维度值。
//  ② 画布要收 `overflow`（EChart 容器 + option.grid 显式留白）。
//  ③ 窄屏柱状图的类目标签要**强制全显 + 倾斜**（Task 13 走查的 390px 实测：8 个 4–5 字类目
//     默认 `interval:'auto'` 会被抽掉一半——柱还在、标签没了，读者无法把柱对齐到类目）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Col, DatePicker, Row, Segmented, Select, Space, Spin, Table, Tag, Typography } from 'antd'
import dayjs, { Dayjs } from 'dayjs'
import { init, use } from 'echarts/core'
import type { EChartsCoreOption, EChartsType } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ApiError, apiGet, apiSend, messageOf } from '../lib/api'
import { periodRangeOf, previousRangeOf } from '../../domain/report-period'
import type { DateRange } from '../../domain/report-period'
import type { KpiPanel, PeriodSpec, ReportSpec } from '../../domain/report-spec'
import { KpiCard } from './KpiCard'

type Panel = ReportSpec['panels'][number]

/**
 * echarts 按需注册清单（最小集：折线/柱状 + 网格/提示/图例 + canvas 渲染器）。
 * ⚠️ 不 `import * as echarts`：全量包体积数倍于此。
 * **导出清单供机检断言**：漏注册某 chart 时组件测试**照绿**（`use` 在测试里是桩，不真装配）
 * ——注册面必须有一条不依赖真渲染的闭环（见 SpecView.test.tsx）。
 */
export const ECHARTS_REGISTRY = [
  LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer,
]
use(ECHARTS_REGISTRY)

/** 一条查询的信任信号面（/query 回包里能出现的那几个字段；缺席 = 不展示）。 */
interface TrustSignals {
  truncated: boolean
  masking?: Record<string, string>
  data_as_of?: unknown
  freshness_line?: string
  total?: string | number | null
}

/** 一个面板的查询结局。denied 单列一类：它不是错误，是「这条口径对这个租户不可见」（spec：看不见）。 */
type PanelResult =
  | ({ kind: 'ok'; columns: string[]; rows: unknown[][] } & TrustSignals)
  | { kind: 'denied' }
  | { kind: 'error'; text: string }

type OkResult = Extract<PanelResult, { kind: 'ok' }>

/**
 * 窄屏柱状图的类目轴策略（Task 13 走查的 390px 实测 + 真机截图校验）。
 *
 * 症状：8 个 4–5 字类目标签在 ~340px 宽的画布里，echarts 默认 `interval:'auto'` 直接**抽掉
 * 一半标签**（柱还在、标签没了）——类目轴的可读性归零；标签更长的口径则相邻重叠。
 * 修法（只对柱状图，折线不碰）：窄容器下 `interval: 0` 强制全显、45° 倾斜排开、
 * `overflow:'truncate'` + `width` 兜住超长类目（完整名仍在 tooltip 的 axis 值里）。
 *
 * 用 echarts 原生 `media` 查询（按**容器宽度**求值，resize/竖屏切换自动重算）而不是在 JS 里
 * 量宽度：宽屏不命中 ⇒ 桌面视觉与改动前逐像素一致。`containLabel: true` 已把倾斜标签算进
 * grid 外沿（实测不裁切），`bottom` 只是再留一点呼吸位。
 */
const NARROW_BAR_MAX_WIDTH = 520
const NARROW_BAR_AXIS_LABEL = { interval: 0, rotate: 45, fontSize: 11, overflow: 'truncate', width: 84 } as const
/** 画布留白（宽窄屏共用；窄屏媒体查询只把 bottom 再抬一点，给倾斜标签呼吸位）。 */
const GRID_MARGINS = { left: 12, right: 20, top: 36, bottom: 12, containLabel: true } as const

/**
 * 透视数据集装配（spec §5 实测坑 1 的修法）。
 *
 * 形状：`dims[0]` 做 x 轴（`xAxis.data` 用维度值）、其余 dims 组合成**系列**——每个系列
 * 一个自己的 `data` 数组、按 x 对齐（缺的格子补 `null`，折线断开而不是连过去）。
 * **不要**把「过滤同组」的多出来的点直接塞进一个系列：实测会被 echarts **连成一条线**。
 *
 * `dimensions` 是**渲染轴声明**：无 slice 时 = 面板 `dims`；有 slice 时 = 服务端分组维度
 * （`slice.dimensions`）——两者都来自规格，渲染器只是照抄。
 */
function buildOption(chart: 'line' | 'bar', dimensions: string[], result: OkResult): EChartsCoreOption {
  const cols = result.columns
  // 声明的维度只有真出现在返回列里才能画（服务端分组不含的维度拿不到列——丢掉，不硬画）
  const dims = dimensions.filter((d) => cols.includes(d))
  // 度量列：语义编译器固定别名 `value`；兜底取第一个非维度列
  const valueCol = cols.includes('value') ? 'value' : cols.find((c) => !dims.includes(c)) ?? cols[0]
  const valueIdx = cols.indexOf(valueCol)

  const xIdx = dims.length > 0 ? cols.indexOf(dims[0]) : -1
  const seriesDims = dims.slice(1)
  const xLabels: string[] = []
  const seriesKeys: string[] = []
  // 同一 (x, 系列) 多行 ⇒ 求和：声明 dims 少于指标 groupBy 时会出现（这些值本来就是 sum 出来的度量）
  const cells = new Map<string, number>()
  for (const row of result.rows) {
    const x = xIdx >= 0 ? String(row[xIdx]) : ''
    if (!xLabels.includes(x)) xLabels.push(x)
    const seriesKey = seriesDims.map((d) => String(row[cols.indexOf(d)])).join('/')
    if (seriesDims.length > 0 && !seriesKeys.includes(seriesKey)) seriesKeys.push(seriesKey)
    // ⚠️ 先判 null/undefined 再 Number()：`Number(null) === 0` 且 finite ⇒ 裸 Number() 会把
    //    「这天没数」洗成 0 画出去（撒谎的折线）。跳过 ⇒ series data 里是 `null`，
    //    echarts 默认**断线**（connectNulls 不开）——正确语义。
    const raw = row[valueIdx]
    if (raw === null || raw === undefined) continue
    const num = Number(raw)
    if (!Number.isFinite(num)) continue // 非数值行画不了（table 路径不受影响，原始值仍可见）
    const key = `${x}\u0000${seriesKey}`
    cells.set(key, (cells.get(key) ?? 0) + num)
  }

  const series = (seriesKeys.length > 0 ? seriesKeys : ['']).map((seriesKey) => ({
    name: seriesKey,
    type: chart,
    data: xLabels.map((x) => cells.get(`${x}\u0000${seriesKey}`) ?? null),
  }))

  const baseOption = {
    // option 半边：grid 显式留白——与 EChart 容器的 overflow:hidden 是同一坑的两半。
    grid: GRID_MARGINS,
    tooltip: { trigger: 'axis' },
    ...(series.length > 1 ? { legend: {} } : {}),
    xAxis: { type: 'category', data: xLabels },
    yAxis: { type: 'value' },
    series,
  }
  // 折线图的 x 轴是连续时间轴、标签天然稀疏——**一字不动**（走查只发现柱状图的重叠/抽稀）。
  if (chart === 'line') return baseOption
  // 柱状图：用 echarts 原生 media 查询按**容器宽度**自适应（resize / 竖屏切换自动重算）——
  // 不在 JS 里量宽度，也不用 ResizeObserver。窄屏下强制全显 + 45° 倾斜 + 超长截断；
  // 宽屏（桌面 console）仍是原来的水平标签，媒体查询不命中 ⇒ 视觉零变化。
  return {
    baseOption,
    media: [{
      query: { maxWidth: NARROW_BAR_MAX_WIDTH },
      option: {
        grid: { bottom: 24 },
        xAxis: { axisLabel: NARROW_BAR_AXIS_LABEL },
      },
    }],
  }
}

/**
 * echarts 挂载点：容器 overflow:hidden + 固定高度（spec §5 实测坑 2 的容器半边）。
 *
 * effect 拆两个：**init 只在挂载时做一次**（卸载才 dispose），option 变化只走 setOption。
 * 若合成一个以 `[option]` 为依赖的 effect，option 是每次父级渲染的新对象 ⇒ **任一**兄弟面板
 * 结果到达都会把已挂图表全部 dispose+init 重来。
 */
function EChart({ option }: { option: EChartsCoreOption }) {
  const ref = useRef<HTMLDivElement>(null)
  const chartRef = useRef<EChartsType | null>(null)
  useEffect(() => {
    if (ref.current === null) return
    const chart = init(ref.current)
    chartRef.current = chart
    const onResize = () => chart.resize()
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.dispose()
      chartRef.current = null
    }
  }, [])
  useEffect(() => {
    chartRef.current?.setOption(option)
  }, [option])
  return <div ref={ref} style={{ width: '100%', height: 280, overflow: 'hidden' }} />
}

/** 渲染轴：有 slice 时以服务端分组维度为准，否则用面板声明的 dims（两者都是规格声明）。 */
function dimsOf(panel: Panel): string[] {
  if (panel.chart === 'text' || panel.chart === 'kpi') return []
  return panel.slice?.dimensions ?? panel.dims
}

/**
 * 查询 body：`{metricId, args}` +（**仅有 slice 时**）服务端分组参数。
 *
 * 无 slice ⇒ **不加任何键**：旧规格（90% 的存量报表）的 body 与 Task 4 逐字节一致，
 * 也避免把「没要求分组」静默变成 `dimensions: []`（那是**显式合计**形态，语义完全不同）。
 * `dimensions` 的回退顺序 = 规格的 slice.dimensions → 面板 dims；两者都空时**不发**
 * （空数组 = 显式合计，不能由「没声明维度」推出来）。
 */
function queryBodyOf(panel: Exclude<Panel, { chart: 'text' | 'kpi' }>, args: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { metricId: panel.metricId, args }
  const slice = panel.slice
  if (slice === undefined) return body
  const dims = slice.dimensions ?? panel.dims
  if (slice.dimensions !== undefined || dims.length > 0) body.dimensions = dims
  if (slice.orderBy !== undefined) body.orderBy = slice.orderBy
  if (slice.limit !== undefined) body.limit = slice.limit
  if (slice.total !== undefined) body.total = slice.total
  return body
}

/**
 * 信任信号页脚（一行）：截断 / 脱敏列 / 新鲜度 / 合计。
 * 纪律：**只转述回包里真有的字段**——`data_as_of` 缺席时不写「数据实时」（未知 ≠ 新鲜）。
 */
function TrustLine({ result }: { result: OkResult }) {
  const parts: string[] = []
  if (result.truncated) parts.push('结果超过单次查询上限，已截断')
  if (result.masking !== undefined) {
    const cols = Object.keys(result.masking)
    if (cols.length > 0) parts.push(`含脱敏列：${cols.join('、')}`)
  }
  if (result.freshness_line !== undefined) parts.push(result.freshness_line)
  else if (result.data_as_of !== undefined && result.data_as_of !== null) parts.push(`数据截止 ${String(result.data_as_of)}`)
  if (result.total !== undefined) parts.push(`合计 ${String(result.total)}`)
  if (parts.length === 0) return null
  return (
    <div data-testid="trust-line" style={{ marginTop: 4 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>{parts.join(' · ')}</Typography.Text>
    </div>
  )
}

/** 单个面板的呈现：查询未回 ⇒ Spin；denied ⇒ 人话（不拖垮整页）；table ⇒ antd Table；图 ⇒ EChart。 */
function PanelBody({ panel, result }: { panel: Panel; result: PanelResult | undefined }) {
  // text / kpi 的呈现不经过查询结果（text 是静态文本，kpi 由 KpiCard 自取合计）——
  // ReportView 的渲染分支里已把它们分流，这里只是类型收口。
  if (panel.chart === 'text') {
    // 纯文本，**不**渲染 HTML（content 来自 spec，写侧已限长；渲染侧仍按纯文本对待）
    return <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{panel.content}</Typography.Paragraph>
  }
  if (panel.chart === 'kpi') return null

  if (result === undefined) return <Spin size="small" />
  if (result.kind === 'denied') {
    return (
      <Alert
        type="warning"
        showIcon
        message="这条口径当前不可用"
        description={<Typography.Text type="secondary">{panel.metricId}</Typography.Text>}
      />
    )
  }
  if (result.kind === 'error') return <Alert type="error" showIcon message={result.text} />
  if (panel.chart === 'table') {
    // table 不进 echarts（图型白名单里它是纯 DOM 呈现）；行值 String 化照 console/query 的先例。
    // 窄屏（企微内置浏览器 ~390px）：外层 overflowX:auto + scroll.x=max-content 让横向滚动
    // 收敛在卡片内部（#1047 报表页移动端实测顶破）。
    return (
      <>
        <div data-testid="table-scroll" style={{ overflowX: 'auto' }}>
          <Table
            size="small"
            rowKey={(_, idx) => String(idx)}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={result.columns.map((c) => ({ title: c, dataIndex: c }))}
            dataSource={result.rows.map((row) =>
              Object.fromEntries(result.columns.map((c, ci) => [c, String(row[ci])])))}
          />
        </div>
        <TrustLine result={result} />
      </>
    )
  }
  return (
    <>
      <EChart option={buildOption(panel.chart, dimsOf(panel), result)} />
      <TrustLine result={result} />
    </>
  )
}

/** 上海「今天」：宿主容器时区不可依赖，业务日一律上海日（与 domain/report-period.ts 同口径）。 */
function shanghaiToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date())
}

/** 切换期间模式时的合法默认值（mode=custom 必须有 from/to，否则 periodRangeOf 会抛）。 */
function switchPeriodMode(mode: PeriodSpec['mode'], current: PeriodSpec, range: DateRange | null): PeriodSpec {
  if (mode === 'month') {
    const month = current.month
      ?? (current.from !== undefined ? current.from.slice(0, 7) : shanghaiToday().slice(0, 7))
    return { mode: 'month', month }
  }
  if (mode === 'last_7_days') return { mode: 'last_7_days' }
  // 自定义：把「当前生效的窗口」预填成可编辑值（不凭空造日期）
  return { mode: 'custom', from: range?.from ?? shanghaiToday(), to: range?.to ?? shanghaiToday() }
}

/**
 * 期间控件：规格声明了 `period` 才出现（旧规格走 RangePicker 分支，行为不变）。
 * 三档模式 = 服务端 schema 的三种枚举；月份选择器与自定义区间按模式切换。
 */
function PeriodBar({ period, range, onChange }: { period: PeriodSpec; range: DateRange | null; onChange: (p: PeriodSpec) => void }) {
  return (
    <div data-testid="period-bar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
      <Segmented
        size="small"
        value={period.mode}
        onChange={(v) => onChange(switchPeriodMode(v as PeriodSpec['mode'], period, range))}
        options={[
          { label: '本月', value: 'month' },
          { label: '近 7 天', value: 'last_7_days' },
          { label: '自定义', value: 'custom' },
        ]}
      />
      {period.mode === 'month' && (
        <DatePicker
          size="small"
          picker="month"
          allowClear={false}
          value={dayjs(`${period.month ?? shanghaiToday().slice(0, 7)}-01`)}
          onChange={(d) => { if (d !== null) onChange({ mode: 'month', month: d.format('YYYY-MM') }) }}
        />
      )}
      {period.mode === 'custom' && period.from !== undefined && period.to !== undefined && (
        <DatePicker.RangePicker
          size="small"
          allowClear={false}
          value={[dayjs(period.from), dayjs(period.to)]}
          onChange={(_, strs) => {
            if (strs[0] !== '' && strs[1] !== '') onChange({ mode: 'custom', from: strs[0], to: strs[1] })
          }}
        />
      )}
    </div>
  )
}

/** 筛选栏的 RangePicker 取值：override 优先，回落规格默认。形状坏（非 {from,to}）⇒ null（不受控）。 */
function rangePickerValue(override: Record<string, unknown>, defaults: Record<string, unknown>) {
  const v = (override.bizday ?? defaults.bizday) as { from?: unknown; to?: unknown } | undefined
  if (v === null || typeof v !== 'object' || typeof v.from !== 'string' || typeof v.to !== 'string') return null
  const f = dayjs(v.from)
  const t = dayjs(v.to)
  return f.isValid() && t.isValid() ? ([f, t] as [Dayjs, Dayjs]) : null
}

/**
 * 报表渲染器（壳无关）。`spec` 已由调用方按 `parseReportSpec` 的白名单写入侧校验过，
 * 读侧的「最小形状」闸（panels 不是数组）由加载壳（`./SpecView.tsx` / 独立页）负责——
 * 本组件只认已过闸的 `ReportSpec`。
 */
export default function ReportView({
  title, spec, chrome, onClose, pinnedVersion,
}: {
  title: string
  spec: ReportSpec
  chrome: 'console' | 'standalone'
  onClose?: () => void
  pinnedVersion?: number | null
}) {
  const [results, setResults] = useState<Record<number, PanelResult>>({})
  // 期间：规格默认值即初值；调用方按 reportId 给 ReportView 换 key ⇒ 换报自然重置。
  const [period, setPeriod] = useState<PeriodSpec | null>(spec.period ?? null)
  // 筛选栏（#1047）：defaults 从规格 args 反推（键级），override 是用户改选的值；
  // 查询时 {...panel.args, ...override}——覆盖键 ⊆ args 键，值仍走服务端授权链（见文件头）。
  const [override, setOverride] = useState<Record<string, unknown>>({})
  const [branches, setBranches] = useState<Array<{ branchNum: string; name: string }> | null>(null)

  const panels = spec.panels

  // 期间 → 具体日期段（custom 形态写侧已校验 from<=to；坏规格兜底成「无期间」而不是崩页）。
  const range = useMemo<DateRange | null>(() => {
    if (period === null) return null
    try {
      return periodRangeOf(period, new Date())
    } catch {
      return null
    }
  }, [period])

  // 筛选栏默认值：键级合并（任何面板出现过的参数键都给控件；值取首个面板的）。
  // text 面板没有 args（schema 保证），显式跳过。
  const defaults = useMemo(() => {
    const merged: Record<string, unknown> = {}
    for (const p of panels) {
      if (p.chart === 'text') continue
      for (const [k, v] of Object.entries(p.args ?? {})) {
        if (!(k in merged)) merged[k] = v
      }
    }
    return merged
  }, [panels])

  const systemBook = typeof defaults.system_book === 'string' ? defaults.system_book : null

  // 门店下拉：规格 args 带 system_book 才拉（拉不到不挡页面——筛选是辅助，非必需）
  useEffect(() => {
    if (systemBook === null || systemBook === '') return
    let alive = true
    apiGet(`/branches?system_book=${encodeURIComponent(systemBook)}`)
      .then((bb) => { if (alive) setBranches((bb as { branches: Array<{ branchNum: string; name: string }> }).branches) })
      .catch(() => { if (alive) setBranches([]) })
    return () => { alive = false }
  }, [systemBook])

  /**
   * 面板 args 的唯一装配点（文件头「两个源头」）：规格 args + 筛选覆盖 + 期间窗口。
   * 期间窗口**最后**写入：它是规格级的当前期间，优先于面板自带的 bizday 默认值。
   * `timeScoped === false` 的面板（如字典/排行快照）不注入 bizday。
   */
  const argsOf = (p: Exclude<Panel, { chart: 'text' }>): Record<string, unknown> => {
    const args: Record<string, unknown> = { ...(p.args ?? {}), ...override }
    if (range !== null && p.timeScoped !== false) args.bizday = range
    return args
  }

  // 规格到了 ⇒ 逐面板查数据（筛选/期间变更 ⇒ 整页重查）。每面板独立落自己的 state：
  // 一个面板 denied/出错**只塌自己那格**，不拖垮整页。
  useEffect(() => {
    setResults({})
    panels.forEach((p, i) => {
      // text 无数据面；kpi 的取数在 KpiCard 内部（显式合计），都不进这条循环
      if (p.chart === 'text' || p.chart === 'kpi') return
      void apiSend('/query', 'POST', queryBodyOf(p, argsOf(p)))
        .then((b) => {
          const out = b as {
            columns?: string[]; rows?: unknown[][]; truncated?: boolean
            masking?: Record<string, string>; data_as_of?: unknown
            freshness_line?: string; total?: string | number | null
          }
          setResults((prev) => ({
            ...prev,
            [i]: {
              kind: 'ok',
              columns: out.columns ?? [],
              rows: out.rows ?? [],
              truncated: out.truncated === true,
              ...(out.masking !== undefined ? { masking: out.masking } : {}),
              ...(out.data_as_of !== undefined ? { data_as_of: out.data_as_of } : {}),
              ...(out.freshness_line !== undefined ? { freshness_line: out.freshness_line } : {}),
              ...(out.total !== undefined ? { total: out.total } : {}),
            },
          }))
        })
        .catch((e) => {
          // /query 的结局映射（routes/query.ts）：ok→200 / **denied→403** / error→502。
          // denied 的正文 `{status:'denied',reason}` 没有 `error` 字段 ⇒ apiSend 落成
          // `ApiError(403,'HTTP_403')`，reason 不上屏（词表外的口径连存在性都不暴露）。
          setResults((prev) => ({
            ...prev,
            [i]: e instanceof ApiError && e.status === 403 ? { kind: 'denied' } : { kind: 'error', text: messageOf(e) },
          }))
        })
    })
    // argsOf/range 都由 panels/override/period 派生 ⇒ 依赖里给这三者即可（避免每渲染重查）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, override, period])

  /** KPI 的对比段：auto 依当前期间模式（月 → 上月同日段；其余 → 等长前移）。 */
  const compareRangeOf = (p: KpiPanel): DateRange | null => {
    if (range === null || p.compare === 'none') return null
    const mode = p.compare === 'auto' ? (period?.mode === 'month' ? 'prev_month' : 'prev_period') : p.compare
    return previousRangeOf(range, mode)
  }

  const showRangePicker = period === null && defaults.bizday !== undefined
  const showBranchPicker = defaults.branch_num !== undefined

  return (
    <div style={chrome === 'standalone' ? { padding: 12 } : undefined}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Space align="center" size={8}>
          <Typography.Title level={5} style={{ margin: 0 }}>{title}</Typography.Title>
          {chrome === 'standalone' && pinnedVersion !== null && pinnedVersion !== undefined && (
            <Tag color="blue">历史版本 v{pinnedVersion}</Tag>
          )}
        </Space>
        {chrome === 'console' && onClose !== undefined && <Button size="small" onClick={onClose}>关闭</Button>}
      </div>
      {period !== null && <PeriodBar period={period} range={range} onChange={setPeriod} />}
      {/* 筛选栏（#1047）：只为规格 args 里出现过的参数键出控件；改选即重查（override）。
          period 声明后 bizday 归期间控件管，这里不再出 RangePicker（避免两个口径同屏）。
          窄屏换行（flexWrap），控件全部 small 档。 */}
      {(showRangePicker || showBranchPicker) && (
        <div data-testid="spec-filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          {showRangePicker && (
            <DatePicker.RangePicker
              size="small"
              value={rangePickerValue(override, defaults)}
              allowClear={false}
              onChange={(_, strs) => {
                if (strs[0] !== '' && strs[1] !== '') {
                  setOverride((o) => ({ ...o, bizday: { from: strs[0], to: strs[1] } }))
                }
              }}
            />
          )}
          {showBranchPicker && (
            <span data-testid="branch-filter">
              <Select
                size="small"
                style={{ minWidth: 200 }}
                showSearch
                optionFilterProp="label"
                loading={branches === null}
                value={String(override.branch_num ?? defaults.branch_num)}
                options={(branches ?? []).map((b) => ({ value: b.branchNum, label: `${b.branchNum} · ${b.name}` }))}
                onChange={(v) => setOverride((o) => ({ ...o, branch_num: v }))}
              />
            </span>
          )}
        </div>
      )}
      <Row gutter={[12, 12]}>
        {panels.map((p, i) => (
          <Col key={i} span={p.span}>
            {p.chart === 'kpi' ? (
              // KpiCard 自带卡片与标题（与面板同款 size="small"），这里不再套第二层 Card
              <KpiCard panel={p} args={argsOf(p)} compareRange={compareRangeOf(p)} />
            ) : (
              <Card size="small" title={p.title}>
                <PanelBody panel={p} result={results[i]} />
              </Card>
            )}
          </Col>
        ))}
      </Row>
    </div>
  )
}
