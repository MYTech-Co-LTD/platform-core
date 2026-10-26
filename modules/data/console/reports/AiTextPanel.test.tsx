// AiTextPanel.test.tsx — `ai_text` 流式面板（计划 2026-10-26 Task 9）。
//
// 判据（与实现一一对应）：
//  ① **事件序**：phase（人话 label，首正文 ~3.2s 不能空白）→ delta 追加 → done 终稿；
//  ② **replace = 整段替换**（不是追加）：数字校验越界/模型失败后旧 delta 作废；
//  ③ **回退与缓存如实上屏**：fallback ⇒「模板摘要（AI 暂不可用）」；cached ⇒「· 已缓存」；
//  ④ **防抖 + 中止**：500ms 窗口内连切期间/门店只发最后一次；卸载清定时器（不发请求）；
//  ⑤ **光标只在流式期间**：未 done 且已有正文时显示 `▍`，done 后消失；
//  ⑥ **流内错误**：`error` 事件 ⇒ 人话告警（状态码细节不上屏）。
//
// mock 点 = `../lib/api` 的 `streamPost`（前缀/失败体翻译在 api.test.ts 判，本文件只判面板行为）。
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../lib/api', () => ({ streamPost: vi.fn() }))
import { streamPost } from '../lib/api'
import type { PeriodSpec } from '../../domain/report-spec'
import AiTextPanel from './AiTextPanel'

const m = vi.mocked(streamPost)

const PERIOD: PeriodSpec = { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }
const NEXT_PERIOD: PeriodSpec = { mode: 'last_7_days' }

const ev = {
  phase: (phase: 'facts' | 'thinking' | 'writing', label: string) =>
    `data: ${JSON.stringify({ type: 'phase', phase, label })}\n\n`,
  delta: (text: string) => `data: ${JSON.stringify({ type: 'delta', text })}\n\n`,
  replace: (text: string, reason = 'number_check') =>
    `data: ${JSON.stringify({ type: 'replace', text, reason })}\n\n`,
  done: (text: string, extra: Record<string, unknown> = {}) =>
    `data: ${JSON.stringify({
      type: 'done', text, fallback: false, dataAsOf: '2026-10-25', generatedAt: 'x', cached: false, ...extra,
    })}\n\n`,
  error: (reason: string) => `data: ${JSON.stringify({ type: 'error', reason })}\n\n`,
}

/** 一次性 SSE：事件块按序入队后关流（跨块半截事件的拼接由 TextDecoder+缓冲处理）。 */
function sseResponse(chunks: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder()
      for (const chunk of chunks) c.enqueue(enc.encode(chunk))
      c.close()
    },
  })
  // 面板只用到 `ok` 与 `body`（读事件流）；不必是真 Response（happy-dom 的 Response 对流体的支持不稳）。
  return { ok: true, body } as unknown as Response
}

/** 可控 SSE：测试里按需 push，用来观察流式中间态（光标）。 */
function liveStream() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c } })
  const enc = new TextEncoder()
  return {
    res: { ok: true, body } as unknown as Response,
    push: async (chunk: string) => { await act(async () => { ctrl.enqueue(enc.encode(chunk)) }) },
    close: async () => { await act(async () => { ctrl.close() }) },
  }
}

const renderPanel = (overrides: Partial<Parameters<typeof AiTextPanel>[0]> = {}) =>
  render(
    <AiTextPanel
      reportId="r1"
      panelIndex={8}
      focus="overview"
      period={PERIOD}
      branchNum="92"
      {...overrides}
    />,
  )

beforeEach(() => { m.mockReset() })
afterEach(cleanup)

describe('AiTextPanel', () => {
  it('★ phase → delta → done：正文逐段出现，终稿带数据截止；请求体含面板/期间/门店', async () => {
    // 真实 SSE 是逐块到达的（首正文 ~3.2s）：用可控流观察中间态，而不是「一次性灌完再断言
    // 转瞬即逝的 phase 标签」（那样测试只能看到终态，反而漏掉「空白等待」这条验收）。
    const live = liveStream()
    m.mockResolvedValue(live.res)
    renderPanel()

    // 首正文前的阶段标签必须可见（不能空白等 3.2s）
    await live.push(ev.phase('facts', '正在核对指标…'))
    await live.push(ev.phase('thinking', '正在分析…'))
    await waitFor(() => expect(screen.getByText('正在分析…')).toBeInTheDocument())

    // delta 追加 + 流式光标（未 done 且已有正文 ⇒ ▍）
    await live.push(ev.delta('结论：'))
    await live.push(ev.delta('好'))
    await waitFor(() => expect(screen.getByTestId('ai-text').textContent).toContain('结论：好▍'))

    await live.push(ev.done('结论：好'))
    await live.close()
    await waitFor(() => expect(screen.getByText('结论：好')).toBeInTheDocument())
    // done 后标签换成「AI 分析」、光标消失；页脚如实给数据截止（cached=false 不写「已缓存」）
    expect(screen.getByText('AI 分析')).toBeInTheDocument()
    expect(screen.getByTestId('ai-text').textContent).not.toContain('▍')
    expect(screen.getByText(/数据截至 2026-10-25/)).toBeInTheDocument()
    expect(screen.queryByText(/已缓存/)).not.toBeInTheDocument()

    expect(m).toHaveBeenCalledOnce()
    expect(m.mock.calls[0]![0]).toBe('/reports/r1/narrative/stream')
    expect(m.mock.calls[0]![1]).toEqual({ panelIndex: 8, period: PERIOD, branchNum: '92' })
  })

  it('★ replace 整段替换（旧 delta 作废）+ fallback/cached 标签', async () => {
    m.mockResolvedValue(sseResponse([
      ev.phase('writing', '正在撰写…'),
      ev.delta('编造的结论 999'),
      ev.replace('模板：本月销售额 51273.89'),
      ev.done('模板：本月销售额 51273.89', { fallback: true, dataAsOf: null, cached: true }),
    ]))
    renderPanel()

    expect(await screen.findByText('模板：本月销售额 51273.89', undefined, { timeout: 3000 })).toBeInTheDocument()
    // 旧 delta 不能再出现（追加式实现的典型错法会留下「编造的结论 999」）
    expect(screen.queryByText(/999/)).not.toBeInTheDocument()
    expect(screen.getByText('模板摘要（AI 暂不可用）')).toBeInTheDocument()
    expect(screen.getByText('数据截至 新鲜度未知 · 已缓存')).toBeInTheDocument()
  })

  it('★ 500ms 防抖 + 中止：窗口内连切期间只发最后一次请求', async () => {
    m.mockResolvedValue(sseResponse([ev.done('好')]))
    const { rerender } = renderPanel()
    // 防抖窗口内切期间：第一发被 clearTimeout 掉，只剩最后一次
    rerender(
      <AiTextPanel reportId="r1" panelIndex={8} focus="overview" period={NEXT_PERIOD} branchNum="92" />,
    )

    await waitFor(() => expect(m).toHaveBeenCalledOnce(), { timeout: 3000 })
    // 等首个请求跑完再复查：被清掉的那发不会再补发（总计仍 1 次）
    await screen.findByText('好', undefined, { timeout: 3000 })
    expect(m).toHaveBeenCalledOnce()
    expect((m.mock.calls[0]![1] as { period: PeriodSpec }).period).toEqual(NEXT_PERIOD)
  })

  it('★ 卸载清定时器：防抖窗口内离开页面不发请求（中止而非记错）', async () => {
    m.mockResolvedValue(sseResponse([ev.done('好')]))
    const { unmount } = renderPanel()
    unmount()
    await new Promise((r) => setTimeout(r, 700))
    expect(m).not.toHaveBeenCalled()
  })

  it('★ 流内 error 事件 ⇒ 人话告警（原文 reason 不上屏）', async () => {
    m.mockResolvedValue(sseResponse([ev.phase('thinking', '正在分析…'), ev.error('NARRATIVE_FAILED')]))
    renderPanel()
    expect(await screen.findByText('AI 分析暂不可用', undefined, { timeout: 3000 })).toBeInTheDocument()
    expect(screen.queryByText(/NARRATIVE_FAILED/)).not.toBeInTheDocument()
  })

  it('期间缺席 ⇒ 不发请求，直接提示（写侧 AI_TEXT_REQUIRES_PERIOD 的兜底）', async () => {
    renderPanel({ period: null })
    expect(await screen.findByText('报表未声明期间')).toBeInTheDocument()
    expect(m).not.toHaveBeenCalled()
  })

  it('版本钉住时透传 version；无版本时 body 不带该键', async () => {
    m.mockResolvedValue(sseResponse([ev.done('好')]))
    renderPanel({ version: 3 })
    await screen.findByText('好', undefined, { timeout: 3000 })
    expect(m.mock.calls[0]![1]).toEqual({ panelIndex: 8, period: PERIOD, branchNum: '92', version: 3 })
  })
})
