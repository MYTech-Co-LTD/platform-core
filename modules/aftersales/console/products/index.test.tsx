// products/index.test.tsx — 商品页（只读）：★ 有 total ⇒ 出现分页控件
// #476：数据源切 `data.dim_item` 发布快照后，无忌语义的价格/数量两列退役（口径②A：先不显示价格），
// 新增单位/条码两列——本用例的 mock 与断言跟着发布契约走。
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
      items: [{ code: '3001', barCode: '6900000001', name: '苹果', spec: '5 斤', unitName: '箱', saleCease: false, eliminate: false }],
      total: 42,
      page: 1,
      size: 20,
    }),
  )
})
afterEach(cleanup)

describe('商品页（只读）', () => {
  it('渲染商品/规格/单位/条码（无价格列——#476 口径②A）', async () => {
    render(<ProductsPage />)
    await waitFor(() => expect(screen.getByText('苹果')).toBeInTheDocument())
    expect(screen.getByText('5 斤')).toBeInTheDocument()
    expect(screen.getByText('箱')).toBeInTheDocument()
    expect(screen.getByText('6900000001')).toBeInTheDocument()
    // 退役列不在表头：防止「响应没了字段、表头还挂着」的半吊子状态
    expect(screen.queryByText('基础数量')).toBeNull()
    expect(screen.queryByText('基础单价')).toBeNull()
  })

  it('★ 有 total ⇒ 出现分页控件，且显示共 42 条', async () => {
    render(<ProductsPage />)
    await waitFor(() => expect(screen.getByText(/共 42 条/)).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).not.toBeNull()
  })
})
