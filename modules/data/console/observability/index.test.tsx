// index.test.tsx — 运行观测页：四块渲染、状态灯文字、对账下钻请求参数。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import ObservabilityPage from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const BODY = {
  generatedAt: '2026-11-22T10:00:00.000Z',
  schedules: [
    {
      key: 'data.dbt_tick', cron: '2-59/10 1-15 * * *', timezone: 'UTC', enabled: true,
      nextRunAt: '2026-11-22T10:12:00.000Z',
      lastRun: { status: 'ok', at: '2026-11-22T10:02:00.000Z', durationMs: 31300, exitCode: 0, error: null },
      fails24h: 0,
    },
    {
      key: 'data.dbt_tables', cron: '25 2 * * *', timezone: 'UTC', enabled: true,
      nextRunAt: '2026-11-23T02:25:00.000Z',
      lastRun: { status: 'timeout', at: '2026-11-22T02:25:00.000Z', durationMs: 5400000, exitCode: null, error: 'timeout' },
      fails24h: 1,
    },
  ],
  assertions: {
    rows: [
      { group: 'core', check: 'dns', verdict: 'ok', detail: 'OK pg_duckdb→172.19.0.2', at: '2026-11-22T09:58:00.000Z' },
      { group: 'core', check: 'swap_offset', verdict: 'warn', detail: 'WARN 本月抵扣额 7353.99', at: '2026-11-22T09:58:00.000Z' },
    ],
    coreAt: '2026-11-22T09:58:00.000Z',
    ooAt: null,
  },
  lake: { hourFiles: 17, hourOldest: '2026-11-22', dayFiles: 1565, dayNewest: '2026-11-21', monthFiles: 52, sealedMax: '2026-11-21', monthIndexMax: '2026-11' },
  materialization: [{ relation: 'fct_retail_sale', status: 'ok', maxBizday: '2026-11-22', materializedAt: '2026-11-22T09:58:00.000Z' }],
  recon: {
    windowDays: 7, storeDays: 2174, overTol: 6, withinTol: 2168, overTolDiffSum: 3407.94,
    byAttribution: [{ attribution: 'swap_split_unrecognized', n: 6, swapOffset: 3407.94 }],
    topBranches: [{ systemBook: '3120', bizday: '2026-11-20', branchNum: 129, diff: 281.6, attribution: 'swap_split_unrecognized', swapOffset: 34 }],
  },
  warnings: [],
}

beforeEach(() => { m.mockReset() })
afterEach(() => cleanup())

describe('运行观测页', () => {
  it('渲染四块：调度状态灯、体检结果、湖数字、对账汇总', async () => {
    m.mockResolvedValueOnce(json(BODY))
    render(<ObservabilityPage />)
    await waitFor(() => expect(screen.getByText('data.dbt_tick')).toBeInTheDocument())
    // 失败档位用文字标签表达（不只靠颜色）
    expect(screen.getByText('超时')).toBeInTheDocument()
    // 体检：ok / warn 两种标签都在（「正常」在多处出现——调度与体检都用同一套状态词）
    expect(screen.getAllByText('正常').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('观察')).toBeInTheDocument()
    expect(screen.getByText('swap_offset')).toBeInTheDocument()
    // 湖
    expect(screen.getByText(/1565 个/)).toBeInTheDocument()
    // 对账汇总
    expect(screen.getAllByText(/差异合计/).length).toBeGreaterThanOrEqual(1)
  })

  it('点对账门店行 ⇒ 下钻请求带 book/bizday/branch，抽屉显示明细', async () => {
    m.mockResolvedValueOnce(json(BODY))
    m.mockResolvedValueOnce(json({ total: 1, rows: [{
      system_book: '3120', bizday: '2026-11-20', branch_num: 129, control: 'sale_amount',
      platform_value: '100.00', source_value: '110.00', diff: '-10.00', tol_applied: '0.01',
      bound_by: 'swap_offset', verdict: 'over_tol', missing_side: null, reason_code: null,
      disposition: null, attribution: 'swap_split_unrecognized', swap_offset: '34.00',
      computed_at: '2026-11-21T00:00:00.000Z',
    }] }))
    render(<ObservabilityPage />)
    await waitFor(() => expect(screen.getByText('129')).toBeInTheDocument())
    fireEvent.click(screen.getByText('129'))
    await waitFor(() => expect(screen.getByText(/sale_amount/)).toBeInTheDocument())
    const url = String(m.mock.calls[1]?.[0] ?? '')
    expect(url).toContain('book=3120')
    expect(url).toContain('bizday=2026-11-20')
    expect(url).toContain('branch=129')
    expect(url).toContain('verdict=over_tol')
  })
})
