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
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    if (url.includes('/metrics/overrides')) return json({ overrides: OVERRIDES })
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

describe('指标管理页', () => {
  it('列出两层：L1 标「平台（只读）」且不给删改，L2 给编辑/删除', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument())

    expect(screen.getByText('平台（只读）')).toBeInTheDocument()
    expect(screen.getByText('本租户派生')).toBeInTheDocument()
    // L1 行不给操作按钮（只读的落点）；L2 行给
    expect(screen.getByText('平台词表经 API 只读')).toBeInTheDocument()
    expect(button('编辑')).toBeInTheDocument()
    expect(button('删除')).toBeInTheDocument()
    // 两行都在表里 ⇒ 只读/可改是**逐行**判的，不是整页一刀切
    expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument()
  })

  it('★ 提交的 body 是结构化 L2 声明：只含 baseMetric/op/别名/维度，**不含任何 SQL 字段**', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('新建派生指标')).toBeInTheDocument())
    fireEvent.click(screen.getByText('新建派生指标'))

    // 填 id 与别名（base 默认取第一条 L1）
    fireEvent.change(screen.getByPlaceholderText('指标 id（如 xiongmao:net_sales）'), {
      target: { value: 'xiongmao:gross' },
    })
    fireEvent.change(screen.getByPlaceholderText('别名（可选；不填则沿用平台指标的标题）'), {
      target: { value: '熊喵毛利' },
    })

    // 打开维度裁剪并选一个维度：打开后组合框顺序 = [基准指标, 可见维度]
    fireEvent.click(screen.getByRole('switch'))
    await waitFor(() => expect(screen.getByText(/可见维度（不选/)).toBeInTheDocument())
    const combos = screen.getAllByRole('combobox')
    fireEvent.mouseDown(combos[combos.length - 1])
    fireEvent.click(await screen.findByTitle('system_book'))

    fireEvent.click(button('保存'))

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post, '没有发出 POST').toBeTruthy()
      expect(post?.body).toMatchObject({
        id: 'xiongmao:gross',
        baseMetric: 'lemeng:retail:net_sales',
        op: { kind: 'refine' },
        alias: '熊喵毛利',
        visibility: { dims: ['system_book'] },
      })
      // ★ 关键断言：结构化声明里**没有**自由 SQL 面
      const body = post?.body as Record<string, unknown>
      for (const forbidden of ['selectSql', 'subjectColumn', 'groupBy', 'source', 'params']) {
        expect(body[forbidden], `提交体里出现了 ${forbidden} ⇒ UI 又能写自由 SQL 了`).toBeUndefined()
      }
    })
  })

  it('别名留空 ⇒ 不带 alias 字段（服务端沿用平台标题；空串会被 zod 的 min(1) 判成非法）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('新建派生指标')).toBeInTheDocument())
    fireEvent.click(screen.getByText('新建派生指标'))
    fireEvent.change(screen.getByPlaceholderText('指标 id（如 xiongmao:net_sales）'), {
      target: { value: 'xiongmao:plain' },
    })
    fireEvent.click(button('保存'))

    await waitFor(() => {
      const post = calls.find((c) => c.method === 'POST')
      expect(post?.body).toMatchObject({ id: 'xiongmao:plain', baseMetric: 'lemeng:retail:net_sales' })
      expect((post?.body as Record<string, unknown>).alias).toBeUndefined()
      // 未裁剪维度 ⇒ 不带 visibility（= 继承平台指标的全部维度，而不是「零维度」）
      expect((post?.body as Record<string, unknown>).visibility).toBeUndefined()
    })
  })

  it('L2 行的删除走 DELETE（L1 行没有删除入口）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument())
    fireEvent.click(button('删除'))
    // 确认按钮的文案由组件**显式**给定（okText="确认删除"）：Popconfirm 的默认 okText 随 locale
    // 漂（未配 zh_CN 时是 "OK"），删除是不可逆动作，它的确认面代码里钉死更好
    fireEvent.click(await screen.findByRole('button', { name: /^确认删除$/ }))
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/metrics/xiongmao:net_sales'))).toBe(true)
    })
  })

  it('★ 两列：L2 显示「最后操作人 + v 版本」，L1 显示「平台物化（追溯走 git）」', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument())
    expect(screen.getByText('ZhangDuo')).toBeInTheDocument()                 // L2 的最后操作人
    expect(screen.getByText('v3')).toBeInTheDocument()                       // L2 的版本
    expect(screen.getByText('平台物化（追溯走 git）')).toBeInTheDocument()      // L1：不显示空白（否则读成「缺数据」）
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
    fireEvent.click(screen.getByText('平台指标'))
    expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument()
    expect(screen.queryByText('xiongmao:net_sales')).toBeNull()

    fireEvent.click(screen.getByText('派生指标'))
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
      expect(await screen.findByText('删除指标')).toBeInTheDocument()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('★ 空清单（UX）：给「指标从哪来」的说明，而不是裸「暂无数据」', async () => {
    m.mockImplementation(async () => json({ metrics: [] }))
    renderPage()
    expect(await screen.findByText('还没有指标。平台指标随数据面接入自动出现；本租户可基于平台指标新建派生指标。'))
      .toBeInTheDocument()
  })

  it('★ 变更历史抽屉：点开 → 拉 /metrics/:id/audit → 渲染动作与口径摘要（删除行的摘要来自 before）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument())
    const l2row = screen.getByText('xiongmao:net_sales').closest('tr')!
    within(l2row).getByRole('button', { name: /^变\s*更\s*历\s*史$/ }).click()

    await waitFor(() => expect(screen.getByText(/变更历史：xiongmao:net_sales/)).toBeInTheDocument())
    // ⚠️ 行内「删除」按钮与审计标签同文（text 按钮不像描边按钮那样自动插空格）⇒ 抽屉内断言
    expect(within(screen.getByRole('dialog')).getByText('删除')).toBeInTheDocument()
    expect(screen.getByText(/被删：L2 派生自 lemeng:retail:net_sales（删前）/)).toBeInTheDocument()  // ★ 删除留证
    expect(screen.getByText('新建')).toBeInTheDocument()
    expect(screen.getByText(/LiLei/)).toBeInTheDocument()                    // 记的是**人**
    // 拉的是本条的审计（不是 /metrics/all）
    expect(calls.some((c) => c.url.includes('/metrics/xiongmao:net_sales/audit'))).toBe(true)
  })
  // ── W8：全额声明 / 覆盖平台口径 ────────────────────────────────────────────────
  it('W8：平台行可「覆盖口径」，保存草稿点 → POST override（name/grain 预填自 L1）', async () => {
    renderPage()
    await screen.findByText('lemeng:retail:net_sales')
    fireEvent.click(button('覆盖口径'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/覆盖平台口径：lemeng:retail:net_sales/)).toBeInTheDocument()
    // name 锁死
    expect(within(dialog).getByDisplayValue('lemeng:retail:net_sales')).toBeDisabled()
    fireEvent.click(within(dialog).getByRole('button', { name: /保\s*存\s*草\s*稿/ }))
    await waitFor(() => {
      const c = calls.find((x) => x.url.includes('/metrics/lemeng:retail:net_sales/override'))
      expect(c?.method).toBe('POST')
      expect((c?.body as { declaration: { name: string; grain: string[] } }).declaration.name)
        .toBe('lemeng:retail:net_sales')
      expect((c?.body as { declaration: { grain: string[] } }).declaration.grain)
        .toEqual(['system_book', 'bizday'])
    })
  })

  it('W8：新建全额声明表单 → POST /metrics/declarations，body 只有声明（不含 SQL 字段）', async () => {
    renderPage()
    await screen.findByText('lemeng:retail:net_sales')
    fireEvent.click(button('新建声明（全额口径）'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByPlaceholderText('如 lemeng:retail:gross_sales'), {
      target: { value: 'tenant:retail:gross' },
    })
    fireEvent.change(within(dialog).getByPlaceholderText('口径定义（必填）'), {
      target: { value: '本租户口径' },
    })
    fireEvent.change(within(dialog).getByPlaceholderText('sum(fct_retail_sale.sale_amount)'), {
      target: { value: 'sum(fct_retail_sale.sale_amount)' },
    })
    fireEvent.change(within(dialog).getByPlaceholderText(/system_book, bizday/), {
      target: { value: 'system_book, bizday' },
    })
    fireEvent.change(within(dialog).getByPlaceholderText('lemeng.retail_order_line.sale_amount'), {
      target: { value: 'lemeng.retail_order_line.sale_amount' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: /^创\s*建$/ }))
    await waitFor(() => {
      const c = calls.find((x) => x.url.includes('/metrics/declarations'))
      expect(c?.method).toBe('POST')
      const d = (c?.body as { declaration: Record<string, unknown> }).declaration
      expect(d.name).toBe('tenant:retail:gross')
      expect(d.expression).toBe('sum(fct_retail_sale.sale_amount)')
      expect(d.grain).toEqual(['system_book', 'bizday'])
      expect(d.reads).toEqual(['lemeng.retail_order_line.sale_amount'])
      // 结构上写不出 SQL：body 里没有 selectSql/subjectColumn/groupBy
      expect(d.selectSql).toBeUndefined()
      expect(d.groupBy).toBeUndefined()
    })
  })

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
    renderPage(['data:query', 'data:manage'], '/console/data/metrics')
    await waitFor(() => expect(screen.getByText('lemeng:retail:net_sales')).toBeInTheDocument())
    // 默认层：说明文字（夹具里没有 bizDescription，回落 description）
    expect(screen.getAllByText('口径定义').length).toBeGreaterThan(0)
    // 技术细节：原生 <details> 折起时内容仍在 DOM ⇒ 专家展开即可见，且不会被藏到别页
    const details = document.querySelectorAll('details')
    expect(details.length).toBeGreaterThan(0)
    const text = [...details].map((d) => d.textContent ?? '').join('\n')
    expect(text).toContain('表达式：')
    expect(text).toContain('sum(fct_retail_sale.net_amount)')
    expect(text).toContain('所需权限：')
  })
})
