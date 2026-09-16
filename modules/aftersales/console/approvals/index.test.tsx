// approvals/index.test.tsx — 申请审批页：列表、通过/驳回、已决不显示操作、无分页
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ApprovalsPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown }> = []
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

const PENDING = {
  id: 7,
  openId: 'o1',
  approveType: 'register',
  status: 'pending',
  oldInfo: {},
  newInfo: { name: '张三', phone: '138', storeIds: [1] },
  createdAt: '2026-09-16T00:00:00Z',
  decidedAt: null,
  decidedBy: null,
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ ok: true })
    return json({ items: [PENDING] })
  })
})
afterEach(cleanup)

describe('申请审批页', () => {
  it('渲染待审申请：申请人、类型、变更内容', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    expect(screen.getByText('注册')).toBeInTheDocument()
    // diffText 把 new_info 摊成「字段: 值」
    expect(screen.getByText(/张三/)).toBeInTheDocument()
  })

  it('★ 通过 ⇒ POST /employee-approvals/7/decide { decision: "approve" }，并刷新列表', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    // antd 给两个汉字的按钮插空格 ⇒ 可访问名是「通 过」
    fireEvent.click(screen.getByRole('button', { name: /通\s*过/ }))
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.url === '/api/modules/aftersales/employee-approvals/7/decide'),
      ).toBe(true),
    )
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ decision: 'approve' })
    // 刷新：GET 至少两次（初次 + 决定后）。⚠️ 必须放进 waitFor —— reload 是异步生效的，
    //    POST 落地后立刻断言会撞竞态（实施时实测：拿到 1）。
    await waitFor(() => expect(calls.filter((c) => c.method === undefined).length).toBeGreaterThanOrEqual(2))
  })

  it('驳回发的是 decision: "reject"', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/decide'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/decide'))!.body).toEqual({ decision: 'reject' })
  })

  it('已决的申请不显示操作按钮，改显示决定人', async () => {
    m.mockImplementation(async () => json({ items: [{ ...PENDING, status: 'approved', decidedBy: '管理员' }] }))
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /通\s*过/ })).toBeNull()
    expect(screen.getByText('管理员')).toBeInTheDocument()
  })

  it('★ 接口失败时显示可展示的错误文案，不白屏', async () => {
    m.mockImplementation(async () => json({ error: 'FORBIDDEN' }, 403))
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('没有权限执行该操作')).toBeInTheDocument())
  })

  it('★ 无 total ⇒ 不出现分页控件', async () => {
    render(<ApprovalsPage />)
    await waitFor(() => expect(screen.getByText('o1')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
