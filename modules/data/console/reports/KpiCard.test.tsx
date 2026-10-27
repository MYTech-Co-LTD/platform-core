// KpiCard.test.tsx — KPI 卡的历史覆盖判据（issue #1078）。
//
// 判据：对比期**整段**落在指标数据覆盖内才出环比；覆盖不足（起点晚于对比期起点 /
// 水位早于对比期终点 / 探测失败）一律 `-`，本期数值照常显示。
// mock 点 = `../lib/api` 的 `apiSend`（前缀/失败体翻译在 api.test.ts 判，本文件只判卡片行为）。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', () => ({ apiSend: vi.fn() }))
import { apiSend } from '../lib/api'
import { parseReportSpec } from '../../domain/report-spec'
import KpiCard, { resetCoverageCache } from './KpiCard'

const m = vi.mocked(apiSend)

function panelOf() {
  const parsed = parseReportSpec({
    panels: [{
      chart: 'kpi', title: '销售额', metricId: 'm', format: 'number',
      compare: 'prev_period', goodDirection: 'up', span: 12, args: {},
    }],
  })
  if (!parsed.ok) throw new Error(parsed.code)
  const p = parsed.spec.panels[0]
  if (p?.chart !== 'kpi') throw new Error('fixture 不是 kpi')
  return p
}

const ARGS = { bizday: { from: '2026-10-01', to: '2026-10-19' } }
const PREV = { from: '2026-09-12', to: '2026-09-30' }

type Body = { args?: Record<string, unknown>; orderBy?: unknown }

/** 覆盖探测 = 带 orderBy 的请求；其余是合计（本期/对比期）。 */
function mockApi(opts: { from?: string | null; to?: string | null; cur?: number; prev?: number | null }) {
  m.mockImplementation(async (_path, _method, body) => {
    const b = (body ?? {}) as Body
    if (b.orderBy !== undefined) {
      if (opts.from === null) return { status: 'denied' }
      return {
        status: 'ok',
        columns: ['value', 'bizday'],
        rows: [[1, `${opts.from}T00:00:00.000Z`]],
        ...(opts.to === undefined ? {} : { watermark: opts.to }),
      }
    }
    const args = b.args ?? {}
    const isPrev = args.bizday !== undefined && (args.bizday as { from?: string }).from === PREV.from
    return { total: isPrev ? (opts.prev === undefined ? 80 : opts.prev) : (opts.cur ?? 100) }
  })
}

beforeEach(() => { resetCoverageCache(); m.mockReset() })
afterEach(() => { cleanup() })

describe('KpiCard 对比覆盖', () => {
  it('对比期起点早于数据起点 ⇒ 环比 `-`，且不发对比期合计查询', async () => {
    mockApi({ from: '2026-09-23', to: '2026-10-26' })
    render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)

    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('-'))
    // 本期数值照常
    expect(screen.getByTestId('kpi-value')).toHaveTextContent('100')
    // `-` 带原因（覆盖不足 + 数据起点），不让用户以为坏了
    expect(screen.getByTestId('kpi-delta')).toHaveAttribute('title', expect.stringContaining('覆盖不足'))
    expect(screen.getByTestId('kpi-delta')).toHaveAttribute('title', expect.stringContaining('2026-09-23'))

    const prevCalls = m.mock.calls.filter(([, , body]) =>
      ((body ?? {}) as Body).args?.bizday !== undefined
      && ((body ?? {}) as Body).args !== undefined
      && (((body ?? {}) as Body).args!.bizday as { from?: string }).from === PREV.from,
    )
    expect(prevCalls).toHaveLength(0)
  })

  it('整段覆盖 ⇒ 正常出环比（无原因提示）', async () => {
    mockApi({ from: '2026-01-01', to: '2026-10-26' })
    render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)

    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('+25.0%'))
    expect(screen.getByTestId('kpi-delta')).not.toHaveAttribute('title')
  })

  it('覆盖完整但对比期无数 ⇒ `-` 说明「对比期无数据或基数无定义」', async () => {
    mockApi({ from: '2026-01-01', to: '2026-10-26', prev: null })
    render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)

    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('-'))
    expect(screen.getByTestId('kpi-delta'))
      .toHaveAttribute('title', '对比期无数据或基数无定义')
  })

  it('对比期终点晚于水位 ⇒ 不出环比（尾段没物化完）', async () => {
    mockApi({ from: '2026-01-01', to: '2026-09-20' })
    render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)

    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('-'))
  })

  it('同一指标的覆盖探测 60s 内复用（不重复请求）', async () => {
    mockApi({ from: '2026-01-01', to: '2026-10-26' })
    const first = render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)
    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('+25.0%'))
    first.unmount()
    render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)
    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('+25.0%'))

    const probes = m.mock.calls.filter(([, , body]) =>
      ((body ?? {}) as Body).orderBy !== undefined)
    expect(probes).toHaveLength(1)
  })

  it('覆盖探测失败 ⇒ 不出环比（宁可不出，不出假数）', async () => {
    mockApi({ from: null })
    render(<KpiCard panel={panelOf()} args={ARGS} compareRange={PREV} />)

    await waitFor(() => expect(screen.getByTestId('kpi-delta')).toHaveTextContent('-'))
    expect(screen.getByTestId('kpi-delta')).toHaveAttribute('title', '对比期数据覆盖未知，暂不展示环比')
  })
})
