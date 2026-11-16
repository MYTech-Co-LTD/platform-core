// MobileHome（/m）— 移动端业务工作台：加载骨架 / 空态 / 应用卡片 / 未登录回跳。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import MobileHome from './MobileHome'

const m = vi.mocked(platformFetch)
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const renderPage = () => render(<MemoryRouter><MobileHome /></MemoryRouter>)

beforeEach(() => { m.mockReset() })
afterEach(cleanup)

describe('移动端业务工作台', () => {
  it('按服务端返回渲染应用卡片（不自己判权限）', async () => {
    m.mockResolvedValue(json({ apps: [
      { moduleId: 'data', mount: '/app/data', title: '报表中心', icon: null, scope: 'data:query' },
      { moduleId: 'aftersales', mount: '/app/aftersales', title: '售后管理', icon: null, scope: 'aftersales:manage' },
    ] }))
    renderPage()
    expect(await screen.findByText('报表中心')).toBeInTheDocument()
    expect(screen.getByText('售后管理')).toBeInTheDocument()
    // 卡片是整页跳转（模块前端是另一套产物）
    expect(screen.getByText('报表中心').closest('a')).toHaveAttribute('href', '/app/data')
  })

  it('空清单：给「需要管理员开通」的下一步，而不是一句「暂无」', async () => {
    m.mockResolvedValue(json({ apps: [] }))
    renderPage()
    expect(await screen.findByText(/暂无可用的业务应用/)).toBeInTheDocument()
    expect(screen.getByText(/需要管理员为你开通对应权限/)).toBeInTheDocument()
  })

  it('持 forms:view 且 forms 模块启用 ⇒ 出现「待我审批」入口（本产物内 SPA 路由）', async () => {
    m.mockImplementation(async (input: string) => {
      if (input === '/api/platform/me/apps') return json({ apps: [] })
      if (input === '/api/platform/auth/session') return json({ scopes: ['forms:view', 'forms:fill'] })
      if (input === '/api/platform/config') return json({ modules: [{ id: 'forms' }] })
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderPage()
    const link = await screen.findByRole('link', { name: /待我审批/ })
    expect(link).toHaveAttribute('href', '/m/oa/approvals')
  })

  it('无 forms:view ⇒ 不出现 OA 入口；空态文案保持不变', async () => {
    m.mockImplementation(async (input: string) => {
      if (input === '/api/platform/me/apps') return json({ apps: [] })
      if (input === '/api/platform/auth/session') return json({ scopes: ['demo:view'] })
      if (input === '/api/platform/config') return json({ modules: [{ id: 'forms' }] })
      throw new Error('unexpected platformFetch: ' + input)
    })
    renderPage()
    expect(await screen.findByText(/暂无可用的业务应用/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /待我审批/ })).toBeNull()
  })

  it('匿名 401 ⇒ 去登录并回跳 /m', async () => {
    m.mockResolvedValue(json({ error: 'UNAUTHENTICATED' }, 401))
    renderPage()
    const link = await screen.findByRole('link', { name: '去登录' })
    expect(link).toHaveAttribute('href', '/login?next=/m')
  })

  it('platformFetch 抛 UNAUTHENTICATED（真 401 的实现形态）⇒ 同样是登录引导，不卡骨架屏', async () => {
    m.mockRejectedValue(new Error('UNAUTHENTICATED'))
    renderPage()
    const link = await screen.findByRole('link', { name: '去登录' })
    expect(link).toHaveAttribute('href', '/login?next=/m')
  })

  it('加载态是骨架卡片（结构先出现），不是一行「正在加载…」', () => {
    m.mockReturnValue(new Promise(() => {}) as unknown as Promise<Response>)
    renderPage()
    // 四张占位卡：骨架没有文本，用容器数量断言
    expect(document.querySelectorAll('[class*="card"]').length).toBeGreaterThanOrEqual(4)
    expect(screen.queryByText('正在加载…')).toBeNull()
  })
})
