// domain/generator.ts — AI 起草表单契约（#724）。
//
// 纪律：
// - **纯函数**（不 import pool / env / Hono）+ **模型可注入** ⇒ 单测用假模型，不绑真供应商；
// - **AI 只产出 draft，永不发布**：本模块只负责「描述 → 合法契约 body」，落库与发布归 routes/storage；
// - **产出必须过既有 compileGate**（不另开一套校验）→「生成器不绕过发布门」；
// - **repair 只回喂一次**：把校验错误原文连同上一轮产出喂回去。仍不过 ⇒ 报错，**不许静默落一个坏 draft**。
import { compileGate } from './contract'
import type { FormContractBody } from './contract'
import { MATERIALS_MARKDOWN } from './materials'
import type { ChatMessage, ChatModel } from './llm'

export type GenerateResult =
  | { ok: true; assetId: string; body: FormContractBody; repairUsed: boolean; raw: string }
  | {
      ok: false
      code: 'LLM_OUTPUT_UNPARSEABLE' | 'CONTRACT_REJECTED'
      detail: string
      /** 最后一次产出原文——**给排障用**（人能看到模型到底吐了什么），不是错误载荷。 */
      raw: string
    }

export interface ParsedDraft {
  assetId: string
  body: FormContractBody
}

const ASSET_ID_RE = /^[a-z][a-z0-9-]{0,63}$/

/** 剥掉模型爱加的 Markdown 围栏（提示词明令禁止，但实测模型仍会偶尔加）。 */
function stripFences(raw: string): string {
  const t = raw.trim()
  const m = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(t)
  return m ? m[1].trim() : t
}

/** 解析模型产出 → {assetId, body}。形状不对就抛（由 generateDraft 转成机检错误码）。 */
export function parseDraft(raw: string): ParsedDraft {
  const text = stripFences(raw)
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    throw new Error('输出不是合法 JSON')
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('输出必须是 JSON 对象')
  const rec = doc as Record<string, unknown>
  const assetId = rec['assetId']
  if (typeof assetId !== 'string' || !ASSET_ID_RE.test(assetId)) {
    throw new Error(`assetId 缺失或不匹配 ${ASSET_ID_RE}（got ${JSON.stringify(assetId)}）`)
  }
  const schema = rec['schema']
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('缺少 schema 对象')
  const uiSchema = rec['uiSchema']
  if (uiSchema !== undefined && (uiSchema === null || typeof uiSchema !== 'object' || Array.isArray(uiSchema))) {
    throw new Error('uiSchema 必须是对象或省略')
  }
  return {
    assetId,
    body: {
      schema: schema as Record<string, unknown>,
      ...(uiSchema !== undefined ? { uiSchema: uiSchema as Record<string, unknown> } : {}),
    },
  }
}

/** 装配首轮消息（导出以便单测断言提示词里没有漏掉硬约束）。 */
export function buildMessages(description: string): ChatMessage[] {
  return [
    { role: 'system', content: MATERIALS_MARKDOWN },
    { role: 'user', content: `业务场景描述：\n${description}` },
  ]
}

/** repair 轮：把上一轮产出与具体错误**原文**回喂，要求只输出修正后的 JSON。 */
function repairMessages(description: string, lastRaw: string, error: string): ChatMessage[] {
  return [
    ...buildMessages(description),
    { role: 'assistant', content: lastRaw },
    {
      role: 'user',
      content: `上面这份产出没有通过平台校验：\n${error}\n\n请修正后**重新输出完整 JSON**（只输出 JSON，不要解释）。`,
    },
  ]
}

/**
 * 描述 → 合法契约 body。**一次生成 + 最多一次 repair**。
 * 任一轮解析失败或过不了 compileGate，都进 repair；repair 后仍不过 ⇒ 失败返回（调用方 400）。
 */
export async function generateDraft(args: { model: ChatModel; description: string }): Promise<GenerateResult> {
  const { model, description } = args

  const tryParse = async (messages: ChatMessage[]): Promise<{ draft: ParsedDraft; raw: string } | { error: string; raw: string }> => {
    const raw = await model.complete(messages)
    try {
      const draft = parseDraft(raw)
      const gate = compileGate(draft.body)
      if (!gate.ok) return { error: `[${gate.code}] ${gate.detail ?? ''}`, raw }
      return { draft, raw }
    } catch (e) {
      return { error: (e as Error).message, raw }
    }
  }

  const first = await tryParse(buildMessages(description))
  if ('draft' in first) {
    return { ok: true, assetId: first.draft.assetId, body: first.draft.body, repairUsed: false, raw: first.raw }
  }

  const second = await tryParse(repairMessages(description, first.raw, first.error))
  if ('draft' in second) {
    return { ok: true, assetId: second.draft.assetId, body: second.draft.body, repairUsed: true, raw: second.raw }
  }

  // 两轮都不过：按错误性质分类（解析不出 vs 契约被拒），原文一并带上供人排查
  const code = second.error.startsWith('[') ? 'CONTRACT_REJECTED' : 'LLM_OUTPUT_UNPARSEABLE'
  return { ok: false, code, detail: second.error, raw: second.raw }
}
