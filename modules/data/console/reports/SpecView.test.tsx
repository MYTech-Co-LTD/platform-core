// SpecView.test.tsx — 平台自绘渲染器（计划 6 Task 4）：拉规格 → 逐面板 POST /query → 渲染。
//
// ★ 本文件最重的两条（Task 1 评审转办的判据 + spec §5 实测坑）：
//  ① **args 原样转发**：渲染器只把 `panel.args` 逐字塞进 /query 的 body，**不解释、不加工**——
//     args 的开放键名（租户自定义过滤参数）安全性全押在服务端 `authorize` 那条链上
//     （unknown_param 拒绝 + 保留键闸 + literal 转义）。渲染器若在这里「帮忙」，
//     等于在授权链之外私开第二口径。夹具的 args 因此**必须非空且带混合类型**——
//     args 是 `{}` 时「转发」与「硬编码 `{}`」不可区分（假绿）。
//  ② **多系列按透视数据集装配**：每个系列一个 `data` 数组、`xAxis.data` 用维度值——
//     把多出来的点塞进一个系列会被连成一条线（spec §5 实测）。
//
// echarts 桩说明：happy-dom 的 `canvas.getContext('2d')` 返回 **null**（实测），真 echarts `init`
// 必抛 ⇒ 组件测试里把 SpecView 用到的 echarts 表面桩掉（形状收严到实际调用的
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
import SpecView, { ECHARTS_REGISTRY } from './SpecView'

const m = vi.mocked(platformFetch)
const mInit = vi.mocked(init)
const mUse = vi.mocked(use)
const calls: { url: string; init?: RequestInit }[] = []
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

/** 一个自绘面板的最小形状（与 domain/report-spec.ts 的白名单字段一致）。 */
interface Panel {
  chart: 'line' | 'bar' | 'table'
  title: string
  metricId: string
  dims: string[]
  args: Record<string, string | number | boolean>
  span: number
}

/**
 * 桩集合：`GET /reports/:id/spec` 回一份规格；`POST /query` 按 metricId 分流——
 * `denied` 集合里的口径回 403 `{status:'denied'}`（照 routes/query.ts 的真实映射），
 * 其余回 `okQueries` 里的结果（缺省一张单列表）。
 */
function stub(spec: { panels: Panel[] }, okQueries: Record<string, { columns: string[]; rows: unknown[][] }>, denied: Set<string>) {
  m.mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (/\/reports\/[^/]+\/spec$/.test(url)) return json({ spec, version: 7 })
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
afterEach(cleanup)

describe('自绘渲染器 SpecView', () => {
  it('★ 打开自绘行 ⇒ 拉规格 + 逐面板查数据（走既有 /query）', async () => {
    // args 非空且混合类型（见文件头①）：字符串 + 布尔——「原样转发」才可被判
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
    //    ⚠️ dims **不进 body**——/query 的 QueryBody 只有 {metricId, args}（dims 是渲染层的
    //    透视轴，不是查询参数）；渲染器替 dims 加工 args 恰是 Task 1 评审要拦的那类「帮忙」。
    const q = calls.find((c) => c.url.endsWith('/query'))!
    expect(JSON.parse(String(q.init?.body))).toEqual({
      metricId: 'lemeng:retail:net_sales',
      args: { system_book: '3120', include_refund: false },
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
    // （init 被 vi.mock 换了实现但类型仍是真 echarts ⇒ 返回值收窄到桩实例用到的表面）
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
    // null 在 echarts 里默认断线（connectNulls 不开），正是「这天没数」的正确语义。
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
    // 闭环的另一半（评审 Minor ③ 原话「一行 `expect(use).toHaveBeenCalledWith([...])` 可闭环」）：
    // 清单必须**真的**被交给 `use()`——只断言常量的话，把调用点改成 `use([LineChart])` 仍照绿，
    // 而真机上 bar 面板会因组件未注册直接空白。两条合起来才叫「注册面有机检」。
    expect(mUse).toHaveBeenCalledWith(ECHARTS_REGISTRY)
    stub({
      panels: [{ chart: 'bar', title: '柱状面板', metricId: 'm1', dims: ['bizday'], args: {}, span: 12 }],
    }, {
      m1: { columns: ['value', 'bizday'], rows: [[80, '2026-09-01']] },
    }, new Set())
    renderView()
    await waitFor(() => expect(mInit).toHaveBeenCalled())
    const chartStub = mInit.mock.results[0].value as unknown as { setOption: ReturnType<typeof vi.fn> }
    const option = chartStub.setOption.mock.calls[0][0] as { series: Array<{ name: string; type: string }> }
    expect(option.series).toEqual([{ name: '', type: 'bar', data: [80] }])
  })
})
