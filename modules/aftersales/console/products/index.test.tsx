// products/index.test.tsx — 商品页（只读）：★ 有 total ⇒ 出现分页控件
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ProductsPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async () =>
    json({
      items: [{ id: 1, name: '苹果', spec: '5 斤', basicQuantity: 1, basicUnitPriceMinor: 1234 }],
      total: 42,
      page: 1,
      size: 20,
    }),
  )
})
afterEach(cleanup)

describe('商品页（只读）', () => {
  it('渲染商品与基础单价（分→元）', async () => {
    render(<ProductsPage />)
    await waitFor(() => expect(screen.getByText('苹果')).toBeInTheDocument())
    expect(screen.getByText('¥12.34')).toBeInTheDocument()
    expect(screen.getByText('5 斤')).toBeInTheDocument()
  })

  it('★ 有 total ⇒ 出现分页控件，且显示共 42 条', async () => {
    render(<ProductsPage />)
    await waitFor(() => expect(screen.getByText(/共 42 条/)).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).not.toBeNull()
  })
})
