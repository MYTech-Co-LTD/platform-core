// index.test.tsx — 全流程页（对象目录形态，#2691）：列表、搜索、详情抽屉、血缘跳转。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import FlowPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const OBJECTS = {
  generatedAt: '2026-11-22T13:00:00Z',
  rows: [
    { kind: 'staging', name: 'stg_lemeng_retail_order_line', domain: 'retail_order_line', upstreamCount: 1, downstreamCount: 4 },
    { kind: 'mart', name: 'fct_retail_sale', domain: 'retail_order_line', upstreamCount: 1, downstreamCount: 3 },
    { kind: 'metric', name: 'sales', domain: null, upstreamCount: 1, downstreamCount: 4 },
  ],
}

const DETAIL = {
  kind: 'mart', name: 'fct_retail_sale', domain: 'retail_order_line',
  columns: [
    { name: 'sale_amount', type: 'numeric', expr: 'round(sum(case when ...), 2)', description: '销售额' },
    { name: 'bizday', type: 'date', expr: null, description: '营业日' },
  ],
  upstream: [{ kind: 'staging', name: 'stg_lemeng_retail_order_line' }],
  downstream: [{ kind: 'metric', name: 'sales' }],
  upstream2: [{ kind: 'lake', name: 'lemeng/retail_order_line' }],
  downstream2: [],
  notes: [],
}

beforeEach(() => { m.mockReset() })
afterEach(() => cleanup())

describe('全流程页（对象目录）', () => {
  it('渲染对象列表，带类型标签与上下游计数', async () => {
    m.mockResolvedValueOnce(json(OBJECTS))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('fct_retail_sale')).toBeInTheDocument())
    expect(screen.getByText('stg_lemeng_retail_order_line')).toBeInTheDocument()
    expect(screen.getAllByText('↑1').length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('↓4').length).toBeGreaterThanOrEqual(1)
  })

  it('搜索过滤（按名称）', async () => {
    m.mockResolvedValueOnce(json(OBJECTS))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('fct_retail_sale')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('搜表名 / 指标 / 管线 / 域'), { target: { value: 'stg_' } })
    await waitFor(() => expect(screen.queryByText('fct_retail_sale')).not.toBeInTheDocument())
    expect(screen.getByText('stg_lemeng_retail_order_line')).toBeInTheDocument()
  })

  it('点行 → 打开详情并请求 kind+name；字段页显示表达式', async () => {
    m.mockResolvedValueOnce(json(OBJECTS))
    m.mockResolvedValueOnce(json(DETAIL))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('fct_retail_sale')).toBeInTheDocument())
    fireEvent.click(screen.getByText('fct_retail_sale'))
    await waitFor(() => expect(screen.getByText('sale_amount')).toBeInTheDocument())
    const url = String(m.mock.calls[1]?.[0] ?? '')
    expect(url).toContain('kind=mart')
    expect(url).toContain('name=fct_retail_sale')
    expect(screen.getByText(/round\(sum\(case when/)).toBeInTheDocument()
  })

  it('血缘页：上下游标签可点击跳转到该对象详情', async () => {
    m.mockResolvedValueOnce(json(OBJECTS))
    m.mockResolvedValueOnce(json(DETAIL))
    m.mockResolvedValueOnce(json({ ...DETAIL, kind: 'staging', name: 'stg_lemeng_retail_order_line', columns: [], upstream: [], downstream: [], upstream2: [], downstream2: [] }))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('fct_retail_sale')).toBeInTheDocument())
    fireEvent.click(screen.getByText('fct_retail_sale'))
    await waitFor(() => expect(screen.getByText('血缘')).toBeInTheDocument())
    fireEvent.click(screen.getByText('血缘'))
    await waitFor(() => expect(screen.getByText('上游 · 1 跳')).toBeInTheDocument())
    fireEvent.click(screen.getAllByText('stg_lemeng_retail_order_line')[0])
    await waitFor(() => {
      const url = String(m.mock.calls[2]?.[0] ?? '')
      expect(url).toContain('kind=staging')
      expect(url).toContain('name=stg_lemeng_retail_order_line')
    })
  })
})
