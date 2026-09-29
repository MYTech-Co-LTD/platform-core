// index.test.tsx — 报表页签：双视图选择（session.scopes）+ 管理动作（页门/发布/回收）。
// 挂载形态照宿主壳真实结构：ReportsPage 经 Outlet 注入 session（demo 模块先例）。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import ReportsPage from './index'

const m = vi.mocked(platformFetch)
const calls: { url: string; init?: RequestInit }[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

const ROWS = [
  { id: 'r1', title: '销售日报', requiredScope: null, renderer: 'metabase' },
  { id: 'r2', title: '未放行报表', requiredScope: 'sales:read', renderer: 'metabase' },
  { id: 'r3', title: '自绘大盘', requiredScope: null, renderer: 'platform' },
]

function renderPage(scopes: string[]) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes } }} />,
        children: [{ path: '/console/data/reports', element: <ReportsPage /> }],
      },
    ],
    { initialEntries: ['/console/data/reports'] },
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
    expect(button('发布')).toBeInTheDocument()
    // 回收是**逐行**给的（三行都有）⇒ 按复数查；「发布」只在页门未放行的那一行（r2）出现，故是单数
    expect(buttons('回收').length).toBeGreaterThan(0)
    expect(buttons('改页门').length).toBeGreaterThan(0)
  })

  it('只有 data:query ⇒ 拉观看清单（不发 /reports/manage），无管理动作，platform 行打开置灰', async () => {
    renderPage(['data:query'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    expect(calls.some((c) => c.url.endsWith('/reports/manage'))).toBe(false)
    expect(screen.queryByRole('button', { name: /^发\s*布$/ })).not.toBeInTheDocument()
    const selfDrawnRow = screen.getByText('自绘大盘').closest('tr')!
    expect((selfDrawnRow.querySelector('button') as HTMLButtonElement).disabled).toBe(true)
    // ⭐ spec ❌ 的修复验收点（2026-09-29 评审 + 人裁「两视图都加」）：观看视图**也**必须看得到
    // 平台自绘徽章——不能只靠置灰按钮/Tooltip。本仓 antd 6.6.3 已移除 v5 的
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

  it('发布：Popconfirm 确认 ⇒ PUT requiredScope=null', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('未放行报表')).toBeInTheDocument())
    fireEvent.click(button('发布'))
    await confirmPopconfirm('确认发布')
    await waitFor(() => {
      const put = calls.find((c) => c.init?.method === 'PUT')
      expect(put?.url).toMatch(/\/reports\/r2$/)
      expect(JSON.parse(String(put?.init?.body))).toEqual({ requiredScope: null })
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
      expect(JSON.parse(String(put?.init?.body))).toEqual({ requiredScope: 'finance:read' })
    })
  })

  it('回收：Popconfirm 确认 ⇒ DELETE', async () => {
    renderPage(['data:query', 'data:manage'])
    await waitFor(() => expect(screen.getByText('销售日报')).toBeInTheDocument())
    fireEvent.click(buttons('回收')[0])
    await confirmPopconfirm('确认回收')
    await waitFor(() => {
      const del = calls.find((c) => c.init?.method === 'DELETE')
      expect(del?.url).toMatch(/\/reports\/r[123]$/)
    })
  })

  it('打开时服务端 409 ⇒ 出人话文案（RENDERER_NOT_EMBEDDABLE；真实通路 = embed-url）', async () => {
    // ⚠️ 订正记录（2026-09-29，Task 3 评审提出）：原稿这里桩的是 **PUT** 返回该码——**假通路**：
    // 全仓唯一产出 `RENDERER_NOT_EMBEDDABLE` 的是 `GET /reports/:id/embed-url`（Task 3 的守卫），
    // PUT 永远不会返它。改桩 embed-url，同时这也是**唯一**能走到该文案的路径：
    // 列表里的 platform 行「打开」已置灰（前一条用例），只有「加载后该行才变成 platform」这种
    // 陈旧视图/竞态才会点到——即该 MESSAGES 条目是**防御性**的，不是主路径。
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
})
