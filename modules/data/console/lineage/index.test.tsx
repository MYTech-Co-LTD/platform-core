// index.test.tsx — 数据生产线页：默认折叠骨架、点字段聚焦、反向追来源、播放、空态。
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
      { name: 'system_book', type: 'varchar', description: '账套', status: 'passthrough' },
      { name: 'bizday', type: 'date', description: '业务日', status: 'passthrough' },
      { name: 'hour', type: 'integer', description: '小时', status: 'passthrough' },
      { name: 'sale_money', type: 'numeric', description: '行金额', status: 'passthrough' },
      { name: 'state', type: 'varchar', description: '单据状态', status: 'passthrough' },
      { name: 'order_total_money', type: 'numeric', description: '整单金额', status: 'dropped' },
    ],
  },
  lake: { prefix: 'lemeng/retail_order_line', partitions: ['system_book', 'bizday', 'hour'], fileName: 'all.parquet', partitionStyle: 'hive' },
  staging: {
    model: 'stg_lemeng_retail_order_line',
    columns: [
      { name: 'system_book', description: '账套', status: 'passthrough' },
      { name: 'org', description: '主体列', status: 'added' },
      { name: 'bizday', description: '业务日', status: 'passthrough' },
      { name: 'hour', description: '小时', status: 'passthrough' },
      { name: 'sale_money', description: '行金额', status: 'passthrough' },
      { name: 'state', description: '单据状态', status: 'passthrough' },
    ],
  },
  marts: {
    model: 'fct_retail_sale',
    columns: [
      { name: 'system_book', description: '账套', status: 'passthrough' },
      { name: 'org', description: '主体列', status: 'passthrough' },
      { name: 'bizday', description: '业务日', status: 'passthrough' },
      { name: 'sale_amount', description: '销售侧金额', status: 'aggregate', inputs: ['sale_money', 'state'] },
      { name: 'net_amount', description: '净销售额', status: 'aggregate', inputs: ['sale_money', 'state'], dependsOn: ['sale_amount'] },
      { name: 'order_count', description: '订单数', status: 'aggregate', inputs: ['state'] },
    ],
  },
  notes: [],
}

const renderPage = (entry = '/console/data/lineage?metric=lemeng:retail:net_sales') =>
  render(<MemoryRouter initialEntries={[entry]}><LineagePage /></MemoryRouter>)

const pills = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.lineage-pill')]
const hiPills = (): HTMLElement[] => pills().filter((p) => p.classList.contains('is-hi'))
const hasField = (t: string): boolean => pills().some((p) => p.dataset.field === t)

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    if (url.includes('/system-map/lineage/')) return json(LINEAGE)
    return json({ metrics: [{ id: 'lemeng:retail:net_sales', title: '净销售额' }] })
  })
})
afterEach(cleanup)

describe('数据生产线', () => {
  it('四段在位；默认只露骨架（分区键 / 粒度键 / 注入列 / 度量）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    expect(screen.getByText(/湖（raw parquet）/)).toBeInTheDocument()
    expect(screen.getByText(/staging（洗净对齐）/)).toBeInTheDocument()
    expect(screen.getByText(/marts（业务成品）/)).toBeInTheDocument()
    // 骨架：分区键 + marts 粒度键
    expect(hasField('system_book')).toBe(true)
    expect(hasField('bizday')).toBe(true)
    // 非骨架列默认收起
    expect(hasField('sale_money')).toBe(false)
    expect(hasField('order_total_money')).toBe(false)
    // 注入列 / 度量在折叠态也露出来
    expect(hasField('org')).toBe(true)
    expect(hasField('net_amount')).toBe(true)
    expect(screen.getAllByText(/展开全部 \d+ 列/).length).toBeGreaterThan(0)
  })

  it('展开全部：非骨架列出现，再点收起回骨架', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    const sourceCard = document.querySelector<HTMLElement>('[data-stage-card="source"]')!
    fireEvent.click(sourceCard.querySelector('.lineage-more')!)
    await waitFor(() => expect(hasField('sale_money')).toBe(true))
    fireEvent.click(sourceCard.querySelector('.lineage-more')!)
    await waitFor(() => expect(hasField('sale_money')).toBe(false))
  })

  it('点源字段：该列与它汇入的度量高亮，并画出连线', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    const sourceCard = document.querySelector<HTMLElement>('[data-stage-card="source"]')!
    fireEvent.click(sourceCard.querySelector('.lineage-more')!)
    await waitFor(() => expect(hasField('sale_money')).toBe(true))
    fireEvent.click(pills().find((p) => p.dataset.field === 'sale_money')!)

    await waitFor(() => expect(hiPills().length).toBeGreaterThan(0))
    const names = hiPills().map((p) => p.dataset.field)
    expect(names).toEqual(expect.arrayContaining(['sale_money', 'sale_amount', 'net_amount']))
    // order_count 不吃 sale_money ⇒ 不高亮
    expect(names).not.toContain('order_count')
    await waitFor(() => expect(document.querySelectorAll('.lineage-edge').length).toBeGreaterThan(0))
  })

  it('点度量（反向）：输入列从 staging 高亮，依赖的度量也点亮', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/marts（业务成品）/)).toBeInTheDocument())
    const martCard = document.querySelector<HTMLElement>('[data-stage-card="marts"]')!
    fireEvent.click([...martCard.querySelectorAll<HTMLElement>('.lineage-pill')].find((p) => p.dataset.field === 'net_amount')!)

    await waitFor(() => expect(hiPills().length).toBeGreaterThan(0))
    const names = hiPills().map((p) => p.dataset.field)
    expect(names).toEqual(expect.arrayContaining(['net_amount', 'sale_money', 'state', 'sale_amount']))
    // 反向时源层的输入列也一起点亮
    expect(names).toEqual(expect.arrayContaining(['sale_money']))
  })

  it('键列直通：staging → marts 同名也连线（不只是聚合度量有线）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    fireEvent.click(pills().find((p) => p.dataset.field === 'bizday')!)
    await waitFor(() => expect(document.querySelectorAll('.lineage-edge[data-kind="pass"]').length).toBeGreaterThan(0))
    // bizday 是三层同名列 ⇒ 源→staging + staging→marts 各一条
    expect(document.querySelectorAll('.lineage-edge[data-kind="pass"]').length).toBe(2)
  })

  it('Esc 退出聚焦，回到折叠骨架', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/marts（业务成品）/)).toBeInTheDocument())
    fireEvent.click(pills().find((p) => p.dataset.field === 'net_amount')!)
    await waitFor(() => expect(hiPills().length).toBeGreaterThan(0))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(hiPills().length).toBe(0))
  })

  it('播放：逐段展开，最后回到折叠总览', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText(/源接口 \+ 契约/)).toBeInTheDocument())
    fireEvent.click(screen.getByText(/播放生产流程/))
    const moreOf = (stage: string): string =>
      document.querySelector<HTMLElement>(`[data-stage-card="${stage}"] .lineage-more`)?.textContent ?? ''
    await waitFor(() => expect(moreOf('marts')).toMatch(/收起/), { timeout: 8000 })
  })

  it('没带 metric ⇒ 空态提示选指标', async () => {
    renderPage('/console/data/lineage')
    await waitFor(() => expect(screen.getAllByText(/选一个指标/).length).toBeGreaterThan(0))
  })
})
