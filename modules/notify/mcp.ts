// mcp.ts — POST /mcp-manage：notify 管理面 MCP 工具（agent 用）。
// 硬边界：无 publish / channel 工具；send_test 收件人强制 = 调用者本人。
// 壳形状照 modules/forms/mcp.ts（§12.13：不跨模块 import，抄形状不抄代码）。
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { ChannelAddressResolver, EventCatalogReader, Identity } from '@platform/sdk'
import { validatePayload } from '@platform/sdk'
import { NOTIFY_TOOLS } from './mcp-tools'
import { resolveDeliverability } from './domain/deliverability'
import { renderContents } from './domain/render'
import { validateRule } from './domain/rules'
import { samplePayload, validateContents } from './domain/template'
import {
  audit, createTemplateRevision, getChannel, getPublishedTemplate, getTemplate, insertDelivery, listChannels,
  listDeliveries, listEnabledChannelIds, listPublishedTemplateKeys, listRules,
  setRuleEnabled, upsertRule,
} from './storage'

export const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type McpDeps = {
  pool: Pool
  org: string
  userId: string
  events?: EventCatalogReader
  addresses?: ChannelAddressResolver
}
type McpToolResult = { text: string; isError: boolean }
type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

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

export function toolDefs(): ToolDef[] {
  return NOTIFY_TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
}

export async function callTool(
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  if (name === 'list_events') return ok({ events: deps.events?.list() ?? [] })

  if (name === 'get_event') {
    const key = str(args.eventKey)
    const ev = key ? deps.events?.get(key) : undefined
    return ev ? ok(ev) : err('event_not_found')
  }

  if (name === 'list_rules') return ok({ rules: await listRules(deps.pool, deps.org) })

  if (name === 'propose_rule' || name === 'update_rule') {
    const id = name === 'update_rule' ? str(args.id) : `rule:${randomUUID()}`
    if (name === 'update_rule' && !id) return err('id_required')

    const eventKey = str(args.eventKey)
    const recipientKey = str(args.recipientKey)
    const templateKey = str(args.templateKey)
    const channels = arr(args.channels)
    if (!eventKey || !recipientKey || !templateKey || channels.length === 0) {
      return err('missing_required')
    }

    const decl = deps.events?.get(eventKey)
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
      templateKey,
      channels,
      cooldownMinutes: typeof args.cooldownMinutes === 'number' ? args.cooldownMinutes : null,
      origin: 'manual' as const,
    }
    const bad = validateRule(rule, decl, enabledChannels, published)
    if (bad) return err(bad)

    await upsertRule(deps.pool, deps.org, { id, enabled: true, ...rule }, deps.userId)
    await audit(deps.pool, deps.org, deps.userId, `mcp.${name}`, id, { ...rule, id })
    return ok({ id, next: '规则即时生效；可在控制台启停/删除' })
  }

  if (name === 'set_rule_enabled') {
    const id = str(args.id)
    if (!id || typeof args.enabled !== 'boolean') return err('missing_required')
    const n = await setRuleEnabled(deps.pool, deps.org, id, args.enabled)
    if (n === 0) return err('not_found')
    await audit(deps.pool, deps.org, deps.userId, 'mcp.set_rule_enabled', id, { enabled: args.enabled })
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
    const decl = deps.events?.get(t.eventKey)
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

    const decl = deps.events?.get(rule.eventKey)
    if (!decl) return err('event_not_declared')

    const warnings: string[] = []
    // 「查不了」≠「没人持有」
    if (!deps.addresses?.resolveScopeHolders) warnings.push('scope_holders_unavailable')
    const given = args.payload as Record<string, unknown> | undefined
    if (!given) warnings.push('sample_mode_field_recipients_unverified')

    const r = await resolveDeliverability(
      { org: deps.org, rule, payload: given ?? samplePayload(decl) },
      {
        getEventDecl: async (key) => deps.events?.get(key) ?? null,
        getPublishedTemplate: async (org, key) => {
          const t = await getPublishedTemplate(deps.pool, org, key)
          return t ? { revision: t.revision, contents: t.contents } : null
        },
        getChannel: async (org, cid) => {
          const ch = await getChannel(deps.pool, org, cid)
          return ch ? { id: cid, provider: ch.provider, enabled: ch.enabled, config: ch.config } : null
        },
        resolveScopeHolders: async (org, key, d) =>
          deps.addresses?.resolveScopeHolders?.(org, key, d) ?? [],
      },
    )
    return ok({
      ruleId: rule.id,
      eventKey: rule.eventKey,
      blocked: r.blocked,
      recipients: r.recipients,
      channels: r.channels,
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
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return err('event_not_declared')
    const bad = validatePayload(decl, payload as Record<string, unknown>)
    if (bad) return err('payload_invalid', { detail: bad })

    const rendered = renderContents(rev.contents, payload as Record<string, unknown>, Object.keys(rev.contents))
    if (!rendered.ok) return err('template_render_failed', { issues: rendered.issues })

    const ch = await getChannel(deps.pool, deps.org, channelId)
    if (!ch || !ch.enabled) return err('channel_not_found')
    const resolved = await deps.addresses?.resolve({
      org: deps.org, provider: ch.provider, casdoorName: deps.userId,
    })
    const address = resolved
      ?? (ch.provider === 'wecom_chat' && ch.config.address_fallback === 'casdoor_name'
        ? deps.userId
        : null)
    if (!address && ch.provider !== 'in_app') return err('missing_address')

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

/** 把 MCP 管理面挂成 `POST /mcp-manage`（挂到模块既有 router 上）。 */
export function registerNotifyMcpManage(
  r: Hono<{ Variables: { identity: Identity } }>,
  deps: { pool: Pool; events?: EventCatalogReader; addresses?: ChannelAddressResolver },
): void {
  r.post('/mcp-manage', async (c) => {
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
    const mcpDeps: McpDeps = {
      pool: deps.pool,
      org: identity.orgId,
      userId: identity.userId,
      events: deps.events,
      addresses: deps.addresses,
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-notify-mcp-manage', version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: toolDefs() })
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await callTool(mcpDeps, name, args)
      return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError })
    }
    return rpcError(-32601, 'method not found')
  })
}
