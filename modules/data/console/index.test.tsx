// index.test.tsx — 数据模块 console 入口的路由壳（指标/报表/数据范围/可能的指标）。
// 站内问数已于 2026-11-12 退役（问数只经 MCP）。
// 【变更】原第四页「我的 Key」已上移宿主（issue #894）；#1953 二期页内 tabs 撤掉，
// 四页改为宿主左侧菜单子项 ⇒ 本文件只测「URL 驱动哪一页」与裸路径规范化。
// 挂载形态照宿主壳的真实结构（同 aftersales/console/index.test.tsx）：
// `{ path: '*', element: <ConsoleModulePage/> }` 挂在 `/console` 下。
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

describe('数据模块 console 入口（URL 选页）', () => {
  it('页内不再渲染页签导航（#1953 二期：改由宿主左侧菜单承担）', () => {
    renderAt('/console/data/metrics')
    // 页签文案来自宿主菜单，模块页自己不该再出现「指标 / 报表」这类导航项
    expect(screen.queryByRole('menuitem', { name: '指标' })).toBeNull()
  })

  it('裸 /console/data 规范化到默认页签 metrics（URL 与内容一致；问数页已退役）', async () => {
    const router = renderAt('/console/data')
    await waitFor(() => expect(router.state.location.pathname).toBe('/console/data/metrics'))
  })


  it('★ 深链到 /metrics 时，指标页内容真的渲染出来（「主体列」是指标页独有表头）', async () => {
    renderAt('/console/data/metrics')
    // 指标表也开了横向滚动 ⇒ antd 量尺行会重复表头文本（同报表页 2026-11-03 UX 改动）
    await waitFor(() => expect(screen.getAllByText('主体列').length).toBeGreaterThan(0))
    await waitFor(() => expect(urls.some((u) => u.includes('/metrics/all'))).toBe(true))
  })

  // 【已移除】「深链到 /keys 渲染 Key 页」：个人 Key 管理已上移宿主（issue #894，正典 §1.5），
  // 本模块不再有 Key 页与 /keys 端点。新页在宿主壳（/console/me/keys + /console/admin/keys）。

  it('深链到 /reports 渲染报表页（「报表标题」是报表页独有表头）并请求 /reports', async () => {
    renderAt('/console/data/reports')
    // ⚠️ 表格开启了横向滚动（scroll.x）⇒ antd 会额外渲染一份隐藏的表头量尺行，
    //    「报表标题」出现两次。用 getAllByText 断言存在即可（2026-11-03 UX 改动）。
    await waitFor(() => expect(screen.getAllByText('报表标题').length).toBeGreaterThan(0))
    await waitFor(() => expect(urls.some((u) => u.includes('/reports'))).toBe(true))
  })

  it('W5 定案 A：仍保留「体系地图」外链（独立追溯页，不是 console 路由页签）', () => {
    renderAt('/console/data/metrics')
    const link = screen.getByText(/体系地图/).closest('a')
    expect(link?.getAttribute('href')).toBe('/api/modules/data/system-map#/overview')
    expect(link?.getAttribute('target')).toBe('_blank')
  })

  it('★ 深链 /scopes 渲染「数据范围」页（#1901；入口显隐由宿主菜单按 data:manage 过滤）', async () => {
    // 普通用户深链：末段不是他可用的页 ⇒ 规范回默认页，不渲染管理页
    const plain = renderAt('/console/data/scopes')
    await waitFor(() => expect(plain.state.location.pathname).toBe('/console/data/metrics'))
    cleanup()
    // 管理员：深链直达，渲染出管理页内容（预览卡标题是本页独有）
    const router = createMemoryRouter(
      [
        {
          element: <Outlet context={{ session: { scopes: ['data:query', 'data:manage'] } }} />,
          children: [{ path: '/console/*', element: <DataConsolePage /> }],
        },
      ],
      { initialEntries: ['/console/data/scopes'] },
    )
    m.mockImplementation(async (url: string) => {
      if (url.includes('/scopes')) return json({ scopes: [] })
      return json({})
    })
    render(<RouterProvider router={router} />)
    // 页签 + 页内标题都会出现「数据范围」（#1953 页面标题收口），故取全量
    expect(screen.getAllByText('数据范围').length).toBeGreaterThan(0)
    await waitFor(() => expect(screen.getByText('有效范围预览（谁看得见什么）')).toBeTruthy())
    expect(router.state.location.pathname).toBe('/console/data/scopes')
  })

  it('★ data:manage 用户可见「可能的指标」页签并请求 /metrics/candidates；普通用户不可见（Wave 2.3）', async () => {
    // 普通用户：菜单里没有「可能的指标」
    renderAt('/console/data/metrics')
    expect(screen.queryByText('可能的指标')).toBeNull()
    cleanup()

    urls.length = 0
    m.mockImplementation(async (url: string) => {
      urls.push(url)
      if (url.includes('/metrics/candidates')) return json({ candidates: [], limit: 200 })
      return json({})
    })
    const router = createMemoryRouter(
      [
        {
          element: <Outlet context={{ session: { scopes: ['data:query', 'data:manage'] } }} />,
          children: [{ path: '/console/*', element: <DataConsolePage /> }],
        },
      ],
      { initialEntries: ['/console/data/candidates'] },
    )
    render(<RouterProvider router={router} />)
    // 页签与卡片标题都会出现「可能的指标」
    expect(screen.getAllByText('可能的指标').length).toBeGreaterThan(0)
    await waitFor(() => expect(urls.some((u) => u.includes('/metrics/candidates'))).toBe(true))
    expect(router.state.location.pathname).toBe('/console/data/candidates')
  })
})
