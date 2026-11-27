// stores/index.test.tsx — 门店页（只读）：★ 未接分页 ⇒ 不出现分页控件
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import StoresPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    if (url.includes('/stores/profile-options')) {
      return json({
        brands: [{ code: 'xiongmao', name: '熊喵', enabled: true, sort: 1 }],
        levels: [{ code: 'A', name: '一级', enabled: true, sort: 1 }],
        coverage: { stores: 1, brandTagged: 1, levelTagged: 1 },
        degraded: false,
      })
    }
    // #155 起真机回 {items,total,page,size}——替身钉在真实形状上（AGENTS.md #11）
    return json({
      items: [{
        code: 'S01', name: '一号店', enable: true, address: '某路 1 号', phone: '010-1',
        brandCode: 'xiongmao', brandName: '熊喵', levelCode: 'A', levelName: '一级',
      }],
      total: 1, page: 1, size: 20,
    })
  })
})
afterEach(cleanup)

function EditableShell() {
  return <Outlet context={{ session: { scopes: ['data:store'] } }} />
}
function renderEditable() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<EditableShell />}>
          <Route index element={<StoresPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  )
}

describe('门店页（只读）', () => {
  it('渲染门店', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(screen.getByText('某路 1 号')).toBeInTheDocument()
    expect(screen.getByText('熊喵')).toBeInTheDocument()
    expect(screen.getByText('一级')).toBeInTheDocument()
    expect(screen.getByText(/已标记品牌 1\/1/)).toBeInTheDocument()
  })

  it('★ 375 家量级：分页控件存在（#2936 起搜索/筛选后仍可翻页）', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).not.toBeNull()
  })

  it('★ 有 data:store：点标签 → 内联新建品牌 → 创建后赋值给该门店（#2930）', async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = []
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      })
      if (url.includes('/stores/profile-options')) {
        return json({
          brands: [{ code: 'xiongmao', name: '熊喵', enabled: true, sort: 1 }],
          levels: [],
          coverage: { stores: 1, brandTagged: 1, levelTagged: 0 },
          degraded: false,
        })
      }
      if (url.startsWith('/api/modules/data/brands')) {
        return json({ code: 'b_new', name: '新品牌', sort: 0, enabled: true, source: 'manual' }, 201)
      }
      if (url.includes('/store-profiles/S01')) return json({ storeCode: 'S01' })
      return json({
        items: [{
          code: 'S01', name: '一号店', enable: true, address: '某路 1 号', phone: '010-1',
          brandCode: 'xiongmao', brandName: '熊喵', levelCode: null, levelName: null,
        }],
        total: 1, page: 1, size: 20,
      })
    })

    renderEditable()
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())

    fireEvent.click(screen.getByText('熊喵'))
    const nameInput = await screen.findByPlaceholderText('新品牌名称')
    fireEvent.change(nameInput, { target: { value: '新品牌' } })
    fireEvent.click(screen.getByRole('button', { name: /新建/ }))

    await waitFor(() => {
      expect(calls.some((c) => c.url.startsWith('/api/modules/data/brands')
        && c.method === 'POST'
        && (c.body as { name?: string }).name === '新品牌')).toBe(true)
    })
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/store-profiles/S01')
        && c.method === 'PUT'
        && (c.body as { brandCode?: string }).brandCode === 'b_new')).toBe(true)
    })
    // 等 assign 后的 reload 全部落地，避免 teardown 时还有 setState 在排队
    await waitFor(() => {
      expect(calls.filter((c) => c.url.startsWith('/api/modules/aftersales/stores?')).length).toBeGreaterThanOrEqual(2)
      expect(calls.filter((c) => c.url === '/api/modules/aftersales/stores/profile-options').length)
        .toBeGreaterThanOrEqual(2)
    })
  })
  it('搜索门店 + 品牌筛选 + 结果计数（#2936）', async () => {
    m.mockImplementation(async (url: string) => {
      if (url.includes('/stores/profile-options')) {
        return json({
          brands: [
            { code: 'xiongmao', name: '熊喵', enabled: true, sort: 1 },
            { code: 'pptd', name: '品品甜', enabled: true, sort: 2 },
          ],
          levels: [
            { code: 'A', name: '一级', enabled: true, sort: 1 },
            { code: 'B', name: '二级', enabled: true, sort: 2 },
          ],
          coverage: { stores: 3, brandTagged: 2, levelTagged: 2 },
          degraded: false,
        })
      }
      return json({
        items: [
          {
            code: 'S01', name: '一号店', enable: true, address: '', phone: '',
            brandCode: 'xiongmao', brandName: '熊喵', levelCode: 'A', levelName: '一级',
          },
          {
            code: 'S02', name: '二号店', enable: false, address: '', phone: '',
            brandCode: 'pptd', brandName: '品品甜', levelCode: 'B', levelName: '二级',
          },
          {
            code: 'S03', name: '三号店', enable: true, address: '', phone: '',
            brandCode: null, brandName: null, levelCode: null, levelName: null,
          },
        ],
        total: 3, page: 1, size: 100,
      })
    })

    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(screen.getByText('二号店')).toBeInTheDocument()
    expect(screen.getByText('三号店')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('搜索门店名称/编码'), { target: { value: '二号' } })
    await waitFor(() => expect(screen.queryByText('一号店')).toBeNull())
    expect(screen.getByText('二号店')).toBeInTheDocument()
    expect(screen.queryByText('三号店')).toBeNull()

    fireEvent.change(screen.getByPlaceholderText('搜索门店名称/编码'), { target: { value: '' } })
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())

    const combos = screen.getAllByRole('combobox')
    fireEvent.mouseDown(combos[0]!)
    const option = await waitFor(() => {
      const el = document.querySelector('.ant-select-item-option[title="熊喵"]')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    fireEvent.click(option)
    await waitFor(() => {
      expect(screen.getByText('一号店')).toBeInTheDocument()
      expect(screen.queryByText('二号店')).toBeNull()
      expect(screen.queryByText('三号店')).toBeNull()
    })
  })

})
