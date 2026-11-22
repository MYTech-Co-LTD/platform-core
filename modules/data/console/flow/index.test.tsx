// index.test.tsx — 全流程页（单域卡片形态，#2689）：域切分、六卡渲染、切换域。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import FlowPage, { domainsOf } from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const N = (id: string, kind: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind, label, x: 0, y: 0, ...extra })
const E = (source: string, target: string) => ({ source, target })

const BODY = {
  generatedAt: '2026-11-22T12:00:00.000Z',
  notes: [],
  nodes: [
    N('src:lemeng.retail_order_line', 'source', 'lemeng.retail_order_line'),
    N('pipe:lemeng/retail_order_line', 'pipeline', 'retail_order_line', { count: 2, members: ['p1', 'p2'] }),
    N('lake:lemeng/retail_order_line', 'lake', 'lemeng/retail_order_line'),
    N('stg:stg_lemeng_retail_order_line', 'staging', 'stg_lemeng_retail_order_line'),
    N('mart:fct_retail_sale', 'mart', 'fct_retail_sale'),
    N('mart:recon_fact', 'recon', 'recon_fact'),
    N('met:sales', 'metric', 'sales', { count: 12 }),
    N('src:lemeng.member_summary', 'source', 'lemeng.member_summary'),
    N('pipe:lemeng/member_summary', 'pipeline', 'member_summary', { count: 1, members: ['p3'] }),
    N('lake:lemeng/member_summary', 'lake', 'lemeng/member_summary'),
    N('stg:stg_lemeng_member_summary', 'staging', 'stg_lemeng_member_summary'),
    N('mart:fct_member_summary', 'mart', 'fct_member_summary'),
    N('met:member', 'metric', 'member', { count: 3 }),
  ],
  edges: [
    E('src:lemeng.retail_order_line', 'pipe:lemeng/retail_order_line'),
    E('pipe:lemeng/retail_order_line', 'lake:lemeng/retail_order_line'),
    E('lake:lemeng/retail_order_line', 'stg:stg_lemeng_retail_order_line'),
    E('stg:stg_lemeng_retail_order_line', 'mart:fct_retail_sale'),
    E('stg:stg_lemeng_retail_order_line', 'mart:recon_fact'),
    E('mart:fct_retail_sale', 'met:sales'),
    E('src:lemeng.member_summary', 'pipe:lemeng/member_summary'),
    E('pipe:lemeng/member_summary', 'lake:lemeng/member_summary'),
    E('lake:lemeng/member_summary', 'stg:stg_lemeng_member_summary'),
    E('stg:stg_lemeng_member_summary', 'mart:fct_member_summary'),
    E('mart:fct_member_summary', 'met:member'),
  ],
}

beforeEach(() => { m.mockReset() })
afterEach(() => cleanup())

describe('domainsOf（按湖前缀切域）', () => {
  it('两个湖 ⇒ 两个域，各自带六层成员；对账族标出', () => {
    const d = domainsOf(BODY as never)
    expect(d.map((x) => x.key)).toEqual(['member_summary', 'retail_order_line'])
    const retail = d.find((x) => x.key === 'retail_order_line')!
    expect(retail.sources).toEqual(['lemeng.retail_order_line'])
    expect(retail.pipelines[0].count).toBe(2)
    expect(retail.staging).toEqual(['stg_lemeng_retail_order_line'])
    expect(retail.marts).toEqual([
      { name: 'fct_retail_sale', kind: 'mart' },
      { name: 'recon_fact', kind: 'recon' },
    ])
    expect(retail.metrics[0].label).toBe('sales')
  })
})

describe('全流程页（卡片形态）', () => {
  it('首屏渲染六张卡，默认第一个域', async () => {
    m.mockResolvedValueOnce(json(BODY))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('源接口')).toBeInTheDocument())
    for (const t of ['源接口', '采集管线', '湖资产', 'staging', 'marts', '指标']) {
      expect(screen.getByText(t)).toBeInTheDocument()
    }
    // 默认域 = member_summary（按 key 排序第一个）
    expect(screen.getByText('lemeng/member_summary')).toBeInTheDocument()
    expect(screen.getByText('member')).toBeInTheDocument()
  })

  it('切换域 → 换成另一条链', async () => {
    m.mockResolvedValueOnce(json(BODY))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('lemeng/member_summary')).toBeInTheDocument())
    fireEvent.click(screen.getByText('retail_order_line'))
    await waitFor(() => expect(screen.getByText('lemeng/retail_order_line')).toBeInTheDocument())
    expect(screen.getByText('stg_lemeng_retail_order_line')).toBeInTheDocument()
    expect(screen.getByText('sales')).toBeInTheDocument()
    expect(screen.getByText('对账')).toBeInTheDocument()
  })
})
