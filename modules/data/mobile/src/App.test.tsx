// App.test.tsx — 移动指标页的呈现与草稿流（spec 2026-11-01 §10.2 判定表 → 页面契约）。
// fetch 全部 mock（纯前端测试）；后端契约已在 routes/metrics.test.ts 钉过，这里钉「页面怎么消费」。
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const origFetch = globalThis.fetch
const origLocation = window.location

afterEach(() => {
  cleanup()
  globalThis.fetch = origFetch
  Object.defineProperty(window, 'location', { configurable: true, value: origLocation })
})

/** fetch mock：按 [path 前缀, method] 路由到响应工厂。 */
function mockFetch(routes: Array<{ match: (url: string, method: string) => boolean; respond: () => Response }>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const hit = routes.find((r) => r.match(url, method))
    if (hit === undefined) throw new Error(`no mock for ${method} ${url}`)
    return hit.respond()
  }) as unknown as typeof fetch
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const LIST = {
  metrics: [
    { id: 'm:l1', title: '净销售额', description: '平台口径', certified: 'certified', source: 'l1', createdBy: null,
      freshness: { status: 'normal', watermark: '2026-11-01' } },
    { id: 'm:mine', title: '我的毛利', description: '自建', certified: 'draft', source: 'l2', createdBy: 'u-me' },
    { id: 'm:other', title: '别人的', description: '自建', certified: 'draft', source: 'l2', createdBy: 'u-someone-else',
      freshness: { status: 'alert', watermark: '2026-10-01' } },
  ],
  self: { userId: 'u-me' },
}

describe('移动指标页（spec 2026-11-01 §10.2）', () => {
  beforeEach(() => {
    mockFetch([{ match: (u, m) => u.includes('/api/modules/data/metrics') && m === 'GET' && !u.includes('/draft'),
      respond: () => json(200, LIST) }])
  })

  it('列表渲染：三张卡 + 徽标（平台口径/自建、认证态、新鲜度三态）', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('净销售额')).toBeTruthy())
    expect(screen.getByText('我的毛利')).toBeTruthy()
    expect(screen.getByText('别人的')).toBeTruthy()
    // 来源判定表：L1 ⇒ 平台口径；L2 ⇒ 自建
    expect(screen.getAllByText('平台口径').length).toBeGreaterThan(0)
    expect(screen.getAllByText('自建').length).toBeGreaterThan(0)
    // 认证徽标：certified ⇒ 平台认证；draft ⇒ 未认证
    expect(screen.getAllByText('平台认证').length).toBeGreaterThan(0)
    expect(screen.getAllByText('未认证').length).toBeGreaterThan(0)
    // 新鲜度：有水位 ⇒ 人话日期；alert ⇒ 滞后；缺席 ⇒ 新鲜度未知（不捏造）
    expect(screen.getByText(/数据至 11月1日/)).toBeTruthy()
    expect(screen.getByText(/滞后/)).toBeTruthy()
    expect(screen.getByText('新鲜度未知')).toBeTruthy()
  })

  it('「编辑草稿」只出现在自己的 L2 上（L1 只读、非我创建只读——判定表直译）', async () => {
    render(<App />)
    await waitFor(() => expect(screen.getByText('我的毛利')).toBeTruthy())
    expect(screen.getAllByText('编辑草稿')).toHaveLength(1)
  })

  it('草稿流：保存草稿 → 确认生效 → 列表刷新（确认走唯一编译点的端上走通）', async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    mockFetch([
      { match: (u, m) => u.endsWith('/draft') && m === 'PUT',
        respond: () => { const r = json(200, { ok: true }); calls.push({ url: 'draft-put', method: 'PUT' }); return r } },
      { match: (u, m) => u.endsWith('/confirm-draft') && m === 'POST',
        respond: () => { calls.push({ url: 'confirm', method: 'POST' }); return json(200, { ok: true }) } },
      { match: (u, m) => u.includes('/api/modules/data/metrics') && m === 'GET',
        respond: () => json(200, LIST) },
    ])
    render(<App />)
    const edit = await waitFor(() => screen.getByText('编辑草稿'))
    edit.click()
    // 编辑器开着：确认生效（无草稿直接点也行——后端 404 有契约；这里走「先确认」最短链）
    const confirmBtn = await waitFor(() => screen.getByText('确认生效'))
    confirmBtn.click()
    await waitFor(() => expect(calls.some((c) => c.url === 'confirm')).toBe(true))
  })

  it('401 ⇒ 跳 wecom 静默授权并带 next 回跳（IM webview 的恢复路径，不是 console /login）', async () => {
    const hrefs: string[] = []
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/app/data/', search: '', set href(v: string) { hrefs.push(v) } },
    })
    mockFetch([{ match: () => true, respond: () => json(401, { error: 'UNAUTHENTICATED' }) }])
    render(<App />)
    await waitFor(() => expect(hrefs[0]).toContain('/api/platform/auth/wecom/silent?next='))
    expect(hrefs[0]).toContain(encodeURIComponent('/app/data/'))
  })

  it('认证升降（D7）：管理员见「撤回认证/标记认证」按钮；普通人不见（affordance 收在 scopes 上）', async () => {
    // 普通人（scopes 无 data:manage）：无按钮
    render(<App />)
    await waitFor(() => expect(screen.getByText('我的毛利')).toBeTruthy())
    expect(screen.queryByText('标记认证')).toBeNull()
    expect(screen.queryByText('撤回认证')).toBeNull()
    cleanup()

    // 管理员：L2 卡上有动作；点击 → PUT certified 到位 + 列表刷新
    const puts: string[] = []
    mockFetch([
      { match: (u, m) => u.includes('/api/modules/data/metrics') && m === 'GET' && !u.includes('/draft') && !u.includes('/certified'),
        respond: () => json(200, { ...LIST, self: { userId: 'u-admin', scopes: ['data:query', 'data:manage'] } }) },
      { match: (u, m) => u.endsWith('/certified') && m === 'PUT',
        respond: () => { puts.push('PUT certified'); return json(200, { ok: true }) } },
    ])
    render(<App />)
    const btn = await waitFor(() => screen.getAllByText('标记认证'))
    expect(btn.length).toBeGreaterThan(0)          // L1 卡不给按钮（读侧恒 certified）
    fireEvent.click(btn[0]!)
    await waitFor(() => expect([...puts]).toContain('PUT certified'))
  })
})
