// SpecView.test.tsx — 平台自绘渲染器（Task 4 起的既有验收 + 2026-10-26 Task 6 新增面）。
//
// ★ 本文件最重的两条（Task 1 评审转办的判据 + spec §5 实测坑）：
//  ① **args 两个源头**：渲染器把「`panel.args` + 筛选栏覆盖（#1047）」塞进 /query 的 body，
//     **不做第三种加工**——args 的开放键名（租户自定义过滤参数）安全性全押在服务端
//     `authorize` 那条链上（unknown_param 拒绝 + 保留键闸 + literal/rangeLiteral 转义）。
//     夹具的 args 因此**必须非空且带混合类型**——args 是 `{}` 时「转发」与「硬编码 `{}`」不可区分。
//  ② **多系列按透视数据集装配**：每个系列一个 `data` 数组、`xAxis.data` 用维度值——
//     把多出来的点塞进一个系列会被连成一条线（spec §5 实测）。
//
// Task 6 新增的三组判据（与实现一一对应）：
//  ③ **旧规格零变化**：无 `period`/`slice` 时 body 恒为 `{metricId, args}`（第一条用例逐字咬）；
//  ④ **期间是规格声明**：`period` 只覆盖 `timeScoped !== false` 的面板；KPI 的 `auto` 对比段
//     按期间模式解析（月 → 上月同日期段）；
//  ⑤ **信任信号如实转述**：masking / data_as_of / freshness_line / truncated 有则显示、
//     没有就不编（「未知 ≠ 新鲜」）。
//
// echarts 桩说明：happy-dom 的 `canvas.getContext('2d')` 返回 **null**（实测），真 echarts `init`
// 必抛 ⇒ 组件测试里把渲染器用到的 echarts 表面桩掉（形状收严到实际调用的
// use/init + setOption/resize/dispose）。图表**装配**正确性经 `setOption` 入参断言；
// 真实渲染由 `pnpm --filter web build`（echarts 打进 console 分包）与真机验收兜。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Outlet, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@platform/sdk/web', () => ({ platformFetch: vi.fn() }))
vi.mock('echarts/core', () => ({
  use: vi.fn(),
  init: vi.fn(() => ({ setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() })),
}))
vi.mock('echarts/charts', () => ({ LineChart: {}, BarChart: {} }))
vi.mock('echarts/components', () => ({ GridComponent: {}, TooltipComponent: {}, LegendComponent: {} }))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }))
import { platformFetch } from '@platform/sdk/web'
import { init, use } from 'echarts/core'
import { BarChart, LineChart } from 'echarts/charts'
import { GridComponent, LegendComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import SpecView from './SpecView'
import { ECHARTS_REGISTRY } from './ReportView'
import { KpiCard } from './KpiCard'

const m = vi.mocked(platformFetch)
const mInit = vi.mocked(init)
const mUse = vi.mocked(use)
const calls: { url: string; init?: RequestInit }[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

/** 夹具形状照 domain/report-spec.ts 的白名单字段（只写用例关心的那些）。 */
interface Panel {
  chart: 'line' | 'bar' | 'table' | 'kpi' | 'text' | 'ai_text'
  title?: string
  /** ai_text 的生成口径（v1 只有 overview）。 */
  focus?: 'overview'
  metricId?: string
  denominatorMetricId?: string
  format?: 'currency' | 'number' | 'percent'
  compare?: 'auto' | 'prev_period' | 'prev_month' | 'none'
  goodDirection?: 'up' | 'down' | 'none'
  timeScoped?: boolean
  dims?: string[]
  args?: Record<string, unknown>
  span: number
  slice?: {
    dimensions?: string[]
    orderBy?: Array<{ column: string; dir: 'asc' | 'desc' }>
    limit?: number
    total?: boolean
  }
  content?: string
}
interface SpecFixture {
  period?: { mode: 'month' | 'last_7_days' | 'custom'; month?: string; from?: string; to?: string }
  panels: Panel[]
}
type QueryBody = { metricId: string; args: Record<string, unknown> } & Record<string, unknown>

/** 所有已发出的 /query body（按发出顺序）。 */
const queryBodies = (): QueryBody[] =>
  calls.filter((c) => c.url.endsWith('/query')).map((c) => JSON.parse(String(c.init?.body)) as QueryBody)

/**
 * 桩集合：`GET /reports/:id/spec` 回一份规格；`POST /query` 按 metricId 分流——
 * `denied` 集合里的口径回 403 `{status:'denied'}`（照 routes/query.ts 的真实映射），
 * 其余回 `okQueries` 里的结果（缺省一张单列表）。
 */
function stub(
  spec: SpecFixture,
  okQueries: Record<string, Record<string, unknown> & { columns: string[]; rows: unknown[][] }>,
  denied: Set<string>,
  extraGet: Record<string, unknown> = {},
) {
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (/\/reports\/[^/]+\/spec$/.test(url)) return json({ spec, version: 7 })
    for (const [suffix, body] of Object.entries(extraGet)) {
      if (url.endsWith(suffix)) return json(body)
    }
    if (url.endsWith('/query')) {
      const body = JSON.parse(String(init?.body)) as { metricId: string }
      if (denied.has(body.metricId)) {
        return json({ status: 'denied', metricId: body.metricId, reason: 'metric_not_declared' }, 403)
      }
      return json({ status: 'ok', truncated: false, ...(okQueries[body.metricId] ?? { columns: ['value'], rows: [[1]] }) })
    }
    return json({})
  })
}

/** 挂载形态照宿主壳（同 reports/index.test.tsx）：SpecView 经 Outlet 注入 session。 */
function renderView(onClose: () => void = () => {}) {
  const router = createMemoryRouter(
    [
      {
        element: <Outlet context={{ session: { scopes: ['data:query'] } }} />,
        children: [{ path: '/console/data/reports', element: <SpecView reportId="r9" title="自绘大盘" onClose={onClose} /> }],
      },
    ],
    { initialEntries: ['/console/data/reports'] },
  )
  render(<RouterProvider router={router} />)
}

/** antd 给「恰好两个汉字」的按钮标签中间插真实空格（autoInsertSpace）⇒ 容空白正则查。 */
const button = (label: string) =>
  screen.getByRole('button', { name: new RegExp(`^${label.split('').join('\\s*')}$`) })

beforeEach(() => {
  calls.length = 0
  m.mockReset()
  mInit.mockClear()
})
afterEach(() => {
  cleanup()
  vi.useRealTimers() // 期间用例可能钉过 Date（vi.setSystemTime）
})

describe('自绘渲染器 SpecView', () => {
  it('★ 打开自绘行 ⇒ 拉规格 + 逐面板查数据（走既有 /query）', async () => {
    // args 非空且混合类型（见文件头①）：字符串 + 布尔——「原样转发」才可被判。
    // 旧规格（无 period / 无 slice）⇒ body **只有** {metricId, args}（文件头③）。
    stub({
      panels: [{
        chart: 'line', title: '净销售额趋势', metricId: 'lemeng:retail:net_sales',
        dims: ['bizday'], args: { system_book: '3120', include_refund: false }, span: 12,
      }],
    }, {}, new Set())
    renderView()

    // ① 两条请求都发出（先规格后数据；顺序不断言——并发面板查询是实现自由）
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/reports/r9/spec'))).toBe(true))
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/query'))).toBe(true))
    // ② 页面出现面板标题
    expect(await screen.findByText('净销售额趋势')).toBeInTheDocument()
    // ③ query 的 body 里该面板的 metricId/args **逐字**（toEqual：多带键/改值都咬）
    //    ⚠️ dims **不进 body**——/query 的 QueryBody 只有 {metricId, args}；无 slice 时
    //    `dimensions` 也不得凭空出现（`dimensions: []` 是显式合计，语义完全不同）。
    const q = calls.find((c) => c.url.endsWith('/query'))!
    expect(JSON.parse(String(q.init?.body))).toEqual({
      metricId: 'lemeng:retail:net_sales',
      args: { system_book: '3120', include_refund: false },
    })
  })

  it('★ 筛选栏：默认值取自面板 args；改门店 ⇒ 以覆盖后的 args 重查（#1047）', async () => {
    stub({
      panels: [{
        chart: 'table', title: '会员销售', metricId: 'lemeng:member:branch_vip_money', dims: [],
        args: { system_book: '3120', branch_num: '92', bizday: { from: '2026-10-01', to: '2026-10-19' } },
        span: 24,
      }],
    }, { 'lemeng:member:branch_vip_money': { columns: ['value'], rows: [[24284.39]] } }, new Set(), {
      '/branches?system_book=3120': { branches: [
        { branchNum: '91', name: '熊喵曲靖沾益1店' },
        { branchNum: '92', name: '熊喵曲靖沾益2店' },
      ] },
    })
    renderView()

    expect(await screen.findByText('24284.39')).toBeInTheDocument()
    // 筛选栏渲染：门店默认值来自规格 args（名称来自 /branches）
    expect(screen.getByTestId('spec-filters')).toBeInTheDocument()
    expect(screen.getByText('92 · 熊喵曲靖沾益2店')).toBeInTheDocument()
    // 无 period ⇒ RangePicker 在（期间控件不在）
    expect(screen.queryByTestId('period-bar')).not.toBeInTheDocument()

    // 改门店 92 → 91：antd Select 交互（mouseDown 开 + 点选项；combobox role 配方照 metrics/index.test）
    const combos = screen.getAllByRole('combobox')
    fireEvent.mouseDown(combos[combos.length - 1])
    fireEvent.click(await screen.findByTitle('91 · 熊喵曲靖沾益1店'))

    // 重查：POST body 的 args.branch_num 被覆盖，其余参数保持规格值
    await waitFor(() => {
      const posts = queryBodies()
      expect(posts.length).toBeGreaterThanOrEqual(2)
      expect(posts[posts.length - 1].args).toMatchObject({
        branch_num: '91',
        system_book: '3120',
        bizday: { from: '2026-10-01', to: '2026-10-19' },
      })
    })
  })

  it('★ 面板查询被拒（denied）⇒ 该面板出人话，不拖垮整页', async () => {
    // 两面板：p1（table，正常回数）+ p2（line，403 denied）——denied 只塌自己那格
    stub({
      panels: [
        { chart: 'table', title: '门店明细', metricId: 'lemeng:retail:stores', dims: [], args: {}, span: 12 },
        { chart: 'line', title: '秘密口径', metricId: 'x:secret', dims: ['bizday'], args: {}, span: 12 },
      ],
    }, {
      'lemeng:retail:stores': { columns: ['store', 'value'], rows: [['3120', '9876']] },
    }, new Set(['x:secret']))
    renderView()

    // 被拒的那格出人话（denied 的 reason 是英文裸码，不直接上屏）
    expect(await screen.findByText('这条口径当前不可用')).toBeInTheDocument()
    // 其余面板照常渲染：标题 + 数据真的画出来了（table 走 DOM，最硬的可观测面）
    expect(await screen.findByText('9876')).toBeInTheDocument()
    expect(screen.getByText('门店明细')).toBeInTheDocument()
    // 窄屏护栏：表在卡内横向滚动，不撑破 Col/页面（#1047 企微 390px 实测顶破）
    expect(screen.getByTestId('table-scroll')).toHaveStyle({ overflowX: 'auto' })
    // 整页没塌：标题栏与关闭按钮仍在
    expect(screen.getByText('自绘大盘')).toBeInTheDocument()
    expect(button('关闭')).toBeInTheDocument()
  })

  it('★ 多系列按透视数据集装配（每系列一个 data 数组；xAxis.data 用维度值）——spec §5 实测坑 1', async () => {
    // dims 两个维度：bizday 做 x 轴、system_book 做系列 ⇒ 必须透视成 2 系列 × 2 点。
    // 「把多出来的点塞进一个系列」的错法会让 series 长度=1 且 data 长 4（点被连成一条线）。
    stub({
      panels: [{
        chart: 'line', title: '分店趋势', metricId: 'm1', dims: ['bizday', 'system_book'],
        args: {}, span: 24,
      }],
    }, {
      m1: {
        columns: ['value', 'system_book', 'bizday'],
        rows: [
          ['100', '3120', '2026-09-01'],
          ['200', '64188', '2026-09-01'],
          ['300', '3120', '2026-09-02'],
          ['400', '64188', '2026-09-02'],
        ],
      },
    }, new Set())
    renderView()
    await waitFor(() => expect(mInit).toHaveBeenCalled())

    // echarts 收到的 option：透视数据集（数值经 Number 归一——pg 的 numeric 走驱动回来是字符串）
    const chartStub = mInit.mock.results[0].value as unknown as { setOption: ReturnType<typeof vi.fn> }
    const option = chartStub.setOption.mock.calls[0][0] as {
      xAxis: { data: string[] }
      series: Array<{ name: string; type: string; data: Array<number | null> }>
      grid: Record<string, unknown>
    }
    expect(option.xAxis.data).toEqual(['2026-09-01', '2026-09-02'])
    expect(option.series).toEqual([
      { name: '3120', type: 'line', data: [100, 300] },
      { name: '64188', type: 'line', data: [200, 400] },
    ])
    // spec §5 实测坑 2：grid 显式留白 + 容器 overflow:hidden（画布溢出到隔壁格子）
    expect(option.grid).toMatchObject({ containLabel: true })
    for (const side of ['left', 'right', 'top', 'bottom']) {
      expect(typeof option.grid[side]).toBe('number')
    }
    const container = mInit.mock.calls[0][0] as HTMLElement
    expect(container.style.overflow).toBe('hidden')
  })

  it('关闭按钮回调 onClose（SpecView 的退出契约）', async () => {
    stub({ panels: [] }, {}, new Set())
    const onClose = vi.fn()
    renderView(onClose)
    expect(await screen.findByText('自绘大盘')).toBeInTheDocument()
    fireEvent.click(button('关闭'))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('★ 图表 init 收口：每图恰一次（兄弟面板结果先后到达不重建已挂画布）——评审 Minor ①', async () => {
    // 两块 line 面板，慢面板的 /query 被卡住不回：快面板先挂 ⇒ init=1；慢面板到达触发**父级
    // 重渲染** ⇒ 旧实现（effect 依赖每次渲染都是新对象的 option）会把快面板 dispose+init 重来
    // （init 变 3）——修法后每图只在挂载时 init 一次，总数恒等于面板数。
    let releaseSlow: (() => void) | null = null
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (/\/reports\/[^/]+\/spec$/.test(url)) {
        return json({
          spec: {
            panels: [
              { chart: 'line', title: '快面板', metricId: 'm1', dims: ['bizday'], args: {}, span: 12 },
              { chart: 'line', title: '慢面板', metricId: 'm2', dims: ['bizday'], args: {}, span: 12 },
            ],
          },
          version: 7,
        })
      }
      if (url.endsWith('/query')) {
        const body = JSON.parse(String(init?.body)) as { metricId: string }
        const rows = body.metricId === 'm1' ? [['2026-09-01', 1]] : [['2026-09-01', 2]]
        if (body.metricId === 'm2') await new Promise<void>((r) => { releaseSlow = r })
        return json({ status: 'ok', truncated: false, columns: ['bizday', 'value'], rows })
      }
      return json({})
    })
    renderView()
    // 快面板数据到达并挂图 ⇒ 恰 1 次 init（慢面板还卡着，不可能更多）
    await waitFor(() => expect(mInit).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(releaseSlow).not.toBeNull())
    releaseSlow!()
    // 慢面板到达 ⇒ 第二块首挂 ⇒ 总数恰 2（不是「快面板重建 + 慢面板首挂」的 3）
    await waitFor(() => expect(mInit).toHaveBeenCalledTimes(2))
    // 稳态复核：再等一拍仍是 2（防「断言时第 3 次还没轮到」的早断言假绿）
    await new Promise((r) => setTimeout(r, 50))
    expect(mInit).toHaveBeenCalledTimes(2)
  })

  it('★ 空度量值保留 null（断线，不画成 0）——评审 Minor ②', async () => {
    // Number(null) === 0 且 finite ⇒ 裸 Number() 会把「无值」洗成 0 画出去（撒谎的折线）。
    stub({
      panels: [{ chart: 'line', title: '断线面板', metricId: 'm1', dims: ['bizday'], args: {}, span: 12 }],
    }, {
      m1: { columns: ['value', 'bizday'], rows: [[100, '2026-09-01'], [null, '2026-09-02']] },
    }, new Set())
    renderView()
    await waitFor(() => expect(mInit).toHaveBeenCalled())
    const chartStub = mInit.mock.results[0].value as unknown as { setOption: ReturnType<typeof vi.fn> }
    const option = chartStub.setOption.mock.calls[0][0] as { series: Array<{ data: Array<number | null> }> }
    expect(option.series[0].data).toEqual([100, null])
  })

  it('★ bar 面板走 BarChart 分支（series type=bar）+ use 注册清单机检——评审 Minor ③', async () => {
    // 注册面闭环：漏注册 BarChart 时组件测试照绿（use 是桩，不真装配）、真机才炸——
    // 这里对**导出的注册清单**做恒等断言（测试与实现 import 同一 mock 模块 ⇒ 同一对象引用）。
    for (const item of [LineChart, BarChart, GridComponent, TooltipComponent, LegendComponent, CanvasRenderer]) {
      expect(ECHARTS_REGISTRY).toContain(item)
    }
    // 闭环的另一半：清单必须**真的**被交给 `use()`。
    expect(mUse).toHaveBeenCalledWith(ECHARTS_REGISTRY)
    stub({
      panels: [{ chart: 'bar', title: '柱状面板', metricId: 'm1', dims: ['bizday'], args: {}, span: 12 }],
    }, {
      m1: { columns: ['value', 'bizday'], rows: [[80, '2026-09-01']] },
    }, new Set())
    renderView()
    await waitFor(() => expect(mInit).toHaveBeenCalled())
    const chartStub = mInit.mock.results[0].value as unknown as { setOption: ReturnType<typeof vi.fn> }
    // 柱状图走 baseOption + media（窄屏类目标签自适应，见下条用例）⇒ series 在 baseOption 里
    const option = chartStub.setOption.mock.calls[0][0] as { baseOption: { series: Array<{ name: string; type: string }> } }
    expect(option.baseOption.series).toEqual([{ name: '', type: 'bar', data: [80] }])
  })

  it('★ 窄屏柱状类目标签：media 查询强制全显 + 45° 倾斜 + 截断；折线图不带 media（Task 13 走查）', async () => {
    // 症状复现：8 个 4–5 字类目在 ~340px 画布里，echarts 默认 interval:'auto' 会抽掉一半标签
    // （柱在、标签没了）；标签更长时相邻重叠。修法 = 窄容器下 interval:0 + rotate:45 + truncate。
    // 组件测试只能断言**声明面**（echarts 是桩，媒体查询不会真求值）——真实触发由 390×844
    // 截图验收兜底；两条用例合起来才是闭环（声明 + 真机）。
    const labels = ['会员消费', '普通零售', '团购核销', '外卖配送', '储值卡消费', '企业团购', '员工内购', '其他销售']
    stub({
      panels: [
        { chart: 'bar', title: '柱状面板', metricId: 'm1', dims: ['order_sale_type_name'], args: {}, span: 24 },
        { chart: 'line', title: '折线面板', metricId: 'm2', dims: ['bizday'], args: {}, span: 24 },
      ],
    }, {
      m1: { columns: ['value', 'order_sale_type_name'], rows: labels.map((l, i) => [String(i + 1), l]) },
      m2: { columns: ['value', 'bizday'], rows: [['1', '2026-09-01']] },
    }, new Set())
    renderView()
    await waitFor(() => expect(mInit).toHaveBeenCalledTimes(2))

    type Option = {
      baseOption?: {
        xAxis: { type: string; data: string[]; axisLabel?: unknown }
        grid: Record<string, unknown>
        series: Array<{ type: string }>
      }
      media?: Array<Record<string, unknown>>
      xAxis?: { axisLabel?: unknown }
    }
    const options = mInit.mock.results.map(
      (r) => (r.value as unknown as { setOption: ReturnType<typeof vi.fn> }).setOption.mock.calls[0][0] as Option,
    )
    const bar = options.find((o) => o.baseOption?.series[0]?.type === 'bar')!
    const line = options.find((o) => o.baseOption === undefined)!

    // 柱状图：类目全量保留（不是被抽稀的 4 个），且窄屏媒体查询把标签钉成「全显 + 倾斜 + 截断」
    expect(bar.baseOption!.xAxis.data).toEqual(labels)
    expect(bar.media).toEqual([{
      query: { maxWidth: 520 },
      option: {
        grid: { bottom: 24 },
        xAxis: { axisLabel: { interval: 0, rotate: 45, fontSize: 11, overflow: 'truncate', width: 84 } },
      },
    }])
    // 呼吸位：宽屏留白仍是原来的 12，窄屏 bottom 在 media 里抬到 24（> 12，见上面的 toEqual）
    expect(bar.baseOption!.grid.bottom).toBe(12)

    // 折线图**一字不动**：option 根部就是原形状，没有 baseOption/media（宽屏桌面行为不变）
    expect(line.baseOption).toBeUndefined()
    expect(line.media).toBeUndefined()
    expect(line.xAxis).toEqual({ type: 'category', data: ['2026-09-01'] })
  })
})

describe('Task 6：期间 / slice / KPI / 文本 / 信任信号', () => {
  it('★ period=month ⇒ timeScoped 面板注入 bizday 窗口；timeScoped=false 的面板不受影响', async () => {
    // 「今天」钉在 2026-10-26（上海日）：当月区间 = 10-01 .. 10-26（只到当天，不画未来）
    vi.setSystemTime(new Date('2026-10-26T12:00:00+08:00'))
    stub({
      period: { mode: 'month', month: '2026-10' },
      panels: [
        {
          chart: 'table', title: '本月销售额', metricId: 'net_sales', dims: [],
          args: { system_book: '3120', branch_num: '92' }, span: 24,
        },
        {
          chart: 'table', title: '门店字典快照', metricId: 'store_snapshot', dims: [],
          args: { system_book: '3120' }, span: 24, timeScoped: false,
        },
      ],
    }, {}, new Set(), {
      '/branches?system_book=3120': { branches: [{ branchNum: '92', name: '熊喵曲靖沾益2店' }] },
    })
    renderView()

    // 期间控件在场（旧规格没有这条栏）
    expect(await screen.findByTestId('period-bar')).toBeInTheDocument()
    await waitFor(() => expect(queryBodies().length).toBe(2))

    const byMetric = new Map(queryBodies().map((b) => [b.metricId, b]))
    expect(byMetric.get('net_sales')!.args).toMatchObject({
      system_book: '3120', branch_num: '92', bizday: { from: '2026-10-01', to: '2026-10-26' },
    })
    // timeScoped=false ⇒ 不注入期间（这条面板按自身 args 取数）
    expect(byMetric.get('store_snapshot')!.args.bizday).toBeUndefined()
  })

  it('★ slice ⇒ body 追加服务端分组/排序/截断；无 slice 的面板一个键都不多', async () => {
    stub({
      panels: [
        {
          chart: 'bar', title: '会员销售（按订单类型）', metricId: 'vip', dims: ['order_sale_type_name'],
          args: { system_book: '3120' }, span: 24,
          slice: { dimensions: ['order_sale_type_name'], orderBy: [{ column: 'order_sale_type_name', dir: 'asc' }], limit: 20 },
        },
        {
          chart: 'table', title: '明细', metricId: 'detail', dims: [], args: { system_book: '3120' }, span: 24,
        },
      ],
    }, {
      vip: { columns: ['order_sale_type_name', 'value'], rows: [['会员', '100']] },
      detail: { columns: ['value'], rows: [['1']] },
    }, new Set())
    renderView()
    await waitFor(() => expect(queryBodies().length).toBe(2))

    const byMetric = new Map(queryBodies().map((b) => [b.metricId, b]))
    // slice：dimensions 回落到声明的 dims，orderBy/limit 原样透传（授权核心再校验列名）
    expect(byMetric.get('vip')).toEqual({
      metricId: 'vip',
      args: { system_book: '3120' },
      dimensions: ['order_sale_type_name'],
      orderBy: [{ column: 'order_sale_type_name', dir: 'asc' }],
      limit: 20,
    })
    // 无 slice ⇒ 与旧规格逐字一致（不凭空补 dimensions: []——那是显式合计）
    expect(byMetric.get('detail')).toEqual({
      metricId: 'detail',
      args: { system_book: '3120' },
    })
  })

  it('★ KPI：比率 = 两个显式合计相除；对比期无数据 ⇒ 差值「-」', async () => {
    // 客单价 = sales ÷ orders。当前段 150/3 = 50；对比段 sales 无数据 ⇒ 差值为「-」（不是 0）。
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const body = JSON.parse(String(init?.body)) as QueryBody
      const inCompare = (body.args.bizday as { from?: string } | undefined)?.from === '2026-09-12'
      const totals: Record<string, number | null> = inCompare
        ? { sales: null, orders: 3 }
        : { sales: 150, orders: 3 }
      return json({ status: 'ok', truncated: false, columns: ['total'], rows: [[totals[body.metricId]]], total: totals[body.metricId] })
    })
    render(
      <KpiCard
        panel={{
          chart: 'kpi', title: '客单价', metricId: 'sales', denominatorMetricId: 'orders',
          format: 'currency', compare: 'prev_period', goodDirection: 'up', span: 12,
          // zod 的 default 让这两个键在**输出**类型里是必填的（渲染器拿到的就是补全后的形状）
          args: {}, timeScoped: true,
        }}
        args={{ system_book: '3120', bizday: { from: '2026-10-01', to: '2026-10-19' } }}
        compareRange={{ from: '2026-09-12', to: '2026-09-30' }}
      />,
    )

    expect(await screen.findByText('¥50.00')).toBeInTheDocument()
    // 对比期：分子 null ⇒ 已知无数（「-」），不是 0 也不是空白
    await waitFor(() => expect(screen.getByTestId('kpi-delta').textContent).toBe('-'))
    // 取数纪律：当前段 2 次（分子+分母）+ 对比段 1 次（分子已缺数 ⇒ 分母不再查）——
    // **全部**是显式合计，对比段的 bizday 被替换为上个等长段
    const bodies = queryBodies()
    expect(bodies).toHaveLength(3)
    expect(bodies.every((b) => b.args.total === true)).toBe(true)
    expect(bodies.filter((b) => (b.args.bizday as { from?: string }).from === '2026-09-12')).toHaveLength(1)
  })

  it('★ KPI：零分母 ⇒ 值「-」（不显示 0 / ∞ / 空白）', async () => {
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const body = JSON.parse(String(init?.body)) as QueryBody
      const total = body.metricId === 'sales' ? 150 : 0
      return json({ status: 'ok', columns: ['total'], rows: [[total]], total })
    })
    render(
      <KpiCard
        panel={{
          chart: 'kpi', title: '客单价', metricId: 'sales', denominatorMetricId: 'orders',
          format: 'currency', compare: 'none', goodDirection: 'none', span: 12,
          args: {}, timeScoped: true,
        }}
        args={{ system_book: '3120' }}
        compareRange={null}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('kpi-value').textContent).toBe('-'))
    // 无对比段 ⇒ 不渲染差值（别拿「-」冒充「对比过」）
    expect(screen.queryByTestId('kpi-delta')).toBeNull()
  })

  it('★ period=month + kpi compare=auto ⇒ 对比段取上月同日期段（10-01..10-26 → 09-01..09-26）', async () => {
    vi.setSystemTime(new Date('2026-10-26T12:00:00+08:00'))
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (/\/reports\/[^/]+\/spec$/.test(url)) {
        return json({
          spec: {
            period: { mode: 'month', month: '2026-10' },
            panels: [{ chart: 'kpi', title: '本月销售额', metricId: 'sales', format: 'number', span: 12 }],
          },
          version: 7,
        })
      }
      return json({ status: 'ok', truncated: false, columns: ['total'], rows: [[111]], total: 111 })
    })
    renderView()
    await waitFor(() => expect(queryBodies().length).toBe(2))

    const byRange = new Map(queryBodies().map((b) => [(b.args.bizday as { from: string }).from, b]))
    expect(byRange.has('2026-10-01')).toBe(true)
    expect(byRange.get('2026-10-01')!.args.bizday).toEqual({ from: '2026-10-01', to: '2026-10-26' })
    // auto + month ⇒ prev_month（不是等长前移的 09-06..09-30）
    expect(byRange.get('2026-09-01')!.args.bizday).toEqual({ from: '2026-09-01', to: '2026-09-26' })
  })

  it('★ text 面板：保留换行、按纯文本渲染（不解析 HTML）', async () => {
    stub({
      panels: [{ chart: 'text', title: '本月结论', content: '第一行\n<b>不是标签</b>', span: 24 }],
    }, {}, new Set())
    renderView()

    const para = await screen.findByText(/第一行/)
    expect(para.textContent).toBe('第一行\n<b>不是标签</b>')
    // whiteSpace:pre-wrap ⇒ 换行真的折行（不是被压成一行）
    expect(para).toHaveStyle({ whiteSpace: 'pre-wrap' })
    // 纯文本：内容里的尖括号**没有**被当成标签渲染
    expect(document.querySelector('b')).toBeNull()
  })

  it('★ ai_text 面板：不进 /query，按 reportId/panelIndex/期间/门店 拉 SSE 并流式上屏（Task 9）', async () => {
    const enc = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of [
          'data: {"type":"phase","phase":"thinking","label":"正在分析…"}\n\n',
          'data: {"type":"delta","text":"本月"}\n\n',
          'data: {"type":"done","text":"本月销售额稳","fallback":false,"dataAsOf":"2026-10-25","generatedAt":"x","cached":false}\n\n',
        ]) c.enqueue(enc.encode(chunk))
        c.close()
      },
    })
    m.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (/\/reports\/[^/]+\/spec$/.test(url)) {
        return json({
          spec: {
            period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' },
            panels: [
              // 数据面板声明 branch_num（筛选栏默认值从它来 ⇒ ai_text 的切片门店与之一致）
              { chart: 'table', title: '会员销售', metricId: 'm1', dims: [], args: { system_book: '3120', branch_num: '92' }, span: 12 },
              { chart: 'ai_text', title: '本月结论', focus: 'overview', span: 24 },
            ],
          },
          version: 7,
        })
      }
      if (url.endsWith('/narrative/stream')) return { ok: true, body: stream } as unknown as Response
      if (url.endsWith('/branches?system_book=3120')) {
        return json({ branches: [{ branchNum: '92', name: '熊喵曲靖沾益2店' }] })
      }
      if (url.endsWith('/query')) {
        return json({ status: 'ok', truncated: false, columns: ['value'], rows: [[1]] })
      }
      return json({})
    })
    renderView()

    expect(await screen.findByText('本月销售额稳', undefined, { timeout: 3000 })).toBeInTheDocument()
    // ① ai_text 不走 /query：查询循环只发了那一个 table 面板
    expect(queryBodies().map((b) => b.metricId)).toEqual(['m1'])
    // ② 流请求体：面板下标（1）+ 当前期间 + 门店；未钉版本 ⇒ 不带 version 键（`.strict()` 端点）
    const call = calls.find((c) => c.url.endsWith('/narrative/stream'))!
    expect(call.init?.method).toBe('POST')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      panelIndex: 1,
      period: { mode: 'custom', from: '2026-10-01', to: '2026-10-19' },
      branchNum: '92',
    })
    // ③ 卡片标题 + AI 标签（与静态 text 面板可区分）
    expect(screen.getByText('本月结论')).toBeInTheDocument()
    expect(screen.getByText('AI')).toBeInTheDocument()
  })

  it('★ 信任信号页脚：masking / freshness_line / data_as_of / truncated 如实展示', async () => {
    stub({
      panels: [
        { chart: 'table', title: '会员销售', metricId: 'm1', dims: [], args: {}, span: 24 },
        { chart: 'table', title: '库存', metricId: 'm2', dims: [], args: {}, span: 24 },
      ],
    }, {
      // 面板 1：脱敏 + 新鲜度行 + 截断（freshness_line 在场时以它为准）
      m1: {
        columns: ['value'], rows: [['1']],
        truncated: true,
        masking: { shop_name: 'partial' },
        freshness_line: '数据截止 2026-10-25（T+1）',
        data_as_of: '2026-10-25 03:00:00 +08:00',
      },
      // 面板 2：只有 data_as_of（没有 freshness_line）⇒ 回落到「数据截止 <ts>」
      m2: { columns: ['value'], rows: [['2']], data_as_of: '2026-10-24 03:00:00 +08:00' },
    }, new Set())
    renderView()

    await waitFor(() => expect(screen.getAllByTestId('trust-line')).toHaveLength(2))
    const all = screen.getAllByTestId('trust-line').map((el) => el.textContent ?? '').join(' | ')
    expect(all).toContain('结果超过单次查询上限，已截断')
    expect(all).toContain('含脱敏列：shop_name')
    expect(all).toContain('数据截止 2026-10-25（T+1）')
    expect(all).toContain('数据截止 2026-10-24 03:00:00 +08:00')
  })
})
