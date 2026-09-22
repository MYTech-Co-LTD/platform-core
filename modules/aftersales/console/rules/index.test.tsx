// rules/index.test.tsx — 规则 CRUD：列表、新建、删除；★ 未接分页 ⇒ 不出分页控件
//
// ⚠️ antd 对「两个汉字」的按钮自动插空格 ⇒ 可访问名是「删 除」「确 定」，用正则匹配。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import RulesPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown }> = []
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const RULE = { id: 1, name: '标准比例', refundRatio: 0.5, remark: null, createdAt: '2026-09-16T00:00:00Z' }

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ id: 2 })
    if (init?.method === 'DELETE') return json({ ok: true })
    // #155 起真机回 {items,total,page,size}——替身钉在真实形状上（AGENTS.md #11）
    return json({ items: [RULE], total: 1, page: 1, size: 20 })
  })
})
afterEach(cleanup)

describe('规则页', () => {
  it('渲染规则行，比例按百分数展示', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
    expect(screen.getByText('50.00%')).toBeInTheDocument()
  })

  it('★ API 已回 total 但 console 未接分页（#155 只做 API 面）⇒ 不出现分页控件', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })

  it('新建：提交体带 name/refundRatio，成功后刷新列表', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /新\s*建\s*规\s*则/ }))
    fireEvent.change(await screen.findByLabelText('名称'), { target: { value: '新规' } })
    fireEvent.change(screen.getByLabelText('退款比例（0–1）'), { target: { value: '0.25' } })
    // Modal 的确定按钮：antd 对两个汉字插空格
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/api/modules/aftersales/rules')).toBe(true))
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: '新规', refundRatio: 0.25 })
    // 刷新：GET /rules 至少被调用两次（初次 + 新建后）
    expect(calls.filter((c) => c.method === undefined && c.url === '/api/modules/aftersales/rules').length).toBeGreaterThanOrEqual(2)
  })

  it('删除要经确认，确认后发 DELETE /rules/:id', async () => {
    render(<RulesPage />)
    await waitFor(() => expect(screen.getByText('标准比例')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /删\s*除/ }))
    fireEvent.click(await screen.findByRole('button', { name: /确\s*定/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/modules/aftersales/rules/1')).toBe(true),
    )
  })
})
