// pages/admin/Integrations.test.tsx — 集成健康页（渲染 + 四态徽标 + 两条告示）
//
// 断言的是**这屏存在的理由**：STALE（真没动静）与 PROBE_FAILED（探不了）必须长得不一样，
// 否则排障方向会被带偏——那正是本设计要消灭的失败模式。
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { App as AntdApp } from 'antd'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(cleanup)
import type { AdminIntegration } from '../../lib/api'

const { listAdminIntegrations } = vi.hoisted(() => ({
  listAdminIntegrations: vi.fn(async () => ({
    integrations: [] as AdminIntegration[],
    summary: { total: 0, stale: 0, probeFailed: 0 },
  })),
}))

vi.mock('../../lib/api', () => ({
  ApiError: class extends Error {},
  listAdminIntegrations,
}))

import AdminIntegrationsPage from './Integrations'

const row = (over: Partial<AdminIntegration> = {}): AdminIntegration => ({
  id: 'wecom-suite-ticket', org: '', kind: 'callback', source: 'sql:app_config',
  slaSeconds: 1800, enabled: true, lastOkAt: null, lastProbeAt: null, lastError: null,
  note: '企微每 10 分钟推一次',
  health: { verdict: 'STALE', ageSeconds: null, reason: '从来没有收到过活性证据（从接入那一刻起就算超期）' },
  ...over,
})

const renderPage = () =>
  render(<AntdApp><AdminIntegrationsPage /></AntdApp>)

describe('集成健康页', () => {
  it('★ STALE 与 PROBE_FAILED 是两个不同的信号（文案与告示都不同）', async () => {
    listAdminIntegrations.mockResolvedValueOnce({
      integrations: [
        row(),
        row({
          id: 'wecom-bridge', kind: 'channel',
          health: { verdict: 'PROBE_FAILED', ageSeconds: null, reason: '探针执行失败：ECONNREFUSED' },
        }),
      ],
      summary: { total: 2, stale: 1, probeFailed: 1 },
    })
    renderPage()

    expect(await screen.findByText('太久没消息')).toBeInTheDocument()
    expect(screen.getByText('探针失败')).toBeInTheDocument()
    expect(screen.getByText(/1 个集成太久没有活性证据/)).toBeInTheDocument()
    expect(screen.getByText(/1 个集成的探针自己没跑通/)).toBeInTheDocument()
    // 说明列直接用服务端原因，不在前端重算
    expect(screen.getByText(/ECONNREFUSED/)).toBeInTheDocument()
  })

  it('全绿 ⇒ 不出告示；空表 ⇒ 给出「还没登记」的明示（不是空白）', async () => {
    renderPage()
    expect(await screen.findByText(/还没有登记任何集成/)).toBeInTheDocument()
    expect(screen.queryByText(/太久没有活性证据/)).toBeNull()
    expect(screen.queryByText(/探针自己没跑通/)).toBeNull()
  })
})
