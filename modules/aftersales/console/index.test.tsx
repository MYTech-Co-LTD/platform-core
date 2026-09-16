// index.test.tsx — 售后 console 入口：tabs 路由壳（M3a）。
//
// ⚠️ 本文件的挂载形态**照抄宿主壳的真实结构**：`{ path: '*', element: <ConsoleModulePage/> }`
//    挂在 `/console` 下（见 `apps/web/src/App.tsx:28`）。这一点是刻意的——下面三条用例
//    全部是被**浏览器实测**抓出来的缺陷（组件测试当时漏掉，因为初版按「理想挂载」写的）：
//      ① 壳用全等匹配找 registry 条目 ⇒ 深链落进 404（修在壳：前缀匹配）
//      ② 相对 `navigate(key)` 以壳的 splat 路由为基准 ⇒ 点页签跳到 `/console/rules`（丢段）
//      ③ 模块内嵌套 `<Routes>` 相对父路由匹配 ⇒ splat 剩余段是 `aftersales/tickets`，
//         `path="tickets"` 永远匹配不上 ⇒ **整块空白、且不报错**
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import AftersalesConsolePage from './index'

const m = vi.mocked(platformFetch)
const urls: string[] = []
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  urls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    urls.push(url)
    if (url.includes('/tickets')) return json({ items: [], total: 0, page: 1, size: 20 })
    if (url.includes('/products')) return json({ items: [], total: 0, page: 1, size: 20 })
    return json({ items: [] })
  })
})
afterEach(cleanup)

/** 照宿主壳的真实挂载：模块页挂在 `/console` 下的 splat 路由 */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes: ['aftersales:manage'] } }} />,
        children: [{ path: '/console/*', element: <AftersalesConsolePage /> }],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('售后 console 入口', () => {
  it('五个页签都在菜单里', () => {
    renderAt('/console/aftersales/tickets')
    for (const label of ['工单', '规则', '员工', '商品', '门店']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('★ ② 点页签导航到**绝对**路径，不丢模块段', async () => {
    const router = renderAt('/console/aftersales/tickets')
    // 等首屏那次数据请求落地，确保已挂载
    await waitFor(() => expect(urls.some((u) => u.includes('/tickets'))).toBe(true))
    fireEvent.click(screen.getByText('规则'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/aftersales/rules'))
  })

  it('★ ③ 深链到 /stores 时，**门店页的内容真的渲染出来**（不只是 URL 对）', async () => {
    renderAt('/console/aftersales/stores')
    // 「地址」是门店页独有的表头；菜单标签里没有它 ⇒ 不会被菜单蒙混过关
    await waitFor(() => expect(screen.getByText('地址')).toBeInTheDocument())
    await waitFor(() => expect(urls.some((u) => u.includes('/stores'))).toBe(true))
  })

  it('深链到 /employees 渲染员工页（另一个非默认页签）', async () => {
    renderAt('/console/aftersales/employees')
    await waitFor(() => expect(screen.getByText('审批状态')).toBeInTheDocument())
  })

  it('裸 /console/aftersales 规范化到工单页（URL 与内容一致）', async () => {
    const router = renderAt('/console/aftersales')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/aftersales/tickets'))
  })
})
