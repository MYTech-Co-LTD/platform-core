// SystemMapView — 移动端体系地图：分组列表、搜索、指标详情（observations + 链路）、深链。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api', () => ({ apiGet: vi.fn() }))
import { apiGet } from './api'
import SystemMapView from './SystemMapView'

const m = vi.mocked(apiGet)
const GRAPH = {
  health: { metricTotal: 57, entityBoundPct: 98.2, auditCoveredPct: 98.2, zeroUse: 17 },
  ontology: {
    nodes: [
      { id: 'entity:门店', type: 'entity', label: '门店', observations: ['3 个指标'] },
      { id: 'metric:lemeng:retail:net_sales', type: 'metric', label: '净销售额', observations: ['口径：按门店日结净额汇总'] },
      { id: 'metric:lemeng:retail:order_count', type: 'metric', label: '订单数', observations: ['口径：有效订单笔数'] },
    ],
    edges: [
      { from: 'metric:lemeng:retail:net_sales', to: 'entity:门店', type: 'belongs_to' },
      { from: 'metric:lemeng:retail:order_count', to: 'entity:门店', type: 'belongs_to' },
    ],
  },
}
const TRAIL = {
  steps: [
    { kind: 'metric', label: '净销售额', from: 'declared' },
    { kind: 'lake', label: 'lemeng/retail_order_line', from: 'inferred' },
  ],
  runtime: { lastRun: { status: 'ok', at: '2026-11-14T00:00:00.000Z' }, materializedAt: '2026-11-14T00:10:00.000Z', maxBizday: '2026-11-13' },
  notes: [],
}

afterEach(cleanup)

describe('移动端体系地图', () => {
  it('KPI 与「业务对象 → 指标」分组；搜索可过滤', async () => {
    m.mockImplementation(async (url: string) => {
      expect(url.startsWith('/api/modules/data/system-map')).toBe(true)
      return url.includes('/trail') ? { trail: TRAIL } : GRAPH
    })
    render(<SystemMapView />)
    await waitFor(() => expect(screen.getByText('体系地图')).toBeTruthy())
    expect(screen.getByText('57')).toBeTruthy()
    expect(screen.getByText('门店 · 2')).toBeTruthy()

    fireEvent.change(screen.getByPlaceholderText('搜索指标或口径'), { target: { value: '订单' } })
    await waitFor(() => expect(screen.queryByText('净销售额')).toBeNull())
    expect(screen.getByText('订单数')).toBeTruthy()
  })

  it('点指标 ⇒ 详情（observations + 链路），返回可回列表', async () => {
    m.mockImplementation(async (url: string) => (url.includes('/trail') ? { trail: TRAIL } : GRAPH))
    render(<SystemMapView />)
    await waitFor(() => expect(screen.getByText('净销售额')).toBeTruthy())
    fireEvent.click(screen.getByText('净销售额'))
    await waitFor(() => expect(screen.getByText('口径：按门店日结净额汇总')).toBeTruthy())
    expect(screen.getByText('lemeng/retail_order_line')).toBeTruthy()
    expect(screen.getByText(/最近一次运行/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /返回/ }))
    await waitFor(() => expect(screen.getByText('门店 · 2')).toBeTruthy())
  })

  it('深链带指标 id ⇒ 数据到达后自动打开该指标', async () => {
    m.mockImplementation(async (url: string) => (url.includes('/trail') ? { trail: TRAIL } : GRAPH))
    render(<SystemMapView focus="lemeng:retail:order_count" />)
    await waitFor(() => expect(screen.getByText('口径：有效订单笔数')).toBeTruthy())
  })
})
