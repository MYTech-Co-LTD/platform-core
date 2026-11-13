// App.test.tsx — 移动指标页的**只读**呈现（spec 2026-11-01 §10.2 判定表 → 页面契约）。
// fetch 全部 mock（纯前端测试）；后端契约已在 routes/metrics.test.ts 钉过，这里钉「页面怎么消费」。
// P4 写面收口（2026-11-13）：移动端是纯只读面——编辑草稿/确认生效/元数据/认证升降全部不存在。
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
      freshness: { status: 'alert', watermark: '2026-10-01' },
      bizDescription: '出库口径毛利', unit: '元' },
  ],
  self: { userId: 'u-me' },
}

/** P4 收口：移动端四个写入口在**任何**身份下都不得出现（admin 也不例外）。 */
const WRITE_ACTIONS = ['编辑草稿', '确认生效', '元数据', '标记认证', '撤回认证']

describe('移动指标页（spec 2026-11-01 §10.2）', () => {
  beforeEach(() => {
    mockFetch([
      { match: (u, m) => u.includes('/api/modules/data/reports') && m === 'GET',
        respond: () => json(200, { reports: [] }) },
      { match: (u, m) => u.includes('/api/modules/data/metrics') && m === 'GET' && !u.includes('/draft'),
        respond: () => json(200, LIST) },
    ])
  })

  it('列表渲染：三张卡 + 徽标（平台口径/自建、认证态、新鲜度三态）', async () => {
    render(<App initialTab="metricsManage" />)
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

  it('★ 移动端搜索（UX）：按名称/说明过滤，计数更新，无匹配有空态', async () => {
    render(<App initialTab="metricsManage" />)
    await waitFor(() => expect(screen.getByText('净销售额')).toBeTruthy())
    const input = screen.getByPlaceholderText('搜索名称 / 说明')

    // "毛利" 同时命中「我的毛利」（标题）与「别人的」（业务描述「出库口径毛利」）
    fireEvent.change(input, { target: { value: '毛利' } })
    expect(screen.getByText('我的毛利')).toBeTruthy()
    expect(screen.getByText('别人的')).toBeTruthy()
    expect(screen.queryByText('净销售额')).toBeNull()
    expect(screen.getByText('匹配 2 / 3')).toBeTruthy()

    // 业务描述也参与匹配（bizDescription='出库口径毛利'）
    fireEvent.change(input, { target: { value: '出库' } })
    expect(screen.getByText('别人的')).toBeTruthy()
    expect(screen.getByText('匹配 1 / 3')).toBeTruthy()

    fireEvent.change(input, { target: { value: '不存在的指标' } })
    expect(screen.getByText('没有匹配的指标')).toBeTruthy()
  })

  it('★ 纯只读：自己的 L2 上没有「编辑草稿 / 元数据」入口（creator 自助写面已退役）', async () => {
    render(<App initialTab="metricsManage" />)
    await waitFor(() => expect(screen.getByText('我的毛利')).toBeTruthy())
    // 卡片仍在（含「我的」只读标记），但不再派生写入口
    expect(screen.getByText('我的')).toBeTruthy()
    expect(screen.queryByText('编辑草稿')).toBeNull()
    expect(screen.queryByText('元数据')).toBeNull()
  })

  it('401 ⇒ 跳 wecom 静默授权并带 next 回跳（IM webview 的恢复路径，不是 console /login）', async () => {
    const hrefs: string[] = []
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { pathname: '/app/data/', search: '', set href(v: string) { hrefs.push(v) } },
    })
    mockFetch([{ match: () => true, respond: () => json(401, { error: 'UNAUTHENTICATED' }) }])
    render(<App initialTab="metricsManage" />)
    await waitFor(() => expect(hrefs[0]).toContain('/api/platform/auth/wecom/silent?next='))
    expect(hrefs[0]).toContain(encodeURIComponent('/app/data/'))
  })

  it('★ 管理员视角也纯只读：卡片与认证徽标渲染，但四个写动作一律不存在', async () => {
    mockFetch([
      { match: (u, m) => u.includes('/api/modules/data/reports') && m === 'GET',
        respond: () => json(200, { reports: [] }) },
      { match: (u, m) => u.includes('/api/modules/data/metrics') && m === 'GET' && !u.includes('/draft'),
        respond: () => json(200, { ...LIST, self: { userId: 'u-admin', scopes: ['data:query', 'data:manage'] } }) },
    ])
    render(<App initialTab="metricsManage" />)
    await waitFor(() => expect(screen.getByText('净销售额')).toBeTruthy())
    expect(screen.getByText('我的毛利')).toBeTruthy()
    expect(screen.getAllByText('平台认证').length).toBeGreaterThan(0)
    for (const label of WRITE_ACTIONS) expect(screen.queryByText(label)).toBeNull()
    // 只读面不得因「有没有动作」而额外发写请求（mock 没有 PUT/POST 路由，发一个就抛）
    expect(screen.getByPlaceholderText('搜索名称 / 说明')).toBeTruthy()
  })

  it('元数据展示：带标注的显示业务描述+单位；未标注的诚实显「未标注」（不编默认值）', async () => {
    render(<App initialTab="metricsManage" />)
    await waitFor(() => expect(screen.getByText('我的毛利')).toBeTruthy())
    expect(screen.getByText(/业务描述：出库口径毛利 · 单位：元/)).toBeTruthy()
    expect(screen.getAllByText('业务描述：未标注').length).toBeGreaterThan(0)   // 夹具里两条未标注（mine + L1）
  })
})

describe('创建入口（决策：创建交给 agent，移动端只读）', () => {
  it('★ admin 也没有手动新建指标入口；四个写动作全部不存在', async () => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/modules/data/reports') && (init?.method ?? 'GET') === 'GET') return json(200, { reports: [] })
      if (url.includes('/api/modules/data/metrics') && (init?.method ?? 'GET') === 'GET') {
        return json(200, { ...LIST, self: { userId: 'u-admin', scopes: ['data:query', 'data:manage'] } })
      }
      throw new Error(`no mock for ${init?.method ?? 'GET'} ${url}`)
    }) as unknown as typeof fetch
    render(<App initialTab="metricsManage" />)
    await waitFor(() => expect(screen.getByText('净销售额')).toBeTruthy())

    // 实现面：手机上手填 id + 写算式的入口必须不存在（admin 也不给）
    expect(screen.queryByText('新建指标')).toBeNull()
    // 页面要回答「指标从哪来」
    expect(screen.getByText(/指标由 agent 创建/)).toBeTruthy()
    // 写面已收口：连认证升降也不再在移动端出现（治理动作在控制台）
    for (const label of WRITE_ACTIONS) expect(screen.queryByText(label)).toBeNull()
  })
})
