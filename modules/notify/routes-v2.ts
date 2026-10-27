// routes-v2.ts — 通知 v2 端点薄壳（expand 阶段；Task 15 rename 为 routes.ts）。
// 主体（org）只来自 identity.orgId，绝不读请求参数。
// 模块零认证：权限门禁由宿主按 manifest.api.internal 施加（未声明 = 不可达）。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { EventCatalogReader, Identity } from '@platform/sdk'
import { validatePayload } from '@platform/sdk'
import { validateRule } from './domain/rules-v2'
import {
  deleteRule, enqueueEvent, listDeliveries, listEnabledChannelIds, listInbox,
  listPublishedTemplateKeys, listRules, markInboxRead, setRuleEnabled, upsertRule,
} from './storage-v2'

type Vars = { Variables: { identity: Identity } }

export function createNotifyRouterV2(deps: {
  pool: Pool
  events?: EventCatalogReader
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

  return r
}
