// employees/index.test.tsx — 员工列表 + 审批；★ 无 total ⇒ 无分页控件
//
// ⚠️ 审批的请求体是 `{ approveStatus }`（枚举字符串），**不是** `{ approve: boolean }`
//    ——以 `routes/masterdata.ts` 的 `ApproveBody` 为准。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import EmployeesPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown }> = []
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

const EMP = { id: 1, name: '张三', phone: '13800000000', storeId: 1, openId: 'o1', approveStatus: 'pending' }

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ ok: true })
    return json({ items: [EMP] })
  })
})
afterEach(cleanup)

describe('员工页', () => {
  it('列表渲染，待审批显示「通过」「驳回」', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /通\s*过/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /驳\s*回/ })).toBeInTheDocument()
  })

  it('★ 审批打 POST /employees/:id/approve，体是 { approveStatus: "approved" }', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /通\s*过/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST' && c.url === '/api/modules/aftersales/employees/1/approve')).toBe(true),
    )
    expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({ approveStatus: 'approved' })
  })

  it('驳回发的是 approveStatus: "rejected"', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/approve'))).toBe(true))
    expect(calls.find((c) => c.url.endsWith('/approve'))!.body).toEqual({ approveStatus: 'rejected' })
  })

  it('★ 无 total ⇒ 不出现分页控件', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
