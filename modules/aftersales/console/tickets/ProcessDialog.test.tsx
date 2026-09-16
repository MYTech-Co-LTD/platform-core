// ProcessDialog.test.tsx — 三种 amountType 的提交体形状 + ★「提交前无任何金额」+ 409 分支
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { ProcessDialog } from './ProcessDialog'

const m = vi.mocked(platformFetch)
const sends: Array<{ url: string; body: unknown }> = []

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

beforeEach(() => {
  sends.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      sends.push({ url, body: JSON.parse(String(init.body)) })
      return json({ ok: true, id: 7, status: 'completed', amountType: 'ratio', amountMinor: 12345 })
    }
    return json({ error: 'NOT_FOUND' }, 404)
  })
})
afterEach(cleanup)

function open() {
  render(<ProcessDialog ticketId={7} open onClose={() => {}} onDone={() => {}} />)
}

describe('ProcessDialog', () => {
  it('ratio：提交体是 { amountType: ratio, refundRatio }（不带空备注）', async () => {
    open()
    fireEvent.click(screen.getByText('按比例退款'))
    fireEvent.change(screen.getByLabelText('退款比例'), { target: { value: '0.5' } })
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.url).toBe('/api/modules/aftersales/tickets/7/process')
    expect(sends[0]!.body).toEqual({ amountType: 'ratio', refundRatio: 0.5 })
  })

  it('★ 提交前【不出现】任何金额；提交后展示的是服务端返回的金额', async () => {
    open()
    fireEvent.click(screen.getByText('按比例退款'))
    fireEvent.change(screen.getByLabelText('退款比例'), { target: { value: '0.5' } })
    // 填了比例之后、提交之前：页面上不该有任何 ¥ 金额（前端不引入第二份金额公式）
    expect(screen.queryByText(/¥/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    // 服务端返回 12345 分 ⇒ 展示 ¥123.45
    await waitFor(() => expect(screen.getByText(/¥123\.45/)).toBeInTheDocument())
  })

  it('fixed：提交体是 { amountType: fixed, amountMinor }（操作员填元，换算成整数分）', async () => {
    open()
    fireEvent.click(screen.getByText('固定金额退款'))
    fireEvent.change(screen.getByLabelText('退款金额（元）'), { target: { value: '12.34' } })
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.body).toEqual({ amountType: 'fixed', amountMinor: 1234 })
  })

  it('reject：只带 amountType（无备注时不带 remark 键）', async () => {
    open()
    fireEvent.click(screen.getByText('驳回'))
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(sends.length).toBe(1))
    expect(sends[0]!.body).toEqual({ amountType: 'reject' })
  })

  it('409 ALREADY_PROCESSED → 明确提示「已被他人处理」，不是笼统报错', async () => {
    m.mockImplementation(async () => json({ error: 'ALREADY_PROCESSED' }, 409))
    open()
    fireEvent.click(screen.getByText('驳回'))
    fireEvent.click(screen.getByRole('button', { name: /提\s*交/ }))
    await waitFor(() => expect(screen.getByText(/已被他人处理/)).toBeInTheDocument())
  })
})
