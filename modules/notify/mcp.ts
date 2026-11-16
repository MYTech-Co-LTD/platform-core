// mcp.ts — POST /mcp-manage：notify 管理面 MCP 工具（agent 用）。
// 硬边界：无 publish / channel 工具；send_test 收件人强制 = 调用者本人。
// 壳形状照 modules/forms/mcp.ts（§12.13：不跨模块 import，抄形状不抄代码）。
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type {
  ChannelAddressResolver, EventCatalogReader, Identity, NotificationEventDecl, RequesterVars,
  SchedulerPortFactory,
} from '@platform/sdk'
import { REQUESTER_CHANNEL, validatePayload } from '@platform/sdk'
import { createAgentRule, createAgentTemplate, sendAgentMessage } from './agent-actions'
import { C_SAFE_TOOLS, NOTIFY_TOOLS, toolsForChannel } from './mcp-tools'
import type { NotifyChannel } from './mcp-tools'
import { channelIsConfigured } from './domain/channel-config'
import { callScheduleTool, isScheduleTool } from './tools/schedules'
import { resolveDeliverability } from './domain/deliverability'
import { resolveDeliveryAddress } from './domain/resolve-address'
import { renderContents } from './domain/render'
import { providerRequiresAddress } from './domain/providers'
import { isWritableRuleId, ruleSnapshot, validateRule } from './domain/rules'
import type { RuleSnapshot } from './domain/rules'
import { samplePayload, validateContents } from './domain/template'
import {
  audit, createTemplateRevision, ensureServiceNamespace, getAgentNamespace, getChannel, getEventDecl,
  getPublishedTemplate, getTemplate, insertDelivery, listAgentNamespaces, listChannels,
  listDeliveries, listEnabledChannelIds, listEventDecls, listPublishedTemplateKeys, listRules,
  setRuleEnabled, upsertRule,
} from './storage'

export const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type McpDeps = {
  pool: Pool
  org: string
  userId: string
  /**
   * 调用者通道。**C 档唯一的执法依据**（spec 2026-11-16 §6.4）：`wecom` ⇒ agent-safe
   * 子集 + 规则一律 pending + namespace 钉死；`pat`/`session` ⇒ N3 full 行为不变。
   * 绝不读 `x-agent-profile`（那是网关的发现视图，客户端可伪造）。
   */
  channel: NotifyChannel
  /** `read` = `/mcp` 只读面（tools/list 只回非 mutating；callTool 拒写）。缺省 full。 */
  mode?: 'full' | 'read'
  /** 调用者 scopes（用于 publish 等工具级闸门）。 */
  scopes?: string[]
  events?: EventCatalogReader
  addresses?: ChannelAddressResolver
  /** 排班端口工厂（未注入 ⇒ 排班工具返回 SCHEDULER_UNAVAILABLE）。 */
  scheduler?: SchedulerPortFactory
}
type McpToolResult = { text: string; isError: boolean }
// annotations.readOnlyHint 是 tools/list 的协议字段（MCP 工具注解），也是能力网关
// 紧凑索引判定 mutating 的**唯一来源**（2026-11-16 能力网关 spec §7.5/§8）：
// notify 的 tools/list 若不投影它，网关只能猜，草稿/写工具的提示就会失真。
type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean }
}

const err = (reason: string, extra: Record<string, unknown> = {}): McpToolResult => ({
  text: JSON.stringify({ status: 'error', reason, ...extra }),
  isError: true,
})
const ok = (payload: unknown): McpToolResult => ({
  text: JSON.stringify(payload),
  isError: false,
})

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const arr = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.length > 0) : []

/**
 * 工具 namespace 的唯一取法：C（wecom）由部署钉死 `NOTIFY_WECOM_NAMESPACE`，**忽略**模型
 * 参数里的 namespace；其余通道仍取参数（N3 行为不变）。空串 ⇒ 调用方回
 * `namespace_unconfigured`（fail-closed，不猜、不回落 org）。
 */
const toolNamespace = (
  deps: Pick<McpDeps, 'channel'>, arg: unknown, pinned: string | null,
): string =>
  deps.channel === 'wecom' ? (pinned ?? '') : str(arg)

/** 统一事件解析：`ext.*` 走租户声明，其余走平台 manifest 目录。 */
async function resolveDecl(deps: McpDeps, key: string): Promise<NotificationEventDecl | null> {
  return key.startsWith('ext.')
    ? getEventDecl(deps.pool, deps.org, key)
    : deps.events?.get(key) ?? null
}

export function toolDefs(deps: Pick<McpDeps, 'channel' | 'mode' | 'scopes'>): ToolDef[] {
  const scopes = deps.scopes ?? []
  const metas = toolsForChannel(deps.channel)
  // 读面（/mcp）：只投影非 mutating（spec §5.2）。channel 过滤先做——wecom 直连读面也
  // 不能越过 C 档（虽然非 mutating 集本就是 C-safe 子集）。
  const nonMutating = deps.mode === 'read' ? metas.filter((t) => !t.mutating) : metas
  // 工具级 scope（spec §6.2）：tools/list 只回调用方满足 requiredScope 的工具。
  // 例：preview_template 只读但要求 notify:manage，notify:view 的读面不应看到它。
  const visible = nonMutating
    .filter((t) => t.requiredScope === null || scopes.includes(t.requiredScope))
  return visible.map(({ name, description, inputSchema, mutating }) => ({
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: !mutating },
  }))
}

export async function callTool(
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  const meta = NOTIFY_TOOLS.find((t) => t.name === name)
  // C 档执法（spec §6.4）：**按 identity.channel，不按 profile/头**。直连模块、伪造
  // `x-agent-profile: full`、或网关头缺失，都在这里被拒。
  if (deps.channel === 'wecom' && !C_SAFE_TOOLS.has(name)) {
    return err('c_tool_not_allowed', { tool: name })
  }
  // 工具级 scope 执法（spec §6.2）：tools/list 已裁剪，直连调用也必须拦
  // （例：只有 notify:view 的调用方不能 preview_template）。
  if (meta && meta.requiredScope !== null
      && !(deps.scopes ?? []).includes(meta.requiredScope)) {
    return err('missing_scope', { scope: meta.requiredScope })
  }
  // 读面只接受非 mutating 工具（工具级错误，与 MCP 的 isError 形态一致）。
  if (deps.mode === 'read' && (!meta || meta.mutating)) {
    return err('read_only_tool_not_allowed', { tool: name })
  }

  // C 档：service-owned 钉死 namespace（spec 2026-11-16 D14）。配置了就幂等 ensure；
  // 缺失/冲突都在这里 fail-closed（冲突 = 同名 human namespace，绝不静默改写）。
  // 只读工具在**未配置**时仍可用（需要 namespace 的工具各自回 namespace_unconfigured）。
  let pinnedNamespace: string | null = null
  if (deps.channel === 'wecom') {
    const configured = (process.env.NOTIFY_WECOM_NAMESPACE ?? '').trim()
    if (configured) {
      const ensured = await ensureServiceNamespace(deps.pool, deps.org, configured)
      if (!ensured.ok) return err(ensured.code)
      pinnedNamespace = configured
    }
  }

  // C 档：排班工具的 namespace 同样钉死（漏掉这里，模型仍可用 create_schedule 等
  // 选别的自己拥有的 namespace）。缺失环境配置 ⇒ fail-closed，不回落 org。
  let scheduleArgs = args
  if (deps.channel === 'wecom' && isScheduleTool(name)) {
    if (!pinnedNamespace) return err('namespace_unconfigured')
    scheduleArgs = { ...args, namespace: pinnedNamespace }
  }

  // 排班工具（W6-P3 + N4）：actor 从调用者身份成形；namespace 归属/事件声明/payload
  // 校验经注入的回调做（工具文件保持纯）。显式 namespace 只能选**自己拥有**的 namespace。
  const schedule = await callScheduleTool(
    {
      scheduler: deps.scheduler,
      actor: { userId: deps.userId, org: deps.org },
      // C（wecom）只认钉死的 service namespace（ownership 由 service_owned 授权，
      // 而不是 userId）；其余通道保持 owner 校验。
      namespaces: {
        owned: async () => deps.channel === 'wecom'
          ? (pinnedNamespace ? [pinnedNamespace] : [])
          : (await listAgentNamespaces(deps.pool, deps.org))
            .filter((n) => n.status === 'active' && n.ownerUserId === deps.userId)
            .map((n) => n.namespace),
        owns: async (namespace) => {
          if (deps.channel === 'wecom') {
            return pinnedNamespace !== null && namespace === pinnedNamespace
          }
          const n = await getAgentNamespace(deps.pool, deps.org, namespace)
          return n !== null && n.status === 'active' && n.ownerUserId === deps.userId
        },
      },
      resolveEventDecl: (org, key) =>
        key.startsWith('ext.')
          ? getEventDecl(deps.pool, org, key)
          : Promise.resolve(deps.events?.get(key) ?? null),
      validatePayload: (decl, payload) => validatePayload(decl, payload),
    },
    name,
    scheduleArgs,
  )
  if (schedule) return schedule

  if (name === 'list_events') {
    return ok({
      events: [...(deps.events?.list() ?? []), ...await listEventDecls(deps.pool, deps.org)],
    })
  }

  if (name === 'get_event') {
    const key = str(args.eventKey)
    const ev = key ? await resolveDecl(deps, key) : undefined
    return ev ? ok(ev) : err('event_not_found')
  }

  if (name === 'list_rules') return ok({ rules: await listRules(deps.pool, deps.org) })

  if (name === 'propose_rule' || name === 'update_rule') {
    const id = name === 'update_rule' ? str(args.id) : `rule:${randomUUID()}`
    if (name === 'update_rule' && !id) return err('id_required')
    // 系统规则（derived:/manual:）只能由 seed/env 管理；agent 不得覆盖。
    if (name === 'update_rule' && !isWritableRuleId(id)) return err('rule_id_reserved')

    const eventKey = str(args.eventKey)
    const recipientKey = str(args.recipientKey)
    const templateKey = str(args.templateKey)
    const channels = arr(args.channels)
    if (!eventKey || !recipientKey || !templateKey || channels.length === 0) {
      return err('missing_required')
    }

    const decl = await resolveDecl(deps, eventKey)
    if (!decl) return err('event_not_declared')

    const [enabledChannels, published] = await Promise.all([
      listEnabledChannelIds(deps.pool, deps.org),
      listPublishedTemplateKeys(deps.pool, deps.org),
    ])
    const rule = {
      eventKey,
      scope: str(args.scope) || '*',
      recipientKey,
      recipientLiteral: Array.isArray(args.recipientLiteral) ? arr(args.recipientLiteral) : null,
      // 部门收件人（spec 2026-10-30 §3.5）：与 HTTP 面同一份校验（validateRule）
      recipientDepts: Array.isArray(args.recipientDepts) ? arr(args.recipientDepts) : null,
      templateKey,
      channels,
      cooldownMinutes: typeof args.cooldownMinutes === 'number' ? args.cooldownMinutes : null,
      origin: 'manual' as const,
    }
    const bad = validateRule(rule, decl, enabledChannels, published)
    if (bad) return err(bad)

    // 规则历史快照（#2322）：audit 里落一份完整可回滚快照
    // recipientDepts 与 HTTP 面同源去重（覆盖 rule 里的原值）
    const snapshot: RuleSnapshot = {
      id, enabled: true, ...rule, ownerNamespace: null,
      recipientDepts: rule.recipientDepts ? [...new Set(rule.recipientDepts)] : null,
    }
    await upsertRule(deps.pool, deps.org, snapshot, deps.userId)
    await audit(deps.pool, deps.org, deps.userId, `mcp.${name}`, id, { ...rule, id, snapshot })
    return ok({ id, next: '规则即时生效；可在控制台启停/删除' })
  }

  if (name === 'set_rule_enabled') {
    const id = str(args.id)
    if (!id || typeof args.enabled !== 'boolean') return err('missing_required')
    // 快照取自写入前的行（enabled 覆盖为目标值）
    const existing = (await listRules(deps.pool, deps.org)).find((x) => x.id === id)
    const n = await setRuleEnabled(deps.pool, deps.org, id, args.enabled)
    if (n === 0) return err('not_found')
    await audit(deps.pool, deps.org, deps.userId, 'mcp.set_rule_enabled', id, {
      enabled: args.enabled,
      snapshot: existing ? ruleSnapshot(existing, { enabled: args.enabled }) : undefined,
    })
    return ok({ id, enabled: args.enabled })
  }

  if (name === 'list_templates') return ok({ templates: await listTemplatesSafe(deps) })

  if (name === 'get_template') {
    const key = str(args.key)
    if (!key) return err('key_required')
    const t = await getTemplate(deps.pool, deps.org, key)
    return t ? ok(t) : err('not_found')
  }

  if (name === 'draft_template') {
    const key = str(args.key)
    const contents = args.contents
    if (!key || !contents || typeof contents !== 'object' || Array.isArray(contents)) {
      return err('missing_required')
    }
    const t = await getTemplate(deps.pool, deps.org, key)
    if (!t) return err('not_found')
    const decl = await resolveDecl(deps, t.eventKey)
    if (!decl) return err('event_not_declared')

    const channels = await listChannels(deps.pool, deps.org)
    const providers = [...new Set(channels.filter((x) => x.enabled).map((x) => x.provider))]
    const issues = validateContents(
      contents as Record<string, Record<string, string>>,
      decl,
      providers.length > 0 ? providers : Object.keys(contents as object),
    )
    if (issues.length > 0) return err('template_invalid', { issues })

    const r = await createTemplateRevision(
      deps.pool, deps.org, key, contents as Record<string, Record<string, string>>, deps.userId)
    await audit(deps.pool, deps.org, deps.userId, 'mcp.draft_template', key, { revision: r.revision })
    return ok({ key, revision: r.revision, status: 'draft', next: '需持 notify:publish 的人在控制台发布' })
  }

  if (name === 'preview_template') {
    const key = str(args.key)
    const payload = args.payload
    if (!key || !payload || typeof payload !== 'object') return err('missing_required')
    const t = await getTemplate(deps.pool, deps.org, key)
    if (!t) return err('not_found')
    const revision = typeof args.revision === 'number' ? args.revision : t.publishedRevision
    const rev = t.revisions.find((x) => x.revision === revision)
    if (!rev) return err('revision_not_found')
    const rendered = renderContents(rev.contents, payload as Record<string, unknown>, Object.keys(rev.contents))
    return rendered.ok ? ok({ rendered: rendered.rendered }) : err('template_render_failed', { issues: rendered.issues })
  }

  if (name === 'list_deliveries') {
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(Math.trunc(args.limit), 1), 100) : 100
    return ok({ deliveries: await listDeliveries(deps.pool, deps.org, limit) })
  }

  if (name === 'check_rule') {
    const id = str(args.id)
    if (!id) return err('id_required')
    const rule = (await listRules(deps.pool, deps.org)).find((x) => x.id === id)
    if (!rule) return err('not_found')

    const decl = await resolveDecl(deps, rule.eventKey)
    if (!decl) return err('event_not_declared')

    const warnings: string[] = []
    // 「查不了」≠「没人持有 / 部门没人」：与 HTTP 预检同一组 warning。
    if (!deps.addresses?.resolveScopeHolders) warnings.push('scope_holders_unavailable')
    if (!deps.addresses?.resolveDeptMembers) warnings.push('dept_resolver_unavailable')
    const given = args.payload as Record<string, unknown> | undefined
    if (!given) warnings.push('sample_mode_field_recipients_unverified')

    const r = await resolveDeliverability(
      { org: deps.org, rule, payload: given ?? samplePayload(decl) },
      {
        getEventDecl: async (o, key) =>
          key.startsWith('ext.')
            ? getEventDecl(deps.pool, o, key)
            : deps.events?.get(key) ?? null,
        getPublishedTemplate: async (org, key) => {
          const t = await getPublishedTemplate(deps.pool, org, key)
          return t ? { revision: t.revision, contents: t.contents } : null
        },
        getChannel: async (org, cid) => {
          const ch = await getChannel(deps.pool, org, cid)
          return ch
            ? {
                id: cid, provider: ch.provider, enabled: ch.enabled, config: ch.config,
                configured: await channelIsConfigured(deps.pool, org, ch),
              }
            : null
        },
        resolveScopeHolders: async (org, key, d) =>
          deps.addresses?.resolveScopeHolders?.(org, key, d) ?? [],
        // 与 HTTP/worker 同源：未注入时 resolveDeliverability 落 dept_resolver_unavailable。
        resolveDeptMembers: deps.addresses?.resolveDeptMembers?.bind(deps.addresses),
      },
    )
    for (const id of r.unconfiguredChannels) warnings.push(`channel_unconfigured:${id}`)
    return ok({
      ruleId: rule.id,
      eventKey: rule.eventKey,
      blocked: r.blocked,
      recipients: r.recipients,
      channels: r.channels,
      unconfiguredChannels: r.unconfiguredChannels,
      warnings,
      next: r.blocked === null ? '可送达' : '按 blocked 修配置后重跑 check_rule',
    })
  }

  if (name === 'send_test') {
    const templateKey = str(args.templateKey)
    const channelId = str(args.channel)
    const payload = args.payload
    if (!templateKey || !channelId || !payload || typeof payload !== 'object') {
      return err('missing_required')
    }
    const recent = await countTest(deps)
    if (recent >= 5) return err('test_rate_limited')

    const t = await getTemplate(deps.pool, deps.org, templateKey)
    const rev = t?.revisions.find((x) => x.revision === t.publishedRevision)
    if (!t || !rev) return err('not_found')
    const decl = await resolveDecl(deps, t.eventKey)
    if (!decl) return err('event_not_declared')
    const bad = validatePayload(decl, payload as Record<string, unknown>)
    if (bad) return err('payload_invalid', { detail: bad })

    const rendered = renderContents(rev.contents, payload as Record<string, unknown>, Object.keys(rev.contents))
    if (!rendered.ok) return err('template_render_failed', { issues: rendered.issues })

    const ch = await getChannel(deps.pool, deps.org, channelId)
    if (!ch || !ch.enabled) return err('channel_not_found')
    const address = await resolveDeliveryAddress(deps.addresses?.resolve, ch, {
      org: deps.org, casdoorName: deps.userId,
    })
    if (!address && providerRequiresAddress(ch.provider)) return err('missing_address')

    // 收件人强制 = 调用者本人；args 里即使带 recipient 也不读
    await insertDelivery(deps.pool, {
      org: deps.org,
      eventId: `test:${randomUUID()}`,
      eventKey: t.eventKey,
      ruleId: 'test',
      recipient: deps.userId,
      channel: ch.id,
      address: address ?? deps.userId,
      templateKey: t.key,
      revision: rev.revision,
      rendered: rendered.rendered[ch.provider] ?? {},
      status: 'pending',
      isTest: true,
    })
    await audit(deps.pool, deps.org, deps.userId, 'mcp.send_test', t.key, { channel: ch.id })
    return ok({ accepted: true, recipient: deps.userId })
  }

  if (name === 'send_message') {
    const namespace = toolNamespace(deps, args.namespace, pinnedNamespace)
    if (!namespace) return err('namespace_unconfigured')
    const toRaw = args.to
    const to = Array.isArray(toRaw) ? arr(toRaw) : str(toRaw)
    const title = str(args.title)
    const body = str(args.body)
    if (!title || !body
        || (Array.isArray(to) ? to.length === 0 : to === '')) {
      return err('missing_required')
    }
    const r = await sendAgentMessage(deps.pool, {
      org: deps.org, userId: deps.userId, namespace,
      eventId: typeof args.eventId === 'string' ? args.eventId : undefined,
      to, title, body,
      link: typeof args.link === 'string' ? args.link : undefined,
      allowServiceNamespace: deps.channel === 'wecom',
    })
    return r.ok
      ? ok({ accepted: r.accepted, eventId: r.eventId })
      : err(r.code, r.detail ?? {})
  }

  if (name === 'create_agent_template') {
    const namespace = toolNamespace(deps, args.namespace, pinnedNamespace)
    if (!namespace) return err('namespace_unconfigured')
    const key = str(args.key)
    const tplName = str(args.name)
    const eventKey = str(args.eventKey)
    const contents = args.contents
    if (!key || !tplName || !eventKey
        || contents === null || typeof contents !== 'object' || Array.isArray(contents)) {
      return err('missing_required')
    }
    const r = await createAgentTemplate(deps.pool, {
      org: deps.org, userId: deps.userId, namespace, key, name: tplName, eventKey,
      contents: contents as Record<string, Record<string, string>>,
      // C 档只能写草稿：发布必须由持 notify:publish 的人做（spec §5.2）。
      publish: deps.channel === 'wecom' ? false : args.publish === true,
      canPublish: (deps.scopes ?? []).includes('notify:publish'),
      allowServiceNamespace: deps.channel === 'wecom',
    })
    return r.ok
      ? ok({ key: r.key, revision: r.revision, published: r.published })
      : err(r.code, r.detail ?? {})
  }

  if (name === 'create_agent_rule') {
    const namespace = toolNamespace(deps, args.namespace, pinnedNamespace)
    if (!namespace) return err('namespace_unconfigured')
    const eventKey = str(args.eventKey)
    const recipientKey = str(args.recipientKey)
    const templateKey = str(args.templateKey)
    const channels = arr(args.channels)
    if (!eventKey || !recipientKey || !templateKey || channels.length === 0) {
      return err('missing_required')
    }
    const r = await createAgentRule(deps.pool, {
      org: deps.org, userId: deps.userId, namespace,
      id: str(args.id) || undefined, eventKey,
      scope: str(args.scope) || undefined,
      recipientKey,
      recipientLiteral: Array.isArray(args.recipientLiteral) ? arr(args.recipientLiteral) : null,
      recipientDepts: Array.isArray(args.recipientDepts) ? arr(args.recipientDepts) : null,
      templateKey, channels,
      cooldownMinutes: typeof args.cooldownMinutes === 'number' ? args.cooldownMinutes : null,
      // C 档：连 in-app 也落 pending/disabled（N3 之上更严，只作用于 wecom）。
      draftOnly: deps.channel === 'wecom',
      allowServiceNamespace: deps.channel === 'wecom',
    })
    return r.ok
      ? ok({ id: r.id, status: r.status, approvalId: r.approvalId, namespace })
      : err(r.code, r.detail ?? {})
  }

  return err('unknown_tool', { name })
}

/** list_templates 的轻封装（避免把 storage 细节散到工具分支里） */
async function listTemplatesSafe(deps: McpDeps) {
  const rows = await deps.pool.query(
    `select key,name,event_key,status,origin,published_revision,updated_at
       from notify.template where org=$1 order by key`, [deps.org])
  return rows.rows.map((r) => ({
    key: r.key,
    name: r.name,
    eventKey: r.event_key,
    status: r.status,
    origin: r.origin,
    publishedRevision: r.published_revision,
    updatedAt: (r.updated_at as Date).toISOString(),
  }))
}

async function countTest(deps: McpDeps): Promise<number> {
  const { rows } = await deps.pool.query(
    `select count(*)::int n from notify.delivery
      where org=$1 and recipient=$2 and is_test and created_at > now()-interval '1 minute'`,
    [deps.org, deps.userId])
  return rows[0].n as number
}

/** 模块 MCP 路由的 context 变量：身份 + 请求者通道（PAT/企微）。 */
type McpRouteVars = { Variables: { identity: Identity } & RequesterVars }

/**
 * 把 notify 的 MCP 面挂到 `path`（挂到模块既有 router 上）。
 *
 * - `mode='full'`（`/mcp-manage`）：B（pat/session）N3 全量；C（wecom）按 channel 投影的
 *   agent-safe 子集 + 规则 pending（执法在 `callTool`，本壳只组装 deps）。
 * - `mode='read'`（`/mcp`，`notify:view`）：只投影非 mutating 工具；`callTool` 拒写。
 *
 * `x-agent-profile`（网关的发现视图）**不读**——C 档只认 `identity.channel`（spec §6.4）。
 */
export function registerNotifyMcp(
  r: Hono<McpRouteVars>,
  path: string,
  deps: {
    pool: Pool
    events?: EventCatalogReader
    addresses?: ChannelAddressResolver
    scheduler?: SchedulerPortFactory
  },
  mode: 'full' | 'read' = 'full',
): void {
  r.post(path, async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | null
    if (msg === null) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200)
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }
    if (msg.id === undefined) return c.body(null, 202)

    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    const identity = c.get('identity') as Identity
    // 未设置 = 系统内会话通道（requester-vars.ts 的语义）。
    const channel = (c.get(REQUESTER_CHANNEL) ?? 'session') as NotifyChannel
    const mcpDeps: McpDeps = {
      pool: deps.pool,
      org: identity.orgId,
      userId: identity.userId,
      channel,
      mode,
      scopes: identity.scopes,
      events: deps.events,
      addresses: deps.addresses,
      scheduler: deps.scheduler,
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: mode === 'read' ? 'platform-notify-mcp-read' : 'platform-notify-mcp-manage',
          version: '0.1.0',
        },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: toolDefs(mcpDeps) })
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await callTool(mcpDeps, name, args)
      return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError })
    }
    return rpcError(-32601, 'method not found')
  })
}
