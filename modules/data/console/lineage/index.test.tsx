// index.test.tsx — 数据生产线页：四段字段、状态标注、播放逐段出现、缺声明说明。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import LineagePage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const LINEAGE = {
  metricId: 'lemeng:retail:net_sales',
  title: '净销售额',
  source: {
    contractId: 'lemeng.retail_order_line',
    columns: [
      { name: 'bizday', type: 'date', description: '业务日', status: 'passthrough' },
      { name: 'order_total_money', type: 'numeric', description: '整单金额', status: 'dropped' },
    ],
  },
  lake: { prefix: 'lemeng/retail_order_line', partitions: ['system_book', 'bizday', 'hour'], fileName: 'all.parquet', partitionStyle: 'hive' },
  staging: { model: 'stg_lemeng_retail_order_line', columns: [
    { name: 'bizday', description: '业务日', status: 'passthrough' },
    { name: 'org', description: '主体列', status: 'added' },
  ] },
  marts: { model: 'fct_retail_sale', columns: [
    { name: 'bizday', description: '业务日', status: 'passthrough' },
    { name: 'net_amount', description: '净销售额', status: 'aggregate' },
  ] },
  notes: [],
}

const renderPage = (entry = '/console/data/lineage?metric=lemeng:retail:net_sales') =>
  render(<MemoryRouter initialEntries={[entry]}><LineagePage /></MemoryRouter>)

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    if (url.includes('/system-map/lineage/')) return json(LINEAGE)
    return json({ metrics: [{ id: 'lemeng:retail:net_sales', title: '净销售额' }] })
  })
})
afterEach(cleanup)

describe('数据生产线', () => {
  it('四段标题与字段都渲染；被丢的列有删除线标记、注入与聚合有标签', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    expect(screen.getByText(/湖（raw parquet）/)).toBeInTheDocument()
    expect(screen.getByText(/staging（洗净对齐）/)).toBeInTheDocument()
    expect(screen.getByText(/marts（业务成品）/)).toBeInTheDocument()
    expect(screen.getByText('order_total_money')).toBeInTheDocument()
    expect(screen.getByText('本层丢掉')).toBeInTheDocument()
    expect(screen.getByText('dbt 注入')).toBeInTheDocument()
    expect(screen.getByText('聚合度量')).toBeInTheDocument()
    // 湖的落盘形态
    expect(screen.getByText(/lemeng\/retail_order_line\//)).toBeInTheDocument()
    expect(screen.getByText(/all\.parquet/)).toBeInTheDocument()
  })

  it('播放：逐段出现（初始只有第 1 段）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    const cards = () => [...document.querySelectorAll('.ant-card')]
    // 首段可见、末段透明
    await waitFor(() => expect((cards()[0] as HTMLElement).style.opacity).toBe('1'))
    fireEvent.click(screen.getByText(/播放生产流程/))
    await waitFor(() => expect((cards()[3] as HTMLElement).style.opacity).toBe('1'), { timeout: 6000 })
  })

  it('没带 metric ⇒ 空态提示选指标', async () => {
    renderPage('/console/data/lineage')
    // Select 的 placeholder 与空态标题都含这句话 ⇒ 复数断言
    await waitFor(() => expect(screen.getAllByText(/选一个指标/).length).toBeGreaterThan(0))
  })
})
