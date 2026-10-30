// deliverability.ts — 收件人/通道可送达性解析（**唯一实现**；D3/D4 的 HTTP 与 MCP 共用）。
// 纯编排：所有 IO 经 deps 注入，模块内不建连接、不读 env。
//
// 为什么要有这一层：worker 里原先是三段内联（tpl → names/holders → channelRows），
// 零结果一律 `continue` ⇒ 静默。抽成函数后，「谁能收到 / 为什么收不到」可被
// worker、HTTP、MCP、体检 job 用**同一份逻辑**回答，不出现两套口径漂移。
import type { DeptExpansion, NotificationEventDecl } from '@platform/sdk'
import type { NotificationRule } from './rules'
import { resolveRecipientNames } from './recipients'

/**
 * 规则当前发不出去的原因（null = 可送达）。
 *
 * `dept_resolver_unavailable` 单列而不是并进 `no_recipient`：前者是**宿主没配解析器**
 * （配置/部署问题），后者是**真的没人**（业务事实）。混成一个码会让排障方向从
 * 「去查部署」错到「去查组织架构」，也与 `scope_holders_unavailable` 的既有口径不一致。
 */
export type Blocked = 'no_recipient' | 'no_channel' | 'template_missing' | 'dept_resolver_unavailable'

export type ResolvedRecipient = {
  name: string
  source: 'field' | 'literal' | 'scope_holders' | 'dept'
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
    /**
     * `secret_refs` 指向的 env 键是否都在本进程可见（缺省视为**已配置**，保持旧行为）。
     * 未配置的通道**不算可送达**——否则预检说「能发」、真发时每个收件人各记一条
     * `secret_missing` 永久失败（2026-10-30 山海实测：seed 出来的 `wecom_default`
     * 就是这样，bridge env 键不在时整条通道是空壳）。
     */
    configured?: boolean
  } | null>
  resolveScopeHolders(
    org: string,
    key: string,
    decl: NotificationEventDecl,
  ): Promise<string[]>
  /**
   * 部门 `ext_id` → 展开后的成员（含子树、已排除禁用；spec 2026-10-30 §3.5）。
   * **缺省 = 查不了**（宿主没注入）：调用方必须落 `dept_resolver_unavailable`，
   * 不得当成空集——那会把「部署没配」伪装成「这个部门没人」。
   */
  resolveDeptMembers?(org: string, extIds: readonly string[]): Promise<DeptExpansion>
}

export type Deliverability = {
  blocked: Blocked | null
  recipients: ResolvedRecipient[]
  channels: Array<{
    id: string
    provider: string
    enabled: boolean
    config?: Record<string, unknown>
    configured?: boolean
  }>
  usableChannels: string[]
  /**
   * 启用了但**没配**（secret_refs 指向的 env 键缺失）的通道 id。
   * 预检据此报 `channel_unconfigured:<id>` —— 这类通道以前要等投递失败才看得见。
   */
  unconfiguredChannels: string[]
  /** 已发布模板（blocked=template_missing 时缺省）；worker 复用它渲染，避免二次读库 */
  tpl?: { revision: number; contents: unknown }
  /**
   * 部门规则的展开结果（**审计三数**的唯一来源）：worker 拿它写审计、预检拿它显示
   * 「将发送给 N 人 / 排除 M 人 / 未解析 K 人」。非部门规则不设。
   */
  deptExpansion?: DeptExpansion
}

/**
 * 通道是否真的能发：启用 **且** 已配置（`secret_refs` 的 env 键都在）。
 * `configured` 缺省 = true（旧调用方/测试不传时行为不变）。
 */
export function isChannelUsable(c: { enabled: boolean; configured?: boolean }): boolean {
  return c.enabled && c.configured !== false
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
    return { blocked: 'template_missing', recipients: [], channels: [], usableChannels: [], unconfiguredChannels: [] }
  }
  const tplOut = { revision: tpl.revision, contents: tpl.contents }

  const decl = await deps.getEventDecl(rule.eventKey)
  const recipients: ResolvedRecipient[] = []
  const seen = new Set<string>()
  let deptExpansion: DeptExpansion | undefined

  if (decl) {
    const kind = decl.recipients[rule.recipientKey]?.kind
    if (kind === 'dept') {
      // ── 部门档（spec 2026-10-30 §3.5）：发送时才展开，组织架构改了即时生效 ──────────
      const depts = rule.recipientDepts ?? []
      if (depts.length === 0) {
        // 配了一半（选了部门档却没选部门）：**不静默发 0 人**，按「没人」显式阻塞
        return { blocked: 'no_recipient', recipients, channels: [], usableChannels: [], unconfiguredChannels: [], tpl: tplOut }
      }
      if (!deps.resolveDeptMembers) {
        // 「查不了」≠「没人」：这条必须与 no_recipient 分开（见 Blocked 的注）
        return {
          blocked: 'dept_resolver_unavailable', recipients, channels: [], usableChannels: [],
          unconfiguredChannels: [], tpl: tplOut,
        }
      }
      deptExpansion = await deps.resolveDeptMembers(org, depts)
      for (const name of deptExpansion.names) {
        if (seen.has(name)) continue
        seen.add(name)
        recipients.push({ name, source: 'dept' })
      }
    } else {
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
  }

  const channels: Deliverability['channels'] = []
  for (const id of rule.channels) {
    const ch = await deps.getChannel(org, id)
    channels.push({
      id,
      provider: ch?.provider ?? 'unknown',
      enabled: ch?.enabled === true,
      config: ch?.config,
      configured: ch?.configured,
    })
  }
  const usableChannels = channels.filter(isChannelUsable).map((c) => c.id)
  const unconfiguredChannels = channels
    .filter((c) => c.enabled && c.configured === false)
    .map((c) => c.id)

  if (recipients.length === 0) {
    return {
      blocked: 'no_recipient', recipients, channels, usableChannels, unconfiguredChannels, tpl: tplOut, deptExpansion,
    }
  }
  if (usableChannels.length === 0) {
    return {
      blocked: 'no_channel', recipients, channels, usableChannels, unconfiguredChannels, tpl: tplOut, deptExpansion,
    }
  }
  return {
    blocked: null, recipients, channels, usableChannels, unconfiguredChannels, tpl: tplOut, deptExpansion,
  }
}

function recipientSource(
  rule: NotificationRule,
  decl: NotificationEventDecl,
): ResolvedRecipient['source'] {
  const kind = decl.recipients[rule.recipientKey]?.kind
  if (kind === 'literal') return 'literal'
  if (kind === 'scope_holders') return 'scope_holders'
  if (kind === 'dept') return 'dept'
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
  // 解析器没配 = 部署缺陷，比「这个部门真没人」更该先修 ⇒ 与 no_channel 同档（高于没人）
  dept_resolver_unavailable: 2,
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
  // 部门解析器没配在**事件级**归到 no_recipients：与 `scope_holders` 未注入时的既有行为
  // 一致（那条也是解析器缺失 ⇒ 零收件人 ⇒ no_recipients）。**规则级**仍保留精确码
  // `dept_resolver_unavailable`（预检面要能区分「部署没配」与「这个部门真没人」）。
  if (worst === 'dept_resolver_unavailable') return 'no_recipients'
  if (worst === 'no_recipient') return 'no_recipients'
  // 全部规则都拿到 null（可送达）但没有任何 delivery 产出（全被判冷却/渲染失败）：
  // 这不是「发不出去」的配置问题 ⇒ 保持 matched（与旧行为一致）。
  return 'matched'
}
