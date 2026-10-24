// pages/admin/OrgTree.test.tsx — 组织架构页渲染冒烟（账户和权限体系 Task 9）
//
// mock lib/api（页面契约面）；经嵌套路由的 Outlet context 注入会话（Users.test.tsx 同款）。
// 授角色语义的单测钉在 onGrant 的关键分支：对变更角色调 setAdminRoleMembers（整组替换）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
import type { ConsoleOutletContext } from '../Console'

const { setAdminRoleMembers } = vi.hoisted(() => ({
  setAdminRoleMembers: vi.fn(async () => ({ ok: true })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  getAdminOrgTree: vi.fn(async () => ({
    tree: [
      {
        name: 'hq', displayName: '总部', parentId: 'myorg', orphan: false, memberCount: 2,
        children: [{ name: 'shop-a', displayName: 'A 店', parentId: 'hq', orphan: false, memberCount: 1, children: [] }],
      },
    ],
  })),
  listAdminMembers: vi.fn(async (group?: string) => ({
    users:
      group === 'shop-a'
        ? [{ name: 'u1', displayName: '店员一', isForbidden: false, roles: ['店长'] }]
        : [
            { name: 'u1', displayName: '店员一', isForbidden: false, roles: ['店长'] },
            { name: 'u2', displayName: '店员二', isForbidden: true, roles: [] },
          ],
  })),
  listAdminRoles: vi.fn(async () => ({
    roles: [{ name: '店长', displayName: '店长', members: 1, codes: ['demo:view'], users: ['u1'] }],
  })),
  setAdminRoleMembers,
}))

import OrgTreePage from './OrgTree'

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

function renderPage() {
  return render(
    <AntdApp>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<Outlet context={ctx} />}>
            <Route index element={<OrgTreePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AntdApp>,
  )
}

describe('AdminOrgTreePage 渲染冒烟', () => {
  it('树节点与全员成员表出现（含禁用标记）', async () => {
    renderPage()
    expect(await screen.findByText(/总部/)).toBeInTheDocument()
    expect(await screen.findByText(/A 店/)).toBeInTheDocument()
    expect(await screen.findByText('店员一')).toBeInTheDocument()
    expect(await screen.findByText('店员二')).toBeInTheDocument()
    expect(screen.getByText('已禁用')).toBeInTheDocument()
  })

  it('选中部门节点 → 按该节点拉成员', async () => {
    const { listAdminMembers } = await import('../../lib/api')
    renderPage()
    await screen.findByText('店员一')
    fireEvent.click(screen.getByText(/A 店/))
    await waitFor(() => {
      expect(listAdminMembers).toHaveBeenLastCalledWith('shop-a')
    })
    expect(await screen.findByText('店员一')).toBeInTheDocument()
  })

  it('授角色：对变更角色整组替换（现成员 ± 该用户），未变更角色不发调用', async () => {
    renderPage()
    // 全员视图第一行 = 店员一（已有 店长）
    const rows = await screen.findAllByText('授角色')
    fireEvent.click(rows[0])
    await screen.findByText(/授予角色/)
    // 弹窗 destroyOnClose：等 Select 渲染出已选项的移除图标（比下拉点击更确定）
    const remove = await waitFor(() => {
      const el = document.querySelector('.ant-select-selection-item-remove')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    fireEvent.click(remove) // 移除 店长（现成员 [u1] → 勾选态变为空）
    const okBtn = await waitFor(() => {
      const el = document.querySelector('.ant-modal-footer .ant-btn-primary')
      expect(el).not.toBeNull()
      return el as HTMLElement
    })
    fireEvent.click(okBtn)
    await waitFor(() => {
      expect(setAdminRoleMembers).toHaveBeenCalledWith('店长', []) // 现成员 [u1] − u1 = []
    })
    expect(setAdminRoleMembers).toHaveBeenCalledTimes(1)
  })
})
