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
  /**
   * kind=dept 的人工规则才用：所选部门 `ext_id`（**发送时**展开，含子树）。
   * `null` = 不是部门规则；空数组 = 选了但一个都没选 ⇒ 视为配置不完整（见 validateRule）。
   */
  recipientDepts: string[] | null
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
    | 'origin'> & { cooldownMinutes?: number | null; recipientDepts?: string[] | null },
  decl: NotificationEventDecl,
  enabledChannels: Set<string>,
  publishedTemplates: Set<string>,
): string | null {
  if (rule.eventKey !== decl.key) return 'RULE_EVENT_MISMATCH'

  const recipient = decl.recipients[rule.recipientKey]
  if (!recipient) return 'RULE_RECIPIENT_UNKNOWN'

  // ── 部门收件人（spec 2026-10-30 §3.5；#1174）────────────────────────────────
  // fail-closed 三面：① 只有事件**声明了 dept 档**才允许按部门发（声明即授权——按部门群发
  // 的爆炸半径远大于点名，不能让消费方自选）；② 选了就必须**至少一个部门**（空选择 = 配了一半，
  // 上线后恒 `no_recipient`，不如当场拒）；③ 非 dept 档**不许**带部门选择（与 recipientLiteral
  // 同款的「拒绝优于静默丢弃」：静默会让调用方以为配了部门）。
  const depts = rule.recipientDepts ?? null
  if (recipient.kind === 'dept') {
    if (rule.origin !== 'manual') return 'RULE_DEPTS_MANUAL_ONLY'
    if (depts === null || depts.length === 0) return 'RULE_DEPTS_REQUIRED'
    if (rule.recipientLiteral !== null) return 'RULE_DEPTS_NOT_ALLOWED'
  } else if (depts !== null && depts.length > 0) {
    return 'RULE_DEPTS_NOT_ALLOWED'
  }

  // 字面名单只在 literal 档 + 人工规则下合法（dept 档带名单在上面的 dept 分支已拒）
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
