// index.test.tsx — 售后 console 的 tabs 路由壳（M3a）。
//
// ⚠️ 本文件的断言**只碰路由与菜单标签**，不碰页面正文——Wave 2 会把下面 5 个骨架页逐个换成
//    真页面，任何对正文的断言都会在那一波变红。
//    同理用 getAllByText：'工单'/'门店' 等既是菜单标签也可能是页面标题，getByText 会因
//    命中多处而抛错。
//
// 渲染经 createMemoryRouter + <Outlet context>：还原 Console 壳注入 session 的真实挂载形态。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it } from 'vitest'
import AftersalesConsolePage from './index'

afterEach(cleanup)

/** 还原 Console 壳的挂载形态：Outlet context 注入 session（模块页只读 scopes） */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes: ['aftersales:manage'] } }} />,
        children: [{ path: '/console/aftersales/*', element: <AftersalesConsolePage /> }],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('售后 console 路由壳', () => {
  it('五个页签都在菜单里', () => {
    renderAt('/console/aftersales/tickets')
    for (const label of ['工单', '规则', '员工', '商品', '门店']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('深链到 /stores 时路由停在 stores（不被重定向走）', async () => {
    const router = renderAt('/console/aftersales/stores')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/aftersales/stores'))
  })

  it('裸 /console/aftersales 重定向到工单', async () => {
    const router = renderAt('/console/aftersales')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/aftersales/tickets'))
  })
})
