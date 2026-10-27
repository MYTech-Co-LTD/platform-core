// rules.test.tsx — 规则列表/启停 + 收件人选项只来自事件声明
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import RulesTab, { recipientOptions, publishedTemplateOptions, enabledChannelOptions } from './rules'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => { fetchMock.mockReset() })

const rule = {
  id: 'r1', enabled: true, eventKey: 'm.a.b', scope: '*',
  recipientKey: 'approver', recipientLiteral: null, templateKey: 't1',
  channels: ['wecom_default'], cooldownMinutes: null, origin: 'manual',
  createdAt: '2026-10-27T00:00:00Z',
}
const event = {
  key: 'm.a.b', title: '测试事件', payload: { u: { type: 'user' } },
  recipients: { approver: { kind: 'field', field: 'u' } },
}

function mockBase() {
  routeFetch({
    'GET /api/modules/notify/rules': () => json({ rules: [rule] }),
    'GET /api/modules/notify/events': () => json({ events: [event] }),
    'GET /api/modules/notify/templates': () => json({
      templates: [{ key: 't1', status: 'published', publishedRevision: 1 }],
    }),
    'GET /api/modules/notify/channels': () => json({
      channels: [{
        id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: true,
        config: {}, secretRefs: {}, health: null, healthAt: null,
      }],
    }),
  })
}

describe('RulesTab', () => {
  it('渲染规则并在启停时 PUT', async () => {
    const calls: string[] = []
    mockBase()
    routeFetch({
      'GET /api/modules/notify/rules': () => json({ rules: [rule] }),
      'GET /api/modules/notify/events': () => json({ events: [event] }),
      'GET /api/modules/notify/templates': () => json({
        templates: [{ key: 't1', status: 'published', publishedRevision: 1 }],
      }),
      'GET /api/modules/notify/channels': () => json({
        channels: [{
          id: 'wecom_default', provider: 'wecom_chat', enabled: true, configured: true,
          config: {}, secretRefs: {}, health: null, healthAt: null,
        }],
      }),
      'PUT /api/modules/notify/rules/r1/enabled': (init) => {
        calls.push(String(init!.body))
        return json({ ok: true })
      },
    })

    render(<RulesTab />)
    expect(await screen.findByText('m.a.b')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(calls).toHaveLength(1))
    expect(JSON.parse(calls[0]!)).toEqual({ enabled: false })
  })

  it('收件人/模板/通道选项只来自声明与启用集', () => {
    expect(recipientOptions(event as never).map((o) => o.value)).toEqual(['approver'])
    expect(recipientOptions(undefined)).toEqual([])
    expect(publishedTemplateOptions([
      { key: 't1', status: 'published', publishedRevision: 1 },
      { key: 't2', status: 'draft', publishedRevision: null },
    ] as never).map((o) => o.value)).toEqual(['t1'])
    expect(enabledChannelOptions([
      { id: 'on', provider: 'wecom_chat', enabled: true },
      { id: 'off', provider: 'wecom_chat', enabled: false },
    ] as never).map((o) => o.value)).toEqual(['on'])
  })
})
