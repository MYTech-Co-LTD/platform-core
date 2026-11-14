// TemplateCreateModal.test.tsx — R2 console 模板入口：选模板 → 填指标 → 建草稿。
// 判据：必填槽前端先拦（不发请求）；填齐后 compile 与 create 的 body 逐字可控；
// 服务端拒绝（缺槽）显示人话。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import { TemplateCreateModal } from './TemplateCreateModal'

const m = vi.mocked(platformFetch)
const calls: { url: string; init?: RequestInit }[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const TEMPLATE = {
  id: 'daily_ops',
  title: '门店经营日报',
  description: '营业额/订单/客单三卡 + 日趋势 + 经营分析。',
  slots: [
    { key: 'revenue', label: '营业额', chart: 'kpi', required: true },
    { key: 'aov', label: '客单价', chart: 'kpi', required: false },
    { key: 'analysis', label: '经营分析', chart: 'ai_text' },
  ],
}

function stub(over: { compile?: () => Response; create?: () => Response } = {}) {
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/reports/templates')) return json({ templates: [TEMPLATE] })
    if (url.endsWith('/templates/daily_ops/compile')) {
      return over.compile !== undefined
        ? over.compile()
        : json({ spec: { period: { mode: 'last_7_days' }, panels: [] } })
    }
    if (url.endsWith('/reports') && init?.method === 'POST') {
      return over.create !== undefined ? over.create() : json({ id: 'r-new' }, 201)
    }
    return json({})
  })
}

afterEach(() => {
  cleanup()
  m.mockReset()
  calls.length = 0
})

const renderModal = (onCreated = vi.fn(), onClose = vi.fn()) =>
  render(<TemplateCreateModal open onClose={onClose} onCreated={onCreated} />)

describe('TemplateCreateModal', () => {
  it('★ 必填槽前端先拦：不发 compile 请求', async () => {
    stub()
    renderModal()

    expect(await screen.findByText('营业额/订单/客单三卡 + 日趋势 + 经营分析。')).toBeInTheDocument()
    // ai_text 槽不出输入框
    expect(screen.queryByTestId('slot-analysis')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))
    expect(await screen.findByText(/还缺必填指标：营业额/)).toBeInTheDocument()
    expect(calls.some((c) => c.url.endsWith('/compile'))).toBe(false)
  })

  it('★ 填齐 ⇒ compile 后 create，body 用编译出的 spec；成功后回调 id', async () => {
    stub()
    const onCreated = vi.fn()
    const onClose = vi.fn()
    renderModal(onCreated, onClose)

    const revenue = await screen.findByTestId('slot-revenue')
    fireEvent.change(revenue, { target: { value: ' lemeng:retail:net_sales ' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('r-new'))
    expect(onClose).toHaveBeenCalled()
    const compile = calls.find((c) => c.url.endsWith('/compile'))!
    expect(JSON.parse(String(compile.init?.body))).toEqual({
      values: { revenue: 'lemeng:retail:net_sales' },   // 只提交填了的槽，且 trim
    })
    const create = calls.find((c) => c.url.endsWith('/reports') && c.init?.method === 'POST')!
    expect(JSON.parse(String(create.init?.body))).toMatchObject({
      title: '门店经营日报',
      renderer: 'platform',
      spec: { period: { mode: 'last_7_days' }, panels: [] },
    })
  })

  it('服务端拒绝（缺槽）⇒ 人话，不静默失败', async () => {
    stub({ compile: () => json({ error: 'MISSING_REQUIRED_SLOT', keys: ['revenue'] }, 400) })
    renderModal()

    fireEvent.change(await screen.findByTestId('slot-revenue'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: /创\s*建/ }))
    expect(await screen.findByText(/还有必填指标没填/)).toBeInTheDocument()
  })
})
