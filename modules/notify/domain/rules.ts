// rules.ts — 规则匹配与解析器校验（纯函数）。
// 【纪律】不 import pool / env / Hono（照 modules/data/domain/authz.ts）：可被任何层安全调用、可穷举单测。
//
// 挂载点语义（正典 docs/architecture.md §2.6）：mount = case_type_id | form_def_id | '*'。
// 「挂载点种类」由 event_type 前缀判定——case.* / sla.* ⇒ case 挂载（SLA 是 case 的属性）；
// form.* ⇒ form 挂载。规则「form 挂载无 assignee 语义」（fail-closed）由此落。

export type RecipientKind = 'assignee' | 'submitter' | 'user_list' | 'field'
export type RuleOrigin = 'derived' | 'manual'
export type Channel = 'wechat_work' | 'in_app'

export type NotificationRule = {
  id: string
  org: string
  enabled: boolean
  eventType: string
  mount: string // case_type_id | form_def_id | '*'
  templateId: string // Novu workflow identifier
  recipient: RecipientKind
  recipientArg?: string | null
  channels: Channel[]
  cooldownMinutes?: number | null
  origin: RuleOrigin
  createdAt: string // ISO；同优先级稳定序用
}

export type MountKind = 'case' | 'form'

/** 事件类型 → 挂载点种类。未登记的前缀返回 null（validateRule 据此 fail-closed 拒）。 */
export function mountKindOf(eventType: string): MountKind | null {
  if (eventType.startsWith('case.') || eventType.startsWith('sla.')) return 'case'
  if (eventType.startsWith('form.')) return 'form'
  return null
}

export type RuleInput = {
  eventType: string
  mount: string
  recipient: RecipientKind
  recipientArg?: string | null
}

/**
 * 形状校验（fail-closed，纯函数，返回机检错误码或 null）。
 * 跨租户引用（user_list/field 只能解析到本 org 用户）属**解析期**检查——需要 DB，不在此层。
 */
export function validateRule(input: RuleInput): { code: string } | null {
  const kind = mountKindOf(input.eventType)
  if (kind === null) return { code: 'RULE_EVENT_TYPE_UNKNOWN' }
  if (kind === 'form' && input.recipient === 'assignee') return { code: 'RULE_RECIPIENT_MOUNT_MISMATCH' }
  if ((input.recipient === 'user_list' || input.recipient === 'field') && !input.recipientArg) {
    return { code: 'RULE_RECIPIENT_ARG_REQUIRED' }
  }
  return null
}

/**
 * 匹配：enabled ∧ eventType 相等 ∧（mount 精确 或 `'*'`）。
 * 优先级：① **有精确 mount 命中时不回通配**（通配只是兜底，§2.6「`'*'` 兜底」）；
 *         ② 命中集里若有 `manual`，则 `derived` 全部让位（覆盖语义，§2.6 取舍②）；
 *         ③ 同优先级按 createdAt 稳定序。
 */
export function matchRules(
  rules: NotificationRule[],
  event: { eventType: string; mount: string },
): NotificationRule[] {
  const candidates = rules.filter((r) => r.enabled && r.eventType === event.eventType)
  const exact = candidates.filter((r) => r.mount === event.mount)
  const pool = exact.length > 0 ? exact : candidates.filter((r) => r.mount === '*')
  const manual = pool.filter((r) => r.origin === 'manual')
  const chosen = manual.length > 0 ? manual : pool
  return [...chosen].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
