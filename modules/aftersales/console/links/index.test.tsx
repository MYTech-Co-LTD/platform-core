// links/index.test.tsx — 身份绑定管理页：列表渲染、确认/改绑/解绑/恢复、revoked 无操作、
// 服务端掩码原样透出（前端不再掩）、无 total 不摆分页（账户统一 Task 8）
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import LinksPage from './index'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown }> = []
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

const ROWS = [
  {
    id: 7, provider: 'wechat-oa', externalId: 'oX', casdoorName: 'grace',
    status: 'pending', phoneMasked: '138****11', boundVia: null, createdAt: '2026-10-10T00:00:00.000Z',
  },
  {
    id: 8, provider: 'wecom', externalId: 'ww:corp', casdoorName: 'heidi',
    status: 'active', phoneMasked: null, boundVia: 'manual', createdAt: '2026-10-10T00:00:00.000Z',
  },
  {
    id: 9, provider: 'wechat-oa', externalId: 'oY', casdoorName: 'ivy',
    status: 'disputed', phoneMasked: '139****22', boundVia: 'auto', createdAt: '2026-10-10T00:00:00.000Z',
  },
  {
    id: 10, provider: 'wecom', externalId: 'ww:x2', casdoorName: 'jack',
    status: 'revoked', phoneMasked: null, boundVia: 'manual', createdAt: '2026-10-10T00:00:00.000Z',
  },
]

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === 'POST') return json({ ok: true })
    return json({ items: ROWS })
  })
})
afterEach(cleanup)

const postCalls = () => calls.filter((c) => c.method === 'POST')

describe('身份绑定页', () => {
  it('渲染四态行：渠道、外部号、账户、状态、绑定方式；掩码手机号**原样**透出（前端不再掩）', async () => {
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('grace')).toBeInTheDocument())
    expect(screen.getAllByText('公众号').length).toBeGreaterThan(0)
    expect(screen.getAllByText('企业微信').length).toBeGreaterThan(0)
    expect(screen.getByText('oX')).toBeInTheDocument()
    // 服务端已掩码的值直接展示——若前端错误地二次掩码，这个原样断言会红
    expect(screen.getByText('138****11')).toBeInTheDocument()
    expect(screen.getAllByText('待确认').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已绑定').length).toBeGreaterThan(0)
    expect(screen.getAllByText('争议中').length).toBeGreaterThan(0)
    expect(screen.getAllByText('已解绑').length).toBeGreaterThan(0)
    expect(screen.getAllByText('人工').length).toBeGreaterThan(0) // boundVia=manual
  })

  it('★ pending 行「确认」⇒ POST /identity-links/7/confirm（无 body），并刷新列表', async () => {
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('grace')).toBeInTheDocument())
    // antd 给两个汉字的按钮插空格 ⇒ 可访问名是「确 认」
    fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }))
    await waitFor(() => expect(postCalls().some((c) => c.url.endsWith('/identity-links/7/confirm'))).toBe(true))
    expect(postCalls().find((c) => c.url.endsWith('/confirm'))!.body).toBeUndefined()
    await waitFor(() => expect(calls.filter((c) => c.method === undefined).length).toBeGreaterThanOrEqual(2))
  })

  it('★ 改绑 ⇒ 弹窗输入目标账户 ⇒ POST /identity-links/8/rebind { casdoorName }', async () => {
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('heidi')).toBeInTheDocument())
    // 改绑按钮按行序 = [pending#7, active#8, disputed#9]；点 active（heidi）那行的
    fireEvent.click(screen.getAllByRole('button', { name: /改\s*绑/ })[1]!)
    const input = await screen.findByPlaceholderText('Casdoor 账户名')
    fireEvent.change(input, { target: { value: 'lily' } })
    fireEvent.click(screen.getByRole('button', { name: /确\s*定/ }))
    await waitFor(() => expect(postCalls().some((c) => c.url.endsWith('/identity-links/8/rebind'))).toBe(true))
    expect(postCalls().find((c) => c.url.endsWith('/rebind'))!.body).toEqual({ casdoorName: 'lily' })
  })

  it('★ active 行「解绑」⇒ POST /identity-links/8/revoke（无 body）', async () => {
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('heidi')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /解\s*绑/ }))
    await waitFor(() => expect(postCalls().some((c) => c.url.endsWith('/identity-links/8/revoke'))).toBe(true))
    expect(postCalls().find((c) => c.url.endsWith('/revoke'))!.body).toBeUndefined()
  })

  it('disputed 行有「恢复」（走 confirm 缺省目标）+ 改绑；revoked 行无任何操作按钮', async () => {
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('ivy')).toBeInTheDocument())
    // 两个「恢复」按钮不会同时存在——恢复只在 disputed 行；确认只在 pending 行
    expect(screen.getByRole('button', { name: /恢\s*复/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /确\s*认/ })).not.toBeNull() // pending 行的确认也在
    // revoked 行（jack 那行）没有操作按钮：全部操作按钮数 = pending2 + active2 + disputed2 = 6
    const opButtons = screen.getAllByRole('button', { name: /确\s*认|改\s*绑|解\s*绑|恢\s*复/ })
    expect(opButtons.length).toBe(6)
  })

  it('★ 操作失败（LINK_TARGET_MISSING）⇒ 弹出可读文案，不白屏', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return json({ error: 'LINK_TARGET_MISSING' }, 400)
      return json({ items: ROWS })
    })
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('grace')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /确\s*认/ }))
    await waitFor(() => expect(screen.getByText('目标账户不存在，请核对账户名后重试')).toBeInTheDocument())
  })

  it('★ 列表 503（服务未注入）⇒ Alert 显示可读文案', async () => {
    m.mockImplementation(async () => json({ error: 'IDENTITY_LINKS_UNAVAILABLE' }, 503))
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('身份绑定服务未就绪，请联系管理员')).toBeInTheDocument())
  })

  it('★ 无 total ⇒ 不出现分页控件', async () => {
    render(<LinksPage />)
    await waitFor(() => expect(screen.getByText('grace')).toBeInTheDocument())
    expect(document.querySelector('.ant-pagination')).toBeNull()
  })
})
