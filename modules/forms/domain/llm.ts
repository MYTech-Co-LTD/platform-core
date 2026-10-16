// domain/llm.ts — OpenAI 兼容协议的最小客户端（#724）。
// 形状照 modules/data/domain/llm.ts 抄（§12.13：不跨模块 import，抄形状不抄代码）。
// 差异：forms 的生成只要**纯文本回**（不涉及工具调用），故 complete() 返回 string 而非 ChatTurn。
//
// 配置键（人已裁定，2026-10-16）：`FORMS_LLM_*` **优先**，缺省**回落 `DATA_LLM_*`**——
// 两实例（mytech/山海）已有 DATA_LLM_* 三键 ⇒ 零部署变更即可用；将来要独立模型或配额，
// 只需补 FORMS_LLM_* 三个键，**不改代码**。
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}
export interface LlmConfig {
  baseUrl: string
  apiKey: string
  model: string
  /** 配置从哪来——503 文案与排障要用（`FORMS_LLM_*` 还是回落来的 `DATA_LLM_*`）。 */
  source: 'FORMS_LLM' | 'DATA_LLM'
}
export interface ChatModel {
  complete(messages: ChatMessage[]): Promise<string>
}

/** 只带**可安全外泄**的理由。失败详情不回显响应体（供应商侧常把请求原文回显，可能含凭证）。 */
export class LlmError extends Error {}

function pick(env: Record<string, string | undefined>, prefix: string): LlmConfig | null {
  const baseUrl = env[`${prefix}_BASE_URL`]?.trim()
  const apiKey = env[`${prefix}_API_KEY`]?.trim()
  const model = env[`${prefix}_MODEL`]?.trim()
  // 三个键**全在**才算配好。任一缺 ⇒ 不算（不半配：半配的端点行为不可预测）
  if (!baseUrl || !apiKey || !model) return null
  return { baseUrl, apiKey, model, source: prefix === 'FORMS_LLM' ? 'FORMS_LLM' : 'DATA_LLM' }
}

/** `FORMS_LLM_*` 优先，缺则回落 `DATA_LLM_*`；都没有 ⇒ null（调用方回可解释的 503，不是 500）。 */
export function llmFromEnv(env: Record<string, string | undefined> = process.env): LlmConfig | null {
  return pick(env, 'FORMS_LLM') ?? pick(env, 'DATA_LLM')
}

interface OpenAiChatResponse {
  choices?: { message?: { content?: unknown } }[]
}

export function openAiCompatModel(cfg: LlmConfig): ChatModel {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`
  return {
    async complete(messages) {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // apiKey 只在请求头；**绝不**进 messages / 审计 / 日志
          authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify({ model: cfg.model, messages }),
      })
      if (!res.ok) throw new LlmError(`LLM_HTTP_${res.status}`)
      const body = (await res.json()) as OpenAiChatResponse
      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new LlmError('LLM_EMPTY_CHOICE')
      return content
    },
  }
}
