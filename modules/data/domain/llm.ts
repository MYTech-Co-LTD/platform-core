// domain/llm.ts —— OpenAI 兼容协议的最小客户端。
// · complete()：**不流式**（agent-loop 用；v1 由后端把最终答案整体推给前端）。
// · completeStream()：真流式 SSE（报表 ai_text 用；逐字增量 + reasoning_content 单独通道）。
// 供应商侧换谁都能接（data-analysis 先例：wishub / DeepSeek 协议兼容）。
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** `role:'tool'` 必填：对应 ToolCall.id。缺了模型无法把结果对上是哪次调用。 */
  toolCallId?: string
  /** `role:'assistant'` 且本轮含工具调用时填：原样回放，下一轮才连得上。 */
  toolCalls?: ToolCall[]
}
export interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ChatTurn { content: string; toolCalls: ToolCall[] }
export interface ChatModel { complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatTurn> }
/** 流式增量：`reasoning`（思考过程，**不外泄展示**）与 `content`（正文）分开给。 */
export interface StreamDelta { content?: string; reasoning?: string }
export interface StreamOpts { temperature?: number; maxTokens?: number; signal?: AbortSignal }
/** 在 `ChatModel` 之上追加流式方法；`complete` 语义与行为与 v1 完全一致。 */
export interface StreamingChatModel extends ChatModel {
  completeStream(messages: ChatMessage[], tools: ToolSpec[], opts?: StreamOpts): AsyncGenerator<StreamDelta>
}
export interface LlmConfig { baseUrl: string; apiKey: string; model: string }

/** 只带**可安全外泄**的理由。失败详情不回显响应体（供应商侧常把请求原文回显，可能含凭证）。 */
export class LlmError extends Error {}

export function llmFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  const baseUrl = env.DATA_LLM_BASE_URL?.trim()
  const apiKey = env.DATA_LLM_API_KEY?.trim()
  const model = env.DATA_LLM_MODEL?.trim()
  // 三个键**全在**才算配好。任一缺 ⇒ null（部署没开通道 A，应回可解释的 503，不是 500）
  if (!baseUrl || !apiKey || !model) return null
  return { baseUrl, apiKey, model }
}

interface OpenAiToolCall { id?: string; function?: { name?: string; arguments?: string } }
interface OpenAiChatResponse { choices?: { message?: { content?: unknown; tool_calls?: OpenAiToolCall[] } }[] }
/** 流式块：DeepSeek 先逐块推 `reasoning_content`（思考），再推 `content`（正文）。 */
interface OpenAiStreamChunk {
  choices?: { delta?: { content?: unknown; reasoning_content?: unknown } }[]
}

export function openAiCompatModel(cfg: LlmConfig): StreamingChatModel {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(messages, tools) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // apiKey 只在请求头；**绝不**进 messages / 审计 / 日志 / SSE 事件
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages.map(toWireMessage),
          tools: tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          tool_choice: 'auto',
        }),
      })
      if (!res.ok) throw new LlmError(`LLM_HTTP_${res.status}`)
      const body = (await res.json()) as OpenAiChatResponse
      const msg = body.choices?.[0]?.message
      if (!msg) throw new LlmError('LLM_EMPTY_CHOICE')
      return {
        content: typeof msg.content === 'string' ? msg.content : '',
        toolCalls: (msg.tool_calls ?? [])
          .map((tc) => ({
            id: tc.id ?? '',
            name: tc.function?.name ?? '',
            arguments: parseArguments(tc.function?.arguments),
          }))
          .filter((tc) => tc.name !== '' && tc.id !== ''),
      }
    },
    // 参数名 `_tools`：v1 明确不发工具（见下方 tools: []），下划线避开 noUnusedParameters。
    async *completeStream(messages, _tools, opts) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: messages.map(toWireMessage),
          // v1 不解析流式 tool_calls：调用方传了工具也只能拿到正文 ⇒ 显式清空，
          // 不把「看起来支持工具」的请求发上去（否则模型吐 tool_calls 增量会被丢掉）。
          tools: [],
          stream: true,
          ...(opts?.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(opts?.maxTokens !== undefined ? { max_tokens: opts.maxTokens } : {}),
        }),
        signal: opts?.signal,
      })
      if (!res.ok) throw new LlmError(`LLM_HTTP_${res.status}`)
      // 供应商忽略 stream:true 时会回普通 JSON（整段答案），此处无法增量 ⇒ 明确失败，
      // 让上层回退模板，而不是把整段当一次 delta 静默输出（UX 上就没有「流」了）。
      if (!res.body || !(res.headers.get('content-type') ?? '').includes('text/event-stream')) {
        throw new LlmError('LLM_NOT_STREAMING')
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const raw of lines) {
            const line = raw.trim()
            if (!line.startsWith('data:')) continue
            const data = line.slice(5).trim()
            if (data === '[DONE]') return
            let json: OpenAiStreamChunk
            try { json = JSON.parse(data) as OpenAiStreamChunk } catch { continue }
            const delta = json.choices?.[0]?.delta
            if (typeof delta?.reasoning_content === 'string' && delta.reasoning_content !== '') {
              yield { reasoning: delta.reasoning_content }
            }
            if (typeof delta?.content === 'string' && delta.content !== '') {
              yield { content: delta.content }
            }
          }
        }
      } finally {
        // 正常读完也要 cancel：提前 return（[DONE] / 上层 abort）时不 cancel 会漏掉底层连接。
        await reader.cancel().catch(() => {})
      }
    },
  }
}

function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    }
  }
  return { role: m.role, content: m.content }
}

/** 供应商把 arguments 当**字符串**回（OpenAI 协议如此）。解析失败给空对象——让授权核心去拒，不在这里抛。 */
function parseArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
