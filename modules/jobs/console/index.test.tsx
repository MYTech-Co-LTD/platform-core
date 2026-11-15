// console/index.test.tsx — 定时任务页（只读）渲染契约。
// 验：拉的端点正确、状态标签、点行加载运行台账、错误出人话。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import JobsConsolePage from './index'

const SCHEDULES = [
  { id: '1', key: 'notify.reconcile', enabled: true, cron: '7 * * * *', timezone: 'UTC',
    nextRunAt: '2026-11-15T11:07:00.000Z', lastStatus: 'ok', lastRunAt: '2026-11-15T10:07:00.000Z' },
  { id: '2', key: 'report.scope_scan', enabled: false, cron: '37 1 * * *', timezone: 'UTC',
    nextRunAt: null, lastStatus: null, lastRunAt: null },
]

const RUNS = [
  { id: '9', key: 'notify.reconcile', status: 'ok', trigger: 'schedule', attempt: 1,
    startedAt: '2026-11-15T10:07:00.000Z', finishedAt: '2026-11-15T10:07:02.000Z',
    exitCode: 0, durationMs: 1500, outputTail: 'refreshed=271' },
]

describe('JobsConsolePage', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
    fetchMock.mockImplementation(async (url: string) => {
      if (url === '/api/modules/jobs/schedules') {
        return { ok: true, json: async () => ({ schedules: SCHEDULES }) }
      }
      if (String(url).startsWith('/api/modules/jobs/runs/')) {
        return { ok: true, json: async () => ({ runs: RUNS }) }
      }
      return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) }
    })
  })

  afterEach(() => { cleanup(); vi.unstubAllGlobals() })

  it('列出排班并区分启停', async () => {
    render(<JobsConsolePage />)
    expect(await screen.findByText('notify.reconcile')).toBeTruthy()
    expect(screen.getByText('report.scope_scan')).toBeTruthy()
    expect(screen.getByText('启用')).toBeTruthy()
    expect(screen.getByText('停用')).toBeTruthy()
    expect(fetchMock).toHaveBeenCalledWith('/api/modules/jobs/schedules')
  })

  it('点行加载该任务的运行台账', async () => {
    render(<JobsConsolePage />)
    fireEvent.click(await screen.findByText('notify.reconcile'))
    expect(await screen.findByText('refreshed=271')).toBeTruthy()
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/modules/jobs/runs/notify.reconcile?limit=20')
    })
  })

  it('加载失败出人话', async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({ error: 'BOOM' }) }))
    render(<JobsConsolePage />)
    expect(await screen.findByText(/加载失败：BOOM/)).toBeTruthy()
  })
})
