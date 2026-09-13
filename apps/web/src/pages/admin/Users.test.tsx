// pages/admin/Users.test.tsx — 用户管理页最小渲染冒烟（M3，issue #46）
//
// mock lib/api（页面契约面）；经嵌套路由的 Outlet context 注入会话（useOutletContext 的真实链路）。
import '@testing-library/jest-dom/vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { describe, expect, it, vi } from 'vitest'
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
  branding: { productName: 'P', logo: null, primaryColor: '#1677ff', background: '', loginMethods: ['password'] },
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
