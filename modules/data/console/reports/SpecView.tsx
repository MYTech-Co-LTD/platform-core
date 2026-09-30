// SpecView.tsx — 平台自绘报表的渲染器（spec §5；计划 6 Task 4）。
//
// 数据纪律（Task 1 评审转办的判据，硬要求）：
//  **只把 `panel.args` 原样转发给既有 `POST /query`，绝不解释、绝不加工**——args 的开放键名
//  （租户自定义过滤参数）安全性全押在服务端 `authorize` 那条链上（unknown_param 拒绝 +
//  保留键闸 + literal 转义）。渲染器若在这里「帮忙」加工，等于在授权链之外私开第二口径。
//  dims 是**渲染层**的透视轴（规格里声明的返回列怎么摆），不是查询参数——/query 的
//  QueryBody 只有 `{metricId, args}`（routes/query.ts），dims 不进 body。
//
// 通路纪律（spec §5 / 计划 6 裁决 5）：面板数据走既有 `POST /query`，**一个面板一次**——
// 语义裁剪、授权、按调用者身份注入主体值、逐查询落 `data.query_audit` 全部复用；
// 不造「整报表数据」端点（那会把 N 次授权/审计合并成一次）。
//
// 渲染质量归我们（spec §5「代价明写」），两条实测坑的修法落在本文件：
//  ① 多系列要**透视数据集**（buildOption）：spec §5 实测「分组数据按『过滤同组』塞进系列
//     会把多出来的点**连成一条线**」⇒ 每个系列一个 `data` 数组、`xAxis.data` 用维度值。
//  ② 画布要收 `overflow`（EChart 容器 + option.grid 显式留白）：spec §5 实测
//     「图表画布会**溢出到隔壁格子**」。
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Col, Row, Spin, Table, Typography } from 'antd'
import { init, use } from 'echarts/core'
import type { EChartsCoreOption, EChartsType } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { ApiError, apiGet, apiSend, messageOf } from '../lib/api'
import type { ReportSpec } from '../../domain/report-spec'

type Panel = ReportSpec['panels'][number]

/**
 * echarts 按需注册清单（最小集：折线/柱状 + 网格/提示/图例 + canvas 渲染器）。
 * ⚠️ 不 `import * as echarts`：全量包体积数倍于此，按需模块导入让 bundler 只留用到的
 *    chart/component/renderer（chunk 尺寸由 `pnpm --filter web build` 验收）。
 * **导出清单供机检断言**（评审 Minor ③，2026-09-30）：漏注册某 chart 时组件测试**照绿**
 * （`use` 在测试里是桩，不真装配）——注册面必须有一条不依赖真渲染的闭环（见 SpecView.test.tsx）。
 * `chart === 'table'` 不进 echarts——antd Table 直渲染（见 PanelBody）。
 */
export const ECHARTS_REGISTRY = [
  LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer,
]
use(ECHARTS_REGISTRY)

/** 一个面板的查询结局。denied 单列一类：它不是错误，是「这条口径对这个租户不可见」（spec：看不见）。 */
type PanelResult =
  | { kind: 'ok'; columns: string[]; rows: unknown[][]; truncated: boolean }
  | { kind: 'denied' }
  | { kind: 'error'; text: string }

/**
 * 透视数据集装配（spec §5 实测坑 1 的修法）。
 *
 * 形状：`dims[0]` 做 x 轴（`xAxis.data` 用维度值）、其余 dims 组合成**系列**——每个系列
 * 一个自己的 `data` 数组、按 x 对齐（缺的格子补 `null`，折线断开而不是连过去）。
 * **不要**把「过滤同组」的多出来的点直接塞进一个系列：实测会被 echarts **连成一条线**。
 */
function buildOption(panel: Panel, chart: 'line' | 'bar', result: Extract<PanelResult, { kind: 'ok' }>): EChartsCoreOption {
  const cols = result.columns
  // 声明的 dims 只有真出现在返回列里才能画（指标 groupBy 不含的维度拿不到列——丢掉，不硬画）
  const dims = panel.dims.filter((d) => cols.includes(d))
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
    // ⚠️ 先判 null/undefined 再 Number()（评审 Minor ②，2026-09-30）：`Number(null) === 0` 且
    //    finite ⇒ 裸 Number() 会把「这天没数」洗成 0 画出去（撒谎的折线）。这里跳过 ⇒ 格子
    //    落空 ⇒ series data 里是 `null`，echarts 默认**断线**（connectNulls 不开）——正确语义。
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

  return {
    // spec §5 实测坑 2 的 option 半边：grid 显式留白（containLabel 让轴标签算进留白内）——
    // 与 EChart 容器的 overflow:hidden 是同一坑的两半，缺一都会溢出到隔壁格子。
    grid: { left: 12, right: 20, top: 36, bottom: 12, containLabel: true },
    tooltip: { trigger: 'axis' },
    ...(series.length > 1 ? { legend: {} } : {}),
    xAxis: { type: 'category', data: xLabels },
    yAxis: { type: 'value' },
    series,
  }
}

/**
 * echarts 挂载点：容器 overflow:hidden + 固定高度（spec §5 实测坑 2 的容器半边）。
 *
 * effect 拆两个（评审 Minor ①，2026-09-30）：**init 只在挂载时做一次**（卸载才 dispose），
 * option 变化只走 setOption。若合成一个以 `[option]` 为依赖的 effect，option 是每次父级
 * 渲染的新对象 ⇒ **任一**兄弟面板结果到达都会把已挂图表全部 dispose+init 重来（首图最多
 * N−1 次重挂）。两个 effect 的声明顺序保证挂载时先 init 后 setOption。
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

/** 单个面板的呈现：查询未回 ⇒ Spin；denied ⇒ 人话（不拖垮整页）；table ⇒ antd Table；图 ⇒ EChart。 */
function PanelBody({ panel, result }: { panel: Panel; result: PanelResult | undefined }) {
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
    // table 不进 echarts（图型白名单三选一里它是纯 DOM 呈现）；行值 String 化照 console/query 的先例
    return (
      <>
        <Table
          size="small"
          rowKey={(_, idx) => String(idx)}
          pagination={false}
          columns={result.columns.map((c) => ({ title: c, dataIndex: c }))}
          dataSource={result.rows.map((row) =>
            Object.fromEntries(result.columns.map((c, ci) => [c, String(row[ci])])))}
        />
        {result.truncated && <Typography.Text type="secondary">结果超过单次查询上限，已截断</Typography.Text>}
      </>
    )
  }
  return <EChart option={buildOption(panel, panel.chart, result)} />
}

/**
 * 平台自绘报表视图：`GET /reports/:id/spec` 拉规格 → 逐面板 `POST /query` → 渲染。
 * 由报表页在 platform 行的「打开」上挂载（见 ./index.tsx）；Metabase 行不经过这里。
 */
export default function SpecView({ reportId, title, onClose }: { reportId: string; title: string; onClose: () => void }) {
  const [panels, setPanels] = useState<Panel[] | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [results, setResults] = useState<Record<number, PanelResult>>({})

  useEffect(() => {
    apiGet(`/reports/${reportId}/spec`)
      .then((b) => {
        // 响应还带 `version`（登记侧版本，写保护用——后续 PUT /spec 要回带）；Task 4 只读不写，
        // 先不持有。⚠️ platform 路径的响应形状与 Metabase 路径**刻意不一致**（Task 3 评审转办），
        // 别按 `{id, metabaseId, created, fingerprint, version}` 那份解析。
        const spec = (b as { spec: ReportSpec }).spec
        // 读侧最小形状闸（fail-closed）：规格在写入侧已过白名单（parseReportSpec）；这里只拦
        // 「连 panels 都不是数组」这种彻底坏的响应，不让它进渲染循环。
        if (spec === null || typeof spec !== 'object' || !Array.isArray(spec.panels)) {
          setFailed('报表规格不合法，请联系平台侧')
          return
        }
        setPanels(spec.panels)
      })
      .catch((e) => setFailed(messageOf(e)))
  }, [reportId])

  // 规格到了 ⇒ 逐面板查数据。每面板独立落自己的 state：一个面板 denied/出错**只塌自己那格**，
  // 不拖垮整页（本文件的两条验收之一）。
  useEffect(() => {
    if (panels === null) return
    panels.forEach((p, i) => {
      // ⚠️ args **原样转发**（文件头纪律）：body 只含 metricId + panel.args 逐字，别的东西都不加。
      void apiSend('/query', 'POST', { metricId: p.metricId, args: p.args })
        .then((b) => {
          const out = b as { columns: string[]; rows: unknown[][]; truncated: boolean }
          setResults((prev) => ({
            ...prev,
            [i]: { kind: 'ok', columns: out.columns ?? [], rows: out.rows ?? [], truncated: out.truncated === true },
          }))
        })
        .catch((e) => {
          // /query 的结局映射（routes/query.ts）：ok→200 / **denied→403** / error→502。
          // denied 的正文 `{status:'denied',reason}` 没有 `error` 字段 ⇒ apiSend 落成
          // `ApiError(403,'HTTP_403')`，reason 不上屏（词表外的口径连存在性都不暴露，spec 约束 3）。
          // 宿主门卫的 403（FORBIDDEN）在本页不可达：能进报表页 = 已持 data:query，/query 也只要它。
          setResults((prev) => ({
            ...prev,
            [i]: e instanceof ApiError && e.status === 403 ? { kind: 'denied' } : { kind: 'error', text: messageOf(e) },
          }))
        })
    })
  }, [panels])

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Typography.Title level={5} style={{ margin: 0 }}>{title}</Typography.Title>
        <Button size="small" onClick={onClose}>关闭</Button>
      </div>
      {failed !== null ? (
        <Alert type="error" showIcon message={failed} />
      ) : panels === null ? (
        <Spin />
      ) : (
        // 面板 span 走 antd 24 栅格（规格字段 span: 1–24，语义就是 Col 的 span）
        <Row gutter={[12, 12]}>
          {panels.map((p, i) => (
            <Col key={i} span={p.span}>
              <Card size="small" title={p.title}>
                <PanelBody panel={p} result={results[i]} />
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </div>
  )
}
