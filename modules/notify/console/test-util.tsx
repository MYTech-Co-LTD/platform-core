// test-util.tsx — console 页面测试共用：mock platformFetch（按方法 + 路径路由）。
// 用法（测试文件顶部）：
//   vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
//   import { routeFetch, json, fetchMock } from './test-util'
//   beforeEach(() => fetchMock.mockReset())
import { vi } from 'vitest'
import { platformFetch } from '@platform/sdk/web'

export const fetchMock = vi.mocked(platformFetch)

export function routeFetch(
  routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>,
): void {
  fetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`
    const handler = routes[key] ?? routes[input]
    if (!handler) throw new Error(`unexpected fetch: ${key}`)
    return handler(init)
  })
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
