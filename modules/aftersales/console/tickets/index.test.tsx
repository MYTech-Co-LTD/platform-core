// tickets/index.test.tsx — 工单列表：渲染、status 筛选、服务端真分页（用响应里的 total）
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import TicketsPage from './index'

const m = vi.mocked(platformFetch)
const urls: string[] = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 一页两条；total=5 ⇒ 分页控件应出现「共 5 条」 */
function page(items: unknown[]): Response {
  return json({ items, total: 5, page: 1, size: 20 })
}

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  code: `T-${id}`,
  product_id: 1,
  product_name: '苹果',
  store_id: 1,
  store_name: '一号店',
  damage_quantity: 2,
  status: 'pending',
  amount_type: null,
  amount_minor: null,
  refund_ratio: null,
  operator: null,
  remark: null,
  related_order: null,
  created_at: '2026-09-16T00:00:00Z',
  processed_at: null,
  ...over,
})

beforeEach(() => {
  urls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    urls.push(url)
    return page([row(1), row(2)])
  })
})
afterEach(cleanup)

describe('工单列表', () => {
  it('渲染列表行与「共 N 条」（total 来自服务端）', async () => {
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-1')).toBeInTheDocument())
    expect(screen.getByText('T-2')).toBeInTheDocument()
    expect(screen.getByText(/共 5 条/)).toBeInTheDocument()
  })

  it('首次请求带 page/size；已处理工单显示金额（分→元）', async () => {
    m.mockImplementation(async (url: string) => {
      urls.push(url)
      return page([row(3, { status: 'completed', amount_type: 'ratio', amount_minor: 12345 })])
    })
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-3')).toBeInTheDocument())
    expect(urls[0]).toBe('/api/modules/aftersales/tickets?page=1&size=20')
    expect(screen.getByText('¥123.45')).toBeInTheDocument()
  })

  it('未处理工单的退款额是占位符（不是 ¥0.00 —— 没算过就是没算过）', async () => {
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-1')).toBeInTheDocument())
    expect(screen.getAllByText('—').length).toBeGreaterThan(0)
  })

  it('接口失败时显示可展示的错误文案，不白屏', async () => {
    m.mockImplementation(async () => json({ error: 'FORBIDDEN' }, 403))
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('没有权限执行该操作')).toBeInTheDocument())
  })

  it('★ 接线：点「处理」真的打开弹窗（不是只画了个按钮）', async () => {
    render(<TicketsPage />)
    await waitFor(() => expect(screen.getByText('T-1')).toBeInTheDocument())
    // antd 对两个汉字的按钮插空格 ⇒ 可访问名是「处 理」
    fireEvent.click(screen.getAllByRole('button', { name: /处\s*理/ })[0]!)
    await waitFor(() => expect(screen.getByText('处理工单 #1')).toBeInTheDocument())
  })
})
