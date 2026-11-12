// changes/index.test.tsx — 待核对页：默认层给「数与差异」，决策只有两个按钮。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ChangesPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const PENDING = {
  changes: [{
    id: 7, metricId: 'x:net_sales', kind: 'create', status: 'preview_ready',
    payload: { baseMetric: 'b:sales', op: { kind: 'refine' }, alias: '净销售额（财务）' },
    preview: { window: { from: '2026-11-04', to: '2026-11-11' }, value: 1102340.12, rows: 12,
      baseline: { id: 'b:sales', value: 1234567.89, deltaPct: -10.71 }, sample: [] },
    submittedBy: 'agent', submittedChannel: 'pat', submittedAt: '2026-11-12T02:00:00Z',
    decidedBy: null, decidedAt: null, rejectReason: null,
  }],
}

beforeEach(() => {
  m.mockReset()
  m.mockImplementation(async (url: string | URL, init?: RequestInit) => {
    const u = String(url)
    if (u.includes('/metric-changes') && (init?.method ?? 'GET') === 'GET') return json(PENDING)
    if (u.includes('/adopt') || u.includes('/reject')) return json({ ok: true })
    return json({})
  })
})
afterEach(cleanup)

describe('待核对页', () => {
  it('默认层：指标 / 类型 / 试算值 vs 参照值 Δ；动作只有采纳与驳回', async () => {
    render(<ChangesPage />)
    await waitFor(() => expect(screen.getByText(/x:net_sales/)).toBeInTheDocument())
    expect(screen.getByText(/1,102,340/)).toBeInTheDocument()       // 试算值（JSON 快照里是无千分位裸数，不撞）
    // 差异在默认层句子与展开层快照 JSON（deltaPct 裸数）各出现一次 ⇒ getAllByText（同报表页量尺行先例）
    expect(screen.getAllByText(/−?10\.71/).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /采\s*纳/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /驳\s*回/ })).toBeInTheDocument()
    // 原始声明/快照收进展开层（TechDetails）
    expect(document.querySelectorAll('details').length).toBeGreaterThan(0)
  })

  it('驳回必填原因：空原因点驳回不发请求', async () => {
    render(<ChangesPage />)
    await waitFor(() => expect(screen.getByText(/x:net_sales/)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /驳\s*回/ }))
    const calls = m.mock.calls.filter(([u, i]) => String(u).includes('/reject') && i?.method === 'POST')
    expect(calls.length).toBe(0)
  })
})
