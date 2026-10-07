// index.test.tsx — 指标管理页（console/metrics）：词表两层的呈现 + L2 声明式表单。
//
// ★ 本文件最重要的那一条是「**UI 结构上写不出 SQL**」：表单提交的 body 只能是
// `L2Declaration`（base + 别名 + 维度白名单 + 过滤），**不含** selectSql / subjectColumn /
// groupBy。这不是「表单恰好没做那几个输入框」，而是 T8 收紧入参之后 UI 侧能表达的全部——
// 一旦有人给页面加回一个「自定义 SQL」输入框，这条用例会红。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
import { platformFetch } from '@platform/sdk/web'
import MetricsPage from './index'

const m = vi.mocked(platformFetch)
/** 记下每次请求（含 body），用来断言「提交了什么」。 */
const calls: Array<{ url: string; method: string; body: unknown }> = []

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
  m.mockReset()
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
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

  it('★ 变更历史抽屉：点开 → 拉 /metrics/:id/audit → 渲染动作与口径摘要（删除行的摘要来自 before）', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('xiongmao:net_sales')).toBeInTheDocument())
    button('变更历史').click()

    await waitFor(() => expect(screen.getByText(/变更历史：xiongmao:net_sales/)).toBeInTheDocument())
    expect(screen.getByText('删除')).toBeInTheDocument()
    expect(screen.getByText(/被删：L2 派生自 lemeng:retail:net_sales（删前）/)).toBeInTheDocument()  // ★ 删除留证
    expect(screen.getByText('新建')).toBeInTheDocument()
    expect(screen.getByText(/LiLei/)).toBeInTheDocument()                    // 记的是**人**
    // 拉的是本条的审计（不是 /metrics/all）
    expect(calls.some((c) => c.url.includes('/metrics/xiongmao:net_sales/audit'))).toBe(true)
  })
})
