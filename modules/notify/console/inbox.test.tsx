// inbox.test.tsx — 收件箱：标记已读
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import InboxTab from './inbox'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => {
  cleanup()
  fetchMock.mockReset()
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
})

describe('InboxTab', () => {
  it('全部已读按钮调用 read-all 并刷新', async () => {
    let readAllCalled = false
    routeFetch({
      'GET /api/modules/notify/inbox': () => json({ items: [{
        id: 'i1', eventId: 'e1', eventKey: 'm.a.b', title: '待审批', body: 'B',
        link: null, readAt: null, createdAt: '2026-10-27T00:00:00Z',
      }] }),
      'POST /api/modules/notify/inbox/read-all': () => {
        readAllCalled = true
        return json({ marked: 1 })
      },
    })
    render(<InboxTab />)
    fireEvent.click(await screen.findByRole('button', { name: /全\s*部\s*已\s*读/ }))
    await waitFor(() => expect(readAllCalled).toBe(true))
  })

  it('展示未读并标记已读', async () => {
    let readCalled = false
    routeFetch({
      'GET /api/modules/notify/inbox': () => json({
        items: [{
          id: 'i1', eventId: 'e1', eventKey: 'm.a.b', title: '待审批',
          body: '申请人：张三', link: 'https://x', readAt: null,
          createdAt: '2026-10-27T00:00:00Z',
        }],
      }),
      'POST /api/modules/notify/inbox/i1/read': () => {
        readCalled = true
        return json({ ok: true })
      },
    })

    render(<InboxTab />)
    expect(await screen.findByText('待审批')).toBeInTheDocument()
    const buttons = screen.getAllByRole('button').filter((b) => b.textContent === '标记已读')
    expect(buttons).toHaveLength(1)
    fireEvent.click(buttons[0]!)
    await waitFor(() => expect(readCalled).toBe(true))
  })
})
