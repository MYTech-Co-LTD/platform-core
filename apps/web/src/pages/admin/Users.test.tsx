// pages/admin/Users.test.tsx — 用户管理页最小渲染冒烟（M3，issue #46）
//
// mock lib/api（页面契约面）；经嵌套路由的 Outlet context 注入会话（useOutletContext 的真实链路）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
import type { ConsoleOutletContext } from '../Console'

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  listAdminUsers: vi.fn(async () => ({
    users: [
      { name: 'alice', displayName: 'Alice', isForbidden: false },
      { name: 'bob', displayName: 'Bob', isForbidden: true },
    ],
  })),
  createAdminUser: vi.fn(),
  setAdminUserForbidden: vi.fn(),
  resetAdminUserPassword: vi.fn(),
  deleteAdminUser: vi.fn(),
}))

import UsersPage from './Users'

const ctx: ConsoleOutletContext = {
  session: {
    user: { id: 'admin1', name: 'admin1', displayName: 'Admin' },
    org: 'myorg',
    scopes: ['tenant:admin'],
    csrfToken: 'x',
  },
  config: { tenant: { slug: 'my', org: 'myorg' }, modules: [] },
  branding: { productName: 'P', primaryColor: '#1677ff', background: '', loginMethods: ['password'] },
}

describe('AdminUsersPage 渲染冒烟', () => {
  it('列出用户与新建入口', async () => {
    render(
      <AntdApp>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<Outlet context={ctx} />}>
              <Route index element={<UsersPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AntdApp>,
    )
    expect(await screen.findByText('alice')).toBeInTheDocument()
    expect(screen.getByText('bob')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建用户' })).toBeInTheDocument()
  })
})

describe('AdminUsersPage 创建后刷新（回归：issue #46 浏览器实测发现）', () => {
  it('提交新建成功后重新拉取用户列表（listAdminUsers 至少两次）', async () => {
    const { listAdminUsers } = await import('../../lib/api')
    const spy = vi.mocked(listAdminUsers)
    spy.mockClear()
    render(
      <AntdApp>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<Outlet context={ctx} />}>
              <Route index element={<UsersPage />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AntdApp>,
    )
    await screen.findByText('alice')
    // 打开弹窗、填表、提交
    fireEvent.click(screen.getByRole('button', { name: '新建用户' }))
    const { createAdminUser } = await import('../../lib/api')
    vi.mocked(createAdminUser).mockResolvedValueOnce({ name: 'newuser' })
    const dialog = await screen.findByRole('dialog')
    const inputs = dialog.querySelectorAll('input')
    fireEvent.change(inputs[0]!, { target: { value: 'newuser' } })
    fireEvent.change(inputs[2]!, { target: { value: 'TestPass#123' } })
    fireEvent.click(Array.from(dialog.querySelectorAll('button')).find(b => /确\s*定|OK/i.test(b.textContent!))!)
    // 等 async 链跑完
    await waitFor(() => expect(vi.mocked(createAdminUser)).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
  })
})
