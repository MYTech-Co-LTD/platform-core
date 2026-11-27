// stores/index.test.tsx — 门店页（只读）：★ 未接分页 ⇒ 不出现分页控件
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import StoresPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

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

describe('门店页（只读）', () => {
  it('渲染门店', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(screen.getByText('某路 1 号')).toBeInTheDocument()
    expect(screen.getByText('熊喵')).toBeInTheDocument()
    expect(screen.getByText('一级')).toBeInTheDocument()
    expect(screen.getByText(/已标记品牌 1\/1/)).toBeInTheDocument()
  })

  it('★ API 已回 total 但 console 未接分页（#155 只做 API 面）⇒ 不出现分页控件', async () => {
    render(<StoresPage />)
    await waitFor(() => expect(screen.getByText('一号店')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
