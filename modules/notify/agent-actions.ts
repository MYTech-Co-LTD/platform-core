// agent-actions.ts — agent 自助动作的应用服务（N2/N3 单一实现）。
//
// HTTP 路由与 MCP 工具都调这里：owner 校验、policy、审批、配额、审计只写一份。
// 返回机检错误码 + HTTP 状态；调用方只做协议适配（JSON / MCP error）。
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { validatePayload } from '@platform/sdk'
import { AGENT_TEMPLATE_KEY_RE } from './domain/agent-event'
import { agentMessageKey, isAgentMessageKey } from './domain/agent-message'
import { isExternalProvider, parseAgentPolicy } from './domain/agent-policy'
import { validateRule } from './domain/rules'
import { validateContents } from './domain/template'
import {
  audit, countActiveAgentRules, countAgentMessagesToday, createApproval, createTemplate,
  createTemplateRevision, ensureAgentMessageDefaults, enqueueEvent, getAgentNamespace,
  getChannel, getEventDecl, getTemplate, hasApprovedRuleApproval, listApprovals,
  listEnabledChannelIds, listPublishedTemplateKeys, listRules, publishTemplateRevision,
  upsertRule,
} from './storage'

export type AgentActionError = {
  ok: false
  code: string
  httpStatus: number
  detail?: Record<string, unknown>
}

const fail = (
  code: string, httpStatus: number, detail?: Record<string, unknown>,
): AgentActionError => ({ ok: false, code, httpStatus, detail })

export type SendAgentMessageInput = {
  org: string
  userId: string
  namespace: string
  eventId?: string
  to: string | string[]
  title: string
  body: string
  link?: string
}

export type SendAgentMessageResult =
  | { ok: true; accepted: boolean; eventId: string }
  | AgentActionError

export async function sendAgentMessage(
  pool: Pool,
  input: SendAgentMessageInput,
): Promise<SendAgentMessageResult> {
  const ns = await getAgentNamespace(pool, input.org, input.namespace)
  if (!ns || ns.status !== 'active' || ns.ownerUserId !== input.userId) {
    return fail('AGENT_NAMESPACE_FORBIDDEN', 403)
  }
  const policy = parseAgentPolicy(ns.policy)
  if (!policy.allowed_channels.includes('inapp_default')) {
    return fail('CHANNEL_NOT_ALLOWED', 403, { channels: ['inapp_default'] })
  }
  const to = Array.isArray(input.to) ? input.to : [input.to]
  if (to.length === 0 || to.some((x) => typeof x !== 'string' || x.trim() === '')) {
    return fail('AGENT_MESSAGE_INVALID_RECIPIENT', 400)
  }
  if (to.length > policy.max_recipients_per_message) {
    return fail('RECIPIENT_QUOTA_EXCEEDED', 429)
  }
  if (await countAgentMessagesToday(pool, input.org, input.namespace)
      >= policy.max_messages_per_day) {
    return fail('MESSAGE_QUOTA_EXCEEDED', 429)
  }
  if ([...input.title].length > 64) return fail('AGENT_MESSAGE_TITLE_TOO_LONG', 400)
  if ([...input.body].length > 500) return fail('AGENT_MESSAGE_BODY_TOO_LONG', 400)
  if (input.link !== undefined && !/^https:\/\//.test(input.link)) {
    return fail('AGENT_MESSAGE_LINK_INVALID', 400)
  }

  await ensureAgentMessageDefaults(pool, input.org, input.namespace, input.userId)
  const eventKey = agentMessageKey(input.namespace)
  const decl = await getEventDecl(pool, input.org, eventKey)
  if (!decl) return fail('AGENT_MESSAGE_NOT_READY', 500)
  const payload = {
    to,
    title: input.title,
    body: input.body,
    ...(input.link === undefined ? {} : { link: input.link }),
  }
  const bad = validatePayload(decl, payload)
  if (bad) return fail('PAYLOAD_INVALID', 400, { detail: bad })

  const eventId = input.eventId ?? `agent-msg:${randomUUID()}`
  const result = await enqueueEvent(pool, {
    org: input.org,
    eventId,
    eventKey,
    scope: '*',
    payload,
    producer: `ext:${input.namespace}`,
  })
  await audit(pool, input.org, input.userId, 'agent.message.send', eventKey, {
    eventId, recipients: to.length,
  })
  return { ok: true, accepted: result.accepted, eventId }
}

export type CreateAgentTemplateInput = {
  org: string
  userId: string
  canPublish: boolean
  namespace: string
  key: string
  name: string
  eventKey: string
  contents: Record<string, Record<string, string>>
  publish: boolean
}

export type CreateAgentTemplateResult =
  | { ok: true; key: string; revision: number; published: boolean; created: boolean }
  | AgentActionError

export async function createAgentTemplate(
  pool: Pool,
  input: CreateAgentTemplateInput,
): Promise<CreateAgentTemplateResult> {
  if (!AGENT_TEMPLATE_KEY_RE.test(input.key)) return fail('AGENT_TEMPLATE_KEY_INVALID', 400)
  const ns = await getAgentNamespace(pool, input.org, input.namespace)
  if (!ns || ns.status !== 'active' || ns.ownerUserId !== input.userId) {
    return fail('AGENT_NAMESPACE_FORBIDDEN', 403)
  }
  if (!input.eventKey.startsWith(`ext.${input.namespace}.`) || isAgentMessageKey(input.eventKey)) {
    return fail('AGENT_EVENT_NOT_OWNED', 400)
  }
  const decl = await getEventDecl(pool, input.org, input.eventKey)
  if (!decl) return fail('EVENT_NOT_DECLARED', 400)
  const issues = validateContents(input.contents, decl, Object.keys(input.contents))
  if (issues.length > 0) return fail('TEMPLATE_INVALID', 400, { issues })

  const created = await createTemplate(pool, input.org, {
    key: input.key, name: input.name, eventKey: input.eventKey,
    ownerNamespace: input.namespace, actor: input.userId,
  })
  if (!created.ok) return fail('TEMPLATE_KEY_TAKEN', 409)
  const rev = await createTemplateRevision(
    pool, input.org, input.key, input.contents, input.userId)
  let published = false
  if (input.publish) {
    if (!input.canPublish) return fail('PUBLISH_FORBIDDEN', 403)
    await publishTemplateRevision(pool, input.org, input.key, rev.revision, input.userId)
    published = true
  }
  await audit(pool, input.org, input.userId, 'agent.template.upsert', input.key, {
    revision: rev.revision, published,
  })
  return { ok: true, key: input.key, revision: rev.revision, published, created: created.created }
}

export type CreateAgentRuleInput = {
  org: string
  userId: string
  namespace: string
  id?: string
  eventKey: string
  scope?: string
  recipientKey: string
  recipientLiteral?: string[] | null
  recipientDepts?: string[] | null
  templateKey: string
  channels: string[]
  cooldownMinutes?: number | null
}

export type CreateAgentRuleResult =
  | { ok: true; id: string; status: 'enabled' | 'pending'; approvalId?: string }
  | AgentActionError

export async function createAgentRule(
  pool: Pool,
  input: CreateAgentRuleInput,
): Promise<CreateAgentRuleResult> {
  const ns = await getAgentNamespace(pool, input.org, input.namespace)
  if (!ns || ns.status !== 'active' || ns.ownerUserId !== input.userId) {
    return fail('AGENT_NAMESPACE_FORBIDDEN', 403)
  }
  const policy = parseAgentPolicy(ns.policy)
  if (!input.eventKey.startsWith(`ext.${input.namespace}.`) || isAgentMessageKey(input.eventKey)) {
    return fail('AGENT_EVENT_NOT_OWNED', 400)
  }
  const decl = await getEventDecl(pool, input.org, input.eventKey)
  if (!decl) return fail('EVENT_NOT_DECLARED', 400)
  const tpl = await getTemplate(pool, input.org, input.templateKey)
  if (!tpl || tpl.ownerNamespace !== input.namespace) {
    return fail('AGENT_TEMPLATE_NOT_OWNED', 400)
  }
  if (input.id && (input.id.startsWith('derived:') || input.id.startsWith('manual:'))) {
    return fail('RULE_ID_RESERVED', 403)
  }
  const rules = await listRules(pool, input.org)
  if (input.id) {
    const existing = rules.find((r) => r.id === input.id)
    if (existing?.ownerNamespace && existing.ownerNamespace !== input.namespace) {
      return fail('RULE_NOT_OWNED', 403)
    }
  }

  const disallowed = input.channels.filter((id) => !policy.allowed_channels.includes(id))
  if (disallowed.length > 0) return fail('CHANNEL_NOT_ALLOWED', 403, { channels: disallowed })
  const channelRows = await Promise.all(
    input.channels.map((id) => getChannel(pool, input.org, id)))
  if (channelRows.some((ch) => ch === null)) return fail('CHANNEL_UNKNOWN', 400)
  const external = channelRows.some(
    (ch) => ch !== null && isExternalProvider(ch.provider))

  const existingRule = input.id ? rules.find((r) => r.id === input.id) : undefined
  if (existingRule?.enabled !== true) {
    const active = await countActiveAgentRules(pool, input.org, input.namespace)
    if (active >= policy.max_active_rules) return fail('RULE_QUOTA_EXCEEDED', 429)
  }

  const [enabledChannels, publishedTemplates] = await Promise.all([
    listEnabledChannelIds(pool, input.org),
    listPublishedTemplateKeys(pool, input.org),
  ])
  const bad = validateRule({
    eventKey: input.eventKey,
    scope: input.scope ?? '*',
    recipientKey: input.recipientKey,
    recipientLiteral: input.recipientLiteral ?? null,
    recipientDepts: input.recipientDepts ?? null,
    templateKey: input.templateKey,
    channels: input.channels,
    cooldownMinutes: input.cooldownMinutes ?? null,
    origin: 'manual',
  }, decl, enabledChannels, publishedTemplates)
  if (bad) return fail(bad, 400)

  const id = input.id ?? `rule:${randomUUID()}`
  const alreadyApproved = external
    ? await hasApprovedRuleApproval(pool, input.org, id)
    : true
  const needsApproval = external && !policy.auto_publish_external && !alreadyApproved
  await upsertRule(pool, input.org, {
    id,
    enabled: !needsApproval,
    eventKey: input.eventKey,
    scope: input.scope ?? '*',
    recipientKey: input.recipientKey,
    recipientLiteral: input.recipientLiteral ?? null,
    recipientDepts: input.recipientDepts ?? null,
    templateKey: input.templateKey,
    channels: input.channels,
    cooldownMinutes: input.cooldownMinutes ?? null,
    origin: 'manual',
    ownerNamespace: input.namespace,
  }, input.userId)

  const approvalDetail = {
    eventKey: input.eventKey, templateKey: input.templateKey, channels: input.channels,
  }
  let approvalId: string | undefined
  if (needsApproval) {
    const pending = (await listApprovals(pool, input.org, 'pending'))
      .find((a) => a.kind === 'rule' && a.targetId === id)
    if (pending) {
      approvalId = pending.id
    } else {
      const ap = await createApproval(pool, input.org, {
        namespace: input.namespace, kind: 'rule', targetId: id,
        requestedBy: input.userId, detail: approvalDetail,
      })
      approvalId = ap.id
      await enqueueEvent(pool, {
        org: input.org,
        eventId: `approval:${ap.id}:pending`,
        eventKey: 'notify.approval.pending',
        scope: input.namespace,
        payload: {
          approvalId: ap.id, namespace: input.namespace, kind: 'rule',
          targetId: id, requestedBy: input.userId,
          summary: `${input.eventKey} → ${input.channels.join(', ')}`,
        },
        producer: 'notify',
      })
    }
  } else if (external && !alreadyApproved) {
    const ap = await createApproval(pool, input.org, {
      namespace: input.namespace, kind: 'rule', targetId: id,
      requestedBy: input.userId, status: 'approved',
      decidedBy: 'system:policy', reason: 'auto_publish_external',
      detail: approvalDetail,
    })
    approvalId = ap.id
  }

  const status = needsApproval ? 'pending' : 'enabled'
  await audit(pool, input.org, input.userId, 'agent.rule.upsert', id, {
    ...approvalDetail, status, approvalId: approvalId ?? null,
  })
  return { ok: true, id, status, approvalId }
}
