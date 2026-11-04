// AskView — 移动端问数 tab：空态示例、SSE 气泡（用户/过程/结论/表格）、错误呈现。
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AskView from './AskView'

const origFetch = globalThis.fetch
afterEach(cleanup)
afterEach(() => { globalThis.fetch = origFetch })

const SSE = [
  'data: {"type":"activity","tool":"list_metrics","detail":"查看可用指标"}',
  'data: {"type":"final","text":"上月合计 1,234 元","table":{"columns":["门店","销售额"],"rows":[["A 店",1000],["B 店",234]]}}',
  '',
].join('\n')

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url.includes('/chat') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as { question: string }
      expect(body.question).toBeTruthy()
      return new Response(SSE, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    throw new Error(`no mock for ${init?.method ?? 'GET'} ${url}`)
  }) as unknown as typeof fetch
})

describe('移动端问数（报表中心三 tab 之一）', () => {
  it('空态给可点的示例问题；点击 ⇒ POST /chat 带 question，渲染用户/过程/结论气泡与表格', async () => {
    render(<AskView />)
    expect(screen.getByText('可以这样问：')).toBeTruthy()

    fireEvent.click(screen.getByText('上个月各门店销售额是多少'))

    await waitFor(() => expect(screen.getByText('上月合计 1,234 元')).toBeTruthy())
    expect(screen.getByText(/list_metrics：查看可用指标/)).toBeTruthy()
    expect(screen.getByText('A 店')).toBeTruthy()
    expect(screen.getByText('234')).toBeTruthy()
    // 用户气泡
    expect(screen.getByText('上个月各门店销售额是多少')).toBeTruthy()
  })

  it('error 事件 ⇒ 红色错误气泡（不中断后续渲染）', async () => {
    globalThis.fetch = (async () => new Response(
      'data: {"type":"error","reason":"NO_SUCH_METRIC","detail":"m1"}\n',
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch

    render(<AskView />)
    fireEvent.click(screen.getByText('本月会员复购率'))
    await waitFor(() => expect(screen.getByText('m1')).toBeTruthy())
  })

  it('HTTP 失败 ⇒ 显示错误码气泡', async () => {
    globalThis.fetch = (async () => json({ error: 'RATE_LIMITED' }, 429)) as unknown as typeof fetch

    render(<AskView />)
    fireEvent.click(screen.getByText('近 7 天销量最高的 10 个商品'))
    await waitFor(() => expect(screen.getByText('RATE_LIMITED')).toBeTruthy())
  })
})
