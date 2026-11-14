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
  // KPI 由服务端下发；这里刻意给与 assets 推算不同的值，用来证明页面**没有**自己重算
  summary: { assets: 29, withStaging: 28, broken: 0, orphans: 12, parentDriven: 3, failedLive: 2 },
  runsWired: true,
  assets: [
    {
      lake: 'lemeng/retail_order_line',
      staging: 'stg_lemeng_retail_order_line',
      views: [],
      marts: ['fct_retail_sale'],
      pipelines: [
        { id: 'lemeng.retail_order_line.l0.3120', account: '3120', cron: '0 5 * * *', enabled: true, scheduled: true, driver: 'schedule', parentIds: [] },
        { id: 'lemeng.retail_order_line.l0.64188', account: '64188', cron: '0 5 * * *', enabled: true, scheduled: true, driver: 'schedule', parentIds: [] },
      ],
    },
    {
      lake: 'lemeng/no_staging_asset',
      staging: null,
      views: [],
      marts: [],
      pipelines: [{ id: 'lemeng.no_staging_asset.l0.3120', account: '3120', cron: null, enabled: false, scheduled: false, driver: 'none', parentIds: [] }],
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
    // KPI 一律来自 summary（与 assets 的 2 条不同，证明没有前端重算）
    expect(screen.getByText('29')).toBeInTheDocument()
    expect(screen.getByText('28')).toBeInTheDocument()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('2')).toBeInTheDocument()
    expect(screen.getByText(/另有 12 条无调度无父管线/)).toBeInTheDocument()
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

describe('运行历史', () => {
  it('点「历史」⇒ 拉该管线记录并列出状态/耗时/错误；未接运行记录时给出说明', async () => {
    m.mockImplementation(async (url: string) => {
      if (url.includes('/runs')) {
        return json({
          pipelineId: 'lemeng.retail_order_line.l0.3120', status: 'ok',
          runs: [
            { runId: 'r2', at: '2026-11-14T01:00:00.000Z', status: 'failed', durationMs: 36000, trigger: 'cron', error: '封版标记 → _DAILY/: invalid date' },
            { runId: 'r1', at: '2026-11-13T01:00:00.000Z', status: 'ok', durationMs: 12000, trigger: 'cron' },
          ],
        })
      }
      return json(MAP)
    })
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())

    const handler = chart.on.mock.calls.filter((c) => c[0] === 'click').at(-1)?.[1] as (p: unknown) => void
    handler({ dataType: 'node', data: { kind: 'asset', name: 'lemeng/retail_order_line' } })
    await waitFor(() => expect(screen.getAllByRole('button', { name: /历史/ }).length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByRole('button', { name: /历史/ })[0]!)
    await waitFor(() => expect(screen.getByText(/封版标记/)).toBeInTheDocument())
    expect(screen.getByText('36s')).toBeInTheDocument()
    expect(screen.getAllByText('cron').length).toBe(2)
  })
})

describe('未调度管线清单', () => {
  it('点「未调度 N」⇒ 列出未登记调度的管线与其最近一次运行', async () => {
    m.mockImplementation(async () => json(MAP))
    render(<PipelinesPage />)
    await waitFor(() => expect(screen.getByText('资产')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /无调度无父管线 12/ }))
    await waitFor(() => expect(screen.getByText('无调度也无父管线的管线（清理候选）')).toBeInTheDocument())
    // MAP 里 only 的未调度管线是 no_staging_asset.l0.3120
    expect(screen.getByText('lemeng.no_staging_asset.l0.3120')).toBeInTheDocument()
  })
})
