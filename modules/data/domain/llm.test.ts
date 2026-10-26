// llm.test.ts — OpenAI 兼容客户端的单元测试（TDD 第一步：先落盘、先红）。
//
// 全部用本地 ReadableStream 桩 fetch，**不连外网**。覆盖：
//  · `complete`（既有非流式）行为不因新增流式方法而变；
//  · `completeStream` 解析 reasoning_content / content 两种 delta，`[DONE]` 结束；
//  · SSE 行被读取边界切断时仍能正确拼接（缓冲区按 `\n` 结算）；
//  · 非 SSE 响应给 `LLM_NOT_STREAMING`、HTTP 非 2xx 给 `LLM_HTTP_<status>`；
//  · opts 的 temperature / maxTokens / signal 落到请求体与 init 上。
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAiCompatModel, LlmError } from './llm'

const sse = (chunks: string[]): Response => {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk))
      c.close()
    },
  })
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const cfg = { baseUrl: 'http://x/', apiKey: 'k', model: 'm' }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('completeStream', () => {
  it('解析 reasoning 与 content 两种 delta，遇 [DONE] 结束', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sse([
        'data: {"choices":[{"delta":{"reasoning_content":"思考"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"结论"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    ))
    const out: Array<{ content?: string; reasoning?: string }> = []
    for await (const d of openAiCompatModel(cfg).completeStream([{ role: 'user', content: 'x' }], [], { maxTokens: 10 })) out.push(d)
    expect(out).toEqual([{ reasoning: '思考' }, { content: '结论' }])
  })

  it('SSE 行被读取边界切断仍能拼出事件；[DONE] 之后的增量不再产出', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sse([
        'data: {"choices":[{"delta":{"cont',
        'ent":"前半"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"后半"}}]}\n\n',
        'data: [DONE]\n\ndata: {"choices":[{"delta":{"content":"不该出现"}}]}\n\n',
      ]),
    ))
    const out: string[] = []
    for await (const d of openAiCompatModel(cfg).completeStream([{ role: 'user', content: 'x' }], [])) {
      if (d.content !== undefined) out.push(d.content)
    }
    expect(out).toEqual(['前半', '后半'])
  })

  it('非 SSE（application/json）⇒ LLM_NOT_STREAMING', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })))
    const model = openAiCompatModel(cfg)
    await expect((async () => {
      for await (const _ of model.completeStream([{ role: 'user', content: 'x' }], [])) void _
    })()).rejects.toThrow('LLM_NOT_STREAMING')
  })

  it('HTTP 非 2xx ⇒ LLM_HTTP_<status>', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('upstream boom', { status: 502 })))
    const model = openAiCompatModel(cfg)
    await expect((async () => {
      for await (const _ of model.completeStream([{ role: 'user', content: 'x' }], [])) void _
    })()).rejects.toThrow('LLM_HTTP_502')
    await expect((async () => {
      for await (const _ of model.completeStream([{ role: 'user', content: 'x' }], [])) void _
    })()).rejects.toBeInstanceOf(LlmError)
  })

  it('opts 落到请求体与 init：stream/temperature/max_tokens/signal', async () => {
    const fetchMock = vi.fn(async () => sse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    const ac = new AbortController()
    for await (const _ of openAiCompatModel(cfg).completeStream(
      [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
      [],
      { temperature: 0.2, maxTokens: 1500, signal: ac.signal },
    )) void _
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://x/chat/completions')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      model: 'm',
      stream: true,
      temperature: 0.2,
      max_tokens: 1500,
      messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }],
    })
    expect(init.signal).toBe(ac.signal)
  })

  it('opts 缺省时不带 temperature / max_tokens', async () => {
    const fetchMock = vi.fn(async () => sse(['data: [DONE]\n\n']))
    vi.stubGlobal('fetch', fetchMock)
    for await (const _ of openAiCompatModel(cfg).completeStream([{ role: 'user', content: 'x' }], [])) void _
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body)) as Record<string, unknown>
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_tokens')
  })
})

describe('complete（既有非流式，本 Task 不改行为）', () => {
  it('解析 content 与 tool_calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{
          message: {
            content: '答案',
            tool_calls: [{ id: 'c1', function: { name: 'f', arguments: '{"a":1}' } }],
          },
        }],
      }), { status: 200, headers: { 'content-type': 'application/json' } }),
    ))
    const turn = await openAiCompatModel(cfg).complete([{ role: 'user', content: 'x' }], [])
    expect(turn).toEqual({ content: '答案', toolCalls: [{ id: 'c1', name: 'f', arguments: { a: 1 } }] })
  })
})
