// render.ts — 模板渲染（预览与投递共用同一实现；2026-10-27 通知基础设施 §5.2）。
// 变量摊平（payload 字段名）；strict 模式 ⇒ 未知变量是错误，不静默渲染空白。
import Handlebars from 'handlebars'

export type Rendered = Record<string, Record<string, string>>
export type Contents = Record<string, Record<string, string>>

/** 企微 markdown 上限约 4096 字节，留余量按 3800 校验 */
const MAX_BYTES: Record<string, number> = { wecom_chat: 3800 }

export function renderContents(
  contents: Contents,
  payload: Record<string, unknown>,
  channels: string[],
): { ok: true; rendered: Rendered } | { ok: false; issues: string[] } {
  const rendered: Rendered = {}
  const issues: string[] = []

  for (const ch of channels) {
    const src = contents[ch]
    if (!src) {
      issues.push(`missing_channel:${ch}`)
      continue
    }
    rendered[ch] = {}
    for (const [field, tpl] of Object.entries(src)) {
      if (typeof tpl !== 'string') {
        issues.push(`not_string:${ch}.${field}`)
        continue
      }
      try {
        const text = Handlebars.compile(tpl, { strict: true, noEscape: true })(payload)
        const max = MAX_BYTES[ch]
        if (max !== undefined && Buffer.byteLength(text) > max) {
          issues.push(`too_long:${ch}.${field}`)
          continue
        }
        rendered[ch][field] = text
      } catch (e) {
        issues.push(`render:${ch}.${field}:${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  return issues.length > 0 ? { ok: false, issues } : { ok: true, rendered }
}
