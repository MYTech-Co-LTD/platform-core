// channels.test.tsx — 通道页：只显示 env 键名、启停/健康、测试发送无收件人输入
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import ChannelsTab from './channels'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => {
  fetchMock.mockReset()
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
})

const channel = {
  id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: false,
  config: {}, secretRefs: { bridge_url: 'WECOM_BRIDGE_URL__X' },
  health: null, healthAt: null,
}

describe('ChannelsTab', () => {
  it('只显示 env 键名；启停/健康检查/测试发送', async () => {
    let patched: unknown = null
    let healthCalled = false
    routeFetch({
      'GET /api/modules/notify/channels': () => json({ channels: [channel] }),
      'GET /api/modules/notify/templates': () => json({ templates: [] }),
      'PATCH /api/modules/notify/channels/wecom_default': (init) => {
        patched = JSON.parse(String(init!.body))
        return json({ ok: true })
      },
      'POST /api/modules/notify/channels/wecom_default/health': () => {
        healthCalled = true
        return json({ ok: true })
      },
    })

    render(<ChannelsTab />)
    expect(await screen.findByText('wecom_default')).toBeInTheDocument()
    expect(screen.getByText('未配置')).toBeInTheDocument()
    expect(screen.getByText('WECOM_BRIDGE_URL__X')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('secret-value')

    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(patched).toEqual({ enabled: false }))

    fireEvent.click(screen.getByRole('button', { name: '健康检查' }))
    await waitFor(() => expect(healthCalled).toBe(true))

    fireEvent.click(screen.getByRole('button', { name: /测试发送/ }))
    await waitFor(() => expect(screen.getByText(/收件人固定为当前登录人/)).toBeInTheDocument())
    expect(screen.queryByLabelText('收件人')).toBeNull()
  })
})
