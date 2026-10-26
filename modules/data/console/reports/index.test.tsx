// index.test.tsx — 报表页签：双视图选择（session.scopes）+ 管理动作（页门/发布/回收）。
// 挂载形态照宿主壳真实结构：ReportsPage 经 Outlet 注入 session（demo 模块先例）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
// SpecView（Task 4 起被本页引入）依赖 echarts；happy-dom 的 canvas.getContext('2d') 返回 null
// （实测）⇒ 真 echarts init 必抛。桩掉 SpecView 用到的表面（形状见 SpecView.test.tsx 头注）。
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
import { platformFetch } from '@platform/sdk/web'
import ReportsPage from './index'

const m = vi.mocked(platformFetch)
const calls: { url: string; init?: RequestInit }[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

// `version` = **登记侧**版本（写保护的读侧，`GET /reports/manage` 回带）：console 从管理清单
// 读到它、写时回带。自绘行（r3）**也给**——登记侧版本与渲染器无关（platform 行的登记行同样有版本）。
// ⚠️ **三行必须互不相同**（评审 I-1，2026-09-29）：若三行同值，「硬写常量」与「读到该行版本」
//    不可区分 ⇒ 写用例全是**假绿**（实测：全行 = 1 时把实现硬写成常量 1，五条写用例照样绿）。
//    互异后，硬写任一常量（含 `1`）都会被**别的行**的断言咬住；断言一律 `ROWS[i].version`，**不硬写**。
// ── 版本徽标字段（月报重做 Task 12）：只有 `GET /reports/manage` 回带。
// r3 = 已发布 v2 且草稿改过（橙色「有未发布改动」）；r4 = 从未发布（灰色「未发布」）。
// Metabase 行（r1/r2）的 publishedVersion 恒 null，但**不渲染**徽标（版本通路只属 platform 行）。
const ROWS = [
  { id: 'r1', title: '销售日报', requiredScope: null, renderer: 'metabase', version: 1, publishedVersion: null, hasUnpublishedChanges: false },
  { id: 'r2', title: '未放行报表', requiredScope: 'sales:read', renderer: 'metabase', version: 2, publishedVersion: null, hasUnpublishedChanges: false },
  { id: 'r3', title: '自绘大盘', requiredScope: null, renderer: 'platform', version: 3, publishedVersion: 2, hasUnpublishedChanges: true },
  { id: 'r4', title: '未发布报表', requiredScope: null, renderer: 'platform', version: 5, publishedVersion: null, hasUnpublishedChanges: false },
]

/** `GET /reports/:id/versions` 夹具：r3 线上 v2，v1 是历史版（可回滚）。 */
const VERSIONS = [
  { version: 2, title: '自绘大盘', publishedAt: '2026-10-24T08:00:00.000Z', publishedBy: 'u1', note: '第二版', draftVersion: 3, isCurrent: true },
  { version: 1, title: '自绘大盘', publishedAt: '2026-10-20T08:00:00.000Z', publishedBy: 'u1', note: '首版', draftVersion: 1, isCurrent: false },
]

function renderPage(scopes: string[], initialEntry = '/console/data/reports') {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes } }} />,
        children: [{ path: '/console/data/reports', element: <ReportsPage /> }],
      },
    ],
    { initialEntries: [initialEntry] },
  )
  render(<RouterProvider router={router} />)
}

/**
 * antd 会给「**恰好两个汉字**」的按钮标签中间插一个**真实空格**（`发 布`）——
 * 这是它的排版特性（`autoInsertSpace`，Button.js 里 `spaceChildren(..., needInserted && mergedInsertSpace)`），
 * 不是 label 真的变了。故本文件照 `console/metrics/index.test.tsx` 一律按
 * `Role + 容空白正则` 查按钮，不用 `getByRole('button', { name: '发布' })`
 * （那会因空格而找不到，而报错会误导成「按钮没渲染」）。
 */
const button = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label.split('').join('\\s*')}$`) })
const buttons = (label: string) =>
  screen.getAllByRole('button', { name: new RegExp(`^${label.split('').join('\\s*')}$`) })

/** 按**行**取按钮：页面上现在有两个「发布」（Metabase 行清页门 / platform 行发版本），
 *  全页 `getByRole` 会因歧义抛错。`rowOf` 用标题文本定位 `<tr>`（标题唯一）。 */
const rowOf = (title: string) => screen.getByText(title).closest('tr')!
const rowButton = (title: string, label: string) =>
  within(rowOf(title)).getByRole('button', { name: new RegExp(`^${label.split('').join('\\s*')}$`) })

/**
 * Popconfirm 的确认按钮。与 metrics 页测试同一条理由：确认按钮的文案由组件**显式**给定
 * （`okText`），不随宿主是否配了 zh_CN locale 漂（未配时默认是 "OK"），
 * 于是可以按 **Role + 文案** 查——不用 `.ant-popconfirm .ant-btn-primary` 这类
 * DOM 结构 selector（结构随版本/主题漂，且 antd v6 里 primary 是 color/variant 三元组）。
 */
const confirmPopconfirm = async (okText: string) => {
  fireEvent.click(await screen.findByRole('button', { name: okText }))
}

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    // 顺序 matters：/reports/manage 与 /reports/:id/embed-url 都以 /reports 开头，长的先判
    if (url.endsWith('/reports/manage')) return json({ reports: ROWS })
    if (/\/reports\/[^/]+\/embed-url$/.test(url)) return json({ url: 'https://mb.test/embed/abc' })
    if (url.endsWith('/reports')) return json({ reports: ROWS.filter((r) => r.requiredScope === null) })
    if (init?.method === 'PUT') return json({ ok: true })
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    return json({})
  })
})
afterEach(cleanup)

describe('报表页签双视图', () => {
  it('data:manage ⇒ 拉管理清单，行全量可见（含未放行），有管理动作', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    expect(calls[0]?.url.endsWith('/reports/manage')).toBe(true)
    // 徽章在管理视图出现**两次**（标题内联 + 渲染器列）⇒ 复数断言（见实现块里的订正记录）
    expect(screen.getAllByText('平台自绘').length).toBeGreaterThanOrEqual(2)
    // 两个「发布」= 两条不同通路（Task 12）：Metabase 行清页门、platform 行发版本。按行取。
    expect(rowButton('未放行报表', '发布')).toBeInTheDocument()
    expect(rowButton('自绘大盘', '发布')).toBeInTheDocument()
    // 回收是**逐行**给的（三行都有）⇒ 按复数查；「发布」只在页门未放行的那一行（r2）出现，故是单数
    expect(buttons('回收').length).toBeGreaterThan(0)
    expect(buttons('改页门').length).toBeGreaterThan(0)
  })

  it('只有 data:query ⇒ 拉观看清单（不发 /reports/manage），无管理动作，platform 行打开可点（Task 4 起打开自绘视图）', async () => {
    renderPage(['data:query'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    expect(calls.some((c) => c.url.endsWith('/reports/manage'))).toBe(false)
    expect(screen.queryByRole('button', { name: /^发\s*布$/ })).not.toBeInTheDocument()
    const selfDrawnRow = screen.getByText('自绘大盘').closest('tr')!
    // ★ 订正记录（2026-09-30，Task 4）：platform 行的「打开」从**置灰**改为**打开自绘视图**
    //    （spec §5 的渲染通路接入）——前置体验里只剩「页门不足」这一个置灰理由（见下一条用例）。
    expect((selfDrawnRow.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    // ★ 订正记录（2026-09-29，Task 5 评审轮）：「编辑」是**管理动作**，其显隐由 `canManage` 与
    //    `renderer === 'metabase'` **两半**共同决定；原稿只咬住了 renderer 那一半
    //    （评审判定：删掉 `canManage &&` 后 10 条全绿）⇒ 这里补上 canManage 这一半的直接断言。
    //    （服务端权威仍是 manifest 的 `scope: data:manage`；本页的 canManage 只是视图选择。）
    const watchRow = screen.getByText('销售日报').closest('tr')!
    expect(within(watchRow).queryByRole('button', { name: /编\s*辑/ })).not.toBeInTheDocument()
    // 正向对照：同一行的「打开」**在** ⇒ 上面「编辑缺席」不是「整行/整页没渲染」冒充的
    expect(within(watchRow).getByRole('button', { name: /打\s*开/ })).toBeInTheDocument()
    // ⭐ spec ❌ 的修复验收点（2026-09-29 评审 + 人裁「两视图都加」）：观看视图**也**必须看得到
    // 平台自绘徽章（Task 4 前的理由是「只有置灰按钮没有解释」；现在打开走自绘视图，
    // 徽章继续承担「这行走哪条渲染路」的扫读）。本仓 antd 6.6.3 已移除 v5 的
    // `getDisabledCompatibleChildren`，**Tooltip 在禁用的原生 button 上不保证弹** ⇒
    // 普通员工否则只看到一个**没有理由的灰按钮**；徽章自己承担「为什么这行点不开」。
    expect(within(selfDrawnRow).getAllByText('平台自绘').length).toBeGreaterThan(0)
  })

  it('管理清单里「门是自己没有的 scope」的行：打开被禁用（服务端 embed-url 对它是 403）', async () => {
    // 管理清单按 spec **不裁行**（管理员必须看得见、能改页门）⇒ 「打开」只按 renderer 置灰是不够的：
    // 页门未放行的行（r2 = sales:read，而本 session 只有 data:query/data:manage）点开必然 403。
    // 改前 console 只渲染裁过的清单，这条路径**不可达**——是本分支新打通的。
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())

    const gatedRow = screen.getByText('未放行报表').closest('tr')!
    const gatedOpen = within(gatedRow).getByRole('button', { name: /打\s*开/ }) as HTMLButtonElement
    expect(gatedOpen.disabled).toBe(true)

    // 反证：同一张表里页门为 null 的行「打开」仍可用 ⇒ 禁用是**逐行**判的，不是整页一刀切
    const openRow = screen.getByText('销售日报').closest('tr')!
    const okOpen = within(openRow).getByRole('button', { name: /打\s*开/ }) as HTMLButtonElement
    expect(okOpen.disabled).toBe(false)
  })

  it('★ platform 行「打开」⇒ 打开自绘视图（GET /spec + 逐面板 /query）；metabase 行仍走 embed-url', async () => {
    // Task 4 接线：同一个「打开」按钮按 renderer 分流——platform 行**不再**碰 embed-url
    // （服务端对它 409 RENDERER_NOT_EMBEDDABLE），改渲染 <SpecView/>；metabase 行一字不动。
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports')) return json({ reports: ROWS.filter((r) => r.requiredScope === null) })
      if (/\/reports\/[^/]+\/embed-url$/.test(url)) return json({ url: 'https://mb.test/embed/abc' })
      if (/\/reports\/[^/]+\/spec$/.test(url)) {
        return json({ spec: { panels: [{ chart: 'table', title: '净销售额趋势', metricId: 'm1', dims: [], args: {}, span: 12 }] }, version: ROWS[2].version })
      }
      if (url.endsWith('/query')) return json({ status: 'ok', truncated: false, columns: ['value'], rows: [['1234']] })
      return json({})
    })
    renderPage(['data:query'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())

    // 对照组先走：metabase 行（销售日报）的「打开」仍是嵌入预览那条路
    fireEvent.click(within(screen.getByText('销售日报').closest('tr')!).getByRole('button', { name: /打\s*开/ }))
    await waitFor(() => {
      const f = document.querySelector('iframe[title^="报表嵌入预览"]') as HTMLIFrameElement
      expect(f?.src).toBe('https://mb.test/embed/abc')
    })

    // platform 行（自绘大盘）：点开 ⇒ SpecView 挂载（拉规格 + 面板查询），**不**碰 embed-url
    fireEvent.click(within(screen.getByText('自绘大盘').closest('tr')!).getByRole('button', { name: /打\s*开/ }))
    expect(await screen.findByText('净销售额趋势')).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reports/r3/spec'))).toBe(true))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/query'))).toBe(true))
    expect(calls.filter((c) => /\/reports\/[^/]+\/embed-url$/.test(c.url))).toHaveLength(1)   // 只有 metabase 那次
  })

  it('★ 深链 ?open=<id>：列表就绪后自动打开该自绘报表，无需点「打开」(#1047)', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports')) return json({ reports: ROWS.filter((r) => r.requiredScope === null) })
      if (/\/reports\/[^/]+\/spec$/.test(url)) {
        return json({ spec: { panels: [{ chart: 'table', title: '净销售额趋势', metricId: 'm1', dims: [], args: {}, span: 24 }] }, version: ROWS[2].version })
      }
      if (url.endsWith('/query')) return json({ status: 'ok', truncated: false, columns: ['value'], rows: [['5678']] })
      return json({})
    })
    renderPage(['data:query'], '/console/data/reports?open=r3')

    // 不点「打开」⇒ SpecView 直挂（拉规格 + 面板查询）
    expect(await screen.findByText('净销售额趋势')).toBeInTheDocument()
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reports/r3/spec'))).toBe(true))
  })

  it('★ 深链指向不存在/不可见的 id ⇒ 静默留在列表，不弹不炸 (#1047)', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports')) return json({ reports: ROWS.filter((r) => r.requiredScope === null) })
      return json({})
    })
    renderPage(['data:query'], '/console/data/reports?open=no-such')

    // 列表正常渲染；spec 端点一次都没被碰（不存在 silently nothing to open）
    expect(await screen.findByText('自绘大盘')).toBeInTheDocument()
    expect(await screen.findByText('销售日报')).toBeInTheDocument()
    expect(calls.some((c) => /\/spec$/.test(c.url))).toBe(false)
  })

  it('发布：Popconfirm 确认 ⇒ PUT requiredScope=null', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(rowButton('未放行报表', '发布'))
    await confirmPopconfirm('确认发布')
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')
      expect(put?.url).toMatch(/\/reports\/r2$/)
      // 版本**从管理清单读回**（Task 3 起 PUT 必带 expectedVersion，缺 ⇒ 400 INVALID_BODY）
      expect(JSON.parse(String(put?.init?.body))).toEqual({ requiredScope: null, expectedVersion: ROWS[1].version })
    })
  })

  it('改页门：Modal 输入 scope 保存 ⇒ PUT requiredScope=<值>', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(buttons('改页门')[0])
    fireEvent.change(screen.getByPlaceholderText('如 sales:read'), { target: { value: 'finance:read' } })
    fireEvent.click(button('确定'))
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')
      expect(put?.url).toMatch(/\/reports\/r[123]$/)
      // 「改页门」按的也是**该行**读回的版本（buttons('改页门')[0] = r1）
      expect(JSON.parse(String(put?.init?.body))).toEqual({ requiredScope: 'finance:read', expectedVersion: ROWS[0].version })
    })
  })

  it('回收：Popconfirm 确认 ⇒ DELETE', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(buttons('回收')[0])
    await confirmPopconfirm('确认回收')
    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === 'DELETE')
      // ⚠️ DELETE 的版本走**查询串**（不是请求体）——`?expectedVersion=N`（Task 3 硬约束）
      // 版本从**夹具**读（`buttons('回收')[0]` = r1），不硬写数值（互异夹具下硬写会被咬住）
      expect(del?.url).toMatch(new RegExp(`/reports/r1\\?expectedVersion=${ROWS[0].version}$`))
    })
  })

  it('打开时服务端 409 ⇒ 出人话文案（RENDERER_NOT_EMBEDDABLE；真实通路 = embed-url）', async () => {
    // ⚠️ 订正记录（2026-09-29，Task 3 评审提出）：原稿这里桩的是 **PUT** 返回该码——**假通路**：
    // 全仓唯一产出 `RENDERER_NOT_EMBEDDABLE` 的是 `GET /reports/:id/embed-url`（Task 3 的守卫），
    // PUT 永远不会返它。改桩 embed-url，同时这也是**唯一**能走到该文案的路径：
    // ⚠️ 再订正（2026-09-30，Task 4）：platform 行的「打开」已**不再置灰**，改走自绘视图
    // （`<SpecView/>`，见前一条用例），压根不调 embed-url ⇒ 本条夹具（客户端当它是 metabase
    // 行、服务端却答 409）正模拟「两边 renderer 不一致 / 视图陈旧」这一类竞态。即该 MESSAGES
    // 条目是**防御性**的，不是主路径。
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })   // 销售日报（metabase 行）
      if (/\/reports\/[^/]+\/embed-url$/.test(url)) {
        return json({ error: 'RENDERER_NOT_EMBEDDABLE' }, 409)
      }
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(button('打开'))
    expect(await screen.findByText('平台自绘报表没有嵌入预览通道')).toBeInTheDocument()
  })

  it('编辑：点击后向平台换 handoff URL，并用 iframe 打开（同父域 ⇒ SameSite=Lax 可用）', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })
      if (/\/reports\/[^/]+\/edit-url$/.test(url)) return json({ url: 'https://mb.test/handoff?t=T' })
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    await waitFor(() => {
      const f = document.querySelector('iframe[title^="报表编辑"]') as HTMLIFrameElement
      expect(f?.src).toBe('https://mb.test/handoff?t=T')
    })
    // ★ 订正记录（2026-09-29，Task 5 评审轮）：上面那个 mock 是「**只有** edit-url 才回 url」，
    //    所以 iframe 拿到 URL 只算**间接**证明路径对——任何别的路径都会回 `{}` 而让断言以别的方式炸。
    //    这里直接把请求路径钉住（模块端点，不含平台前缀）。
    expect(calls.some((c) => c.url.endsWith('/reports/r1/edit-url'))).toBe(true)
  })

  it('platform 行没有「编辑」（没有 Metabase dashboard 可编辑）', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
    const row = screen.getByText('自绘大盘').closest('tr')!
    expect(within(row).queryByRole('button', { name: /编\s*辑/ })).not.toBeInTheDocument()
    // 正向对照：同一张表里 metabase 行**有**「编辑」⇒ 上面那条查不到是**逐行**判 renderer 的结果，
    // 不是「整页崩了/按钮压根没实现」造成的恒真。
    const metabaseRow = screen.getByText('销售日报').closest('tr')!
    expect(within(metabaseRow).getByRole('button', { name: /编\s*辑/ })).toBeInTheDocument()
  })

  it('★ 兜底「在新标签打开」重新领票（一次性票据不可复用）⇒ 同步预开空白页 + 新票导航它', async () => {
    // 票据是**一次性**的（nonce 在代理 `/handoff` 即被消费）：iframe 一渲染，第一枚票就用掉了。
    // 兜底若复用同一枚票，**最需要它**的场景（CSP 挡住 iframe）恰恰必然 401 ⇒ 必须重新领票。
    // 本用例每次 edit-url 发一枚不同的票（t=T1、t=T2）以区分「新票」与「已消费的旧票」；
    // **第二次领票被卡住不立刻回**，用来证明 `window.open` 是在**同步点击上下文**里调用的
    // （等 fetch 回来再 open 会被浏览器判成弹窗直接拦掉——这正是本次修复要咬住的回归）。
    let issued = 0
    let releaseSecond: (() => void) | null = null
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })
      if (/\/reports\/[^/]+\/edit-url$/.test(url)) {
        if (issued === 1) await new Promise<void>((r) => { releaseSecond = () => r() })
        return json({ url: `https://mb.test/handoff?t=T${++issued}` })
      }
      return json({})
    })
    // window.open 返回**句柄**（真机同形状）：同步预开的是 about:blank，拿到新票后再导航它。
    // ⚠️ 不能按「open 直接收新票 URL」断言——那样会逼实现去带 `noopener`，而带 noopener 时
    //    open **恒返 null**（MDN；真机 Chromium 实测），句柄拿不到、兜底整体失效。
    const replace = vi.fn()
    const fakeWin = { closed: false, location: { replace } } as unknown as Window
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => fakeWin)
    try {
      renderPage(['data:query', 'data:manage'])
      await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
      await waitFor(() => {
        const f = document.querySelector('iframe[title^="报表编辑"]') as HTMLIFrameElement
        expect(f?.src).toBe('https://mb.test/handoff?t=T1')
      })
      // 兜底是 **button**（不是复用票据的 `<a href>`）；按 Role 查即同时钉住了这一点
      fireEvent.click(screen.getByRole('button', { name: /在新标签打开/ }))
      // ⭐ 同步性：此刻第二次 edit-url **还没回**（上面被卡住），而空白页**已经**开好了。
      //    把 `window.open` 挪到 `await` 之后再写 ⇒ 这里立刻红。
      expect(openSpy).toHaveBeenCalledWith('about:blank', '_blank')
      expect(replace).not.toHaveBeenCalled()   // 新票没到手之前不导航
      releaseSecond!()
      // 新票到手后导航**那个已开好的标签页**（不是覆盖 iframe 里那枚已消费的旧票）
      await waitFor(() => expect(replace).toHaveBeenCalledWith('https://mb.test/handoff?t=T2'))
      expect(calls.filter((c) => c.url.endsWith('/reports/r1/edit-url'))).toHaveLength(2)
      expect(replace).not.toHaveBeenCalledWith('https://mb.test/handoff?t=T1')
      // 兜底不覆盖 iframe：面板里仍是第一次那枚票
      const f = document.querySelector('iframe[title^="报表编辑"]') as HTMLIFrameElement
      expect(f?.src).toBe('https://mb.test/handoff?t=T1')
    } finally {
      openSpy.mockRestore()
    }
  })

  it('★ 兜底：window.open 返回 null（弹窗被拦）⇒ 明说「浏览器拦下了新标签页」', async () => {
    // 同步预开窗也可能开不出来（浏览器弹窗拦截）——此时**必须明说**：兜底唯一的失败形态，
    // 不说就只剩「点了没反应」。这条同时也守着「别给 open 带 noopener」那个坑
    // （带 noopener ⇒ open 恒返 null ⇒ 每次点兜底都只弹这句，而线上根本没人拦）。
    let issued = 0
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })
      if (/\/reports\/[^/]+\/edit-url$/.test(url)) return json({ url: `https://mb.test/handoff?t=T${++issued}` })
      return json({})
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      renderPage(['data:query', 'data:manage'])
      await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
      fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
      await waitFor(() => {
        const f = document.querySelector('iframe[title^="报表编辑"]') as HTMLIFrameElement
        expect(f?.src).toBe('https://mb.test/handoff?t=T1')
      })
      fireEvent.click(screen.getByRole('button', { name: /在新标签打开/ }))
      expect(await screen.findByText('浏览器拦下了新标签页，请允许本站弹窗后重试')).toBeInTheDocument()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('★ 服务端 503（未配代理 origin）⇒ 出人话文案', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: [ROWS[0]] })
      if (/\/reports\/[^/]+\/edit-url$/.test(url)) return json({ error: 'EDIT_PROXY_UNCONFIGURED' }, 503)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /编\s*辑/ }))
    expect(await screen.findByText('编辑入口未配置（请联系运维）')).toBeInTheDocument()
  })

  it('★ 写请求带上读到的版本；409 ⇒ 出人话并自动刷新列表', async () => {
    // ⚠️ 订正记录（2026-09-29，Task 5 实施）：计划原稿这里管理清单返回 `[ROWS[0]]` 却点「发布」——
    //    而「发布」按钮**只在 `requiredScope !== null` 的行渲染**（见 index.tsx 的
    //    `{r.requiredScope !== null && (<Popconfirm …发布…)}`），ROWS[0]（销售日报）页门为 null
    //    ⇒ 原稿取不到按钮、用例连路径都走不到。最小订正：改用 ROWS[1]（未放行报表，sales:read），
    //    它正是页门未放行、复现「发布」入口的那一行；`expectedVersion` 的期望值同步取 ROWS[1].version
    //    （本轮夹具所有行都是 1，故数值与计划原稿一致，仅取数来源更贴行）。
    let reloads = 0
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) { reloads += 1; return json({ reports: [ROWS[1]] }) }
      if (init?.method === 'PUT') return json({ error: 'STALE_WRITE', currentVersion: 9 }, 409)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(rowButton('未放行报表', '发布'))
    await confirmPopconfirm('确认发布')

    // ① 请求体带版本（ROWS[1].version）② 409 出人话 ③ 列表被重新拉取（reload）
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')!
      // `toEqual`（不是 `toMatchObject`，评审 Minor ①）：多带键/带错键也要咬得住
      expect(JSON.parse(String(put.init?.body))).toEqual({ requiredScope: null, expectedVersion: ROWS[1].version })
    })
    expect(await screen.findByText('这份报表刚被别人改过，已为你刷新，请重试')).toBeInTheDocument()
    await waitFor(() => expect(reloads).toBeGreaterThan(1))
  })

  it('★ 回收 409（版本陈旧）⇒ 出人话并自动刷新列表（DELETE 版本走查询串）', async () => {
    // 与上一条同构，但走 **DELETE** 通路：版本在**查询串**里（`?expectedVersion=N`），
    // 且 recycle 的 `catch` 也必须 `await load()`（三条写动作的 catch 各自独立，互不覆盖）。
    // ⚠️ 刻意按**第二行**（r2，version 2 ≠ 1）：DELETE 通路若只测第一行，就与「硬写 1 / 恒取首行版本」
    //    不可区分（评审 I-1 的反面）；用非首行 + 夹具读值同时咬住硬写与取错行。
    let reloads = 0
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) { reloads += 1; return json({ reports: [ROWS[0], ROWS[1]] }) }
      if (init?.method === 'DELETE') return json({ error: 'STALE_WRITE', currentVersion: 9 }, 409)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(buttons('回收')[1])   // 第二行 = r2（`buttons` 按 DOM 序 = 数据源序）
    await confirmPopconfirm('确认回收')

    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === 'DELETE')!
      expect(del.url).toMatch(new RegExp(`/reports/r2\\?expectedVersion=${ROWS[1].version}$`))
    })
    expect(await screen.findByText('这份报表刚被别人改过，已为你刷新，请重试')).toBeInTheDocument()
    await waitFor(() => expect(reloads).toBeGreaterThan(1))
  })

  it('★ 改页门 409 ⇒ 出人话 + 关掉 Modal（陈旧快照不得留在框内）+ 刷新列表', async () => {
    // 评审 I-2：`saveGate` 的 Modal 持的是**加载时**的行快照；列表刷新后 `gateEdit` 仍指旧行。
    // 若不关框，用户照着「请重试」在框内再点「确定」⇒ 再发一次**陈旧版本** ⇒ 再 409（死循环的假象）。
    // 故 409 必须 `setGateEdit(null)`：重试只能从**刷新后的列表**重新进入。
    let reloads = 0
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) { reloads += 1; return json({ reports: [ROWS[0]] }) }
      if (init?.method === 'PUT') return json({ error: 'STALE_WRITE', currentVersion: 9 }, 409)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(buttons('改页门')[0])
    fireEvent.change(screen.getByPlaceholderText('如 sales:read'), { target: { value: 'finance:read' } })
    fireEvent.click(button('确定'))

    expect(await screen.findByText('这份报表刚被别人改过，已为你刷新，请重试')).toBeInTheDocument()
    // ── 「Modal 消失」在本环境只能观测成**离场态**（订正记录 2026-09-29）──────────────────
    // antd Modal 关闭 = `open=false` ⇒ rc-motion 给 `.ant-modal` 加 `ant-zoom-leave*`（mask 上
    // `ant-fade-leave*`），真浏览器要等 `transitionend` 才把 DOM 摘掉。⚠️ happy-dom **不派发
    // transitionend**（实测：手动 `fireEvent.transitionEnd` / `animationEnd` 也不摘），且离场期间
    // rc-motion **冻结子树**（标题/输入仍是旧值）⇒ **不能**用「标题不见」判消失（试过，恒真失败）。
    // 故判据 = 离场类出现（或 DOM 已摘，覆盖真浏览器形态）。
    const modalClosing = () => {
      const modal = document.querySelector('.ant-modal')
      return modal === null || modal.className.includes('-leave')
    }
    await waitFor(() => expect(modalClosing()).toBe(true))
    await waitFor(() => expect(reloads).toBeGreaterThan(1))
  })

  it('★ 管理清单漏带 version ⇒ fail-closed 出人话，不落成可写的坏快照', async () => {
    // 评审 Minor ③：`load` 里 `b as { reports: ReportRow[] }` 是无校验断言——服务端若漏带
    // `version`（契约破损 / 旧版本服务端），硬落进 state 后写动作会发出 `?expectedVersion=undefined`
    // （PUT 亦然）⇒ 服务端 400「输入不合法」，**根因被静默**。这里 fail-closed：坏快照**不落地**。
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) {
        // 缺 `version`（其余字段齐备——单看形状是「正常」的，这正是要拦的那类静默）
        return json({ reports: [{ id: 'r1', title: '销售日报', requiredScope: 'sales:read', renderer: 'metabase' }] })
      }
      return json({})
    })
    renderPage(['data:query', 'data:manage'])

    expect(await screen.findByText('报表清单缺少版本号，请刷新页面；若仍如此请联系平台侧')).toBeInTheDocument()
    // 坏快照不落地 ⇒ 表里没有行，也就没有能发出坏版本的写按钮
    expect(screen.queryByRole('button', { name: /^发\s*布$/ })).not.toBeInTheDocument()
    expect(screen.queryByText('销售日报')).not.toBeInTheDocument()
  })
})

// ── 版本管理（月报重做 Task 12；设计 §6.4）──────────────────────────────────────────
// 只覆盖 platform 行：徽标 / 发布（note）/ 下线 / 版本抽屉（查看·回滚）/ 独立链接 /
// 平台行隐藏改页门。Metabase 行的既有动作由上面的 describe 守住（「一字不动」）。
describe('平台自绘行的版本管理', () => {
  const manageRows = (rows = ROWS) => m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url.endsWith('/reports/manage')) return json({ reports: rows })
    return json({})
  })

  it('版本徽标：未发布 / 有未发布改动；Metabase 行不硬造徽标', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())

    expect(within(rowOf('未发布报表')).getByText('未发布')).toBeInTheDocument()
    expect(within(rowOf('自绘大盘')).getByText('v2 · 有未发布改动')).toBeInTheDocument()
    // 反证：Metabase 行的 publishedVersion 也是 null，但版本通路不属它——不渲染「未发布」。
    expect(within(rowOf('销售日报')).queryByText('未发布')).toBeNull()
  })

  it('版本徽标：发布后无改动 ⇒ 已发布 vN', async () => {
    manageRows([{ ...ROWS[2], hasUnpublishedChanges: false }])
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
    expect(within(rowOf('自绘大盘')).getByText('已发布 v2')).toBeInTheDocument()
    expect(within(rowOf('自绘大盘')).queryByText('v2 · 有未发布改动')).toBeNull()
  })

  it('观看视图（无 data:manage）不渲染版本徽标（GET /reports 不带版本字段）', async () => {
    renderPage(['data:query'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
    expect(screen.queryByText('v2 · 有未发布改动')).toBeNull()
    expect(screen.queryByText('未发布')).toBeNull()
  })

  it('平台行隐藏「改页门」，Metabase 行保持；未发布行没有下线/复制链接', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())

    expect(within(rowOf('自绘大盘')).queryByRole('button', { name: /改\s*页\s*门/ })).toBeNull()
    expect(within(rowOf('未发布报表')).queryByRole('button', { name: /改\s*页\s*门/ })).toBeNull()
    // 正向对照：Metabase 行的改页门仍在 ⇒ 上面的缺席不是整页没渲染
    expect(within(rowOf('销售日报')).getByRole('button', { name: /改\s*页\s*门/ })).toBeInTheDocument()

    // 未发布 ⇒ 没有可失效的线上版本，也没有可复制的独立链接
    expect(within(rowOf('未发布报表')).queryByRole('button', { name: /下\s*线/ })).toBeNull()
    expect(within(rowOf('未发布报表')).queryByRole('button', { name: /复制链接/ })).toBeNull()
    // 但发布 / 版本历史入口恒在
    expect(within(rowOf('未发布报表')).getByRole('button', { name: /^发\s*布$/ })).toBeInTheDocument()
    expect(within(rowOf('未发布报表')).getByRole('button', { name: /^版\s*本$/ })).toBeInTheDocument()
  })

  it('发布：Modal 填 note ⇒ POST /reports/r3/publish 带行版本', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: ROWS })
      if (url.endsWith('/reports/r3/publish')) return json({ ok: true, publishedVersion: 3 })
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())

    fireEvent.click(rowButton('自绘大盘', '发布'))
    fireEvent.change(screen.getByPlaceholderText('发布备注（可选）'), { target: { value: '十月月报' } })
    fireEvent.click(button('确认发布'))

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/reports/r3/publish'))!
      expect(post.init?.method).toBe('POST')
      // 版本取**该行**读回值（不硬写数值；互异夹具下硬写会被别的行咬住）
      expect(JSON.parse(String(post.init?.body))).toEqual({ expectedVersion: ROWS[2].version, note: '十月月报' })
    })
    expect(await screen.findByText('已发布 v3')).toBeInTheDocument()
  })

  it('发布幂等：服务端 unchanged ⇒ 文案说「仍是 vN」而不是谎报新版本', async () => {
    m.mockImplementation(async (url: string) => {
      if (url.endsWith('/reports/manage')) return json({ reports: ROWS })
      if (url.endsWith('/reports/r3/publish')) return json({ ok: true, publishedVersion: 2, unchanged: true })
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
    fireEvent.click(rowButton('自绘大盘', '发布'))
    fireEvent.click(button('确认发布'))
    expect(await screen.findByText('内容未变，仍是 v2')).toBeInTheDocument()
  })

  it('发布 409（版本陈旧）⇒ 人话 + 关 Modal + 刷新列表', async () => {
    let reloads = 0
    m.mockImplementation(async (url: string) => {
      if (url.endsWith('/reports/manage')) { reloads += 1; return json({ reports: ROWS }) }
      // 版本端点的失败体是 `{ ok:false, reason }`（不是 `{error}`）——按真机形状桩
      if (url.endsWith('/reports/r3/publish')) return json({ ok: false, reason: 'STALE_WRITE' }, 409)
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
    fireEvent.click(rowButton('自绘大盘', '发布'))
    fireEvent.click(button('确认发布'))

    expect(await screen.findByText('这份报表刚被别人改过，已为你刷新，请重试')).toBeInTheDocument()
    await waitFor(() => expect(reloads).toBeGreaterThan(1))
    // Modal 关闭在本环境只能观测离场态（happy-dom 不派发 transitionend；同改页门用例）
    const modalClosing = () => {
      const modal = document.querySelector('.ant-modal')
      return modal === null || modal.className.includes('-leave')
    }
    await waitFor(() => expect(modalClosing()).toBe(true))
  })

  it('下线：Popconfirm 确认 ⇒ POST /reports/r3/unpublish 带行版本', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: ROWS })
      if (url.endsWith('/reports/r3/unpublish')) return json({ unpublished: true })
      return json({})
    })
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())

    fireEvent.click(rowButton('自绘大盘', '下线'))
    await confirmPopconfirm('确认下线')

    await waitFor(() => {
      const post = calls.find((c) => c.url.endsWith('/reports/r3/unpublish'))!
      expect(post.init?.method).toBe('POST')
      expect(JSON.parse(String(post.init?.body))).toEqual({ expectedVersion: ROWS[2].version })
    })
    expect(await screen.findByText('已下线「自绘大盘」')).toBeInTheDocument()
  })

  it('版本历史抽屉：列出历史、查看钉版本链接、回滚旧版带行版本', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (url.endsWith('/reports/manage')) return json({ reports: ROWS })
      if (url.endsWith('/reports/r3/versions')) return json({ versions: VERSIONS })
      if (url.endsWith('/reports/r3/versions/1/rollback')) return json({ ok: true, publishedVersion: 3 })
      return json({})
    })
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)
    try {
      renderPage(['data:query', 'data:manage'])
      await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
      fireEvent.click(rowButton('自绘大盘', '版本'))

      expect(await screen.findByText('版本历史：自绘大盘')).toBeInTheDocument()
      expect(screen.getByText('v2')).toBeInTheDocument()
      const v1Row = screen.getByText('v1').closest('tr')!
      // 线上版自己不给回滚（白生成一版）；历史版给
      expect(within(v1Row).getByRole('button', { name: /回\s*滚/ })).toBeInTheDocument()
      expect(within(screen.getByText('v2').closest('tr')!).queryByRole('button', { name: /回\s*滚/ })).toBeNull()

      // 「查看」= 钉住旧版本的独立链接（新标签）
      fireEvent.click(within(v1Row).getByRole('button', { name: /查\s*看/ }))
      expect(openSpy).toHaveBeenCalledWith(
        `${window.location.origin}/r/r3?v=1`, '_blank', 'noopener,noreferrer',
      )

      fireEvent.click(within(v1Row).getByRole('button', { name: /回\s*滚/ }))
      await confirmPopconfirm('确认回滚')
      await waitFor(() => {
        const post = calls.find((c) => c.url.endsWith('/reports/r3/versions/1/rollback'))!
        expect(post.init?.method).toBe('POST')
        expect(JSON.parse(String(post.init?.body))).toEqual({
          expectedVersion: ROWS[2].version, note: '回滚自 v1',
        })
      })
      expect(await screen.findByText('已回滚，当前发布 v3')).toBeInTheDocument()
    } finally {
      openSpy.mockRestore()
    }
  })

  it('复制独立链接：写剪贴板 origin + /r/:id', async () => {
    const writeText = vi.fn(async () => {})
    const desc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      renderPage(['data:query', 'data:manage'])
      await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
      fireEvent.click(rowButton('自绘大盘', '复制链接'))
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/r/r3`))
      expect(await screen.findByText('独立链接已复制')).toBeInTheDocument()
    } finally {
      if (desc) Object.defineProperty(navigator, 'clipboard', desc)
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard
    }
  })

  it('剪贴板不可用 ⇒ 回退把链接文本摆出来', async () => {
    const writeText = vi.fn(async () => { throw new Error('denied') })
    const desc = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const url = `${window.location.origin}/r/r3`
    try {
      renderPage(['data:query', 'data:manage'])
      await waitFor(() => expect(screen.getByText('自绘大盘')).toBeInTheDocument())
      fireEvent.click(rowButton('自绘大盘', '复制链接'))
      expect(await screen.findByText(url)).toBeInTheDocument()
    } finally {
      if (desc) Object.defineProperty(navigator, 'clipboard', desc)
      else delete (navigator as unknown as { clipboard?: unknown }).clipboard
    }
  })
})
