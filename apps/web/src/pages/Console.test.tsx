// Console.test.tsx — console 壳（Task 18）TDD：本文件先行，驱动 pages/Console.tsx + lib/api.ts 扩展。
//
// 契约来源：Task 13 /session /logout（csrf 现取）、Task 12 /branding、
// /api/platform/config（服务端已按租户启用过滤）、console-registry.gen（构建期聚合）。
// mock 点两个：platformFetch（按 URL 回 Response，调用全序留痕）+ 生成物 registry（vi.hoisted 可变数组）。
// 渲染走真实 <App/> 路由表（createBrowserRouter + happy-dom location）——连 /console 嵌套线路由一起测真。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ComponentType } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))

// 生成物 mock：模块经 vi.hoisted 数组按测试注入（registry 是「构建期聚合」产物，测试里等价于手摆）
const { fakeRegistry } = vi.hoisted(() => ({
  fakeRegistry: [] as Array<{
    path: string
    title: string
    icon?: string
    scope: string
    load: () => Promise<{ default: ComponentType }>
  }>,
}))
vi.mock('../console-registry.gen', () => ({ consoleRegistry: fakeRegistry }))

import { platformFetch } from '@platform/sdk/web'
import App from '../App'

const platformFetchMock = vi.mocked(platformFetch)

const SESSION = {
  user: { id: 'u-1', name: 'alice', displayName: 'Alice 陈' },
  org: 'acme-org',
  scopes: ['demo:console', 'other:console', 'billing:console'],
  csrfToken: 'csrf-xyz',
}
const SESSION_NO_DEMO = { ...SESSION, scopes: ['other:console'] }
const CONFIG_DEMO_ONLY = {
  tenant: { slug: 'acme', org: 'acme-org' },
  // 服务端契约：停用模块根本不出现（/config 已按 tenant_module 过滤）
  modules: [
    {
      id: 'demo',
      name: '演示模块',
      console: [
        { path: '/console/demo/things', title: '演示工单', icon: 'AppstoreOutlined', scope: 'demo:console' },
        // config 有、registry 没有的项 → Console 跳过
        { path: '/console/ghost/page', title: '幽灵页', scope: 'demo:console' },
      ],
    },
  ],
}
const BRANDING = { productName: 'ACME 平台', primaryColor: '#7c3aed', loginMethods: ['password'] }

/** 模块 console 页测试替身（registry.load 的 default 导出） */
function DemoPage() {
  return <div>演示模块页面内容</div>
}
function OtherPage() {
  return <div>停用模块页面内容</div>
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 全序留痕的 platformFetch mock；branding 缺省自动注册（Console 软依赖它，失败走默认品牌） */
const calls: Array<{ url: string; init?: RequestInit }> = []
function mockApi(handlers: Record<string, () => Response>): void {
  platformFetchMock.mockImplementation(async (input: string, init?: RequestInit) => {
    calls.push({ url: input, init })
    const handler = handlers[input] ?? (input === '/api/platform/branding' ? () => jsonResponse(BRANDING) : null)
    if (!handler) throw new Error('unexpected platformFetch: ' + input)
    return handler()
  })
}

function setRegistry(entries: typeof fakeRegistry): void {
  fakeRegistry.splice(0, fakeRegistry.length, ...entries)
}

/** 渲染整个 App（真实路由表），从 at 路径进入 */
function renderApp(at = '/console') {
  window.history.pushState({}, '', at)
  return render(<App />)
}

/** happy-dom 的 location.href 赋值非同步跳转，轮询 pathname 直到命中（同 Login.test） */
async function waitForLocation(pathname: string): Promise<void> {
  await waitFor(
    () => {
      if (window.location.pathname !== pathname) {
        throw new Error(`location 未跳转到 ${pathname}（当前 ${window.location.pathname}）`)
      }
    },
    { timeout: 3000 },
  )
}

beforeEach(() => {
  window.history.pushState({}, '', '/console')
})

afterEach(() => {
  cleanup()
  vi.resetAllMocks()
  calls.length = 0
  fakeRegistry.length = 0
})

describe('Console 壳（菜单聚合 + 权限门禁）', () => {
  it('① 服务端停用模块与 registry 缺项都不出菜单，只出现启用且可挂载项', async () => {
    // registry 三项：demo（config 在，启用）+ other（config 不在=服务端停用）
    setRegistry([
      {
        path: '/console/demo/things',
        title: '演示工单',
        icon: 'AppstoreOutlined',
        scope: 'demo:console',
        load: () => Promise.resolve({ default: DemoPage }),
      },
      {
        path: '/console/other/page',
        title: '停用页面',
        scope: 'other:console',
        load: () => Promise.resolve({ default: OtherPage }),
      },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()

    // 系统项「概览」+ 启用项出现
    expect(await screen.findByText('概览')).toBeInTheDocument()
    expect(screen.getByText('演示工单')).toBeInTheDocument()
    // 停用模块（config 缺席）与幽灵页（registry 缺席）都不出菜单
    expect(screen.queryByText('停用页面')).not.toBeInTheDocument()
    expect(screen.queryByText('幽灵页')).not.toBeInTheDocument()
  })

  it('①b 无所需 scope 的项被权限门禁拦下（菜单不出现）', async () => {
    setRegistry([
      {
        path: '/console/demo/things',
        title: '演示工单',
        scope: 'demo:console',
        load: () => Promise.resolve({ default: DemoPage }),
      },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION_NO_DEMO),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()

    expect(await screen.findByText('概览')).toBeInTheDocument()
    expect(screen.queryByText('演示工单')).not.toBeInTheDocument()
  })

  it('② registry 为空：概览 + 系统项正常渲染不炸，概览页展示会话/租户信息', async () => {
    setRegistry([])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()

    expect(await screen.findByText('概览')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeInTheDocument()
    // 概览页（index 路由）内容：租户 slug / 用户 displayName（avatar 也有一份）/ scope 标签
    expect(await screen.findByText('acme')).toBeInTheDocument()
    expect(screen.getAllByText('Alice 陈').length).toBeGreaterThan(0)
    expect(screen.getByText('demo:console')).toBeInTheDocument()
    expect(screen.queryByText('演示工单')).not.toBeInTheDocument()
  })

  it('②b 点击启用菜单项 → 懒加载模块页渲染（lazy(load) 接线）', async () => {
    const load = vi.fn(() => Promise.resolve({ default: DemoPage }))
    setRegistry([
      { path: '/console/demo/things', title: '演示工单', scope: 'demo:console', load },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()
    fireEvent.click(await screen.findByText('演示工单'))

    expect(await screen.findByText('演示模块页面内容')).toBeInTheDocument()
    expect(load).toHaveBeenCalled()
  })

  it('②c 无 scope 用户直敲模块 console URL → 403 Result（路由级门禁与菜单同判定，不触发懒加载）', async () => {
    const load = vi.fn(() => Promise.resolve({ default: DemoPage }))
    setRegistry([
      { path: '/console/demo/things', title: '演示工单', scope: 'demo:console', load },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION_NO_DEMO),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    // 直敲 URL（非点菜单进入）：SESSION_NO_DEMO 无 demo:console
    renderApp('/console/demo/things')

    expect(await screen.findByText('无权访问')).toBeInTheDocument()
    expect(screen.getByText('需要权限 demo:console')).toBeInTheDocument()
    // 403 短路在 lazy(load) 之前——不该触发模块页加载
    expect(load).not.toHaveBeenCalled()
    expect(screen.queryByText('演示模块页面内容')).not.toBeInTheDocument()
  })

  it('③ 退出：现取 /session 再 POST /logout（带 x-csrf-token）→ 跳 /login', async () => {
    setRegistry([])
    // 第二次 /session（点退出时的现取）回轮换后的 csrf——钉死 logout 必须用现取值而非挂载缓存
    let sessionCalls = 0
    mockApi({
      '/api/platform/auth/session': () => {
        sessionCalls += 1
        return jsonResponse(sessionCalls === 1 ? SESSION : { ...SESSION, csrfToken: 'csrf-rotated' })
      },
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
      '/api/platform/auth/logout': () => jsonResponse({ ok: true }),
    })

    renderApp()
    fireEvent.click(await screen.findByRole('button', { name: '退出登录' }))

    // 等 logout 调用落trace（getSession → logout 是两次异步接力）
    await waitFor(() => {
      expect(calls.some((c) => c.url === '/api/platform/auth/logout')).toBe(true)
    })
    // 挂载一次 /session，点退出必须「现取」再一次（会话重签轮换 csrf——Task 13 契约），再 POST logout
    const authCalls = calls.filter((c) => c.url.startsWith('/api/platform/auth/'))
    expect(authCalls.map((c) => c.url)).toEqual([
      '/api/platform/auth/session',
      '/api/platform/auth/session',
      '/api/platform/auth/logout',
    ])
    expect(authCalls[2].init?.method).toBe('POST')
    // 关键断言：logout 用的是第二次现取的轮换 csrf，不是挂载时的旧值 csrf-xyz
    expect((authCalls[2].init?.headers as Record<string, string>)['x-csrf-token']).toBe('csrf-rotated')
    await waitForLocation('/login')
  })

  it('④ 未登录（401 → platformFetch 已跳 /login 并 throw）：Console 不渲染任何内容', async () => {
    setRegistry([])
    mockApi({
      // 按 platformFetch 契约 mock：401 时先跳 /login 再 throw UNAUTHENTICATED
      '/api/platform/auth/session': () => {
        window.location.href = '/login?next=/console'
        throw new Error('UNAUTHENTICATED')
      },
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    const { container } = renderApp()

    await waitFor(() => {
      expect(window.location.pathname).toBe('/login')
    })
    await waitFor(() => {
      expect(container.textContent).toBe('')
    })
    expect(screen.queryByText('概览')).not.toBeInTheDocument()
  })
})
