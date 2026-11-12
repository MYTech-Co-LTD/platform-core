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

  it('draft/preview_failed 行（P0 终审 F1）：驳回可用、采纳仍禁；「跑试算」补跑后列表刷新；draft 显「试算还没跑完」', async () => {
    const DRAFT_ROW = {
      id: 9, metricId: 'x:draft_one', kind: 'meta', status: 'draft',
      payload: { unit: '元' }, preview: null,
      submittedBy: 'agent', submittedChannel: 'mcp', submittedAt: '2026-11-12T03:00:00Z',
      decidedBy: null, decidedAt: null, rejectReason: null,
    }
    const FAILED_ROW = {
      ...DRAFT_ROW, id: 10, metricId: 'x:failed_one', status: 'preview_failed',
      preview: { error: 'METRIC_NOT_FOUND', ranAt: '2026-11-12T03:01:00Z' },
    }
    let list: { changes: Record<string, unknown>[] } = { changes: [DRAFT_ROW, FAILED_ROW] }
    m.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/metric-changes') && (init?.method ?? 'GET') === 'GET') return json(list)
      if (u.includes('/preview') && init?.method === 'POST') {
        // 补跑成功：draft 行翻 preview_ready，重进待办；failed 行留在原地
        list = { changes: [{ ...DRAFT_ROW, status: 'preview_ready', preview: { value: 3, rows: 1 } }, FAILED_ROW] }
        return json({ ok: true })
      }
      if (u.includes('/adopt') || u.includes('/reject')) return json({ ok: true })
      return json({})
    })
    render(<ChangesPage />)
    await waitFor(() => expect(screen.getByText(/x:draft_one/)).toBeInTheDocument())
    // draft 行的默认层句子是「试算还没跑完」，不是裸的「试算 —（0 行）」
    expect(screen.getByText('试算还没跑完')).toBeInTheDocument()
    // 两行都未到 preview_ready ⇒ 采纳全禁；驳回对全部未决态可用
    const adoptButtons = screen.getAllByRole('button', { name: /采\s*纳/ })
    expect(adoptButtons.length).toBe(2)
    expect(adoptButtons.every((b) => b.hasAttribute('disabled'))).toBe(true)
    const rejectButtons = screen.getAllByRole('button', { name: /驳\s*回/ })
    expect(rejectButtons.length).toBe(2)
    expect(rejectButtons.every((b) => !b.hasAttribute('disabled'))).toBe(true)
    // 「跑试算」只在 draft/preview_failed 行出现；点 draft 行的 → POST /preview → 列表刷新
    expect(screen.getAllByRole('button', { name: /跑试算/ }).length).toBe(2)
    fireEvent.click(screen.getAllByRole('button', { name: /跑试算/ })[0])
    await waitFor(() => expect(
      m.mock.calls.some(([u, i]) => String(u).endsWith('/metric-changes/9/preview') && i?.method === 'POST'),
    ).toBe(true))
    // 刷新后 draft 行已是 preview_ready：句子里有试算值，且不再有它的「跑试算」（只剩 failed 行那颗）
    await waitFor(() => expect(screen.getByText(/x:draft_one/)).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: /跑试算/ }).length).toBe(1)
    expect(screen.getByText('试算 3（1 行）')).toBeInTheDocument()
  })

  it('试算历史（P1 Task 5）：有 previewHistory 的行在展开层显「之前试过 N 次」，无历史行不显', async () => {
    const HIST_ROW = {
      ...PENDING.changes[0]!, id: 11, metricId: 'x:with_hist',
      previewHistory: [
        { window: { from: '2026-11-04', to: '2026-11-11' }, value: 900, rows: 12 },
        { window: { from: '2026-10-28', to: '2026-11-04' }, value: 800, rows: 11 },
      ],
    }
    m.mockImplementation(async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      if (u.includes('/metric-changes') && (init?.method ?? 'GET') === 'GET') {
        return json({ changes: [PENDING.changes[0]!, HIST_ROW] })
      }
      return json({})
    })
    render(<ChangesPage />)
    await waitFor(() => expect(screen.getByText(/x:with_hist/)).toBeInTheDocument())
    // 展开层（TechDetails）里有人话提示，不在默认层句子
    expect(screen.getByText(/之前试过 2 次/)).toBeInTheDocument()
    // 无历史的行（PENDING 第一行 previewHistory 缺席）不得出现该提示
    expect(screen.queryByText(/之前试过 0 次/)).not.toBeInTheDocument()
  })
})
