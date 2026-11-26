// tickets/index.test.tsx — 工单页编排：筛选/计数/分页/勾选/删除/导出/预览（2026-11-26 重写）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import TicketsPage from './index'

const m = vi.mocked(platformFetch)
const urls: string[] = []
const posts: Array<{ url: string; body: Record<string, unknown> }> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const row = (id: number, over: Record<string, unknown> = {}) => ({
  id,
  code: `AS-0000000${id}`,
  product_id: 1,
  product_name: '苹果',
  store_id: 1,
  store_name: '熊喵一号店',
  product_code: 'I1',
  store_code: 'S1',
  damage_quantity: 2,
  damage_amount_minor: 900,
  status: 'pending',
  amount_type: null,
  amount_minor: null,
  refund_ratio: null,
  operator: null,
  remark: null,
  opinion: '',
  related_order: '',
  arrival_at: null,
  watermark_at: null,
  brand: 'xiongmao',
  image_count: 0,
  video_count: 0,
  created_at: '2026-09-16T00:00:00Z',
  processed_at: null,
  ...over,
})

const counts = {
  status: { all: 5, pending: 2, completed: 2, cancelled: 1 },
  brand: { xiongmao: 3, pptd: 1, none: 1 },
}

const detail = {
  ...row(1),
  basic_quantity: 15,
  basic_unit_price_minor: 450,
  settlement_price_minor: 450,
  submitter_openid: 'openid-a',
  settlement_source: 'transfer',
  settlement_order_no: 'MO123',
  settlement_item_code: 'I1',
  settlement_line_key: '0',
  settlement_bizday: '2026-09-15',
  attachments: [],
}

beforeEach(() => {
  urls.length = 0
  posts.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    urls.push(url)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      posts.push({ url, body })
      if (url.includes('/batch-delete')) {
        return json({ deleted: body.ids as number[], failed: [] })
      }
      return json({ ok: true, id: 1, status: 'completed', amountType: 'ratio', amountMinor: 225 })
    }
    if (url.includes('/tickets/counts')) return json(counts)
    if (url.includes('/tickets?')) return json({ items: [row(1), row(2)], total: 5, page: 1, size: 20 })
    if (url.includes('/tickets/1')) return json(detail)
    if (url.includes('/rules')) return json({ items: [], total: 0, page: 1, size: 100 })
    return json({ error: 'NOT_FOUND' }, 404)
  })
})
afterEach(cleanup)

/** 带 Outlet context 的渲染壳：删除按钮按 `session.scopes` 显隐。 */
function Shell(props: { scopes: string[] }) {
  return <Outlet context={{ session: { scopes: props.scopes } }} />
}
function renderPage(scopes: string[] = ['aftersales:manage']) {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Shell scopes={scopes} />}>
          <Route index element={<TicketsPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('工单列表', () => {
  it('渲染列表行、「共 N 条」与状态/品牌计数', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    expect(screen.getByText('AS-00000002')).toBeInTheDocument()
    expect(screen.getByText(/共 5 条/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '待处理 2' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '熊喵 3' })).toBeInTheDocument()
  })

  it('首次请求带 page/size；已处理显示赔付额', async () => {
    m.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url.includes('/tickets/counts')) return json(counts)
      if (url.includes('/tickets?')) {
        return json({ items: [row(3, { status: 'completed', amount_type: 'ratio', amount_minor: 12345 })], total: 5, page: 1, size: 20 })
      }
      return json({ error: 'NOT_FOUND' }, 404)
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000003')).toBeInTheDocument())
    expect(urls.some((u) => u.includes('/tickets?page=1&size=20'))).toBe(true)
    expect(screen.getByText('¥123.45')).toBeInTheDocument()
  })

  it('状态胶囊：点击后查询带 status、回第 1 页、计数也跟随状态', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '待处理 2' }))
    await waitFor(() => expect(urls.some((u) => u.includes('status=pending'))).toBe(true))
    expect(urls.filter((u) => u.includes('status=pending')).length).toBeGreaterThanOrEqual(2) // 列表 + 计数
    // 再点一次回到全部
    fireEvent.click(screen.getByRole('button', { name: '待处理 2' }))
    await waitFor(() => {
      const lists = urls.filter((u) => u.includes('/tickets?'))
      expect(lists.at(-1)).not.toContain('status=pending')
    })
  })

  it('品牌胶囊：点击后查询带 brand', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '熊喵 3' }))
    await waitFor(() => expect(urls.some((u) => u.includes('brand=xiongmao'))).toBe(true))
  })

  it('搜索：输入工单编号后点搜索，查询带 code；重置清空', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('工单编号'), { target: { value: 'AS-9' } })
    fireEvent.click(screen.getByRole('button', { name: /搜\s*索/ }))
    await waitFor(() => expect(urls.some((u) => u.includes('code=AS-9'))).toBe(true))
    fireEvent.click(screen.getByRole('button', { name: /重\s*置/ }))
    await waitFor(() => {
      const last = [...urls].reverse().find((u) => u.includes('/tickets?'))
      expect(last).not.toContain('code=')
    })
  })

  it('接口失败时显示可展示的错误文案，不白屏', async () => {
    m.mockImplementation(async () => json({ error: 'FORBIDDEN' }, 403))
    renderPage()
    await waitFor(() => expect(screen.getByText('没有权限执行该操作')).toBeInTheDocument())
  })

  it('★ 接线：点「处理」打开弹窗（详情加载后标题带单号）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    fireEvent.click(screen.getAllByRole('button', { name: /^处\s*理$/ })[0]!)
    await waitFor(() => expect(screen.getByText('处理工单 AS-00000001')).toBeInTheDocument())
  })

  it('删除按钮按 aftersales:delete 显隐', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /删\s*除/ })).toBeNull()
    cleanup()
    renderPage(['aftersales:manage', 'aftersales:delete'])
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /删\s*除/ })).toBeInTheDocument()
  })

  it('勾选 + 删除：确认后 POST ids，并刷新列表', async () => {
    renderPage(['aftersales:manage', 'aftersales:delete'])
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    const boxes = screen.getAllByRole('checkbox')
    fireEvent.click(boxes[1]!)
    await waitFor(() => expect(screen.getByText('已选择 1 项')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /删\s*除/ }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/工单与附件会一并删除/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: /删\s*除/ }))
    await waitFor(() => expect(posts.some((p) => p.url.includes('/batch-delete'))).toBe(true))
    expect(posts.find((p) => p.url.includes('/batch-delete'))!.body).toEqual({ ids: [1] })
  })

  it('导出下拉：选「筛选结果」打开导出弹窗', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /导\s*出/ }))
    fireEvent.click(await screen.findByText('筛选结果'))
    expect(await screen.findByText('导出工单')).toBeInTheDocument()
    expect(screen.getByText('范围：当前筛选结果')).toBeInTheDocument()
  })

  it('附件列：点击打开预览（先取详情拿预签名 URL）', async () => {
    m.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url.includes('/tickets/counts')) return json(counts)
      if (url.includes('/tickets?')) return json({ items: [row(1, { image_count: 1 })], total: 1, page: 1, size: 20 })
      if (url.includes('/tickets/1')) return json({
        ...detail,
        attachments: [{ id: 9, objectKey: 'k', contentType: 'image/jpeg', sizeBytes: 10, url: 'https://x/1.jpg' }],
      })
      return json({ error: 'NOT_FOUND' }, 404)
    })
    renderPage()
    await waitFor(() => expect(screen.getByText('AS-00000001')).toBeInTheDocument())
    fireEvent.click(screen.getByText('图片 1'))
    await waitFor(() => expect(screen.getByText('第 1 / 1 个')).toBeInTheDocument())
  })
})
