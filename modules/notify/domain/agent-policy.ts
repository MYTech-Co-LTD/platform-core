// agent-policy.ts — agent namespace 的爆炸半径策略（N3）。
//
// 默认最小权限：只允许 inapp_default、外发不自动、收件人/规则/每日消息都有上限。
// 策略存 notify.agent_namespace.policy（jsonb）；本文件负责解析/合并与通道风险分类。
export type AgentPolicy = {
  /** 规则可用的通道 id；默认只有 inapp_default。 */
  allowed_channels: string[]
  /** 预授权外发（企微/webhook）。false ⇒ 外发规则走审批。 */
  auto_publish_external: boolean
  max_recipients_per_message: number
  max_active_rules: number
  max_messages_per_day: number
}

export const DEFAULT_AGENT_POLICY: AgentPolicy = {
  allowed_channels: ['inapp_default'],
  auto_publish_external: false,
  max_recipients_per_message: 50,
  max_active_rules: 20,
  max_messages_per_day: 200,
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0
    ? Math.trunc(Math.min(v, 1_000_000))
    : fallback
}

export function parseAgentPolicy(raw: unknown): AgentPolicy {
  const r = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const channels = Array.isArray(r.allowed_channels)
    ? r.allowed_channels.filter((x): x is string => typeof x === 'string' && x.length > 0)
    : []
  return {
    allowed_channels: channels.length > 0 ? [...new Set(channels)] : [...DEFAULT_AGENT_POLICY.allowed_channels],
    auto_publish_external: r.auto_publish_external === true,
    max_recipients_per_message: positiveInt(
      r.max_recipients_per_message, DEFAULT_AGENT_POLICY.max_recipients_per_message),
    max_active_rules: positiveInt(r.max_active_rules, DEFAULT_AGENT_POLICY.max_active_rules),
    max_messages_per_day: positiveInt(
      r.max_messages_per_day, DEFAULT_AGENT_POLICY.max_messages_per_day),
  }
}

/** PATCH 语义：未提供的字段沿用当前策略，不做隐式重置。 */
export function mergeAgentPolicy(
  current: AgentPolicy,
  patch: Record<string, unknown>,
): AgentPolicy {
  return parseAgentPolicy({ ...current, ...patch })
}

/** 非 in_app 一律按外发处理（未知 provider 也保守按外部）。 */
export function isExternalProvider(provider: string): boolean {
  return provider !== 'in_app'
}
