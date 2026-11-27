// employees/index.test.tsx — 人员页：员工档案 + 身份绑定（#2941）。
//
// 审批请求体是 `{ approveStatus }`；身份绑定列从 `/identity-links` 派生，写操作走同一组端点。
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

const EMP = {
  id: 1, name: '张三', phone: '13800000000', storeCode: 'S1', openId: 'o1', approveStatus: 'pending',
}
const LINK = {
  id: 11, org: 'test', provider: 'wechat-oa', externalId: 'o1', casdoorName: 'zhangsan',
  status: 'pending', phoneMasked: '138****00', boundVia: 'auto', sourceApprovalId: null,
  disputedAt: null, boundAt: null, revokedAt: null, revokedBy: null, createdAt: '2026-11-27T00:00:00Z',
}

function mockData(links: unknown[] = [LINK]) {
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ ok: true })
    if (url.includes('/identity-links')) return json({ items: links })
    if (url.includes('/employees')) return json({ items: [EMP], total: 1, page: 1, size: 100 })
    return json({ error: 'NOT_FOUND' }, 404)
  })
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  mockData()
})
afterEach(cleanup)

describe('人员页', () => {
  it('列表渲染，待审批显示「通过」「驳回」', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(screen.getByText('S1')).toBeInTheDocument()
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

  it('★ 身份绑定列：公众号 openid 关联；点开抽屉可确认', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    // 派生摘要：LINK 是 pending ⇒ 待确认
    expect(screen.getByText('待确认')).toBeInTheDocument()

    fireEvent.click(screen.getByText('待确认'))
    await waitFor(() => expect(screen.getByText('张三 · 身份绑定')).toBeInTheDocument())
    expect(screen.getAllByText('o1').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'POST'
        && c.url === '/api/modules/aftersales/identity-links/11/confirm')).toBe(true),
    )
    // 等操作后的 reload 落地，避免 teardown 时还有 setState 在排队
    await waitFor(() =>
      expect(calls.filter((c) => c.url === '/api/modules/aftersales/identity-links').length)
        .toBeGreaterThanOrEqual(2),
    )
  })

  it('★ 未归属绑定：openid 匹配不上员工的绑定单独查看', async () => {
    mockData([{ ...LINK, id: 12, externalId: 'o999' }])
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(screen.getByText(/未归属绑定（1）/)).toBeInTheDocument()

    fireEvent.click(screen.getByText(/未归属绑定（1）/))
    await waitFor(() => expect(screen.getByText('o999')).toBeInTheDocument())
    expect(screen.getByText(/按公众号 openid 关联员工/)).toBeInTheDocument()
  })

  it('无分页控件（员工量级小；一次拉全）', async () => {
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
  it('★ /identity-links 503 ⇒ 员工档案仍显示，绑定列降级', async () => {
    m.mockImplementation(async (url: string) => {
      if (url.includes('/identity-links')) return json({ error: 'IDENTITY_LINKS_UNAVAILABLE' }, 503)
      if (url.includes('/employees')) return json({ items: [EMP], total: 1, page: 1, size: 100 })
      return json({ error: 'NOT_FOUND' }, 404)
    })
    render(<EmployeesPage />)
    await waitFor(() => expect(screen.getByText('张三')).toBeInTheDocument())
    expect(screen.getByText('绑定信息不可用')).toBeInTheDocument()
    expect(screen.getByText('身份绑定数据暂不可用，人员档案仍可查看。')).toBeInTheDocument()
  })

})
