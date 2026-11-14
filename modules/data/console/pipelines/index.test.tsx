// index.test.tsx — 管线地图：KPI、三层节点、账套过滤、点资产看管线清单与运行状态。
// ECharts 在 happy-dom 里没有 canvas ⇒ mock 成假图（只记录 setOption / on）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
vi.mock('echarts/core', () => ({ init: vi.fn(() => chart), use: vi.fn() }))
vi.mock('echarts/charts', () => ({ GraphChart: {} }))
vi.mock('echarts/components', () => ({ LegendComponent: {}, TooltipComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))

import { platformFetch } from '@platform/sdk/web'
import PipelinesPage from './index'

const m = vi.mocked(platformFetch)
const chart = { setOption: vi.fn(), on: vi.fn(), off: vi.fn(), resize: vi.fn() }
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const MAP = {
  generatedAt: '2026-11-14T00:00:00.000Z',
  runsWired: true,
  assets: [
    {
      lake: 'lemeng/retail_order_line',
      staging: 'stg_lemeng_retail_order_line',
      views: [],
      marts: ['fct_retail_sale'],
      pipelines: [
        { id: 'lemeng.retail_order_line.l0.3120', account: '3120', cron: '0 5 * * *', enabled: true, scheduled: true },
        { id: 'lemeng.retail_order_line.l0.64188', account: '64188', cron: '0 5 * * *', enabled: true, scheduled: true },
      ],
    },
    {
      lake: 'lemeng/no_staging_asset',
      staging: null,
      views: [],
      marts: [],
      pipelines: [{ id: 'lemeng.no_staging_asset.l0.3120', account: '3120', cron: null, enabled: false, scheduled: false }],
    },
  ],
  orphanStaging: ['stg_lemeng_orphan'],
  warnings: ['1 个湖资产没有对应的 staging 模型（链路断点）'],
  recentRuns: {
    'lemeng.retail_order_line.l0.3120': [
      { status: 'ok', at: '2026-11-14T00:00:00.000Z', durationMs: 1200 },
      { status: 'ok', at: '2026-11-13T00:00:00.000Z' },
    ],
    'lemeng.retail_order_line.l0.64188': [
      { status: 'failed', at: '2026-11-14T00:00:00.000Z', error: '封版标记 → _DAILY/: invalid date format' },
    ],
  },
}

const lastOption = () => {
  const calls = chart.setOption.mock.calls
  return calls[calls.length - 1]?.[0] as { series: Array<{ data: Array<{ id: string; label?: string }>; edges: unknown[] }> } | undefined
}

beforeEach(() => { m.mockReset(); chart.setOption.mockClear(); chart.on.mockClear() })
afterEach(() => cleanup())

describe('管线地图', () => {
  it('拉 /system-map/pipelines，KPI 与三层节点渲染', async () => {
    m.mockImplementation(async () => json(MAP))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())
    expect(screen.getByText('断点')).toBeInTheDocument()
    // staging 1 / 断点 1 / 最近失败 1 ⇒ 三个「1」（资产是 2）
    expect(screen.getByText('2')).toBeInTheDocument()
    // staging 1 / 在跑失败 1 / 断点 1 ⇒ 三个「1」
    expect(screen.getAllByText('1')).toHaveLength(3)
    await waitFor(() => expect(lastOption()?.series[0]!.data).toHaveLength(4)) // 2 资产 + 1 staging + 1 mart
  })

  it('账套过滤：选 64188 只剩那条管线对应的资产', async () => {
    m.mockImplementation(async () => json(MAP))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())
    fireEvent.click(screen.getByText('64188'))
    await waitFor(() => expect(lastOption()?.series[0]!.data.map((n) => n.id)).toEqual([
      'asset:lemeng/retail_order_line', 'staging:stg_lemeng_retail_order_line', 'mart:fct_retail_sale',
    ]))
  })

  it('点资产 ⇒ 抽屉列出管线、调度与运行状态；断点资产显示「—（断点）」', async () => {
    m.mockImplementation(async () => json(MAP))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())

    const handler = chart.on.mock.calls.filter((c) => c[0] === 'click').at(-1)?.[1] as (p: unknown) => void
    handler({ dataType: 'node', data: { kind: 'asset', name: 'lemeng/retail_order_line' } })

    await waitFor(() => expect(screen.getByText('lemeng.retail_order_line.l0.3120')).toBeInTheDocument())
    expect(screen.getByText(/账套 3120 · 0 5 \* \* \*/)).toBeInTheDocument()
    expect(screen.getByText(/最近 failed/)).toBeInTheDocument()
    // 失败原因要看得见（排障的第一句话）
    expect(screen.getByText(/封版标记/)).toBeInTheDocument()
    // 多次 run 时给出「近 N 次」摘要
    expect(screen.getByText(/近 2 次/)).toBeInTheDocument()
    const drawer = document.querySelector('.ant-drawer-body') as HTMLElement
    expect(within(drawer).getByText(/staging：stg_lemeng_retail_order_line/)).toBeInTheDocument()
  })

  it('只看异常：只留失败/运行中的节点（含被它牵连的 staging/marts）', async () => {
    m.mockImplementation(async () => json(MAP))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())
    fireEvent.click(screen.getByText('只看异常'))
    await waitFor(() => {
      const ids = lastOption()?.series[0]!.data.map((n) => n.id) ?? []
      expect(ids).toContain('asset:lemeng/retail_order_line')
      expect(ids).not.toContain('asset:lemeng/no_staging_asset')
    })
  })

  it('断点口径与 domain 一致：只被视图读的资产不算断点', async () => {
    m.mockImplementation(async () => json({
      ...MAP,
      assets: [{ ...MAP.assets[1]!, views: ['vw_x'] }],
    }))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText('断点')).toBeInTheDocument())
    // 断点 KPI 的数值应为 0（该资产有视图消费）
    const kpi = screen.getByText('断点').parentElement!
    expect(within(kpi).getByText('0')).toBeInTheDocument()
  })

  it('接口失败 ⇒ 人话 + 重试', async () => {
    m.mockImplementation(async () => new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 }))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('你没有这个操作的权限，需要找管理员开通')).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /重/ })).toBeInTheDocument()
  })
})

describe('健康只看在跑的管线', () => {
  it('未调度的历史失败不染红（否则图会长期挂着几年前的失败）', async () => {
    const m2 = m
    m2.mockImplementation(async () => json({
      ...MAP,
      assets: [{ ...MAP.assets[0]!, pipelines: [{ id: 'old.one.off', account: null, cron: null, enabled: false, scheduled: false }] }],
      recentRuns: { 'old.one.off': [{ status: 'failed', at: '2026-10-21T00:00:00.000Z' }] },
    }))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())
    await waitFor(() => {
      const node = lastOption()?.series[0]!.data.find((n) => n.id === 'asset:lemeng/retail_order_line') as
        { itemStyle?: { borderColor?: string } } | undefined
      expect(node?.itemStyle?.borderColor).toBe('#EBEDF0') // idle，不是失败红
    })
  })
})
