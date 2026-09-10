// note.test.tsx — 演示模块 console 页组件测试（Task 19；组件测试放模块内）。
//
// mock 点一个：platformFetch（按 URL 回 Response）——页面业务行为全走它。
// 渲染经 createMemoryRouter + <Outlet context>：还原 Console 壳注入 session.scopes
// 的真实挂载形态（useOutletContext 的消费路径一并测真）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import DemoConsolePage from './index'

const platformFetchMock = vi.mocked(platformFetch)

const calls: Array<{ url: string; init?: RequestInit }> = []

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 按首遇注册的 URL → Response 工厂；未注册 URL 直接失败（防静默放行） */
function mockApi(handlers: Record<string, () => Response>): void {
  platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init })
    const handler = handlers[input]
    if (!handler) throw new Error('unexpected platformFetch: ' + input)
    return handler()
  })
}

/** 以给定 scopes 渲染页面（模拟 Console 壳的 Outlet context 注入） */
function renderPage(scopes: string[]): void {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes } }} />,
        children: [{ path: '/', element: <DemoConsolePage /> }],
      },
    ],
    { initialEntries: ['/'] },
  )
  render(<RouterProvider router={router} />)
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('演示模块 console 页', () => {
  it('① Ping → GET /api/modules/demo/ping 并展示返回 JSON', async () => {
    mockApi({
      '/api/modules/demo/ping': () =>
        jsonResponse({ pong: true, identity: { userId: 'admin1', orgId: 'acme' } }),
    })
    // 只给 demo:view：Ping 本身只吃这个 scope，且避免触发便签挂载拉取
    renderPage(['demo:view'])

    fireEvent.click(screen.getByRole('button', { name: 'Ping' }))

    expect(await screen.findByText(/"pong": true/)).toBeInTheDocument()
    expect(screen.getByText(/"userId": "admin1"/)).toBeInTheDocument()
    expect(calls.map((c) => c.url)).toContain('/api/modules/demo/ping')
  })

  it('② 持有 demo:note：挂载即拉便签列表，输入 + 添加 → POST 后刷新', async () => {
    mockApi({
      '/api/modules/demo/notes': () =>
        calls.filter((c) => c.url === '/api/modules/demo/notes' && c.init?.method === 'POST').length
          > 0
          ? jsonResponse({ notes: [{ id: 2, body: '第二条', created_at: '2026-09-10T00:00:00Z' }, { id: 1, body: '第一条', created_at: '2026-09-09T00:00:00Z' }] })
          : jsonResponse({ notes: [{ id: 1, body: '第一条', created_at: '2026-09-09T00:00:00Z' }] }),
    })
    renderPage(['demo:view', 'demo:note'])

    // 挂载即取列表（demo:note 在会话里）
    expect(await screen.findByText('#1 第一条')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText('写点什么…'), { target: { value: '第二条' } })
    fireEvent.click(screen.getByRole('button', { name: '添加便签' }))

    await waitFor(() => {
      expect(screen.getByText('#2 第二条')).toBeInTheDocument()
    })
    const post = calls.find(
      (c) => c.url === '/api/modules/demo/notes' && c.init?.method === 'POST',
    )
    expect(post?.init?.body).toBe(JSON.stringify({ body: '第二条' }))
  })

  it('③ 无 demo:note：不出便签 UI、不发 /notes 请求（权限判定只读 session.scopes）', async () => {
    mockApi({
      '/api/modules/demo/ping': () => jsonResponse({ pong: true, identity: {} }),
    })
    renderPage(['demo:view'])

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: '添加便签' })).not.toBeInTheDocument()
    })
    expect(screen.queryByPlaceholderText('写点什么…')).not.toBeInTheDocument()
    expect(screen.queryByText('便签（demo:note）')).not.toBeInTheDocument()
    expect(calls.map((c) => c.url)).not.toContain('/api/modules/demo/notes')
  })
})
