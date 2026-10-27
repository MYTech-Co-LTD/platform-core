// deliveries.test.tsx — 投递页：只对 failed/dead 显示重试
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import DeliveriesTab from './deliveries'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => {
  fetchMock.mockReset()
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
})

const base = {
  eventId: 'e1', eventKey: 'm.a.b', ruleId: 'r1', recipient: 'u1',
  channel: 'wecom_default', address: 'wecom-u1', templateKey: 't1', revision: 1,
  attempts: 2, isTest: false, lastError: '502', createdAt: '2026-10-27T00:00:00Z',
}

describe('DeliveriesTab', () => {
  it('只对 failed/dead 显示重试，重试发复合键', async () => {
    let retried: unknown = null
    routeFetch({
      'GET /api/modules/notify/deliveries': () => json({
        deliveries: [
          { ...base, status: 'failed' },
          { ...base, eventId: 'e2', status: 'sent', lastError: null },
        ],
      }),
      'POST /api/modules/notify/deliveries/retry': (init) => {
        retried = JSON.parse(String(init!.body))
        return json({ ok: true })
      },
    })

    render(<DeliveriesTab />)
    expect(await screen.findAllByRole('button', { name: /重\s*试/ })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }))
    await waitFor(() => expect(retried).toEqual({
      eventId: 'e1', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
    }))
  })
})
