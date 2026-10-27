// events.test.tsx — 事件目录渲染
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import EventsTab from './events'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => { fetchMock.mockReset() })

describe('EventsTab', () => {
  it('渲染事件 key / 标题 / 收件人', async () => {
    routeFetch({
      'GET /api/modules/notify/events': () => json({
        events: [{
          key: 'm.a.b',
          title: '测试事件',
          payload: { u: { type: 'user' } },
          recipients: { approver: { kind: 'field', field: 'u' } },
        }],
      }),
    })

    render(<EventsTab />)
    expect(await screen.findByText('m.a.b')).toBeInTheDocument()
    expect(screen.getByText('测试事件')).toBeInTheDocument()
    expect(screen.getByText('approver')).toBeInTheDocument()
  })
})
