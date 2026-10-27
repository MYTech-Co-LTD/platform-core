// recipients.ts — 收件人解析（纯函数部分）。
// kind=field / literal 在这里解析；kind=scope_holders 需要 Casdoor/DB，由 worker 注入的解析器处理。
import type { NotificationEventDecl } from '@platform/sdk'

export function resolveRecipientNames(
  rule: Pick<{ recipientKey: string; recipientLiteral: string[] | null },
    'recipientKey' | 'recipientLiteral'>,
  decl: NotificationEventDecl,
  payload: Record<string, unknown>,
): string[] {
  const r = decl.recipients[rule.recipientKey]
  if (!r) return []

  if (r.kind === 'literal') return rule.recipientLiteral ?? []

  if (r.kind === 'field' && r.field) {
    const v = payload[r.field]
    if (typeof v === 'string' && v) return [v]
    if (Array.isArray(v)) {
      return v.filter((x): x is string => typeof x === 'string' && x.length > 0)
    }
  }

  return [] // scope_holders：交给 worker 注入的解析器
}
