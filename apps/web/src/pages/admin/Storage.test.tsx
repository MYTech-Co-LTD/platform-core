// pages/admin/Storage.test.tsx — 存储配置页最小渲染冒烟（M3c）
//
// 形状照 Users.test.tsx（mock lib/api + MemoryRouter + Outlet context + AntdApp）。
// 三条用例各钉一个**会在真机上出错**的点：
//   ① 未配置 + 有平台默认 ⇒ 必须说「走平台默认」而不是报警（否则每个新租户开屏就见红）；
//   ② 保存成功后要**重新拉取**（掩码与三态告示都靠它刷新，不刷新页面就停在旧状态）；
//   ③ 测试连接失败要显示**分类**（HTTP_403），不是「操作失败」四个字——后者用户无从下手。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom'
import { App as AntdApp } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
import type { ConsoleOutletContext } from '../Console'

// ApiError 的替身要能带 reason/detail（真实类的形状）——第三条用例靠它证明页面把分类显示出来了
vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    constructor(readonly code: string, readonly reason?: string, readonly detail?: string) {
      super(code)
    }
  },
  getAdminStorage: vi.fn(async () => ({
    configured: false, partial: false,
    endpoint: '', region: '', bucket: '', accessKeyIdMasked: '',
    platformFallback: true,
  })),
  saveAdminStorage: vi.fn(async () => ({ ok: true })),
  testAdminStorage: vi.fn(async () => ({ ok: true })),
  clearAdminStorage: vi.fn(async () => ({ ok: true })),
}))

import StoragePage from './Storage'

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
            <Route index element={<StoragePage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AntdApp>,
  )
}

describe('AdminStoragePage 渲染冒烟', () => {
  it('未配置 + 有平台默认 ⇒ 说「使用平台默认存储」，且不报警', async () => {
    renderPage()
    expect(await screen.findByText(/本租户附件使用平台默认存储/)).toBeInTheDocument()
    expect(screen.queryByText(/附件功能不可用/)).toBeNull()
    expect(screen.getByRole('button', { name: /保\s*存/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '测试连接' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '清除配置' })).toBeInTheDocument()
  })

  it('保存成功后重新拉取配置（getAdminStorage 至少两次）', async () => {
    const api = await import('../../lib/api')
    const getSpy = vi.mocked(api.getAdminStorage)
    getSpy.mockClear()
    // 已配态的租户**再保存**（改 bucket 是真实动作）：表单有值 ⇒ 必填校验通过
    getSpy.mockResolvedValueOnce({
      configured: true, partial: false, endpoint: 'zos.acme.test', region: 'xinan1', bucket: 'b1',
      accessKeyIdMasked: 'AKIA****', platformFallback: true,
    })
    renderPage()
    await screen.findByText(/本租户附件写入你自己的桶/)
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(vi.mocked(api.saveAdminStorage)).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(getSpy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 })
  })

  it('测试连接失败 ⇒ 把服务端给的分类显示出来（不是「操作失败」四个字）', async () => {
    const api = await import('../../lib/api')
    const ApiErrorCtor = api.ApiError as unknown as new (code: string, reason?: string, detail?: string) => Error
    vi.mocked(api.testAdminStorage).mockRejectedValueOnce(
      new ApiErrorCtor('STORAGE_PROBE_FAILED', 'HTTP_403', 'zos.acme.test: 403'),
    )
    renderPage()
    await screen.findByText(/本租户附件使用平台默认存储/)
    fireEvent.click(screen.getByRole('button', { name: '测试连接' }))
    expect(await screen.findByText(/HTTP_403/)).toBeInTheDocument()
    // detail（endpoint host）也要露出来——用户要据此判断「是不是这台机器连不上那个桶」
    expect(screen.getByText(/zos\.acme\.test: 403/)).toBeInTheDocument()
  })
})
