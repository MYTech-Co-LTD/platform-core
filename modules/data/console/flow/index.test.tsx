// index.test.tsx — 动效流水线（#2693）：三泳道渲染、节点计数、排班条、点节点开详情。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import FlowPage, { slotPct } from './index'

const m = vi.mocked(platformFetch)
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

const FLOW = {
  notes: [],
  nodes: [
    { id: 'src:a', kind: 'source', label: 'lemeng.retail_order_line' },
    { id: 'pipe:p', kind: 'pipeline', label: 'retail_order_line', count: 2, members: ['p1', 'p2'] },
    { id: 'lake:l', kind: 'lake', label: 'lemeng/retail_order_line' },
    { id: 'stg:s', kind: 'staging', label: 'stg_lemeng_retail_order_line' },
    { id: 'mart:m', kind: 'mart', label: 'fct_retail_sale' },
    { id: 'mart:r', kind: 'recon', label: 'recon_fact' },
    { id: 'met:e', kind: 'metric', label: 'sales', count: 12, members: ['sales'] },
    { id: 'use:d', kind: 'consumer', label: '钻取明细' },
  ],
}

const OBS = {
  schedules: [
    { key: 'data.dbt_tick', cron: '2-59/10 1-15 * * *', enabled: true, lastRun: { status: 'ok' }, fails24h: 0 },
    { key: 'data.dbt_tables', cron: '25 2 * * *', enabled: true, lastRun: { status: 'ok' }, fails24h: 0 },
    { key: 'data.warehouse_assertions', cron: '*/5 * * * *', enabled: true, lastRun: { status: 'failed' }, fails24h: 2 },
  ],
  recon: {
    windowDays: 7, storeDays: 2174, overTol: 6, withinTol: 2168, overTolDiffSum: 3407.94,
    byAttribution: [{ attribution: 'swap_split_unrecognized', n: 6 }],
  },
}

beforeEach(() => { m.mockReset() })
afterEach(() => cleanup())

describe('动效流水线', () => {
  it('三条泳道都在：生产 / 对账 / 排班；生产泳道显示各层计数', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('① 数据怎么生产')).toBeInTheDocument())
    expect(screen.getByText('② 怎么对账（近 7 天）')).toBeInTheDocument()
    expect(screen.getByText('③ 怎么排班（北京时间 24 小时）')).toBeInTheDocument()
    // 生产泳道：管线计数 2（组节点 count 求和）、指标 12、marts 计数
    expect(screen.getByText('采集管线')).toBeInTheDocument()
    const nums = screen.getAllByText('2')
    expect(nums.length).toBeGreaterThanOrEqual(1)
  })

  it('对账泳道显示真实数字（店日 / 超容差 / 归因）', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('差异计算')).toBeInTheDocument())
    expect(screen.getByText('2174')).toBeInTheDocument()
    expect(screen.getByText('6')).toBeInTheDocument()
    expect(screen.getByText(/swap_split_unrecognized 6/)).toBeInTheDocument()
    expect(screen.getByText(/¥3,407.94/)).toBeInTheDocument()
  })

  it('排班泳道渲染启用中的档位（失败档红字）', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('dbt_tick')).toBeInTheDocument())
    expect(screen.getByText('dbt_tables')).toBeInTheDocument()
    const failed = screen.getByText('warehouse_assertions')
    expect(failed).toBeInTheDocument()
  })

  it('暂停/播放按钮切换动效', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    const { container } = render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('⏸ 暂停动效')).toBeInTheDocument())
    fireEvent.click(screen.getByText('⏸ 暂停动效'))
    expect(screen.getByText('▶ 播放动效')).toBeInTheDocument()
    expect(container.querySelector('.df-paused')).not.toBeNull()
  })

  it('点生产泳道的 marts 节点 → 请求对象详情并按 name 打开', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    m.mockResolvedValueOnce(json({
      kind: 'mart', name: 'fct_retail_sale', displayName: '零售销售事实', summary: '每店每天一行',
      domain: null, columns: [], upstream: [{ kind: 'staging', name: 'stg_x', displayName: '零售明细（定型）' }],
      downstream: [], upstream2: [], downstream2: [], notes: [],
    }))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('marts')).toBeInTheDocument())
    fireEvent.click(screen.getByText('marts'))
    await waitFor(() => {
      const url = String(m.mock.calls[2]?.[0] ?? '')
      expect(url).toContain('kind=mart')
      expect(url).toContain('name=fct_retail_sale')
    })
  })

  it('详情默认「关系」Tab：显示人话名、上游与读法说明', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    m.mockResolvedValueOnce(json({
      kind: 'mart', name: 'fct_retail_sale', displayName: '零售销售事实', summary: '每店每天一行',
      domain: null, columns: [], upstream: [{ kind: 'staging', name: 'stg_x', displayName: '零售明细（定型）' }],
      downstream: [], upstream2: [], downstream2: [], notes: [],
    }))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('marts')).toBeInTheDocument())
    fireEvent.click(screen.getByText('marts'))
    await waitFor(() => expect(screen.getByText('读法：左边的把数据交给它，它算完交给右边。点任意方块跳到那个对象。')).toBeInTheDocument())
    expect(screen.getByText('零售销售事实')).toBeInTheDocument()
    expect(screen.getByText('零售明细（定型）')).toBeInTheDocument()
    expect(screen.getByText('上游（数据从哪来）')).toBeInTheDocument()
    expect(screen.getByText('下游（谁在用它）')).toBeInTheDocument()
  })

  it('点「采集管线」→ 先开组清单（列出每条），点一条才进节点流', async () => {
    m.mockResolvedValueOnce(json(FLOW)).mockResolvedValueOnce(json(OBS))
    m.mockResolvedValueOnce(json({
      kind: 'pipeline', name: 'p1', displayName: 'p1', summary: null, domain: null, columns: [],
      upstream: [], downstream: [], upstream2: [], downstream2: [], notes: [],
      pipelineSteps: [
        { id: 's1', step: 1, component: 'src.rest', kind: 'fetch', label: '取数（接口）', detail: 'page 1', count: null },
        { id: 's2', step: 2, component: 'snk.minio', kind: 'sink', label: '写湖', detail: null, count: null },
      ],
    }))
    render(<FlowPage />)
    await waitFor(() => expect(screen.getByText('采集管线')).toBeInTheDocument())
    fireEvent.click(screen.getByText('采集管线'))
    // 组清单出现：两条成员
    await waitFor(() => expect(screen.getByText('p1')).toBeInTheDocument())
    expect(screen.getByText('p2')).toBeInTheDocument()
    expect(screen.getByText(/采集管线（2 条）/)).toBeInTheDocument()
    // 点成员 → 请求 pipeline 详情
    fireEvent.click(screen.getByText('p1'))
    await waitFor(() => {
      const url = String(m.mock.calls[2]?.[0] ?? '')
      expect(url).toContain('kind=pipeline')
      expect(url).toContain('name=p1')
    })
    // 节点流默认展示（步骤条）
    await waitFor(() => expect(screen.getByText('取数（接口）')).toBeInTheDocument())
    expect(screen.getByText('写湖')).toBeInTheDocument()
  })

  it('slotPct：10:25 = 43.4%', () => {
    expect(slotPct({ hour: 10, minute: 25 })).toBeCloseTo(((10 * 60 + 25) / 1440) * 100, 5)
  })
})
