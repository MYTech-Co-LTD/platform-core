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
import { App as AntdApp } from 'antd'
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

// ── #12 定时器收尸 ────────────────────────────────────────────────────────────
// 现象：CI 的 web job **24 条全过却 exit 1**，报未捕获 `ReferenceError: window is not defined`，
// 栈顶落在 `@ant-design/pro-components` 的 `BaseMenu.js:25`：`setTimeout(() => setCollapsed(...), 400)`。
// 根因（上游缺陷）：BaseMenu 的 `MenuItemTooltip` 在 useEffect 里调度这个 400ms 定时器，**不返回
// cleanup**；回调本身是一次 React setState ⇒ 组件卸载后定时器仍存活，等它触发时 vitest 可能已经把
// happy-dom 环境拆掉（window 没了）⇒ React 的更新路径读 window 抛 ReferenceError。它不是断言失败，
// 而是**用例之外的未捕获异常**——所以 24 条全绿而进程退出码 1。同一 commit `rerun --failed` 即变绿，
// 说明纯属「拆除 ↔ 定时器到期」的赛跑（CI 慢机更易输）。复现见本文件 ★ 用例。
//
// 处置：把本用例期间经全局 setTimeout 调度、拆除时**尚未触发**的定时器在拆除点显式 clearTimeout
// （真时钟下没有 clearAllTimers 这种 API，只能自己登记 id）。**这不是把红压绿**：不吞异常、不碰
// 退出码、不改断言强度——只是不让第三方调度的回调活过它所属的环境。
const realSetTimeout: typeof globalThis.setTimeout = globalThis.setTimeout.bind(globalThis)
const realClearTimeout: typeof globalThis.clearTimeout = globalThis.clearTimeout.bind(globalThis)

/**
 * 本文件期间已调度、拆除时仍未触发的定时器；键是 `setTimeout` 的**返回值原物**。
 *
 * 键类型写 `unknown` 而**不是 `number`**：happy-dom 下全局 `setTimeout` 返回的是 Node 的
 * `Timeout` **对象**，不是一个 number（探针实测：`typeof === 'object'`、构造名 `Timeout`；
 * 第一版探针用 `JSON.stringify` 打它，因 `Timeout` 循环引用**直接抛错**）。而 DOM lib 给
 * `window.setTimeout` 的声明面**就是** `number` —— 照抄那个声明等于写一个与运行时不符的类型
 * （R5-2 建议改 5：本轮主题恰是"照实写"）。
 * 行为不受影响：Map 按**对象标识**存键，`Timeout` 对象同样唯一；`clearTimeout` 对本仓登记的
 * 任何 id 都接受（消费点在 teardownConsole）。
 * 存 **id → { ms, label }** 而非只存 id：★ 用例的前置断言要认出「具体是哪条定时器」，
 * 只数个数在 M2 变异（antd 定时器不再登记）下仍全绿 —— 那个时刻在册的另有 4 条与本
 * 缺陷无关的定时器（RTL waitFor 1000ms / SWR 3000ms+2000ms / deferred 0ms），
 * 「数量 > 0」验证不了它声称的事实（R5 三路评审 findings）。
 */
const armedTimers = new Map<unknown, { ms: number; label: string }>()

/**
 * ★ 用例前置断言要认的那条定时器 = antd `BaseMenu` 无 cleanup 的那条（见上方 #12 现象说明）。
 * 两个字段都不可省：**延迟 400ms** 把它与同刻在册的无关定时器分开（实测那一刻另有 4 条：
 * RTL waitFor 1000ms、SWR 3000ms / 2000ms、deferred 0ms），**回调体 `setCollapsed`** 把它
 * 与将来别的 400ms 定时器分开。只断言「在册数量 > 0」会被那 4 条满足 ⇒ 前置断言名不副实，
 * 上游修好（antd 补 cleanup）后本用例仍全绿（R5 三路评审 findings 必须改 1）。
 * 上游若改了这个回调的形状，本该在这里变红提醒重核 —— 那是有用的红，不是过紧。
 */
const ANTD_TOOLTIP_TIMER = { ms: 400, marker: 'setCollapsed' } as const
/** 拆除之后仍被触发的定时器回调（期望恒为空——这条断言就是 #12 的回归护栏） */
const timersFiredAfterTeardown: string[] = []
let tornDown = false

/** 接管全局 setTimeout：登记 id + 标注回调是否发生在拆除之后（只有登记，不改时序/不吞异常） */
function installTimerTracker(): void {
  globalThis.setTimeout = ((handler: TimerHandler, ms?: number, ...rest: unknown[]) => {
    if (typeof handler !== 'function') return realSetTimeout(handler, ms, ...rest)
    const label = String(handler).replace(/\s+/g, ' ').slice(0, 72)
    const wrapped = () => {
      if (tornDown) timersFiredAfterTeardown.push(label)
      ;(handler as (...a: unknown[]) => void)(...rest)
    }
    const id = realSetTimeout(wrapped as TimerHandler, ms)
    armedTimers.set(id, { ms: typeof ms === 'number' ? ms : 0, label })
    return id
  }) as typeof globalThis.setTimeout
}

function restoreTimerTracker(): void {
  globalThis.setTimeout = realSetTimeout
}

/** 用例拆除：卸载组件 + 收掉本用例期间调度、尚未触发的定时器（afterEach 与 ★ 用例共用同一路径） */
function teardownConsole(): void {
  cleanup()
  // 收尸必须在卸载**之后**：卸载本身也会调度定时器（antd 的 mousePosition 复位等），
  // 一并收掉。clearTimeout 对已触发的 id 是 no-op，故整批清是安全的。
  tornDown = true
  // `as number` 只是把**声明面**按回去（DOM lib 的 clearTimeout 收 number，而 happy-dom 实返
  // 的是 `Timeout` 对象，见 armedTimers 的说明）——运行期传进去的就是当初登记的那个对象本身，
  // 收窄不改变它，`clearTimeout` 对两者都有效。
  for (const id of armedTimers.keys()) realClearTimeout(id as number)
  armedTimers.clear()
}

beforeEach(() => {
  // 护栏：上一个用例拆除时应当已收干净——afterEach 的收尸一旦被摘掉，这里就会红
  expect(armedTimers.size, '上一个用例遗留未收尸的定时器').toBe(0)
  window.history.pushState({}, '', '/console')
  tornDown = false
  timersFiredAfterTeardown.length = 0
  installTimerTracker()
})

afterEach(() => {
  teardownConsole()
  restoreTimerTracker()
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

    // 系统项「概览」+ 启用项出现（工作台卡片会带同名文本，菜单断言钉在菜单节点上防歧义）
    expect(await screen.findByText('概览')).toBeInTheDocument()
    const menuHit = (await screen.findAllByText('演示工单')).find((el) =>
      el.className.includes('ant-pro-base-menu'),
    )
    expect(menuHit).toBeDefined()
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
    // 概览页（index 路由）= 工作台（issue #36）：欢迎卡（租户/用户）+ 空模块态
    expect(await screen.findByText(/租户 acme/)).toBeInTheDocument()
    expect(screen.getAllByText(/Alice 陈/).length).toBeGreaterThan(0)
    expect(screen.getByText(/当前没有可用的模块/)).toBeInTheDocument()
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
    // 点的是「菜单项」（工作台卡片也有同名文本，见 ⑥）——钉在菜单节点上防歧义
    const menuText = (await screen.findAllByText('演示工单')).find((el) =>
      el.className.includes('ant-pro-base-menu'),
    )
    expect(menuText).toBeDefined()
    fireEvent.click(menuText!)

    expect(await screen.findByText('演示模块页面内容')).toBeInTheDocument()
    expect(load).toHaveBeenCalled()
  })

  it('⑥ 工作台：模块入口卡片按可见集合渲染，点击直达模块页', async () => {
    setRegistry([
      {
        path: '/console/demo/things',
        title: '演示工单',
        icon: 'AppstoreOutlined',
        scope: 'demo:console',
        load: () => Promise.resolve({ default: DemoPage }),
      },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()
    // 工作台出现模块入口卡片：卡片标题与所属模块名（moduleName 来自 config）在同一张 .ant-card 内
    // ——钉住「这是工作台卡片」而非顶栏菜单项（菜单项不在 .ant-card 里，防假绿；顶栏菜单也有同名文本）
    const cardTitle = (await screen.findAllByText('演示工单')).find((el) => el.closest('.ant-card'))
    expect(cardTitle).toBeDefined()
    const card = cardTitle!.closest('.ant-card')
    expect(card?.textContent).toContain('演示模块')
    // 点击卡片 → 懒加载模块页
    fireEvent.click(cardTitle!)
    expect(await screen.findByText('演示模块页面内容')).toBeInTheDocument()
  })

  it('⑦ 根路径 / 重定向 /console（登录态直达工作台，不再出现「工作台建设中」占位）', async () => {
    setRegistry([])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp('/')
    await waitForLocation('/console')
    expect(await screen.findByText(/你好，/)).toBeInTheDocument()
    expect(screen.queryByText('工作台建设中')).not.toBeInTheDocument()
  })

  it('⑦b 顶层未知路径同样重定向 /console（占位页全站下线）', async () => {
    setRegistry([])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp('/some-garbage-path')
    await waitForLocation('/console')
    expect(await screen.findByText(/你好，/)).toBeInTheDocument()
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

  it('⑤ 暗色切换：点击写入 localStorage，再点切回；初始读取持久化值', async () => {
    setRegistry([])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })
    window.localStorage.setItem('console-theme', 'dark') // 初始持久化值

    renderApp()
    const btn = await screen.findByRole('button', { name: '切换暗色模式' })
    // dark 态点击 → light
    fireEvent.click(btn)
    await waitFor(() => expect(window.localStorage.getItem('console-theme')).toBe('light'))
    // 再点 → dark
    fireEvent.click(btn)
    await waitFor(() => expect(window.localStorage.getItem('console-theme')).toBe('dark'))
    window.localStorage.removeItem('console-theme')
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

  it('★ 负例：拆除后不留存活定时器（antd MenuItemTooltip 的 400ms 定时器无 cleanup，#12）', async () => {
    setRegistry([
      {
        path: '/console/demo/things',
        title: '演示工单',
        scope: 'demo:console',
        load: () => Promise.resolve({ default: DemoPage }),
      },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    renderApp()
    // 前提：菜单（level 0）挂载后确实调度了 antd 的 tooltip 定时器，否则本用例空转
    expect((await screen.findAllByText('演示工单')).length).toBeGreaterThan(0)
    const antdTimers = [...armedTimers.values()].filter(
      (t) => t.ms === ANTD_TOOLTIP_TIMER.ms && t.label.includes(ANTD_TOOLTIP_TIMER.marker),
    )
    expect(
      antdTimers.length,
      '菜单挂载后应已登记 antd BaseMenu 的 400ms 定时器（setCollapsed(props.collapsed)）',
    ).toBeGreaterThan(0)

    // 走与 afterEach 完全相同的拆除路径（卸载 + 收尸），再等过 antd 的 400ms 窗口
    teardownConsole()
    // 先让 React 自己已排队的收尾工作跑完（scheduler 走 setImmediate，与 antd 的 400ms 定时器无关）：
    // 否则下面把 window 拿掉会把 React 的正常收尾也算成"遗留回调"，变成假红。
    for (let i = 0; i < 4; i += 1) await new Promise((r) => realSetTimeout(r, 0))
    // 再模拟 CI 的时序：vitest 拆掉 happy-dom 之后 window 已不存在——遗留回调此时触发就会
    // 复刻线上那条 `ReferenceError: window is not defined`（而不是被环境兜住变成静默 no-op）
    vi.stubGlobal('window', undefined)
    try {
      await new Promise((r) => realSetTimeout(r, 600))
    } finally {
      vi.unstubAllGlobals()
    }

    expect(timersFiredAfterTeardown, `拆除后仍触发的定时器：${JSON.stringify(timersFiredAfterTeardown)}`).toEqual([])
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

// ── issue #106：管理台缺 antd <App> 提供者 ⇒ 14 个 message 调用点全抛 TypeError ──────────
// 现象：antd 6.x 的 App.useApp() 是**裸 useContext**，没挂 <App> 时默认值是
// `{ message: {}, notification: {}, modal: {} }` ⇒ `message.success/error` 是 undefined，
// 调用即抛 `TypeError: message.error is not a function`；管理台所有操作反馈静默失效
// （成功与失败在界面上同形）。
//
// 断言强度（防「空转」）：光断言「壳里有 App 标签」验证不了任何东西——那是对实现形状的
// 同义反复。本用例走**渲染后的真实调用**：① 壳内组件拿到的 message 是**真函数**；
// ② 调它之后**真的渲染出可见文案**（`<App>` 内建的 message 持有人被挂载，调用有出口）。
// 缺了 ①，② 也无从谈起；只有 ② 能证明「反馈对用户可见」这件事真的成立。
/**
 * 壳内探针每次渲染留下的 message（供断言读取；用例前置清空数组）。
 * 用**数组**而不是模块级 `let`/属性：前者无论怎么清空都不会被 TS 的控制流分析窄化，
 * 而 `delete probe.message` / `probe.message = undefined` 会把该属性一路窄成 `undefined`
 * ——后面 `message.success` 直接判为 `never`（typecheck 实测 TS2339，两版都踩过）。
 */
const probeMessages: Array<ReturnType<typeof AntdApp.useApp>['message']> = []

/** 挂在管理台壳内（经 registry 懒加载）的探针页：只做一件事——把 useApp() 的 message 交出去 */
function MessageProbe() {
  probeMessages.push(AntdApp.useApp().message)
  return <div>消息探针页</div>
}

describe('管理台 antd <App> 提供者（issue #106）', () => {
  it('壳内 App.useApp() 拿到的 message 是真 API，且调用渲染出可见反馈', async () => {
    probeMessages.length = 0
    setRegistry([
      {
        path: '/console/probe',
        title: '消息探针',
        scope: 'demo:console',
        load: () => Promise.resolve({ default: MessageProbe }),
      },
    ])
    mockApi({
      '/api/platform/auth/session': () => jsonResponse(SESSION),
      '/api/platform/config': () => jsonResponse(CONFIG_DEMO_ONLY),
    })

    // 直敲模块路由（经壳的 Outlet 渲染）——探针确实在管理台壳**之内**，不是裸渲染
    renderApp('/console/probe')
    expect(await screen.findByText('消息探针页')).toBeInTheDocument()

    // ① 真函数（缺 <App> 时 antd 给的默认值是 {} ⇒ 这两个断言在修复前即红）
    const message = probeMessages.at(-1)
    expect(typeof message?.success).toBe('function')
    expect(typeof message?.error).toBe('function')

    // ② 调用有出口：文案真的渲染进文档（`<App>` 内建持有人已挂载）
    message!.success('保存成功 #106')
    expect(await screen.findByText('保存成功 #106')).toBeInTheDocument()
    message!.error('保存失败 #106')
    expect(await screen.findByText('保存失败 #106')).toBeInTheDocument()
  })
})
