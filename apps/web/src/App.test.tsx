// App.test.tsx — 宿主路由表里 `/r/:id` 的接线（计划 2026-10-26 Task 13）。
//
// 两条判据：
//  ① `/r/:id` 在 `*` 兜底**之前**：裸打开 /r/abc 渲染独立页，**不被重定向 /console**；
//  ② 登录回跳保留查询串：/login?next=%2Fr%2Fabc%3Fv%3D1 登录成功后落到 /r/abc?v=1
//     （#1060 查询串透传；下一跳的独立页才能钉住历史版本）。
//
// 独立页本体在 `modules/data/console/standalone.test.tsx` 里测；这里把它替身掉，
// 只验路由顺序与回跳（避免把 echarts/antd 的渲染细节拖进宿主路由测试）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
vi.mock('../../../modules/data/console/standalone', () => ({
  default: () => <div data-testid="standalone-stub">独立报表</div>,
}))

import { platformFetch } from '@platform/sdk/web'
import App from './App'

const m = vi.mocked(platformFetch)

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const BRANDING = { productName: 'Platform', primaryColor: '#1890ff', loginMethods: ['password'] }

/** happy-dom 的 location.href 赋值非同步生效，轮询到命中（防 flake，同 Login.test.tsx） */
async function waitForLocation(pathname: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (window.location.pathname !== pathname) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`location 未跳到 ${pathname}（当前 ${window.location.pathname}${window.location.search}）`)
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}

beforeEach(() => {
  window.history.pushState({}, '', '/')
  m.mockReset()
})
afterEach(cleanup)

describe('App 路由表：报表独立页 /r/:id', () => {
  it('① /r/abc 裸打开渲染独立页，不被 `*` 兜底重定向到 /console', async () => {
    window.history.pushState({}, '', '/r/abc')
    render(<App />)

    expect(await screen.findByTestId('standalone-stub')).toBeInTheDocument()
    expect(window.location.pathname).toBe('/r/abc')
  })

  it('② 登录回跳保留 ?v=N：/login?next=%2Fr%2Fabc%3Fv%3D1 → /r/abc?v=1', async () => {
    window.history.pushState({}, '', '/login?next=%2Fr%2Fabc%3Fv%3D1')
    m.mockImplementation(async (input: string) => {
      if (input === '/api/platform/branding') return json(BRANDING)
      if (input === '/api/platform/auth/login') return json({ ok: true })
      throw new Error('unexpected platformFetch: ' + input)
    })

    render(<App />)
    await screen.findByText('Platform')

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'right-pass' } })
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }))

    await waitForLocation('/r/abc')
    expect(window.location.search).toBe('?v=1')
  })
})
