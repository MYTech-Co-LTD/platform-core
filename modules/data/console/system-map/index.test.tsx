// index.test.tsx — 体系地图（本体图）页：KPI、搜索聚焦、点节点开抽屉、错误态。
// ECharts 在 happy-dom 里没有 canvas ⇒ mock 成假图：只记录 setOption / on，不真渲染。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
vi.mock('echarts/core', () => ({ init: vi.fn(() => chart), use: vi.fn() }))
vi.mock('echarts/charts', () => ({ GraphChart: {} }))
vi.mock('echarts/components', () => ({ LegendComponent: {}, TooltipComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

import { platformFetch } from '@platform/sdk/web'
import SystemMapPage from './index'

const m = vi.mocked(platformFetch)
const chart = { setOption: vi.fn(), on: vi.fn(), off: vi.fn(), resize: vi.fn() }
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const TRAIL = {
  metricId: 'lemeng:retail:net_sales',
  title: '净销售额',
  steps: [
    { kind: 'metric', label: '净销售额', detail: 'lemeng:retail:net_sales', from: 'declared' },
    { kind: 'mart', label: 'fct_retail_sale', detail: 'marts 表', from: 'declared' },
    { kind: 'staging', label: 'stg_lemeng_retail_order_line', detail: 'dbt staging 模型', from: 'declared' },
    { kind: 'lake', label: 'lemeng/retail_order_line', detail: '1 条管线写入', from: 'declared' },
    { kind: 'pipeline', label: 'lemeng.retail_order_line.l0.3120', detail: 'duckle 管线', from: 'declared' },
  ],
  runtime: { pipelineId: 'lemeng.retail_order_line.l0.3120', lastRun: { runId: 'r1', at: '2026-11-14T00:00:00.000Z', status: 'ok', durationMs: 12000 }, materializedAt: '2026-11-14T00:10:00.000Z', maxBizday: '2026-11-13' },
  notes: [],
}

const GRAPH = {
  generatedAt: '2026-11-13T00:00:00.000Z',
  health: { metricTotal: 57, entityBoundPct: 98.2, auditCoveredPct: 98.2, zeroUse: 17 },
  ontology: {
    nodes: [
      { id: 'entity:门店', type: 'entity', label: '门店', observations: ['3 个指标挂在这个对象上'] },
      { id: 'metric:lemeng:retail:net_sales', type: 'metric', label: '净销售额', observations: ['口径：按门店日结净额汇总', '近 30 天使用 12 次'] },
      { id: 'metric:lemeng:retail:order_count', type: 'metric', label: '订单数', observations: ['口径：有效订单笔数'] },
      { id: 'source:fct_retail_sale', type: 'source', label: 'fct_retail_sale', observations: ['2 个指标由它算出'] },
    ],
    edges: [
      { from: 'metric:lemeng:retail:net_sales', to: 'entity:门店', type: 'belongs_to' },
      { from: 'metric:lemeng:retail:net_sales', to: 'source:fct_retail_sale', type: 'derives_from' },
    ],
  },
  warnings: [],
}

/** 取最近一次 setOption 传进去的数据（节点/边）。 */
const lastOption = () => {
  const calls = chart.setOption.mock.calls
  return calls[calls.length - 1]?.[0] as {
    series: Array<{ data: Array<{ id: string; name: string }>; edges: unknown[] }>
  } | undefined
}

beforeEach(() => {
  m.mockReset()
  chart.setOption.mockClear()
  chart.on.mockClear()
})

afterEach(() => cleanup())

describe('体系地图·本体图', () => {
  it('拉 /system-map/graph，KPI 与节点/边计数都渲染出来', async () => {
    m.mockImplementation(async (url: string) => {
      expect(url).toContain('/system-map/graph')
      return json(GRAPH)
    })
    render(<SystemMapPage />)
    await waitFor(() => expect(screen.getByText('57')).toBeInTheDocument())
    // 实体绑定率与对账覆盖率恰好都是 98.2% ⇒ 复数断言
    expect(screen.getAllByText('98.2%')).toHaveLength(2)
    expect(screen.getByText('17')).toBeInTheDocument()
    expect(screen.getByText(/4 个节点 · 2 条关系/)).toBeInTheDocument()
    // 图拿到的是全量节点（setOption 在数据到达后的 effect 里 ⇒ 用 waitFor 等它）
    await waitFor(() => expect(lastOption()?.series[0]!.data).toHaveLength(4))
  })

  it('搜索：只保留命中节点 + 一跳邻居', async () => {
    m.mockImplementation(async () => json(GRAPH))
    render(<SystemMapPage />)
    await waitFor(() => expect(screen.getByText('57')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('搜指标、业务对象或源表'), { target: { value: '净销售额' } })
    // 净销售额 + 它的两个邻居（门店、源表）；「订单数」被筛掉
    await waitFor(() => expect(screen.getByText(/3 个节点/)).toBeInTheDocument())
    await waitFor(() => expect(lastOption()?.series[0]!.data.map((n) => n.id))
      .not.toContain('metric:lemeng:retail:order_count'))

    // 清空恢复全图
    fireEvent.change(screen.getByPlaceholderText('搜指标、业务对象或源表'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText(/4 个节点/)).toBeInTheDocument())
  })

  it('点节点 ⇒ 右侧抽屉给出 observations 与链路；关掉后不残留', async () => {
    m.mockImplementation(async (url: string) => url.includes('/trail') ? json({ trail: TRAIL }) : json(GRAPH))
    render(<SystemMapPage />)
    await waitFor(() => expect(screen.getByText('57')).toBeInTheDocument())

    // 从图表点击回调里拿到注册的 handler，直接喂一个指标节点
    // 每次 data 变化都会重注册一次（先 off 再 on）⇒ 取最后一次，那才是拿到数据之后的
    const clickCalls = chart.on.mock.calls.filter((c) => c[0] === 'click')
    const handler = clickCalls[clickCalls.length - 1]?.[1] as (p: unknown) => void
    expect(handler).toBeTypeOf('function')
    // 点击回调会触发 fetch('/trail') → setState → 抽屉渲染。包 act() 让 React 更新确定性冲刷；
    // 首次断言显式放宽到 5s：CI 负载下「点击 → 取链路 → 渲染」常超过 waitFor 默认的 1s
    // （#2177：main 上偶发 Unable to find an element，本地与重跑均通过）。
    act(() => handler({ dataType: 'node', data: { id: 'metric:lemeng:retail:net_sales' } }))

    await waitFor(() => expect(screen.getByText('口径：按门店日结净额汇总')).toBeInTheDocument(), { timeout: 5000 })
    expect(screen.getByText('近 30 天使用 12 次')).toBeInTheDocument()
    expect(screen.getByText('关联 2 条关系')).toBeInTheDocument()
    // 链路：marts → staging → 湖 → 管线，以及运行态
    await waitFor(() => expect(screen.getByText('fct_retail_sale')).toBeInTheDocument())
    expect(screen.getByText('stg_lemeng_retail_order_line')).toBeInTheDocument()
    expect(screen.getByText(/最近一次运行/)).toBeInTheDocument()
    expect(screen.getByText('数据水位：2026-11-13')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(screen.queryByText('口径：按门店日结净额汇总')).toBeNull())
  })

  it('接口失败 ⇒ 人话 + 重试，不静默空图', async () => {
    m.mockImplementation(async () => new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 }))
    render(<SystemMapPage />)
    await waitFor(() => expect(screen.getByText('你没有这个操作的权限，需要找管理员开通')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /重/ })).toBeInTheDocument()
  })
})
