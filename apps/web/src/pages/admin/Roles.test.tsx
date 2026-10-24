// pages/admin/Roles.test.tsx — 角色管理页冒烟（账户和权限体系 Task 10）
//
// mock lib/api（Users.test.tsx 同款模式）；钉四个写路径：建角色 / 删角色 / 成员整组替换 / 码差分挂收。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
import type { ConsoleOutletContext } from '../Console'

const { createAdminRole, deleteAdminRole, setAdminRoleMembers, grantAdminPermissionRole, revokeAdminPermissionRole } =
  vi.hoisted(() => ({
    createAdminRole: vi.fn(async () => ({ ok: true })),
    deleteAdminRole: vi.fn(async () => ({ ok: true })),
    setAdminRoleMembers: vi.fn(async () => ({ ok: true })),
    grantAdminPermissionRole: vi.fn(async () => ({ ok: true })),
    revokeAdminPermissionRole: vi.fn(async () => ({ ok: true })),
  }))

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  listAdminRoles: vi.fn(async () => ({
    roles: [{ name: '店长', displayName: '门店店长', members: 1, codes: ['demo:view'], users: ['u1'] }],
  })),
  listAdminMembers: vi.fn(async () => ({
    users: [
      { name: 'u1', displayName: '店员一', isForbidden: false, roles: ['店长'] },
      { name: 'u2', displayName: '店员二', isForbidden: false, roles: [] },
    ],
  })),
  listAdminPermissions: vi.fn(async () => ({
    permissions: [
      { code: 'demo:view', name: '演示查看', users: [] },
      { code: 'demo:manage', name: '演示管理', users: [] },
    ],
  })),
  createAdminRole,
  deleteAdminRole,
  setAdminRoleMembers,
  grantAdminPermissionRole,
  revokeAdminPermissionRole,
}))

import RolesPage from './Roles'

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
            <Route index element={<RolesPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AntdApp>,
  )
}

const okBtn = async () => {
  await waitFor(() => {
    expect(document.querySelector('.ant-modal-footer .ant-btn-primary')).not.toBeNull()
  })
  fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary') as HTMLElement)
}

describe('AdminRolesPage 渲染冒烟', () => {
  it('角色表出现（名称/成员数/挂码）+ 新建入口', async () => {
    renderPage()
    expect(await screen.findByText('门店店长')).toBeInTheDocument()
    expect(screen.getByText('demo:view')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建角色' })).toBeInTheDocument()
  })

  it('新建角色：表单提交调 createAdminRole', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: '新建角色' }))
    fireEvent.change(await screen.findByLabelText('角色名（标识）'), { target: { value: 'region-manager' } })
    fireEvent.change(screen.getByLabelText('显示名（可选）'), { target: { value: '区域经理' } })
    await okBtn()
    await waitFor(() => {
      expect(createAdminRole).toHaveBeenCalledWith({ name: 'region-manager', displayName: '区域经理' })
    })
  })

  it('编辑角色：成员勾选变化 → setAdminRoleMembers 整组替换；码勾选差分 → grant', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('编辑'))
    // 候选集是异步加载——先等两组的文本真实渲染（CI 慢机时序下，拿旧数组点会点到 detached 节点，
    // onChange 不触发 ⇒ 保存的是初始勾选态。教训：勾选类断言一律先 findByText 再 getByLabelText）
    await screen.findByText('店员二（u2）')
    await screen.findByText('demo:manage')
    fireEvent.click(screen.getByLabelText('店员二（u2）')) // 现成员 [u1] → [u1,u2]
    fireEvent.click(screen.getByLabelText('demo:manage')) // 原 codes [demo:view] → 差分 grant
    await okBtn()
    await waitFor(() => {
      expect(setAdminRoleMembers).toHaveBeenCalledWith('店长', ['u1', 'u2'])
      expect(grantAdminPermissionRole).toHaveBeenCalledWith('demo:manage', '店长')
    })
    expect(revokeAdminPermissionRole).not.toHaveBeenCalled()
    expect(deleteAdminRole).not.toHaveBeenCalled()
  })

  it('删除角色：确认后调 deleteAdminRole', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('删除'))
    // AntdApp 未配 zh-CN locale → Popconfirm 默认按钮文案为 OK
    fireEvent.click(await screen.findByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(deleteAdminRole).toHaveBeenCalledWith('店长')
    })
  })
})
