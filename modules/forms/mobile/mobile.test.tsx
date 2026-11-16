// @vitest-environment happy-dom
// mobile/mobile.test.tsx — 移动端 OA 审批页（/m/oa/approvals*）组件测试（issue #2363）。
// 姿势照 `console/console.test.tsx`：只 mock `platformFetch`，页面行为全走它。
// 关键门禁：列表卡片可点、详情只读字段 + 历史、驳回意见必填（空意见「拒绝」禁用）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { RouterProvider, createMemoryRouter, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import MobileApprovals from './Approvals'
import MobileApprovalDetail from './ApprovalDetail'

const platformFetchMock = vi.mocked(platformFetch)

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

type Handler = (init?: RequestInit) => Response

function mockApi(handlers: Record<string, Handler>): void {
  platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    const handler = handlers[input]
    if (!handler) throw new Error('unexpected platformFetch: ' + input)
    return handler(init)
  })
}

/** 与 App.tsx 同形的参数 → props 适配（组件保持纯 props，测试不依赖 router 上下文实现）。 */
function DetailRoute() {
  const { caseId } = useParams()
  return caseId === undefined ? null : <MobileApprovalDetail caseId={caseId} />
}

function renderAt(path: string): void {
  const router = createMemoryRouter(
    [
      { path: '/m/oa/approvals', element: <MobileApprovals /> },
      { path: '/m/oa/approvals/:caseId', element: <DetailRoute /> },
    ],
    { initialEntries: [path] },
  )
  render(<RouterProvider router={router} />)
}

const SUBMISSION = {
  id: '1', assetId: 'leave', version: 1,
  payload: { reason: '家事', days: 2 },
  submittedBy: 'u1', submittedAt: '2026-11-16T01:00:00Z',
  status: 'pending_approval', caseId: 'c1',
  plan: {
    nodes: [
      { key: 'leader', title: '直属主管', approvers: ['u-lead'] },
      { key: 'hr', title: 'HR', approvers: ['u-hr'] },
    ],
  },
  decidedAt: null, decisionAction: null, decisionComment: null,
}

const DETAIL = {
  submission: SUBMISSION,
  contract: {
    schema: {
      type: 'object',
      properties: { reason: { type: 'string', title: '事由' }, days: { type: 'number', title: '天数' } },
    },
  },
  case: {
    currentNode: 'leader',
    nodeDecisions: [
      { nodeKey: 'leader', approver: 'u-lead', action: 'approve', comment: '同意', at: '2026-11-16T02:00:00Z' },
    ],
  },
  engineError: null,
}

beforeEach(() => { platformFetchMock.mockReset() })
afterEach(async () => {
  cleanup()
  // React 19 的 scheduler 会在下一个 macrotask 里跑已排队的渲染/副作用。若不等它落地，
  // happy-dom 环境先被拆掉，CI 上会出现 “window is not defined” 的 unhandled error
  // （本地单跑不易复现）。让它在环境仍存活时跑完。
  await new Promise((resolve) => setTimeout(resolve, 0))
})

describe('移动端待审批列表（/m/oa/approvals）', () => {
  it('卡片渲染标题、发起人、当前节点与时间；整卡链到详情', async () => {
    mockApi({
      '/api/modules/forms/approvals/mine': () => jsonResponse({
        approvals: [
          { submissionId: '1', caseId: 'c1', title: '请假 - 张三', requester: '张三', nodeTitle: '直属主管', submittedAt: '2026-11-16T01:00:00Z' },
        ],
      }),
    })
    renderAt('/m/oa/approvals')
    const title = await screen.findByText('请假 - 张三')
    expect(screen.getByText('发起人：张三')).toBeInTheDocument()
    expect(screen.getByText(/直属主管/)).toBeInTheDocument()
    expect(title.closest('a')).toHaveAttribute('href', '/m/oa/approvals/c1')
  })

  it('无待办时明确显示「暂无待审批」', async () => {
    mockApi({ '/api/modules/forms/approvals/mine': () => jsonResponse({ approvals: [] }) })
    renderAt('/m/oa/approvals')
    expect(await screen.findByText('暂无待审批')).toBeInTheDocument()
  })

  it('加载失败要看得见（不是静默空列表）', async () => {
    mockApi({
      '/api/modules/forms/approvals/mine': () => jsonResponse({ error: 'INTERNAL' }, 500),
    })
    renderAt('/m/oa/approvals')
    expect(await screen.findByText('待审批列表加载失败')).toBeInTheDocument()
  })
})

describe('移动端审批详情（/m/oa/approvals/:caseId）', () => {
  it('只读字段 + 当前节点 + 审批历史；驳回意见为空时禁用', async () => {
    mockApi({ '/api/modules/forms/approvals/c1': () => jsonResponse(DETAIL) })
    renderAt('/m/oa/approvals/c1')

    expect(await screen.findByText('审批：leave - u1')).toBeInTheDocument()
    expect(screen.getByText('直属主管')).toBeInTheDocument()
    // 历史：节点标题 · 审批人 · 动作 + 意见
    expect(screen.getByText('直属主管 · u-lead · 通过')).toBeInTheDocument()
    expect(screen.getByText('同意')).toBeInTheDocument()

    const reject = screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement
    const approve = screen.getByRole('button', { name: '通过' }) as HTMLButtonElement
    expect(reject.disabled).toBe(true)
    expect(approve.disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('审批意见'), { target: { value: '材料不全' } })
    await waitFor(() => expect(reject.disabled).toBe(false))
  })

  it('驳回提交意见并回列表；通过不要求意见', async () => {
    const decisions: Array<{ url: string; body: unknown }> = []
    mockApi({
      '/api/modules/forms/approvals/c1': () => jsonResponse(DETAIL),
      '/api/modules/forms/approvals/c1/decision': (init) => {
        decisions.push({ url: '/approvals/c1/decision', body: JSON.parse(String(init?.body)) })
        return jsonResponse({ ok: true, nodeKey: 'leader' })
      },
      '/api/modules/forms/approvals/mine': () => jsonResponse({ approvals: [] }),
    })
    renderAt('/m/oa/approvals/c1')

    fireEvent.change(await screen.findByLabelText('审批意见'), { target: { value: '材料不全' } })
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))

    await waitFor(() => expect(decisions).toHaveLength(1))
    expect(decisions[0].body).toEqual({ action: 'reject', comment: '材料不全' })
    // 动作成功回列表（移动端不再把用户留在已终结的详情页）
    expect(await screen.findByText('暂无待审批')).toBeInTheDocument()
  })

  it('动作失败：就地显示错误码，不跳走（移动端不用飘走的全局提示）', async () => {
    mockApi({
      '/api/modules/forms/approvals/c1': () => jsonResponse(DETAIL),
      '/api/modules/forms/approvals/c1/decision': () => jsonResponse({ error: 'ENGINE_CONFLICT' }, 409),
    })
    renderAt('/m/oa/approvals/c1')

    fireEvent.change(await screen.findByLabelText('审批意见'), { target: { value: '材料不全' } })
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))

    expect(await screen.findByText('审批动作未完成')).toBeInTheDocument()
    expect(screen.getByText('ENGINE_CONFLICT')).toBeInTheDocument()
    // 仍在详情页（没回列表）
    expect(screen.getByText('审批：leave - u1')).toBeInTheDocument()
  })

  it('通过：不填意见也能提交（body 不带 comment）', async () => {
    let body: unknown
    mockApi({
      '/api/modules/forms/approvals/c1': () => jsonResponse(DETAIL),
      '/api/modules/forms/approvals/c1/decision': (init) => {
        body = JSON.parse(String(init?.body))
        return jsonResponse({ ok: true, nodeKey: 'leader' })
      },
      '/api/modules/forms/approvals/mine': () => jsonResponse({ approvals: [] }),
    })
    renderAt('/m/oa/approvals/c1')

    fireEvent.click(await screen.findByRole('button', { name: '通过' }))
    await waitFor(() => expect(body).toEqual({ action: 'approve' }))
    expect(await screen.findByText('暂无待审批')).toBeInTheDocument()
  })
})
