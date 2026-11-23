// admin/settings.test.tsx — 售后设置（管理组子页）：三态渲染、首次必填 secret、留空不修改、
// CSRF 走 session、保存后回读。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import SettingsPage from './settings'

const m = vi.mocked(platformFetch)
const calls: Array<{ url: string; method?: string; body?: unknown; csrf?: string }> = []
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } })

let state = { appId: '', configured: false, partial: false, secretConfigured: false }

beforeEach(() => {
  calls.length = 0
  state = { appId: '', configured: false, partial: false, secretConfigured: false }
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url, method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      csrf: (init?.headers as Record<string, string> | undefined)?.['x-csrf-token'],
    })
    if (url === '/api/platform/session') return json({ csrfToken: 'tok-1' })
    if (init?.method === 'PUT') {
      const b = JSON.parse(String(init.body)) as { appId: string }
      state = { ...state, appId: b.appId, configured: true, partial: false, secretConfigured: true }
      return json({ ok: true })
    }
    return json(state)
  })
})
// #1329：React 19 调度任务可能在 cleanup 后才执行 → 先排空一个宏任务再拆环境
afterEach(async () => {
  cleanup()
  await new Promise((r) => setTimeout(r, 0))
})

describe('售后设置（公众号配置）', () => {
  it('未配置 ⇒ 提示访客登录不可用，secret 标「首次配置必填」', async () => {
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByText(/未配置：售后移动端访客登录不可用/)).toBeInTheDocument())
    expect(screen.getByText('首次配置必填')).toBeInTheDocument()
  })

  it('半套配置 ⇒ 告警「配置不完整 ⇒ 访客登录不可用」', async () => {
    state = { appId: 'wx123', configured: false, partial: true, secretConfigured: false }
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByText(/配置不完整/)).toBeInTheDocument())
  })

  it('已配置 ⇒ AppID 回填，secret 提示「已配置；留空表示不修改」', async () => {
    state = { appId: 'wx123', configured: true, partial: false, secretConfigured: true }
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByDisplayValue('wx123')).toBeInTheDocument())
    expect(screen.getByText('已配置；留空表示不修改')).toBeInTheDocument()
  })

  it('保存 ⇒ 先取 session 的 csrfToken，再带 x-csrf-token PUT；secret 留空时不传 secret 字段', async () => {
    state = { appId: 'wx123', configured: true, partial: false, secretConfigured: true }
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByDisplayValue('wx123')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => {
      const put = calls.find((c) => c.method === 'PUT')
      expect(put).toBeTruthy()
      expect(put!.csrf).toBe('tok-1')
      expect(put!.body).toEqual({ appId: 'wx123' }) // secret 留空 ⇒ 字段不传（服务端保持原值）
    })
    expect(calls.some((c) => c.url === '/api/platform/session')).toBe(true)
  })

  it('首次配置未填 secret ⇒ 前端校验拦截，不发 PUT', async () => {
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByText(/未配置/)).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('wx1234567890abcdef'), { target: { value: 'wx-new' } })
    fireEvent.click(screen.getByRole('button', { name: /保\s*存/ }))
    await waitFor(() => expect(screen.getByText('首次配置必须填写 AppSecret')).toBeInTheDocument())
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})
