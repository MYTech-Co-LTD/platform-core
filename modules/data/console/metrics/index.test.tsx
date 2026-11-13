// index.test.tsx — 指标管理页（console/metrics）：词表两层的呈现 + L2 声明式表单。
//
// ★ 本文件最重要的那一条是「**UI 结构上写不出 SQL**」：表单提交的 body 只能是
// `L2Declaration`（base + 别名 + 维度白名单 + 过滤），**不含** selectSql / subjectColumn /
// groupBy。这不是「表单恰好没做那几个输入框」，而是 T8 收紧入参之后 UI 侧能表达的全部——
// 一旦有人给页面加回一个「自定义 SQL」输入框，这条用例会红。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import MetricsPage from './index'

const m = vi.mocked(platformFetch)
/** 记下每次请求（含 body），用来断言「提交了什么」。 */
const calls: Array<{ url: string; method: string; body: unknown }> = []
/** W8：覆盖清单夹具（每个用例可改写；默认空）。 */
let OVERRIDES: Array<Record<string, unknown>> = []
/** 候选池夹具（#1953 四期：指标页顶部「待采用」提示）。 */
let CANDIDATES: unknown[] = []

const json = (b: unknown) =>
  new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } })

/** 词表夹具：一条 L1（平台，只读）+ 一条 L2（本租户，可改）。 */
const CATALOG = {
  metrics: [
    {
      id: 'lemeng:retail:net_sales', title: '净销售额', description: '口径定义', requiredScope: null,
      subjectColumn: 'org', selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book, bizday from fct_retail_sale',
      groupBy: 'system_book, bizday', params: {}, source: 'l1',
      updatedBy: null, version: 1,
    },
    {
      id: 'xiongmao:net_sales', title: '熊喵净销售', description: 'L2 派生自 lemeng:retail:net_sales', requiredScope: null,
      subjectColumn: 'org', selectSql: 'select sum(fct_retail_sale.net_amount) as value, system_book from fct_retail_sale',
      groupBy: 'system_book', params: {}, source: 'l2',
      updatedBy: 'ZhangDuo', version: 3,
      // P1 Task 8a（047 列）：归属面随 /metrics/all 透传（adminView camelCase），展开层消费
      ownerDept: '熊喵门店组', entity: '销售额', variantNote: '不含退货（平台口径含退货冲减）',
    },
  ],
}

/** 变更史夹具（#489）：一建一删，删的那行**摘要来自 before**（删除留证在 UI 上要看得见）。 */
const AUDIT = {
  audit: [
    { id: 2, action: 'delete', userId: 'LiLei', channel: 'pat', keyId: 3,
      createdAt: '2026-10-07T03:00:00.000Z',
      before: { title: '删前', description: 'L2 派生自 lemeng:retail:net_sales（删前）' }, after: null },
    { id: 1, action: 'create', userId: 'ZhangDuo', channel: 'session', keyId: null,
      createdAt: '2026-10-07T01:00:00.000Z',
      before: null, after: { title: '建时', description: 'L2 派生自 lemeng:retail:net_sales' } },
  ],
}

beforeEach(() => {
  calls.length = 0
  OVERRIDES = []
  CANDIDATES = []
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    if (url.includes('/metrics/overrides')) return json({ overrides: OVERRIDES })
    if (url.includes('/metrics/candidates')) return json({ candidates: CANDIDATES })
    if (url.includes('/metrics/all')) return json(CATALOG)
    if (url.includes('/audit')) return json(AUDIT)
    return json({ ok: true })
  })
})
afterEach(cleanup)

const renderPage = () => render(<MetricsPage />)

/**
 * antd 会给「**恰好两个汉字**」的按钮标签中间自动插一个空格（`编 辑` / `保 存`）——
 * 这是它的排版特性（`autoInsertSpace`），不是 label 真的变了。故本文件一律按
 * `Role + 容空白正则` 查按钮，不用 `getByText('编辑')`（那会因空格而找不到，
 * 而报错会误导成「按钮没渲染」）。
 */
const button = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label.split('').join('\\s*')}$`) })

/** 行内操作收进「⋯」菜单（#2050 返工）：先按 id 找到行，再点开菜单。 */
const openRowMenu = (id: string) => {
  const row = screen.getAllByText(id)[0]!.closest('tr')
  expect(row, `表格里找不到 ${id} 这一行`).toBeTruthy()
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: '更多操作' }))
}
const clickMenuItem = async (label: string) => {
  fireEvent.click(await screen.findByRole('menuitem', { name: label }))
}

describe('指标管理页 · 候选指标入口（#1953 四期）', () => {
  it('有候选 ⇒ 顶部提示「N 个待采用」并给入口；无候选 ⇒ 不出现', async () => {
    CANDIDATES = [{ id: 'c1' }, { id: 'c2' }]
    render(<MetricsPage />)
    expect(await screen.findByText(/2 个候选指标待采用/)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /去查看/ })
    expect(link).toHaveAttribute('href', '/console/data/candidates')
    cleanup()

    CANDIDATES = []
    render(<MetricsPage />)
    await waitFor(() => expect(screen.queryByText(/候选指标待采用/)).toBeNull())
  })
})

describe('指标管理页', () => {
  it('列出两层：L1 标「平台（只读）」、L2 标「本租户派生」；行内动作只剩只读的「变更历史」', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument())

    expect(screen.getAllByText('平台（只读）').length).toBeGreaterThan(0)
    expect(screen.getAllByText('本租户派生').length).toBeGreaterThan(0)
    // P4 人面收口：两层菜单都只剩「变更历史」，写入口（覆盖口径/编辑/元数据/删除）都不在
    openRowMenu('lemeng:retail:net_sales')
    expect((await screen.findAllByRole('menuitem', { name: '变更历史' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('menuitem', { name: '覆盖口径' })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    openRowMenu('xiongmao:net_sales')
    expect((await screen.findAllByRole('menuitem', { name: '变更历史' })).length).toBeGreaterThan(0)
    expect(screen.queryByRole('menuitem', { name: '编辑' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '元数据' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: '删除' })).toBeNull()
  })

  it('★ 更新列：L2 显示「人 + v 版本」，L1 显示「平台物化」', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument())
    expect(screen.getByText(/ZhangDuo · v3/)).toBeInTheDocument()   // L2：人 + 版本
    expect(screen.getByText('平台物化')).toBeInTheDocument()          // L1：不显示空白（否则读成「缺数据」）
  })

  it('★ 工具条（UX）：搜索指标、来源筛选、无匹配空态', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument())
    const search = screen.getByPlaceholderText('搜索指标 id / 标题 / 说明')

    fireEvent.change(search, { target: { value: '熊喵' } })
    expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument()
    expect(screen.queryByText('lemeng:retail:net_sales')).toBeNull()

    fireEvent.change(search, { target: { value: '不存在的指标' } })
    expect(screen.getByText('没有匹配的指标，试试清空搜索或切换筛选')).toBeInTheDocument()

    fireEvent.change(search, { target: { value: '' } })
    // KPI 条里也有「平台指标」字样 ⇒ 取筛选控件（button/radio）那一个
    fireEvent.click(screen.getAllByText('平台指标').at(-1)!)
    expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument()
    expect(screen.queryByText('xiongmao:net_sales')).toBeNull()

    fireEvent.click(screen.getAllByText('派生指标').at(-1)!)
    expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument()
    expect(screen.queryByText('lemeng:retail:net_sales')).toBeNull()
  })

  it('★ 窄屏（<768px）渲染卡片列表；L2 卡片有「更多」，L1 只有只读说明（#移动端）', async () => {
    const mq = {
      matches: true, media: '(max-width: 767px)', onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
      addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }
    vi.stubGlobal('matchMedia', vi.fn(() => mq))
    try {
      renderPage()
      await waitFor(() => expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument())
      expect(screen.queryByRole('table')).toBeNull()
      // L1 只读卡没有动作按钮；L2 卡有一个 44px 的「更多操作」
      expect(screen.getAllByRole('button', { name: '更多操作' })).toHaveLength(1)
      expect(screen.getByText('只读')).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: '更多操作' }))
      // P4：移动面板同样只剩只读动作
      expect(await screen.findByText('变更历史')).toBeInTheDocument()
      expect(screen.queryByText('删除指标')).toBeNull()
      expect(screen.queryByText('编辑')).toBeNull()
      expect(screen.queryByText('元数据')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('★ 空清单（UX）：给「指标从哪来」的说明，而不是裸「暂无数据」', async () => {
    m.mockImplementation(async () => json({ metrics: [] }))
    renderPage()
    expect(await screen.findByText('还没有指标。平台指标随数据面接入自动出现；新指标在企微里对机器人说一声，或经 MCP 提交。'))
      .toBeInTheDocument()
  })

  it('★ 变更历史抽屉：点开 → 拉 /metrics/:id/audit → 渲染动作与口径摘要（删除行的摘要来自 before）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument())
    openRowMenu('xiongmao:net_sales')
    await clickMenuItem('变更历史')

    await waitFor(() => expect(screen.getByText(/变更历史：xiongmao:net_sales/)).toBeInTheDocument())
    // ⚠️ 行内「删除」按钮与审计标签同文（text 按钮不像描边按钮那样自动插空格）⇒ 抽屉内断言
    const dialogs = screen.getAllByRole('dialog')
    expect(within(dialogs[dialogs.length - 1]!).getByText('删除')).toBeInTheDocument()
    expect(screen.getByText(/被删：L2 派生自 lemeng:retail:net_sales（删前）/)).toBeInTheDocument()  // ★ 删除留证
    expect(screen.getByText('新建')).toBeInTheDocument()
    expect(screen.getByText(/LiLei/)).toBeInTheDocument()                    // 记的是**人**
    // 拉的是本条的审计（不是 /metrics/all）
    expect(calls.some((c) => c.url.includes('/metrics/xiongmao:net_sales/audit'))).toBe(true)
  })
  // ── P4 人面收口：写入口全删，读面/决策面保留 ────────────────────────────────────
  it('★ 人面写入口全部移除：行菜单 / 详情抽屉 / 移动面板只剩「变更历史」，说明指向 agent 提案 → 待核对', async () => {
    renderPage()
    await screen.findByText('lemeng:retail:net_sales')

    // 顶部说明改为「agent 提案 → 待核对页采纳」（P4 Task 2 文案）
    expect(screen.getByText(/指标变更一律由 agent 提案（企微\/MCP）/)).toBeInTheDocument()
    expect(screen.getByText(/待核对/)).toBeInTheDocument()
    // 新建入口必须不存在（不是置灰——留着按钮就等于留着「手填 id/表达式」的风险面）
    expect(screen.queryByText('新建派生指标')).toBeNull()
    expect(screen.queryByText(/新建声明/)).toBeNull()
    // 常驻教程已删（#2058）：来源说明只在空态出现——有数据时不占版面
    expect(screen.queryByText(/指标由 agent 创建/)).toBeNull()

    // L1 详情抽屉：覆盖口径入口已删；只读的变更历史还在
    const l1Row = screen.getAllByText('lemeng:retail:net_sales')[0]!.closest('tr')!
    fireEvent.click(within(l1Row).getByRole('button', { name: /^详\s*情$/ }))
    let drawer = screen.getAllByRole('dialog').at(-1)!
    expect(await within(drawer).findByRole('button', { name: /^变\s*更\s*历\s*史$/ })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /^覆\s*盖\s*口\s*径$/ })).toBeNull()
    fireEvent.keyDown(document.body, { key: 'Escape' })

    // L2 详情抽屉：编辑 / 元数据 / 删除三个按钮都不在
    const l2Row = screen.getAllByText('xiongmao:net_sales')[0]!.closest('tr')!
    fireEvent.click(within(l2Row).getByRole('button', { name: /^详\s*情$/ }))
    drawer = screen.getAllByRole('dialog').at(-1)!
    expect(await within(drawer).findByRole('button', { name: /^变\s*更\s*历\s*史$/ })).toBeInTheDocument()
    expect(within(drawer).queryByRole('button', { name: /^编\s*辑$/ })).toBeNull()
    expect(within(drawer).queryByRole('button', { name: /^元\s*数\s*据$/ })).toBeNull()
    expect(within(drawer).queryByRole('button', { name: /^删\s*除$/ })).toBeNull()

    // KEEP 的读面动作仍在
    expect(screen.getByRole('button', { name: /^使\s*用\s*统\s*计$/ })).toBeInTheDocument()
  })

  // ── W8：覆盖清单（KEEP：两步决策流的确认步）────────────────────────────────────
  it('W8：覆盖清单显示草稿，确认启用 → POST confirm；删除 → DELETE override', async () => {
    OVERRIDES = [{ id: 'lemeng:retail:net_sales', title: '本租户口径', certified: 'draft',
      selectSql: 'select sum(x) as value from t', updatedBy: 'u', version: 1, updatedAt: null }]
    renderPage()
    expect(await screen.findByText('草稿（未生效）')).toBeInTheDocument()
    fireEvent.click(button('确认启用'))
    fireEvent.click(screen.getAllByRole('button', { name: /^确\s*认\s*启\s*用$/ }).at(-1)!)
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/metrics/lemeng:retail:net_sales/override/confirm')
        && c.method === 'POST')).toBe(true)
    })
    fireEvent.click(button('删除覆盖'))
    fireEvent.click(screen.getAllByRole('button', { name: /^删\s*除\s*覆\s*盖$/ }).at(-1)!)
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/metrics/lemeng:retail:net_sales/override')
        && c.method === 'DELETE')).toBe(true)
    })
  })

})

describe('口径列：单页双层（Wave 4.3）', () => {
  it('默认层给业务说法；技术细节里才有表达式 / 维度 / 权限码（折叠，不隐藏）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument())
    // 默认层：说明文字（夹具里没有 bizDescription，回落 description）
    expect(screen.getAllByText('口径定义').length).toBeGreaterThan(0)
    // 技术细节现在在「详情」抽屉里（#2050 返工：表格只负责扫，读一次的进抽屉）。
    // 归属面断言打在 L2 行（夹具里归属三字段在 L2）——正好验证「带归属的行走抽屉全链」
    const row = screen.getAllByText('xiongmao:net_sales')[0]!.closest('tr')!
    fireEvent.click(within(row).getByRole('button', { name: /^详\s*情$/ }))
    await waitFor(() => expect(document.querySelectorAll('details').length).toBeGreaterThan(0))
    const details = document.querySelectorAll('details')
    expect(details.length).toBeGreaterThan(0)
    const text = [...details].map((d) => d.textContent ?? '').join('\n')
    expect(text).toContain('表达式：')
    expect(text).toContain('sum(fct_retail_sale.net_amount)')
    expect(text).toContain('所需权限：')
    // 归属面（P1 Task 8a，047 列）：展开层带归属部门/概念/差异说明，值随 /metrics/all 透传
    expect(text).toContain('归属部门：')
    expect(text).toContain('归属部门：熊喵门店组')
    expect(text).toContain('概念：销售额')
    expect(text).toContain('差异说明：不含退货')
    // 默认层零新增词（P1 纪律）：摘掉全部 details 后，正文里不得出现归属三词
    const bare = document.body.cloneNode(true) as HTMLElement
    bare.querySelectorAll('details').forEach((d) => d.remove())
    expect(bare.textContent ?? '').not.toContain('归属部门')
    expect(bare.textContent ?? '').not.toContain('差异说明')
  })
})
