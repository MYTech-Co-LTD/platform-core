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
//  ③ `kpi` 的 `compare`：对比段由 `domain/report-query.ts` 的 `compareRangeOf` 算好交给 KpiCard；
//     KpiCard 只发显式合计查询。
//
// args / query body 的装配规则**不在本文件**：与 AI 文本事实包共用 `domain/report-query.ts`
// （两处各写一份，args 形状会静默漂移）。
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
import { periodRangeOf, yearAgoRangeOf } from '../../domain/report-period'
import type { DateRange } from '../../domain/report-period'
import type { DataPanel } from '../../domain/report-query'
import { chartCompareRangesOf, compareRangeOf, panelArgsOf, panelQueryBodyOf } from '../../domain/report-query'
import type { PeriodSpec, ReportSpec } from '../../domain/report-spec'
import { KpiCard } from './KpiCard'
import AiTextPanel from './AiTextPanel'
import { RichText } from '../lib/rich-text'

type Panel = ReportSpec['panels'][number]

/**
 * 服务端渲染闸（P5 Task 3）的降级占位符：观看者无权看某个面板的口径时，`published-spec`
 * 把该面板原位替换成 `{ index, denied: true }`（**不带** metricId/chart/title/args）。
 * 视为「本格无内容」：不取数、不参与筛选栏默认值、只渲染一行「无此口径权限」。
 */
interface DeniedPanel { index: number; denied: true }
type ViewPanel = Panel | DeniedPanel
const isDeniedPanel = (p: ViewPanel): p is DeniedPanel => 'denied' in p && p.denied === true

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

/** /query 的 ok 回包 → 渲染结果（字段白名单；缺省不补假值）。 */
function okResultOf(b: unknown): OkResult {
  const out = b as {
    columns?: string[]; rows?: unknown[][]; truncated?: boolean
    masking?: Record<string, string>; data_as_of?: unknown
    freshness_line?: string; total?: string | number | null
  }
  return {
    kind: 'ok',
    columns: out.columns ?? [],
    rows: out.rows ?? [],
    truncated: out.truncated === true,
    ...(out.masking !== undefined ? { masking: out.masking } : {}),
    ...(out.data_as_of !== undefined ? { data_as_of: out.data_as_of } : {}),
    ...(out.freshness_line !== undefined ? { freshness_line: out.freshness_line } : {}),
    ...(out.total !== undefined ? { total: out.total } : {}),
  }
}

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

/** 北京的日历日 / 钟点（与 query-service 的 data_as_of 同一把尺：en-CA + Asia/Shanghai）。 */
const SH_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})
const SH_TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
/** pg 回传的完整 ISO 时间戳（Z 结尾）——从字符串形态也要能认出（JSON 序列化后会丢 Date 类型）。 */
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/

/**
 * 日期维度在表格/图表上的统一展示（#1094 起，**#400 修时区口径**）：
 *   · `Date`（pg date/timestamptz 的默认回传形态）或完整 ISO 串 ⇒ 按 **Asia/Shanghai** 格式化：
 *     上海零点 ⇒ `YYYY-MM-DD`；否则 `YYYY-MM-DD HH:mm`。
 *   · 旧的「只按列名==bizday 截 UTC 日期部分」是**错的**：`date` 列经驱动解析为上海午夜时
 *     UTC ISO 落在前一天（2026-08-15 显示成 08-14T16:00Z 或反之），截 UTC 日期部分 ⇒ 差一天
 *     （#400 的真机证据）。而「取上海日历日」对两种进程时区下的解析结果都落到正确业务日。
 *   · 列名无关：任何日期型维度（day/system_book 之外的 order_day、created_at…）同享此口径。
 *   · 其它值 String 化（数字、文本维原样）。
 */
function displayValue(_column: string, v: unknown): string {
  if (v === null || v === undefined) return ''
  const d = v instanceof Date
    ? v
    : (typeof v === 'string' && ISO_TS_RE.test(v) ? new Date(v) : null)
  if (d !== null && !Number.isNaN(d.getTime())) {
    const day = SH_DATE_FMT.format(d)
    const time = SH_TIME_FMT.format(d)
    // 日期型值的两种实测解析路径都要认：进程时区 Asia/Shanghai ⇒ 上海零点（16:00Z 前一天）；
    // UTC 进程 ⇒ UTC 午夜（00:00Z）。两者都渲染成纯日期；真正的钟点值才带 HH:mm。
    const utcMidnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0
    return time === '00:00:00' || utcMidnight ? day : `${day} ${time.slice(0, 5)}`
  }
  return String(v)
}

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
interface ChartCells {
  xLabels: string[]
  seriesKeys: string[]
  cells: Map<string, number>
}

function chartCellsOf(dimensions: string[], result: OkResult): ChartCells {
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
    const x = xIdx >= 0 ? displayValue(cols[xIdx]!, row[xIdx]) : ''
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
  // #399 口径 A：x 轴按维度值**升序**（numeric 感知的 localeCompare——日期串、数字串、中文名
  // 都单调）。返回行序不可信：SQL 无 ORDER BY（LIMIT 截断后顺序未定义），乱序折线看起来与
  // 正确折线一模一样 = 「图在撒谎」。文本维的「升序」语义存疑是已知取舍——图表横轴单调成立
  // 本身是产品可辩护的默认（issue #399 方案 A）；需要自定义顺序时走 args.orderBy（方案 C，未开）。
  xLabels.sort((a, b) => a.localeCompare(b, 'zh', { numeric: true }))
  return { xLabels, seriesKeys, cells }
}

export function buildOption(
  chart: 'line' | 'bar',
  dimensions: string[],
  result: OkResult,
  compares: Array<{ label: string; result: OkResult }> = [],
): EChartsCoreOption {
  const base = chartCellsOf(dimensions, result)
  const xLabels = base.xLabels
  const bizdayX = dimensions[0] === 'bizday'
  const currentKeys = base.seriesKeys.length > 0 ? base.seriesKeys : ['']
  const series: Array<{ name: string; type: 'line' | 'bar'; data: Array<number | null> }> = []
  const hasCompare = compares.length > 0
  const nameOf = (key: string, suffix: string): string => key === '' ? suffix : `${key}·${suffix}`

  for (const key of currentKeys) {
    series.push({
      name: hasCompare ? nameOf(key, '本期') : key,
      type: chart,
      data: xLabels.map((x) => base.cells.get(`${x}\u0000${key}`) ?? null),
    })
  }
  for (const cmp of compares) {
    const other = chartCellsOf(dimensions, cmp.result)
    const keys = other.seriesKeys.length > 0 ? other.seriesKeys : ['']
    for (const key of keys) {
      if (!currentKeys.includes(key)) currentKeys.push(key)
      // 日期轴按**序号**对齐（上期/去年同期的第 n 天 ↔ 本期的第 n 天）；类别轴按值对齐。
      const data = xLabels.map((x, i) => {
        const srcX = bizdayX ? other.xLabels[i] : x
        if (srcX === undefined) return null
        return other.cells.get(`${srcX}\u0000${key}`) ?? null
      })
      series.push({ name: nameOf(key, cmp.label), type: chart, data })
    }
  }

  const multi = series.length > 1
  const baseOption = {
    // option 半边：grid 显式留白——与 EChart 容器的 overflow:hidden 是同一坑的两半。
    // 图例放底部：放顶部会压住折线/柱体（本期/上期/去年同期三系列时尤其明显）。
    grid: { ...GRID_MARGINS, bottom: multi ? 34 : GRID_MARGINS.bottom },
    tooltip: { trigger: 'axis' },
    ...(multi ? { legend: { type: 'scroll', bottom: 0, itemWidth: 10, itemHeight: 6 } } : {}),
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
        // 底部要同时容纳 45° 类目标签 + 图例。
        grid: { bottom: multi ? 64 : 24 },
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
  if (panel.chart === 'text' || panel.chart === 'kpi' || panel.chart === 'ai_text') return []
  return panel.slice?.dimensions ?? panel.dims
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
interface PanelCompare { label: string; result: OkResult }

function PanelBody({ panel, result, compares = [] }: { panel: Panel; result: PanelResult | undefined; compares?: PanelCompare[] }) {
  // text / kpi 的呈现不经过查询结果（text 是静态文本，kpi 由 KpiCard 自取合计）——
  // ReportView 的渲染分支里已把它们分流，这里只是类型收口。
  if (panel.chart === 'text') {
    // 纯文本 / 受限富文本（R3）。两者都**不**渲染 HTML：markdown 走 RichText 的 React 节点。
    return panel.format === 'markdown'
      ? <div style={{ lineHeight: 1.85 }}><RichText text={panel.content} /></div>
      : <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{panel.content}</Typography.Paragraph>
  }
  if (panel.chart === 'kpi') return null
  // ai_text：内容在**观看时**由服务端生成，不经过 /query 结果。渲染（SSE + AI 感）是
  // 计划 Task 9 的范围，本期只做类型收口——先留空，不查询、不伪造内容。
  if (panel.chart === 'ai_text') return null

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
    // table 不进 echarts（图型白名单里它是纯 DOM 呈现）；行值 String 化照原 console/query（站内问数，2026-11-12 退役）的先例。
    // 窄屏（企微内置浏览器 ~390px）：外层 overflowX:auto + scroll.x=max-content 让横向滚动
    // 收敛在卡片内部（#1047 报表页移动端实测顶破）。
    //
    // `columns` 是**渲染期投影**（设计 §7.3.1）：声明的列按序展示，返回里没有的列丢弃并
    // 显式告警（fail-visible，不静默展示全部/伪造列）；未声明 = 旧规格的「展示全部」。
    const declared = panel.columns
    const cols = declared === undefined
      ? result.columns
      : declared.filter((c) => result.columns.includes(c))
    const missing = declared?.filter((c) => !result.columns.includes(c)) ?? []
    return (
      <>
        {missing.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message={`声明的列不存在：${missing.join('、')}`}
            style={{ marginBottom: 8 }}
          />
        )}
        <div data-testid="table-scroll" style={{ overflowX: 'auto' }}>
          <Table
            size="small"
            rowKey={(_, idx) => String(idx)}
            pagination={false}
            scroll={{ x: 'max-content' }}
            columns={cols.map((c) => ({ title: c, dataIndex: c }))}
            dataSource={result.rows.map((row) =>
              Object.fromEntries(cols.map((c) =>
                [c, displayValue(c, row[result.columns.indexOf(c)])])))}
          />
        </div>
        <TrustLine result={result} />
      </>
    )
  }
  return (
    <>
      <EChart option={buildOption(panel.chart, dimsOf(panel), result, compares)} />
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

function shanghaiYesterday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - 24 * 60 * 60 * 1000))
}

/**
 * 日报的默认单日：规格里钉的日期会随发布陈旧（如 11-08 的规格在 11-10 打开）。
 * 未钉历史版本时，默认跟到「昨天」——日报数据都是 T-1，今天还没营业结束。
 */
function initialPeriodOf(p: PeriodSpec | null, pinned: boolean): PeriodSpec | null {
  if (p === null || pinned || p.mode !== 'day' || p.day === undefined) return p
  const y = shanghaiYesterday()
  return p.day < y ? { ...p, day: y } : p
}

/** 切换期间模式时的合法默认值（mode=custom 必须有 from/to，否则 periodRangeOf 会抛）。 */
function switchPeriodMode(mode: PeriodSpec['mode'], current: PeriodSpec, range: DateRange | null): PeriodSpec {
  if (mode === 'month') {
    const month = current.month
      ?? (current.from !== undefined ? current.from.slice(0, 7) : shanghaiToday().slice(0, 7))
    return { mode: 'month', month }
  }
  if (mode === 'last_7_days') return { mode: 'last_7_days' }
  if (mode === 'day') {
    return { mode: 'day', day: current.day ?? range?.to ?? shanghaiToday() }
  }
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
          { label: '单日', value: 'day' },
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
      {period.mode === 'day' && (
        <DatePicker
          size="small"
          allowClear={false}
          value={dayjs(period.day ?? shanghaiToday())}
          onChange={(d) => { if (d !== null) onChange({ mode: 'day', day: d.format('YYYY-MM-DD') }) }}
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
  reportId, title, spec, chrome, onClose, pinnedVersion, preview,
}: {
  /**
   * 报表 id：`ai_text` 的流式端点按它定位（`/reports/:id/narrative/stream`）；
   * KPI 的「计算过程」也按它定位（`/reports/:id/receipt`）。其余面板走 `/query`。
   */
  reportId: string
  title: string
  spec: ReportSpec
  chrome: 'console' | 'standalone'
  onClose?: () => void
  pinnedVersion?: number | null
  /** 草稿预览：计算凭证按草稿内容取（未发布报表只能预览，不能按快照取）。 */
  preview?: 'draft'
}) {
  const [results, setResults] = useState<Record<number, PanelResult>>({})
  const [compareResults, setCompareResults] = useState<Record<number, PanelCompare[]>>({})
  // 对比查询按面板去重（results 每完成一格都会触发对比 effect，不能重复发起）。
  const compareLoaded = useRef(new Set<string>())
  // 只有进入视口（含 300px 预取）的图表才查历史对比——首屏不再一次打 22 条。
  const compareVisible = useRef(new Set<number>())
  const [visibleTick, setVisibleTick] = useState(0)
  // 期间：规格默认值即初值；调用方按 reportId 给 ReportView 换 key ⇒ 换报自然重置。
  // 钉了历史版本时保持规格原值；否则单日默认跟到昨天（日报 T-1）。
  const [period, setPeriod] = useState<PeriodSpec | null>(
    () => initialPeriodOf(spec.period ?? null, pinnedVersion !== null && pinnedVersion !== undefined),
  )
  // 筛选栏（#1047）：defaults 从规格 args 反推（键级），override 是用户改选的值；
  // 查询时 {...panel.args, ...override}——覆盖键 ⊆ args 键，值仍走服务端授权链（见文件头）。
  const [override, setOverride] = useState<Record<string, unknown>>({})
  const [branches, setBranches] = useState<Array<{ branchNum: string; name: string }> | null>(null)

  // 观看面可能带降级占位符（`{index,denied:true}`）——类型上并入，运行期用 `isDeniedPanel` 分流。
  const panels: ViewPanel[] = spec.panels

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
  // text / ai_text 面板没有 args（schema 保证），显式跳过。
  const defaults = useMemo(() => {
    const merged: Record<string, unknown> = {}
    for (const p of panels) {
      if (isDeniedPanel(p)) continue
      if (p.chart === 'text' || p.chart === 'ai_text') continue
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
   * 共享装配规则在 `domain/report-query.ts`（panelArgsOf）——与 AI 文本事实包同源。
   * 期间窗口**最后**写入：它是规格级的当前期间，优先于面板自带的 bizday 默认值。
   * `timeScoped === false` 的面板（如字典/排行快照）不注入 bizday。
   *
   * 筛选栏的**分支**覆盖走 `panelArgsOf` 的 `branchNum`（只覆盖声明过 `branch_num` 的面板：
   * 控件只因某面板声明了该键才出现，没声明的面板不该被静默加上它从未要过的过滤参数）；
   * 其余覆盖键（period 未声明时的 bizday 区间）按键级叠加——覆盖键 ⊆ 面板 args 键由筛选栏保证，
   * 值的合法性仍由服务端 authorize 链兜底。
   */
  const argsOf = (p: DataPanel): Record<string, unknown> => {
    const branchNum = typeof override.branch_num === 'string' ? override.branch_num : undefined
    const args = panelArgsOf(p, range, branchNum)
    for (const [k, v] of Object.entries(override)) {
      if (k === 'branch_num') continue
      if (k === 'bizday' && range !== null) continue // 规格级期间窗口优先
      args[k] = v
    }
    return args
  }

  // 规格到了 ⇒ 逐面板查数据（筛选/期间变更 ⇒ 整页重查）。每面板独立落自己的 state：
  // 一个面板 denied/出错**只塌自己那格**，不拖垮整页。
  useEffect(() => {
    setResults({})
    setCompareResults({})
    compareLoaded.current.clear()
    panels.forEach((p, i) => {
      // 降级占位符 / text / ai_text 无数据面；kpi 的取数在 KpiCard 内部（显式合计），都不进这条循环
      if (isDeniedPanel(p)) return
      if (p.chart === 'text' || p.chart === 'kpi' || p.chart === 'ai_text') return
      void apiSend('/query', 'POST', panelQueryBodyOf(p, argsOf(p)))
        .then((b) => setResults((prev) => ({ ...prev, [i]: okResultOf(b) })))
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

  // 视口观察：只给「看得见」的图表查历史对比。
  useEffect(() => {
    const els = Array.from(document.querySelectorAll<HTMLElement>('[data-panel-index]'))
    const markAll = (): void => {
      panels.forEach((_, i) => compareVisible.current.add(i))
      setVisibleTick((t) => t + 1)
    }
    if (typeof IntersectionObserver === 'undefined') {
      markAll()
      return
    }
    const obs = new IntersectionObserver((entries) => {
      let changed = false
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const i = Number((e.target as HTMLElement).dataset.panelIndex)
        if (!Number.isInteger(i) || compareVisible.current.has(i)) continue
        compareVisible.current.add(i)
        changed = true
      }
      if (changed) setVisibleTick((t) => t + 1)
    }, { rootMargin: '300px' })
    els.forEach((el) => obs.observe(el))
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, period])

  /**
   * 历史对比**延后且限量**加载：先让主查询（11 格）出数，再最多 3 路并发补对比。
   * 同时发起 22 条对比查询会把 pg_duckdb 打满，首屏几十秒（2026-11-10 现场）。
   */
  useEffect(() => {
    const jobs: Array<{
      i: number
      ranges: ReturnType<typeof chartCompareRangesOf>
      panel: Extract<Panel, { chart: 'line' | 'bar' }>
    }> = []
    panels.forEach((p, i) => {
      if (isDeniedPanel(p)) return
      if (p.chart !== 'line' && p.chart !== 'bar') return
      if (results[i]?.kind !== 'ok') return
      if (!compareVisible.current.has(i)) return
      const ranges = chartCompareRangesOf(p, range, period?.mode)
      if (ranges.length === 0) return
      const sig = `${i}:${JSON.stringify(ranges)}`
      if (compareLoaded.current.has(sig)) return
      compareLoaded.current.add(sig)
      jobs.push({ i, panel: p, ranges })
    })
    if (jobs.length === 0) return
    let cancelled = false
    const run = async (): Promise<void> => {
      const queue = [...jobs]
      const worker = async (): Promise<void> => {
        for (;;) {
          const job = queue.shift()
          if (job === undefined || cancelled) return
          const list = await Promise.all(job.ranges.map(async (c) => {
            try {
              const b = await apiSend('/query', 'POST', panelQueryBodyOf(job.panel, { ...argsOf(job.panel), bizday: c.range }))
              return { label: c.label, result: okResultOf(b) }
            } catch {
              // 对比期失败不塌主图：少一条曲线。
              return null
            }
          }))
          if (cancelled) return
          const ok = list.filter((x): x is PanelCompare => x !== null)
          if (ok.length > 0) setCompareResults((prev) => ({ ...prev, [job.i]: ok }))
        }
      }
      await Promise.all([worker(), worker(), worker()])
    }
    // 让主图先完成首帧，再补历史曲线。
    const timer = setTimeout(() => { void run() }, 800)
    return () => { cancelled = true; clearTimeout(timer) }
    // argsOf/range 由 override/period 派生；results 变化只用于判断主查询完成。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panels, override, period, range, results, visibleTick])

  const showRangePicker = period === null && defaults.bizday !== undefined
  const showBranchPicker = defaults.branch_num !== undefined
  // 动态副标题（#1085）：登记标题里的门店/期间是创建时的，切门店/切期间后必须由副标题说清。
  const selectedBranchNum = typeof override.branch_num === 'string'
    ? override.branch_num
    : typeof defaults.branch_num === 'string' ? defaults.branch_num : undefined
  const selectedBranch = selectedBranchNum === undefined
    ? undefined
    : branches?.find((b) => b.branchNum === selectedBranchNum)
  const branchScope = selectedBranchNum === undefined
    ? null
    : selectedBranch === undefined
      ? `门店 ${selectedBranchNum}`
      : `门店 ${selectedBranch.name}（${selectedBranchNum}）`
  const periodScope = range === null ? null : `${range.from} ~ ${range.to}`
  // `ai_text` 的切片门店：筛选栏覆盖优先，其次规格默认——与 argsOf 的 branch 口径**同源**
  // （`panelArgsOf` 只覆盖声明过 `branch_num` 的面板；ai_text 没有 args，故这里显式取）。
  const aiBranchNum = typeof override.branch_num === 'string'
    ? override.branch_num
    : typeof defaults.branch_num === 'string' ? defaults.branch_num : undefined

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
      {(branchScope !== null || periodScope !== null) && (
        <Typography.Text
          type="secondary"
          style={{ fontSize: 12, display: 'block', marginBottom: 8 }}
          data-testid="view-scope"
        >
          当前视图：
          {[branchScope, periodScope === null ? null : `统计期间 ${periodScope}`]
            .filter((s): s is string => s !== null).join(' · ')}
        </Typography.Text>
      )}
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
          <Col key={i} span={isDeniedPanel(p) ? 12 : p.span} data-panel-index={i}>
            {isDeniedPanel(p) ? (
              // 渲染闸（P5 Task 3）：该格的口径对这个观看者不可见。**不显示**任何口径信息
              // （标题/图型/metricId 服务端已剥掉），只留一句中性说明。
              <Card size="small">
                <Alert type="warning" showIcon title="无此口径权限" />
              </Card>
            ) : p.chart === 'ai_text' ? (
              // ai_text 的正文在观看时由服务端流式生成（不进 /query、不读 spec 文案）。
              // 期间/门店/版本都是**当前观看态**：切期间即重生成，切门店即换切片。
              <Card size="small" title={<Space>{p.title}<Tag color="blue">AI</Tag></Space>}>
                <AiTextPanel
                  key={`${i}:${JSON.stringify(period)}:${aiBranchNum ?? ''}`}
                  reportId={reportId}
                  panelIndex={i}
                  focus={p.focus}
                  period={period}
                  branchNum={aiBranchNum}
                  version={pinnedVersion ?? undefined}
                />
              </Card>
            ) : p.chart === 'kpi' ? (
              // KpiCard 自带卡片与标题（与面板同款 size="small"），这里不再套第二层 Card
              // 对比段：auto 依当前期间模式（月 → 上月同日段；其余 → 等长前移）
              <KpiCard
                panel={p}
                args={argsOf(p)}
                compareRange={compareRangeOf(p, period?.mode, range)}
                yoyRange={p.compareYoY && range !== null ? yearAgoRangeOf(range) : null}
                receiptCtx={{
                  reportId,
                  panelIndex: i,
                  period,
                  ...(aiBranchNum === undefined ? {} : { branchNum: aiBranchNum }),
                  ...(pinnedVersion === null || pinnedVersion === undefined ? {} : { version: pinnedVersion }),
                  ...(preview === undefined ? {} : { preview }),
                }}
              />
            ) : (
              <Card size="small" title={p.title}>
                <PanelBody panel={p} result={results[i]} compares={compareResults[i]} />
              </Card>
            )}
          </Col>
        ))}
      </Row>
    </div>
  )
}
