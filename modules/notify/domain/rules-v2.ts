// rules-v2.ts — 规则匹配与校验（纯函数；2026-10-27 通知基础设施 §4）。
// 与旧 domain/rules.ts 并存到 Task 15（expand/contract）；新代码只 import 本文件。
// 【纪律】不 import pool / env / Hono：可穷举单测、可被 worker/宿主安全复用。
import type { NotificationEventDecl } from '@platform/sdk'

export type RuleOrigin = 'derived' | 'manual'

export interface NotificationRule {
  org: string
  id: string
  enabled: boolean
  eventKey: string
  /** 实例值或 '*' */
  scope: string
  recipientKey: string
  /** kind=literal 的人工规则才用 */
  recipientLiteral: string[] | null
  templateKey: string
  channels: string[]
  cooldownMinutes: number | null
  origin: RuleOrigin
  createdAt: string
}

/**
 * 匹配：enabled ∧ eventKey 相等 ∧（精确 scope 或 '*'）。
 * 优先级：① 精确 scope 命中时不回退 '*'
 *         ② 命中集里若有 manual，derived 全部让位
 *         ③ 同优先级按 createdAt 稳定序
 */
export function matchRules(
  rules: NotificationRule[],
  event: { eventKey: string; scope: string },
): NotificationRule[] {
  const candidates = rules.filter((r) => r.enabled && r.eventKey === event.eventKey)
  const exact = candidates.filter((r) => r.scope === event.scope)
  const pool = exact.length > 0 ? exact : candidates.filter((r) => r.scope === '*')
  const manual = pool.filter((r) => r.origin === 'manual')
  const chosen = manual.length > 0 ? manual : pool
  return [...chosen].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/**
 * 形状/引用校验（fail-closed，返回机检错误码或 null）。
 * 跨租户引用属解析期检查（需要 DB），不在本层。
 */
export function validateRule(
  rule: Pick<NotificationRule,
    'eventKey' | 'scope' | 'recipientKey' | 'recipientLiteral' | 'templateKey' | 'channels'
    | 'origin'> & { cooldownMinutes?: number | null },
  decl: NotificationEventDecl,
  enabledChannels: Set<string>,
  publishedTemplates: Set<string>,
): string | null {
  if (rule.eventKey !== decl.key) return 'RULE_EVENT_MISMATCH'

  const recipient = decl.recipients[rule.recipientKey]
  if (!recipient) return 'RULE_RECIPIENT_UNKNOWN'

  if (rule.recipientLiteral !== null) {
    if (rule.origin !== 'manual' || recipient.kind !== 'literal') {
      return 'RULE_LITERAL_MANUAL_ONLY'
    }
  }

  if (rule.scope !== '*' && !decl.scope) return 'RULE_SCOPE_UNKNOWN'
  if (rule.channels.length === 0) return 'RULE_CHANNELS_REQUIRED'
  if (rule.channels.some((c) => !enabledChannels.has(c))) return 'RULE_CHANNEL_UNKNOWN'
  if (!publishedTemplates.has(rule.templateKey)) return 'RULE_TEMPLATE_UNKNOWN'
  const cooldown = rule.cooldownMinutes ?? null
  if (cooldown !== null && cooldown < 0) return 'RULE_COOLDOWN_INVALID'

  return null
}
