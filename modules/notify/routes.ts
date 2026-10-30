// routes-v2.ts — 通知 v2 端点薄壳（expand 阶段；Task 15 rename 为 routes.ts）。
// 主体（org）只来自 identity.orgId，绝不读请求参数。
// 模块零认证：权限门禁由宿主按 manifest.api.internal 施加（未声明 = 不可达）。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type { ChannelAddressResolver, EventCatalogReader, Identity } from '@platform/sdk'
import { validatePayload } from '@platform/sdk'
import { checkWecomHealth, checkWebhookHealth } from './domain/channel'
import { resolveDeliverability, type DeliverabilityDeps } from './domain/deliverability'
import { renderContents } from './domain/render'
import { validateRule } from './domain/rules'
import { samplePayload, validateContents } from './domain/template'
import { registerNotifyMcpManage } from './mcp'
import {
  audit, channelConfigured, countRecentTestDeliveries, createTemplateRevision,
  deleteRule, enqueueEvent, getChannel, getPublishedTemplate, getTemplate, insertDelivery, listChannels,
  listDeliveries, listEnabledChannelIds, listInbox, listPublishedTemplateKeys, listRules,
  listTemplates, markAllInboxRead, markInboxRead, patchChannel, publishTemplateRevision, retryDelivery,
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

  /**
   * 把模块 storage + 注入的 events/addresses 适配成 deliverability 依赖（**唯一一处**）。
   * worker 有自己的适配（它直连 storage），但解析逻辑是同一个 `resolveDeliverability`。
   */
  const ddeps: DeliverabilityDeps = {
    getEventDecl: async (key) => deps.events?.get(key) ?? null,
    getPublishedTemplate: async (o, key) => {
      const t = await getPublishedTemplate(deps.pool, o, key)
      return t ? { revision: t.revision, contents: t.contents } : null
    },
    getChannel: async (o, id) => {
      const ch = await getChannel(deps.pool, o, id)
      // `configured`：secret_refs 的 env 键在本进程是否齐全（与 /channels 的判定同一函数）
      return ch
        ? { id, provider: ch.provider, enabled: ch.enabled, config: ch.config, configured: channelConfigured(ch.secret_refs) }
        : null
    },
    resolveScopeHolders: async (o, key, decl) =>
      deps.addresses?.resolveScopeHolders?.(o, key, decl) ?? [],
    // 部门展开：**不兜底成空数组**——未注入时要落 dept_resolver_unavailable（见 domain 的注），
    // 这里返回 undefined 会让 resolveDeliverability 走那条分支。
    resolveDeptMembers: deps.addresses?.resolveDeptMembers?.bind(deps.addresses),
  }

  r.get('/rules', async (c) => c.json({ rules: await listRules(deps.pool, org(c)) }))

  /**
   * 部门选择器（组织架构 Phase C；#1174）：规则里能选的部门。
   * 数据来自宿主注入的 `listOrgNodes`（模块读不到 platform.org_*——B1）；
   * **未注入 / 未同步**都回空数组，由前端提示「先在企业微信同步组织架构」——
   * 这与写规则的 fail-closed 一致（空集时选了也发不出去，见 validateDeptIds）。
   */
  r.get('/org-depts', async (c) => {
    const list = await deps.addresses?.listOrgNodes?.(org(c)) ?? []
    return c.json({ depts: list, available: deps.addresses?.listOrgNodes !== undefined })
  })

  // ── 可送达性预检（只读，D3）：回答「会发给谁 / 为什么发不出去」─────────────
  // 与投递期共用 `resolveDeliverability`（单一实现）⇒ 不会「预检说能发、实际发不出」。
  const resolveFor = async (
    o: string,
    id: string,
    mode: 'sample' | 'payload',
    payload?: Record<string, unknown>,
  ) => {
    const rule = (await listRules(deps.pool, o)).find((x) => x.id === id)
    if (!rule) return { notFound: true as const }
    const decl = deps.events?.get(rule.eventKey)
    if (!decl) return { eventMissing: true as const }

    const warnings: string[] = []
    // 「查不了」≠「没人持有」：解析器未注入时必须显式说出来
    if (!deps.addresses?.resolveScopeHolders) warnings.push('scope_holders_unavailable')
    if (!deps.addresses?.resolveDeptMembers) warnings.push('dept_resolver_unavailable')
    // sample 模式下 field 类的 user 值是占位符，解析不到真实用户
    if (mode === 'sample') warnings.push('sample_mode_field_recipients_unverified')

    const r2 = await resolveDeliverability(
      { org: o, rule, payload: payload ?? samplePayload(decl) },
      ddeps,
    )
    // 启用了但没配的通道：以前要等真发失败（每个收件人一条 secret_missing）才看得见
    for (const id of r2.unconfiguredChannels) warnings.push(`channel_unconfigured:${id}`)
    return {
      body: {
        ruleId: rule.id, eventKey: rule.eventKey, scope: rule.scope, mode,
        blocked: r2.blocked, recipients: r2.recipients, channels: r2.channels, warnings,
        // 部门规则的展开三数（「将发送给 N 人 / 排除 M / 未解析 K」的唯一来源）
        deptExpansion: r2.deptExpansion,
      },
    }
  }

  r.get('/rules/deliverability', async (c) => {
    const o = org(c)
    const out: Array<{
      ruleId: string; eventKey: string; blocked: string | null; recipientCount: number
      /** 启用了但没配（env 键缺失）的通道 id —— 前端据此标「未配置」，不等真发失败 */
      unconfiguredChannels: string[]
    }> = []
    for (const rule of await listRules(deps.pool, o)) {
      const decl = deps.events?.get(rule.eventKey)
      const r2 = await resolveDeliverability(
        { org: o, rule, payload: decl ? samplePayload(decl) : {} },
        ddeps,
      )
      out.push({
        ruleId: rule.id, eventKey: rule.eventKey,
        blocked: r2.blocked, recipientCount: r2.recipients.length,
        unconfiguredChannels: r2.unconfiguredChannels,
      })
    }
    return c.json({ rules: out })
  })

  r.get('/rules/:id/resolve', async (c) => {
    const res = await resolveFor(org(c), c.req.param('id'), 'sample')
    if ('notFound' in res) return c.json({ error: 'NOT_FOUND' }, 404)
    if ('eventMissing' in res) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    return c.json(res.body)
  })

  r.post('/rules/:id/resolve', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      { payload?: Record<string, unknown> } | null
    if (!body?.payload) return c.json({ error: 'INVALID_BODY' }, 400)
    const res = await resolveFor(org(c), c.req.param('id'), 'payload', body.payload)
    if ('notFound' in res) return c.json({ error: 'NOT_FOUND' }, 404)
    if ('eventMissing' in res) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    return c.json(res.body)
  })

  r.post('/rules', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      id?: string
      eventKey?: string
      scope?: string
      recipientKey?: string
      recipientLiteral?: string[] | null
      /** kind=dept 才用：所选部门 ext_id（发送时展开含子树） */
      recipientDepts?: string[] | null
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
      recipientDepts: body.recipientDepts ?? null,
      templateKey: body.templateKey,
      channels: body.channels,
      cooldownMinutes: body.cooldownMinutes ?? null,
      origin: 'manual',
    }, decl, channels, templates)
    if (bad) return c.json({ error: bad }, 400)

    // ── 部门 id 的配置期校验（组织架构 Phase C；与报表部门门同一套 fail-closed）──────
    // 未知 ext_id ⇒ 400；组织架构未同步（或宿主没注入选择器）⇒ 409：这两种状态下「配了也恒
    // 发不出去」，当场拒掉比让它上线后静默 0 收件人好。位置在**任何写之前**。
    const depts = body.recipientDepts ?? []
    if (depts.length > 0) {
      const nodes = deps.addresses?.listOrgNodes === undefined
        ? null
        : await deps.addresses.listOrgNodes(org(c))
      if (nodes === null) return c.json({ error: 'ORG_RESOLVER_UNAVAILABLE' }, 409)
      if (nodes.length === 0) return c.json({ error: 'ORG_NOT_SYNCED' }, 409)
      const known = new Set(nodes.map((n) => n.extId))
      const unknown = [...new Set(depts)].filter((d) => !known.has(d))
      if (unknown.length > 0) return c.json({ error: 'RULE_DEPT_UNKNOWN', unknown }, 400)
    }

    const id = body.id ?? `rule:${randomUUID()}`
    await upsertRule(deps.pool, org(c), {
      id,
      enabled: true,
      eventKey: body.eventKey,
      scope: body.scope ?? '*',
      recipientKey: body.recipientKey,
      recipientLiteral: body.recipientLiteral ?? null,
      recipientDepts: body.recipientDepts ?? null,
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

  r.post('/inbox/read-all', async (c) => {
    const identity = c.get('identity') as Identity
    const marked = await markAllInboxRead(deps.pool, identity.orgId, identity.userId)
    return c.json({ marked })
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
    } else if (ch.provider === 'webhook') {
      const urlKey = ch.secret_refs.url
      const keyKey = ch.secret_refs.key
      const hookUrl = urlKey ? process.env[urlKey] : undefined
      const hookSecret = keyKey ? process.env[keyKey] : undefined
      result = hookUrl && hookSecret
        ? await checkWebhookHealth({ url: hookUrl, key: hookSecret })
        : { ok: false, detail: 'webhook url/key env 未配置' }
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

  registerNotifyMcpManage(r, {
    pool: deps.pool, events: deps.events, addresses: deps.addresses,
  })

  return r
}
