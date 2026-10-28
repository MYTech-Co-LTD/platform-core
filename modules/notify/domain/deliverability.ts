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
  ): Promise<{ id: string; provider: string; enabled: boolean } | null>
  resolveScopeHolders(
    org: string,
    key: string,
    decl: NotificationEventDecl,
  ): Promise<string[]>
}

export type Deliverability = {
  blocked: Blocked | null
  recipients: ResolvedRecipient[]
  channels: Array<{ id: string; provider: string; enabled: boolean }>
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
    channels.push({ id, provider: ch?.provider ?? 'unknown', enabled: ch?.enabled === true })
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
