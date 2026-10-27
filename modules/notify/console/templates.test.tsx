// templates.test.tsx — 模板编辑/预览/版本/发布
import '@testing-library/jest-dom/vitest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { message } from 'antd'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import TemplatesTab from './templates'
import { fetchMock, json, routeFetch } from './test-util'

beforeEach(() => {
  fetchMock.mockReset()
  // antd message 会起 3s 定时器；测试拆除后触发会被报成 unhandled error
  vi.spyOn(message, 'success').mockImplementation(() => (() => {}) as never)
  vi.spyOn(message, 'error').mockImplementation(() => (() => {}) as never)
})

const summary = {
  key: 't1', name: 'T', eventKey: 'm.a.b', status: 'published', origin: 'tenant',
  publishedRevision: 1, updatedAt: '2026-10-27T00:00:00Z',
}
const detail = {
  ...summary,
  revisions: [
    {
      revision: 2, contents: { wecom_chat: { text: 'v2 {{u}}' } }, bodyHash: 'h2',
      reviewStatus: 'draft', createdBy: 'u', createdAt: '2026-10-27T00:00:00Z',
    },
    {
      revision: 1, contents: { wecom_chat: { text: '{{u}}' } }, bodyHash: 'h1',
      reviewStatus: 'approved', createdBy: 'u', createdAt: '2026-10-27T00:00:00Z',
    },
  ],
}

describe('TemplatesTab', () => {
  it('预览逐通道渲染；发布调用 publish', async () => {
    let published: unknown = null
    routeFetch({
      'GET /api/modules/notify/templates': () => json({ templates: [summary] }),
      'GET /api/modules/notify/templates/t1': () => json(detail),
      'POST /api/modules/notify/templates/t1/preview': (init) => {
        const body = JSON.parse(String(init!.body)) as { payload: { u?: string } }
        return body.payload.u
          ? json({ rendered: { wecom_chat: { text: 'T' } } })
          : json({ error: 'TEMPLATE_RENDER_FAILED', issues: ['unknown_variable:nope'] }, 400)
      },
      'POST /api/modules/notify/templates/t1/publish': (init) => {
        published = JSON.parse(String(init!.body))
        return json({ publishedRevision: 2 })
      },
    })

    render(<TemplatesTab />)
    fireEvent.click(await screen.findByText(/^T/))
    await waitFor(() => expect(screen.getByLabelText('样例 payload')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('样例 payload'), { target: { value: '{"u":"u1"}' } })
    fireEvent.click(screen.getByRole('button', { name: /预\s*览/ }))
    await waitFor(() => expect(screen.getByTestId('preview-wecom_chat').textContent).toContain('T'))

    fireEvent.click(screen.getByRole('button', { name: '发布 v2' }))
    await waitFor(() => expect(published).toEqual({ revision: 2 }))
    // 等发布后的 detail/list 重载落定，避免测试拆除后仍有 pending promise
    await waitFor(() => {
      const paths = fetchMock.mock.calls.map((c) => String(c[0]))
      expect(paths.filter((p) => p === '/api/modules/notify/templates/t1').length).toBeGreaterThanOrEqual(2)
      expect(paths.filter((p) => p === '/api/modules/notify/templates').length).toBeGreaterThanOrEqual(2)
    })
  })
})
