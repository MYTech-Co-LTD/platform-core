// Login.test.tsx — 登录页运行时品牌渲染（TDD：本文件先行，驱动 lib/api.ts + pages/Login.tsx）
//
// 契约来源：Task 12 branding / Task 13 login / Task 14 企微 qr+postMessage / Task 10 platformFetch。
// 唯一 mock 点 = platformFetch（按 URL 回 Response），api.ts 的错误体解析逻辑走真实代码。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

import { platformFetch } from '@platform/sdk/web'
import LoginPage from './Login'

const platformFetchMock = vi.mocked(platformFetch)

const BRANDING_DUAL = {
  productName: 'ACME 工单平台',
  primaryColor: '#7c3aed',
  loginMethods: ['password', 'wecom-qr'],
}
const BRANDING_PASSWORD_ONLY = {
  productName: 'Platform',
  primaryColor: '#1890ff',
  loginMethods: ['password'],
}
const WECOM_QR_URL = 'https://login.work.weixin.qq.com/wwlogin/sso?appid=CORP'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 按 URL 路由 mock platformFetch；未登记 URL 直接炸（防假绿） */
function mockApi(handlers: Record<string, () => Response>): void {
  platformFetchMock.mockImplementation(async (input: string) => {
    const handler = handlers[input]
    if (!handler) throw new Error('unexpected platformFetch: ' + input)
    return handler()
  })
}

beforeEach(() => {
  window.history.pushState({}, '', '/login')
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
})

describe('LoginPage（运行时品牌）', () => {
  it('① 双方法租户：渲染 productName 与 账密+企微 两个 Tab', async () => {
    mockApi({ '/api/platform/branding': () => jsonResponse(BRANDING_DUAL) })

    render(<LoginPage />)

    expect(await screen.findByText('ACME 工单平台')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: '账号密码登录' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '企业微信扫码' })).toBeInTheDocument()
  })

  it('② 单 password 方法租户：仅一个 Tab，无企微 Tab', async () => {
    mockApi({ '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY) })

    render(<LoginPage />)

    await screen.findByText('Platform')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.queryByRole('tab', { name: '企业微信扫码' })).not.toBeInTheDocument()
  })

  it('②b loginMethods 空数组（租户配置错）：兜底渲染单账密 Tab，不留零 Tab 白页', async () => {
    mockApi({
      '/api/platform/branding': () =>
        jsonResponse({ productName: 'Broken Tenant', primaryColor: '#1890ff', loginMethods: [] }),
    })

    render(<LoginPage />)

    await screen.findByText('Broken Tenant')
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: '账号密码登录' })).toBeInTheDocument()
  })

  it('③ 账密提交失败（401 BAD_CREDENTIALS）：Alert 显示对应文案', async () => {
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY),
      '/api/platform/auth/login': () => jsonResponse({ error: 'BAD_CREDENTIALS' }, 401),
    })

    render(<LoginPage />)
    await screen.findByText('Platform')

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'wrong-pass' } })
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }))

    expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument()
    // 失败后留在本页（不跳转）
    expect(window.location.pathname).toBe('/login')
  })

  it('③b 账密提交成功：跳 next 缺省的 /console', async () => {
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY),
      '/api/platform/auth/login': () => jsonResponse({ ok: true }),
    })

    render(<LoginPage />)
    await screen.findByText('Platform')

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'right-pass' } })
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }))

    await waitForLocation('/console')
  })

  it('③c next=//evil.example（协议相对）：防开放重定向，回落 /console', async () => {
    window.history.pushState({}, '', '/login?next=//evil.example')
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY),
      '/api/platform/auth/login': () => jsonResponse({ ok: true }),
    })

    render(<LoginPage />)
    await screen.findByText('Platform')

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'right-pass' } })
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }))

    await waitForLocation('/console')
  })

  it('③d next=https://evil.example（绝对外链）：防开放重定向，回落 /console', async () => {
    window.history.pushState({}, '', '/login?next=https://evil.example/x')
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY),
      '/api/platform/auth/login': () => jsonResponse({ ok: true }),
    })

    render(<LoginPage />)
    await screen.findByText('Platform')

    fireEvent.change(screen.getByLabelText('用户名'), { target: { value: 'alice' } })
    fireEvent.change(screen.getByLabelText('密码'), { target: { value: 'right-pass' } })
    fireEvent.click(screen.getByRole('button', { name: /登\s*录/ }))

    await waitForLocation('/console')
  })

  it('④ 企微 Tab：挂载取 qr 渲染 iframe；postMessage sso-fail → 错误 Alert', async () => {
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_DUAL),
      '/api/platform/auth/wecom/qr': () => jsonResponse({ url: WECOM_QR_URL }),
    })

    render(<LoginPage />)
    await screen.findByText('ACME 工单平台')

    fireEvent.click(screen.getByRole('tab', { name: '企业微信扫码' }))
    const iframe = await screen.findByTitle('企业微信扫码登录')
    expect(iframe).toHaveAttribute('src', WECOM_QR_URL)

    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'sso-fail', error: 'NO_ACCOUNT' },
        origin: window.location.origin,
      }),
    )
    expect(await screen.findByText(/未绑定平台账号/)).toBeInTheDocument()
  })

  it('④b 企微 Tab：postMessage sso-done → 跳 /console（含 next 参数优先）', async () => {
    window.history.pushState({}, '', '/login?next=/console/demo')
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_DUAL),
      '/api/platform/auth/wecom/qr': () => jsonResponse({ url: WECOM_QR_URL }),
    })

    render(<LoginPage />)
    await screen.findByText('ACME 工单平台')

    fireEvent.click(screen.getByRole('tab', { name: '企业微信扫码' }))
    await screen.findByTitle('企业微信扫码登录')

    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'sso-done' },
        origin: window.location.origin,
      }),
    )
    await waitForLocation('/console/demo')
  })

  it('④c 异 origin 的 sso-done：忽略不跳转；同 origin 再发才跳（origin 校验）', async () => {
    mockApi({
      '/api/platform/branding': () => jsonResponse(BRANDING_DUAL),
      '/api/platform/auth/wecom/qr': () => jsonResponse({ url: WECOM_QR_URL }),
    })

    render(<LoginPage />)
    await screen.findByText('ACME 工单平台')

    fireEvent.click(screen.getByRole('tab', { name: '企业微信扫码' }))
    await screen.findByTitle('企业微信扫码登录')

    // 异源伪造 sso-done → 不跳
    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'sso-done' },
        origin: 'https://evil.example',
      }),
    )
    await new Promise((r) => setTimeout(r, 150))
    expect(window.location.pathname).toBe('/login')

    // 正控制：同源再发 → 跳（证明监听器活着，被拦的只是异源）
    fireEvent(
      window,
      new MessageEvent('message', {
        data: { type: 'sso-done' },
        origin: window.location.origin,
      }),
    )
    await waitForLocation('/console')
  })

  it('⑤ ?error=NO_ACCOUNT 挂载（302 浏览器兜底）：直接显示对应文案', async () => {
    window.history.pushState({}, '', '/login?error=NO_ACCOUNT')
    mockApi({ '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY) })

    render(<LoginPage />)

    expect(await screen.findByText(/未绑定平台账号/)).toBeInTheDocument()
  })

  it('⑤b ?error=未知码 挂载：回退通用文案', async () => {
    window.history.pushState({}, '', '/login?error=SOMETHING_ELSE')
    mockApi({ '/api/platform/branding': () => jsonResponse(BRANDING_PASSWORD_ONLY) })

    render(<LoginPage />)

    expect(await screen.findByText('登录失败，请稍后重试')).toBeInTheDocument()
  })

  it('⑤c branding 取失败：回退默认品牌（Platform + 单账密 Tab）', async () => {
    platformFetchMock.mockImplementation(async () => jsonResponse({ error: 'BOOM' }, 500))

    render(<LoginPage />)

    expect(await screen.findByText('Platform')).toBeInTheDocument()
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('tab', { name: '账号密码登录' })).toBeInTheDocument()
  })
})

/** happy-dom 的 location.href 赋值非同步跳转，轮询 pathname 直到命中（防 flake） */
async function waitForLocation(pathname: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (window.location.pathname !== pathname) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `location 未跳转到 ${pathname}（当前 ${window.location.pathname}${window.location.search}）`,
      )
    }
    await new Promise((r) => setTimeout(r, 10))
  }
}
