// routes-v2.ts — 通知 v2 端点薄壳（expand 阶段；Task 15 rename 为 routes.ts）。
// 主体（org）只来自 identity.orgId，绝不读请求参数。
// 模块零认证：权限门禁由宿主按 manifest.api.internal 施加（未声明 = 不可达）。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { ChannelAddressResolver, EventCatalogReader, Identity } from '@platform/sdk'
import { validatePayload } from '@platform/sdk'
import { checkWecomHealth } from './domain/channel'
import { renderContents } from './domain/render'
import { validateRule } from './domain/rules'
import { validateContents } from './domain/template'
import {
  audit, channelConfigured, countRecentTestDeliveries, createTemplateRevision,
  deleteRule, enqueueEvent, getChannel, getTemplate, insertDelivery, listChannels,
  listDeliveries, listEnabledChannelIds, listInbox, listPublishedTemplateKeys, listRules,
  listTemplates, markInboxRead, patchChannel, publishTemplateRevision, retryDelivery,
  setChannelHealth, setRuleEnabled, upsertRule,
} from './storage'

type Vars = { Variables: { identity: Identity } }

export function createNotifyRouter(deps: {
  pool: Pool
  events?: EventCatalogReader
  addresses?: ChannelAddressResolver
}) {
  const r = new Hono<Vars>()
  const org = (c: { get: (k: 'identity') => unknown }) => (c.get('identity') as Identity).orgId

  r.get('/rules', async (c) => c.json({ rules: await listRules(deps.pool, org(c)) }))

  r.post('/rules', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      id?: string
      eventKey?: string
      scope?: string
      recipientKey?: string
      recipientLiteral?: string[] | null
      templateKey?: string
      channels?: string[]
      cooldownMinutes?: number | null
    } | null
    if (!body?.eventKey || !body.recipientKey || !body.templateKey || !body.channels) {
      return c.json({ error: 'RULE_INVALID_BODY' }, 400)
    }

    const decl = deps.events?.get(body.eventKey)
    if (!decl) return c.json({ error: 'RULE_EVENT_UNKNOWN' }, 400)

    const [channels, templates] = await Promise.all([
      listEnabledChannelIds(deps.pool, org(c)),
      listPublishedTemplateKeys(deps.pool, org(c)),
    ])
    const bad = validateRule({
      eventKey: body.eventKey,
      scope: body.scope ?? '*',
      recipientKey: body.recipientKey,
      recipientLiteral: body.recipientLiteral ?? null,
      templateKey: body.templateKey,
      channels: body.channels,
      cooldownMinutes: body.cooldownMinutes ?? null,
      origin: 'manual',
    }, decl, channels, templates)
    if (bad) return c.json({ error: bad }, 400)

    const id = body.id ?? `rule:${randomUUID()}`
    await upsertRule(deps.pool, org(c), {
      id,
      enabled: true,
      eventKey: body.eventKey,
      scope: body.scope ?? '*',
      recipientKey: body.recipientKey,
      recipientLiteral: body.recipientLiteral ?? null,
      templateKey: body.templateKey,
      channels: body.channels,
      cooldownMinutes: body.cooldownMinutes ?? null,
      origin: 'manual',
    }, (c.get('identity') as Identity).userId)
    return c.json({ id }, 201)
  })

  r.put('/rules/:id/enabled', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
    if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'RULE_INVALID_BODY' }, 400)
    const n = await setRuleEnabled(deps.pool, org(c), c.req.param('id'), body.enabled)
    if (n === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true })
  })

  r.delete('/rules/:id', async (c) => {
    const n = await deleteRule(deps.pool, org(c), c.req.param('id'))
    if (n === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true })
  })

  r.get('/deliveries', async (c) =>
    c.json({ deliveries: await listDeliveries(deps.pool, org(c)) }))

  // 外部生产者（case-engine 等）：PAT + notify:emit；org 只来自 identity
  r.post('/emit', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      eventId?: string
      eventKey?: string
      scope?: string
      payload?: Record<string, unknown>
    } | null
    if (!body?.eventId || !body.eventKey) return c.json({ error: 'EMIT_INVALID_BODY' }, 400)

    const decl = deps.events?.get(body.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const payload = body.payload ?? {}
    const bad = validatePayload(decl, payload)
    if (bad) return c.json({ error: 'PAYLOAD_INVALID', detail: bad }, 400)

    const result = await enqueueEvent(deps.pool, {
      org: org(c),
      eventId: body.eventId,
      eventKey: body.eventKey,
      scope: body.scope ?? '*',
      payload,
      producer: 'external',
    })
    return c.json(result, 202)
  })

  r.get('/inbox', async (c) => {
    const identity = c.get('identity') as Identity
    const unread = c.req.query('unread') === '1'
    return c.json({ items: await listInbox(deps.pool, identity.orgId, identity.userId, unread) })
  })

  r.post('/inbox/:id/read', async (c) => {
    const identity = c.get('identity') as Identity
    await markInboxRead(deps.pool, identity.orgId, identity.userId, c.req.param('id'))
    return c.json({ ok: true })
  })

  // ── 事件目录（只读；来自宿主注入的 reader）──────────────────────────────────
  r.get('/events', async (c) => c.json({ events: deps.events?.list() ?? [] }))

  r.get('/events/:key', async (c) => {
    const ev = deps.events?.get(c.req.param('key'))
    return ev ? c.json(ev) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  // ── 模板：草稿 / 预览 / 发布 ────────────────────────────────────────────────
  r.get('/templates', async (c) => c.json({ templates: await listTemplates(deps.pool, org(c)) }))

  r.get('/templates/:key', async (c) => {
    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    return t ? c.json(t) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  r.post('/templates/:key/revisions', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      contents?: Record<string, Record<string, string>>
    } | null
    if (!body?.contents) return c.json({ error: 'INVALID_BODY' }, 400)

    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    if (!t) return c.json({ error: 'NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const channels = await listChannels(deps.pool, org(c))
    const providers = [...new Set(channels.filter((x) => x.enabled).map((x) => x.provider))]
    const issues = validateContents(body.contents, decl,
      providers.length > 0 ? providers : Object.keys(body.contents))
    if (issues.length > 0) return c.json({ error: 'TEMPLATE_INVALID', issues }, 400)

    const actor = (c.get('identity') as Identity).userId
    const r = await createTemplateRevision(deps.pool, org(c), t.key, body.contents, actor)
    await audit(deps.pool, org(c), actor, 'template.draft', t.key, { revision: r.revision })
    return c.json(r, 201)
  })

  r.post('/templates/:key/preview', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      contents?: Record<string, Record<string, string>>
      revision?: number
      payload?: Record<string, unknown>
    } | null
    if (!body?.payload) return c.json({ error: 'INVALID_BODY' }, 400)

    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    if (!t) return c.json({ error: 'NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const contents = body.contents
      ?? t.revisions.find((x) => x.revision === (body.revision ?? t.publishedRevision))?.contents
    if (!contents) return c.json({ error: 'REVISION_NOT_FOUND' }, 404)

    const issues = validateContents(contents, decl, Object.keys(contents))
    if (issues.length > 0) return c.json({ error: 'TEMPLATE_RENDER_FAILED', issues }, 400)

    const rendered = renderContents(contents, body.payload, Object.keys(contents))
    if (!rendered.ok) return c.json({ error: 'TEMPLATE_RENDER_FAILED', issues: rendered.issues }, 400)
    return c.json({ rendered: rendered.rendered })
  })

  r.post('/templates/:key/publish', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { revision?: number } | null
    if (!body?.revision) return c.json({ error: 'INVALID_BODY' }, 400)

    const t = await getTemplate(deps.pool, org(c), c.req.param('key'))
    if (!t) return c.json({ error: 'NOT_FOUND' }, 404)
    const rev = t.revisions.find((x) => x.revision === body.revision)
    if (!rev) return c.json({ error: 'REVISION_NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const channels = await listChannels(deps.pool, org(c))
    const providers = [...new Set(channels.filter((x) => x.enabled).map((x) => x.provider))]
    const issues = validateContents(rev.contents, decl,
      providers.length > 0 ? providers : Object.keys(rev.contents))
    if (issues.length > 0) return c.json({ error: 'TEMPLATE_INVALID', issues }, 400)

    const actor = (c.get('identity') as Identity).userId
    await publishTemplateRevision(deps.pool, org(c), t.key, rev.revision, actor)
    await audit(deps.pool, org(c), actor, 'template.publish', t.key, { revision: rev.revision })
    return c.json({ publishedRevision: rev.revision })
  })

  // ── 通道：列表 / 配置 / 健康 ────────────────────────────────────────────────
  r.get('/channels', async (c) => {
    const list = await listChannels(deps.pool, org(c))
    return c.json({
      channels: list.map((x) => ({ ...x, configured: channelConfigured(x.secretRefs) })),
    })
  })

  r.patch('/channels/:id', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return c.json({ error: 'INVALID_BODY' }, 400)
    if ('secret_refs' in body || 'secretRefs' in body) {
      return c.json({ error: 'SECRET_REFS_READONLY' }, 400)
    }
    const allowed = new Set(['enabled', 'config'])
    if (Object.keys(body).some((k) => !allowed.has(k))) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const config = body.config as Record<string, unknown> | undefined
    if (config && Object.keys(config).some((k) =>
      !['address_fallback', 'rate_limit_per_min', 'timeout_ms'].includes(k))) {
      return c.json({ error: 'CONFIG_KEY_INVALID' }, 400)
    }

    const n = await patchChannel(deps.pool, org(c), c.req.param('id'), {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : undefined,
      config,
    }, (c.get('identity') as Identity).userId)
    return n === 0 ? c.json({ error: 'NOT_FOUND' }, 404) : c.json({ ok: true })
  })

  r.post('/channels/:id/health', async (c) => {
    const ch = await getChannel(deps.pool, org(c), c.req.param('id'))
    if (!ch) return c.json({ error: 'NOT_FOUND' }, 404)

    let result: { ok: boolean; detail?: string } = { ok: true }
    if (ch.provider === 'wecom_chat') {
      const envKey = ch.secret_refs.bridge_url
      const bridgeUrl = envKey ? process.env[envKey] : undefined
      result = bridgeUrl
        ? await checkWecomHealth(bridgeUrl)
        : { ok: false, detail: 'bridge_url env 未配置' }
    }
    await setChannelHealth(deps.pool, org(c), ch.id, result.ok ? 'ok' : 'error', result.detail)
    return c.json(result)
  })

  // ── 测试发送：收件人强制 = 调用者本人 ──────────────────────────────────────
  r.post('/test-send', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      templateKey?: string
      channel?: string
      payload?: Record<string, unknown>
      recipient?: string
    } | null
    if (!body?.templateKey || !body.channel || !body.payload) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }

    const identity = c.get('identity') as Identity
    const recent = await countRecentTestDeliveries(deps.pool, identity.orgId, identity.userId)
    if (recent >= 5) return c.json({ error: 'TEST_RATE_LIMITED' }, 429)

    const t = await getTemplate(deps.pool, identity.orgId, body.templateKey)
    const rev = t?.revisions.find((x) => x.revision === t.publishedRevision)
    if (!t || !rev) return c.json({ error: 'NOT_FOUND' }, 404)
    const decl = deps.events?.get(t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const bad = validatePayload(decl, body.payload)
    if (bad) return c.json({ error: 'PAYLOAD_INVALID', detail: bad }, 400)

    const rendered = renderContents(rev.contents, body.payload, Object.keys(rev.contents))
    if (!rendered.ok) return c.json({ error: 'TEMPLATE_RENDER_FAILED', issues: rendered.issues }, 400)

    const ch = await getChannel(deps.pool, identity.orgId, body.channel)
    if (!ch || !ch.enabled) return c.json({ error: 'CHANNEL_NOT_FOUND' }, 404)

    const resolved = await deps.addresses?.resolve({
      org: identity.orgId, provider: ch.provider, casdoorName: identity.userId,
    })
    const address = resolved
      ?? (ch.provider === 'wecom_chat' && ch.config.address_fallback === 'casdoor_name'
        ? identity.userId
        : null)
    if (!address && ch.provider !== 'in_app') return c.json({ error: 'MISSING_ADDRESS' }, 400)

    await insertDelivery(deps.pool, {
      org: identity.orgId,
      eventId: `test:${randomUUID()}`,
      eventKey: t.eventKey,
      ruleId: 'test',
      recipient: identity.userId,
      channel: ch.id,
      address: address ?? identity.userId,
      templateKey: t.key,
      revision: rev.revision,
      rendered: rendered.rendered[ch.provider] ?? {},
      status: 'pending',
      isTest: true,
    })
    await audit(deps.pool, identity.orgId, identity.userId, 'test.send', t.key, { channel: ch.id })
    return c.json({ accepted: true }, 202)
  })

  // ── 手动重试（仅 failed/dead）──────────────────────────────────────────────
  r.post('/deliveries/retry', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      eventId?: string
      ruleId?: string
      recipient?: string
      channel?: string
    } | null
    if (!body?.eventId || !body.ruleId || !body.recipient || !body.channel) {
      return c.json({ error: 'INVALID_BODY' }, 400)
    }
    const n = await retryDelivery(deps.pool, org(c), {
      eventId: body.eventId, ruleId: body.ruleId,
      recipient: body.recipient, channel: body.channel,
    })
    if (n === 0) return c.json({ error: 'NOT_RETRYABLE' }, 404)
    await audit(deps.pool, org(c), (c.get('identity') as Identity).userId,
      'delivery.retry', `${body.eventId}|${body.ruleId}`, body)
    return c.json({ ok: true })
  })

  return r
}
