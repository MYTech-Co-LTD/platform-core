// deliverability.ts — 收件人/通道可送达性解析（**唯一实现**；D3/D4 的 HTTP 与 MCP 共用）。
// 纯编排：所有 IO 经 deps 注入，模块内不建连接、不读 env。
//
// 为什么要有这一层：worker 里原先是三段内联（tpl → names/holders → channelRows），
// 零结果一律 `continue` ⇒ 静默。抽成函数后，「谁能收到 / 为什么收不到」可被
// worker、HTTP、MCP、体检 job 用**同一份逻辑**回答，不出现两套口径漂移。
import type { NotificationEventDecl } from '@platform/sdk'
import type { NotificationRule } from './rules'
import { resolveRecipientNames } from './recipients'

/** 规则当前发不出去的原因（null = 可送达） */
export type Blocked = 'no_recipient' | 'no_channel' | 'template_missing'

export type ResolvedRecipient = {
  name: string
  source: 'field' | 'literal' | 'scope_holders'
}

export type DeliverabilityDeps = {
  getEventDecl(key: string): Promise<NotificationEventDecl | null>
  getPublishedTemplate(
    org: string,
    key: string,
  ): Promise<{ revision: number; contents: unknown } | null>
  getChannel(
    org: string,
    id: string,
  ): Promise<{
    id: string
    provider: string
    enabled: boolean
    /** 非敏感配置（address_fallback 等）；worker 的地址回退判定要用 */
    config?: Record<string, unknown>
  } | null>
  resolveScopeHolders(
    org: string,
    key: string,
    decl: NotificationEventDecl,
  ): Promise<string[]>
}

export type Deliverability = {
  blocked: Blocked | null
  recipients: ResolvedRecipient[]
  channels: Array<{
    id: string
    provider: string
    enabled: boolean
    config?: Record<string, unknown>
  }>
  usableChannels: string[]
  /** 已发布模板（blocked=template_missing 时缺省）；worker 复用它渲染，避免二次读库 */
  tpl?: { revision: number; contents: unknown }
}

/**
 * 阻塞原因的优先级：**模板 > 收件人 > 通道**。
 * 为什么模板最先：模板缺失时连渲染都做不了，报「没人」会把排查方向带偏。
 */
export async function resolveDeliverability(
  input: { org: string; rule: NotificationRule; payload: Record<string, unknown> },
  deps: DeliverabilityDeps,
): Promise<Deliverability> {
  const { org, rule, payload } = input

  const tpl = await deps.getPublishedTemplate(org, rule.templateKey)
  if (!tpl) {
    return { blocked: 'template_missing', recipients: [], channels: [], usableChannels: [] }
  }
  const tplOut = { revision: tpl.revision, contents: tpl.contents }

  const decl = await deps.getEventDecl(rule.eventKey)
  const recipients: ResolvedRecipient[] = []
  const seen = new Set<string>()

  if (decl) {
    for (const name of resolveRecipientNames(rule, decl, payload)) {
      if (seen.has(name)) continue
      seen.add(name)
      recipients.push({ name, source: recipientSource(rule, decl) })
    }
    // literal 规则的人员已在 rule.recipientLiteral 里；不再问 scope_holders
    if (!rule.recipientLiteral) {
      for (const name of await deps.resolveScopeHolders(org, rule.recipientKey, decl)) {
        if (seen.has(name)) continue
        seen.add(name)
        recipients.push({ name, source: 'scope_holders' })
      }
    }
  }

  const channels: Deliverability['channels'] = []
  for (const id of rule.channels) {
    const ch = await deps.getChannel(org, id)
    channels.push({
      id,
      provider: ch?.provider ?? 'unknown',
      enabled: ch?.enabled === true,
      config: ch?.config,
    })
  }
  const usableChannels = channels.filter((c) => c.enabled).map((c) => c.id)

  if (recipients.length === 0) {
    return { blocked: 'no_recipient', recipients, channels, usableChannels, tpl: tplOut }
  }
  if (usableChannels.length === 0) {
    return { blocked: 'no_channel', recipients, channels, usableChannels, tpl: tplOut }
  }
  return { blocked: null, recipients, channels, usableChannels, tpl: tplOut }
}

function recipientSource(
  rule: NotificationRule,
  decl: NotificationEventDecl,
): ResolvedRecipient['source'] {
  const kind = decl.recipients[rule.recipientKey]?.kind
  if (kind === 'literal') return 'literal'
  if (kind === 'scope_holders') return 'scope_holders'
  return 'field'
}

// ── 事件状态聚合（D2）─────────────────────────────────────────────────────────

export type EventStatus =
  | 'new'
  | 'matched'
  | 'no_rules'
  | 'no_recipients'
  | 'no_channel'
  | 'invalid'

/** 严重度：越靠前越该先修（模板坏了什么都发不出去；通道停了比没人更接近「能修好」） */
const SEVERITY: Record<Blocked, number> = {
  template_missing: 3,
  no_channel: 2,
  no_recipient: 1,
}

/**
 * 多规则聚合：**只要有任一条真的产出了投递，就是 matched**；否则取最严重的阻塞原因。
 *
 * 为什么「有投递就算通」：一个事件命中两条规则时，一条能发、一条不能，
 * 事件整体**确实发出去了一部分**——标成阻塞会掩盖「已经有人收到」的事实。
 * 「哪条规则坏了」由 `notify.delivery` 的缺席 + 规则体检（D3 preflight）定位。
 */
export function aggregateEventStatus(
  perRule: Array<Blocked | null>,
  producedDeliveries: boolean,
): EventStatus {
  if (producedDeliveries) return 'matched'
  if (perRule.length === 0) return 'no_rules'

  const worst = perRule.reduce<Blocked | null>((acc, b) => {
    if (b === null) return acc
    if (acc === null) return b
    return SEVERITY[b] > SEVERITY[acc] ? b : acc
  }, null)

  if (worst === 'template_missing') return 'invalid'
  if (worst === 'no_channel') return 'no_channel'
  if (worst === 'no_recipient') return 'no_recipients'
  // 全部规则都拿到 null（可送达）但没有任何 delivery 产出（全被判冷却/渲染失败）：
  // 这不是「发不出去」的配置问题 ⇒ 保持 matched（与旧行为一致）。
  return 'matched'
}
