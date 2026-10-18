// index.test.tsx — 数据模块 console 入口：三页签的路由壳（问数/指标/报表）。
// 【变更】原第四页「我的 Key」已上移宿主（issue #894，正典 §1.5）⇒ 页签与断言同删。
// 挂载形态照宿主壳的真实结构（同 aftersales/console/index.test.tsx）：
// `{ path: '*', element: <ConsoleModulePage/> }` 挂在 `/console` 下。
// 只测「URL 驱动哪一页」：裸路径规范化、页签点击走绝对路径、深链真的渲染出那页的内容。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import DataConsolePage from './index'

const m = vi.mocked(platformFetch)
const urls: string[] = []
const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  urls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string) => {
    urls.push(url)
    if (url.includes('/metrics/all')) {
      return json({ metrics: [{ id: 'sales_daily', title: '销售日明细', description: '', requiredScope: null, subjectColumn: 'org' }] })
    }
    if (url.includes('/keys')) return json({ keys: [] })
    if (url.includes('/reports')) return json({ reports: [] })
    return json({})
  })
})
afterEach(cleanup)

/** 照宿主壳的真实挂载：模块页挂在 `/console` 下的 splat 路由 */
function renderAt(path: string) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes: ['data:query'] } }} />,
        children: [{ path: '/console/*', element: <DataConsolePage /> }],
      },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
  return router
}

describe('数据模块 console 入口（三页签）', () => {
  it('三个页签都在菜单里', () => {
    renderAt('/console/data/query')
    for (const label of ['问数', '指标', '报表']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
    }
  })

  it('裸 /console/data 规范化到默认页签 query（URL 与内容一致）', async () => {
    const router = renderAt('/console/data')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/data/query'))
  })

  it('★ 点页签导航到**绝对**路径，不丢模块段（data）', async () => {
    const router = renderAt('/console/data/query')
    fireEvent.click(screen.getByText('指标'))
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/data/metrics'))
  })

  it('★ 深链到 /metrics 时，指标页内容真的渲染出来（「主体列」是指标页独有表头）', async () => {
    renderAt('/console/data/metrics')
    await waitFor(() => expect(screen.getByText('主体列')).toBeInTheDocument())
    await waitFor(() => expect(urls.some((u) => u.includes('/metrics/all'))).toBe(true))
  })

  // 【已移除】「深链到 /keys 渲染 Key 页」：个人 Key 管理已上移宿主（issue #894，正典 §1.5），
  // 本模块不再有 Key 页与 /keys 端点。新页在宿主壳（/console/me/keys + /console/admin/keys）。

  it('深链到 /reports 渲染报表页（「报表标题」是报表页独有表头）并请求 /reports', async () => {
    renderAt('/console/data/reports')
    await waitFor(() => expect(screen.getByText('报表标题')).toBeInTheDocument())
    await waitFor(() => expect(urls.some((u) => u.includes('/reports'))).toBe(true))
  })
})
