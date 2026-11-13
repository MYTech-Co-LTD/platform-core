// index.test.tsx — 体系地图（本体图）页：KPI、搜索聚焦、点节点开抽屉、错误态。
// ECharts 在 happy-dom 里没有 canvas ⇒ mock 成假图：只记录 setOption / on，不真渲染。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
  }
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
    // 图拿到的是全量节点
    expect(lastOption().series[0]!.data).toHaveLength(4)
  })

  it('搜索：只保留命中节点 + 一跳邻居', async () => {
    m.mockImplementation(async () => json(GRAPH))
    render(<SystemMapPage />)
    await waitFor(() => expect(screen.getByText('57')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText('搜指标、业务对象或源表'), { target: { value: '净销售额' } })
    // 净销售额 + 它的两个邻居（门店、源表）；「订单数」被筛掉
    await waitFor(() => expect(screen.getByText(/3 个节点/)).toBeInTheDocument())
    expect(lastOption().series[0]!.data.map((n) => n.id)).not.toContain('metric:lemeng:retail:order_count')

    // 清空恢复全图
    fireEvent.change(screen.getByPlaceholderText('搜指标、业务对象或源表'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText(/4 个节点/)).toBeInTheDocument())
  })

  it('点节点 ⇒ 右侧抽屉给出 observations；关掉后不残留', async () => {
    m.mockImplementation(async () => json(GRAPH))
    render(<SystemMapPage />)
    await waitFor(() => expect(screen.getByText('57')).toBeInTheDocument())

    // 从图表点击回调里拿到注册的 handler，直接喂一个指标节点
    // 每次 data 变化都会重注册一次（先 off 再 on）⇒ 取最后一次，那才是拿到数据之后的
    const clickCalls = chart.on.mock.calls.filter((c) => c[0] === 'click')
    const handler = clickCalls[clickCalls.length - 1]?.[1] as (p: unknown) => void
    expect(handler).toBeTypeOf('function')
    handler({ dataType: 'node', data: { id: 'metric:lemeng:retail:net_sales' } })

    await waitFor(() => expect(screen.getByText('口径：按门店日结净额汇总')).toBeInTheDocument())
    expect(screen.getByText('近 30 天使用 12 次')).toBeInTheDocument()
    expect(screen.getByText('关联 2 条关系')).toBeInTheDocument()

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
