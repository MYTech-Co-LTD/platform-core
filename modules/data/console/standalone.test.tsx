// standalone.test.tsx — 报表独立页 `/r/:id`（计划 2026-10-26 Task 13）。
//
// 唯一 mock 点 = platformFetch（按 URL 回 Response），api.ts 走真实代码。
// 判据（与实现一一对应）：
//  ① 数据源只有 `/published-spec`：**404 时不回退 `/draft`**（草稿是管理面）；
//  ② `?v=N` 原样透传并显示「历史版本 vN」；无 v 时不显示标签；
//  ③ 无导航/菜单/关闭按钮（chrome=standalone）；
//  ④ 响应形状坏 ⇒ fail-closed 报错，不把垃圾喂给渲染器。
//
// echarts 桩说明同 SpecView.test.tsx：happy-dom 的 canvas.getContext('2d') 返回 null，
// 真 echarts init 必抛；本文件只渲染 text 面板，桩掉即可。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
import { platformFetch } from '@platform/sdk/web'
import StandaloneReport from './standalone'

const m = vi.mocked(platformFetch)
const urls: string[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

/** 已发布快照形状 = `getPublishedSpec` 的返回（title/spec/version 是独立页用到的字段）。 */
const PUBLISHED = {
  title: '月报',
  version: 2,
  spec: { panels: [{ chart: 'text', content: '结论', span: 24 }] },
}

function mockPublished(body: unknown = PUBLISHED, status = 200) {
  m.mockImplementation(async (url: string) => {
    urls.push(url)
    return json(body, status)
  })
}

/** 照真实路由挂载：独立页只挂 `/r/:id`（宿主 App.tsx 的同款形状）。 */
function renderAt(path: string) {
  const router = createMemoryRouter([{ path: '/r/:id', element: <StandaloneReport /> }], {
    initialEntries: [path],
  })
  return render(<RouterProvider router={router} />)
}

beforeEach(() => {
  urls.length = 0
  m.mockReset()
})
afterEach(cleanup)

describe('StandaloneReport（/r/:id 独立页）', () => {
  it('① 渲染已发布规格；无导航/菜单/关闭按钮（chrome=standalone）', async () => {
    mockPublished()

    renderAt('/r/r1')

    expect(await screen.findByText('结论')).toBeInTheDocument()
    // 只打 published-spec：独立页没有草稿回退路
    expect(urls).toEqual(['/api/modules/data/reports/r1/published-spec'])
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expect(screen.queryByText('关闭')).toBeNull()
  })

  it('② ?v=N 透传给 published-spec，并显示「历史版本 vN」标签', async () => {
    mockPublished()

    renderAt('/r/r1?v=2')

    expect(await screen.findByText('结论')).toBeInTheDocument()
    expect(urls).toEqual(['/api/modules/data/reports/r1/published-spec?v=2'])
    expect(screen.getByText('历史版本 v2')).toBeInTheDocument()
  })

  it('②b 无 ?v=：不带查询参数、不显示历史版本标签', async () => {
    mockPublished()

    renderAt('/r/r1')

    expect(await screen.findByText('结论')).toBeInTheDocument()
    expect(urls).toEqual(['/api/modules/data/reports/r1/published-spec'])
    expect(screen.queryByText(/历史版本/)).toBeNull()
  })

  it('③ 未发布/已下线（404 NOT_PUBLISHED）：报错且**绝不**回退 /draft', async () => {
    mockPublished({ error: 'NOT_PUBLISHED' }, 404)

    renderAt('/r/r1')

    expect(await screen.findByText('NOT_PUBLISHED')).toBeInTheDocument()
    // 草稿回退 = 绕过发布闸；断言整个请求面里没有 /draft
    expect(urls).toEqual(['/api/modules/data/reports/r1/published-spec'])
    expect(urls.some((u) => u.includes('/draft'))).toBe(false)
  })

  it('④ 响应形状坏（spec.panels 非数组）：fail-closed 报错，不进渲染循环', async () => {
    mockPublished({ title: '月报', version: 1, spec: {} })

    renderAt('/r/r1')

    expect(await screen.findByText('报表规格不合法，请联系平台侧')).toBeInTheDocument()
    expect(screen.queryByText('结论')).toBeNull()
  })
})
