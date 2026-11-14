// routes-v2.ts — 通知 v2 端点薄壳（expand 阶段；Task 15 rename 为 routes.ts）。
// 主体（org）只来自 identity.orgId，绝不读请求参数。
// 模块零认证：权限门禁由宿主按 manifest.api.internal 施加（未声明 = 不可达）。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import type {
  ChannelAddressResolver, EventCatalogReader, Identity, NotificationEventDecl,
} from '@platform/sdk'
import { validatePayload } from '@platform/sdk'
import {
  AGENT_TEMPLATE_KEY_RE, NAMESPACE_RE, isAgentEventKey, validateAgentEventDecl,
} from './domain/agent-event'
import { agentMessageKey, isAgentMessageKey } from './domain/agent-message'
import {
  isExternalProvider, mergeAgentPolicy, parseAgentPolicy,
} from './domain/agent-policy'
import { checkWecomHealth, checkWebhookHealth } from './domain/channel'
import { resolveDeliverability, type DeliverabilityDeps } from './domain/deliverability'
import { channelIsConfigured } from './domain/channel-config'
import { listAddressIssues } from './domain/delivery-stats'
import { resolveDeliveryAddress } from './domain/resolve-address'
import { renderContents } from './domain/render'
import { validateRule } from './domain/rules'
import { samplePayload, validateContents } from './domain/template'
import { registerNotifyMcpManage } from './mcp'
import {
  audit, countActiveAgentRules, countAgentMessagesToday, countRecentTestDeliveries,
  createAgentNamespace, createApproval, createTemplate, createTemplateRevision,
  decideApproval, deleteRule, ensureAgentMessageDefaults, enqueueEvent, getAgentNamespace,
  getApproval, getChannel, getEventDecl, getPublishedTemplate, getTemplate,
  hasApprovedRuleApproval, insertDelivery, listAgentNamespaces, listApprovals, listChannels,
  listDeliveries, listEnabledChannelIds, listEventDecls, listInbox, listPublishedTemplateKeys,
  listRules, listTemplates, markAllInboxRead, markInboxRead, patchChannel,
  publishTemplateRevision, retryDelivery, setAgentNamespacePolicy, setChannelHealth,
  setRuleEnabled, upsertEventDecl, upsertRule,
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
   * 统一事件解析：`ext.*` 走租户/agent 声明（N1 双平面），其余走 manifest 内存目录。
   * HTTP / preflight / MCP / worker 必须共用同一套顺序。
   */
  const resolveEventDecl = async (o: string, key: string): Promise<NotificationEventDecl | null> =>
    key.startsWith('ext.')
      ? getEventDecl(deps.pool, o, key)
      : deps.events?.get(key) ?? null

  /** agent 资源写权限：namespace 存在、active、owner = 调用者。 */
  const ownsNamespace = async (
    o: string, namespace: string, identity: Identity,
  ): Promise<boolean> => {
    const ns = await getAgentNamespace(deps.pool, o, namespace)
    return ns !== null && ns.status === 'active' && ns.ownerUserId === identity.userId
  }

  /**
   * 把模块 storage + 注入的 events/addresses 适配成 deliverability 依赖（**唯一一处**）。
   * worker 有自己的适配（它直连 storage），但解析逻辑是同一个 `resolveDeliverability`。
   */
  const ddeps: DeliverabilityDeps = {
    getEventDecl: resolveEventDecl,
    getPublishedTemplate: async (o, key) => {
      const t = await getPublishedTemplate(deps.pool, o, key)
      return t ? { revision: t.revision, contents: t.contents } : null
    },
    getChannel: async (o, id) => {
      const ch = await getChannel(deps.pool, o, id)
      // `configured`：直连看凭据、桥看 secret_refs 的 env 键（与 /channels 同一实现）
      return ch
        ? { id, provider: ch.provider, enabled: ch.enabled, config: ch.config, configured: await channelIsConfigured(deps.pool, o, ch) }
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
    const decl = await resolveEventDecl(o, rule.eventKey)
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
      const decl = await resolveEventDecl(o, rule.eventKey)
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

    const decl = await resolveEventDecl(org(c), body.eventKey)
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

    const identity = c.get('identity') as Identity
    // agent 规则按 owner_namespace 隔离：非 owner 不得通过通用 /rules 覆盖；
    // owner 通过通用路由更新时也**保留** owner_namespace，不能把 agent 规则降成租户规则。
    let ownerNamespace: string | null = null
    if (body.id) {
      const existing = (await listRules(deps.pool, org(c))).find((r) => r.id === body.id)
      if (existing?.ownerNamespace) {
        if (!await ownsNamespace(org(c), existing.ownerNamespace, identity)) {
          return c.json({ error: 'RULE_NOT_OWNED' }, 403)
        }
        ownerNamespace = existing.ownerNamespace
      }
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
      ownerNamespace,
    }, identity.userId)
    return c.json({ id }, 201)
  })

  r.put('/rules/:id/enabled', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { enabled?: boolean } | null
    if (!body || typeof body.enabled !== 'boolean') return c.json({ error: 'RULE_INVALID_BODY' }, 400)
    const identity = c.get('identity') as Identity
    const id = c.req.param('id')
    const rule = (await listRules(deps.pool, org(c))).find((r) => r.id === id)
    if (rule?.ownerNamespace && !await ownsNamespace(org(c), rule.ownerNamespace, identity)) {
      return c.json({ error: 'RULE_NOT_OWNED' }, 403)
    }
    if (body.enabled && rule?.ownerNamespace) {
      const channelRows = await Promise.all(
        rule.channels.map((cid) => getChannel(deps.pool, org(c), cid)))
      const external = channelRows.some(
        (ch) => ch !== null && isExternalProvider(ch.provider))
      if (external && !await hasApprovedRuleApproval(deps.pool, org(c), id)) {
        return c.json({ error: 'APPROVAL_REQUIRED' }, 403)
      }
    }
    const n = await setRuleEnabled(deps.pool, org(c), id, body.enabled)
    if (n === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true })
  })

  r.delete('/rules/:id', async (c) => {
    const identity = c.get('identity') as Identity
    const id = c.req.param('id')
    const rule = (await listRules(deps.pool, org(c))).find((r) => r.id === id)
    if (rule?.ownerNamespace && !await ownsNamespace(org(c), rule.ownerNamespace, identity)) {
      return c.json({ error: 'RULE_NOT_OWNED' }, 403)
    }
    const n = await deleteRule(deps.pool, org(c), id)
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

    const decl = await resolveEventDecl(org(c), body.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const identity = c.get('identity') as Identity
    // ext 事件必须由 namespace owner 发；持 notify:manage 的租户管理员可代发。
    if (body.eventKey.startsWith('ext.')) {
      const ns = body.eventKey.split('.')[1]
      const nsRow = ns ? await getAgentNamespace(deps.pool, identity.orgId, ns) : null
      if (!nsRow || nsRow.status !== 'active'
          || (nsRow.ownerUserId !== identity.userId && !identity.hasScope('notify:manage'))) {
        return c.json({ error: 'AGENT_NAMESPACE_FORBIDDEN' }, 403)
      }
    }

    const payload = body.payload ?? {}
    const bad = validatePayload(decl, payload)
    if (bad) return c.json({ error: 'PAYLOAD_INVALID', detail: bad }, 400)

    const result = await enqueueEvent(deps.pool, {
      org: identity.orgId,
      eventId: body.eventId,
      eventKey: body.eventKey,
      scope: body.scope ?? '*',
      payload,
      producer: body.eventKey.startsWith('ext.')
        ? `ext:${body.eventKey.split('.')[1]}`
        : 'external',
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

  // ── 事件目录（只读；平台 manifest + 租户/agent 声明 N1 双平面）────────────────
  r.get('/events', async (c) => {
    const platform = (deps.events?.list() ?? []).map((e) => ({ ...e, source: 'platform' as const }))
    const tenant = (await listEventDecls(deps.pool, org(c)))
      .map((e) => ({ ...e, source: 'agent' as const }))
    return c.json({ events: [...platform, ...tenant] })
  })

  r.get('/events/:key', async (c) => {
    const ev = await resolveEventDecl(org(c), c.req.param('key'))
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
    const identity = c.get('identity') as Identity
    if (t.ownerNamespace && !await ownsNamespace(org(c), t.ownerNamespace, identity)) {
      return c.json({ error: 'AGENT_TEMPLATE_FORBIDDEN' }, 403)
    }
    const decl = await resolveEventDecl(org(c), t.eventKey)
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
    const decl = await resolveEventDecl(org(c), t.eventKey)
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
    const identity = c.get('identity') as Identity
    if (t.ownerNamespace && !await ownsNamespace(org(c), t.ownerNamespace, identity)) {
      return c.json({ error: 'AGENT_TEMPLATE_FORBIDDEN' }, 403)
    }
    const rev = t.revisions.find((x) => x.revision === body.revision)
    if (!rev) return c.json({ error: 'REVISION_NOT_FOUND' }, 404)
    const decl = await resolveEventDecl(org(c), t.eventKey)
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
  // 「谁收不到」的读面（plan 2026-10-31 Phase 2 / #1225）：按收件人聚合永久失败，只读。
  // 挂在 /channels/address-issues：与通道配置同一屏，且静态路径优先于任何 /channels/:id。
  r.get('/channels/address-issues', async (c) => c.json({ issues: await listAddressIssues(deps.pool, org(c)) }))

  r.get('/channels', async (c) => {
    const o = org(c)
    const list = await listChannels(deps.pool, o)
    return c.json({
      channels: await Promise.all(
        list.map(async (x) => ({ ...x, configured: await channelIsConfigured(deps.pool, o, x) })),
      ),
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
      !['address_fallback', 'rate_limit_per_min', 'timeout_ms', 'transport'].includes(k))) {
      return c.json({ error: 'CONFIG_KEY_INVALID' }, 400)
    }
    // transport 是**迁移开关**（spec 2026-10-31 §3.5）：只接受两个值，写错了必须当场拒——
    // 写成 'Direct'/true 之类会让通道静默落回桥，那正是「配错了直连」被伪装成正常的老路。
    if (config && 'transport' in config && config.transport !== 'direct' && config.transport !== 'bridge') {
      return c.json({ error: 'CONFIG_VALUE_INVALID', detail: "transport 只能是 'direct' 或 'bridge'" }, 400)
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
    const decl = await resolveEventDecl(org(c), t.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)

    const bad = validatePayload(decl, body.payload)
    if (bad) return c.json({ error: 'PAYLOAD_INVALID', detail: bad }, 400)

    const rendered = renderContents(rev.contents, body.payload, Object.keys(rev.contents))
    if (!rendered.ok) return c.json({ error: 'TEMPLATE_RENDER_FAILED', issues: rendered.issues }, 400)

    const ch = await getChannel(deps.pool, identity.orgId, body.channel)
    if (!ch || !ch.enabled) return c.json({ error: 'CHANNEL_NOT_FOUND' }, 404)

    const address = await resolveDeliveryAddress(deps.addresses?.resolve, ch, {
      org: identity.orgId, casdoorName: identity.userId,
    })
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

  // ── 租户/agent 命名空间与事件声明（N1 双平面）──────────────────────────────
  r.get('/agent/namespaces', async (c) =>
    c.json({ namespaces: await listAgentNamespaces(deps.pool, org(c)) }))

  r.post('/agent/namespaces', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      namespace?: string
      displayName?: string
      policy?: Record<string, unknown>
    } | null
    if (!body?.namespace || !NAMESPACE_RE.test(body.namespace)) {
      return c.json({ error: 'AGENT_NAMESPACE_INVALID' }, 400)
    }
    const identity = c.get('identity') as Identity
    const r = await createAgentNamespace(deps.pool, identity.orgId, {
      namespace: body.namespace,
      displayName: body.displayName?.trim() || body.namespace,
      ownerUserId: identity.userId,
      policy: body.policy && typeof body.policy === 'object' && !Array.isArray(body.policy)
        ? body.policy
        : undefined,
    })
    if (!r.created && r.row.ownerUserId !== identity.userId) {
      return c.json({ error: 'AGENT_NAMESPACE_TAKEN' }, 409)
    }
    const generic = await ensureAgentMessageDefaults(
      deps.pool, identity.orgId, r.row.namespace, identity.userId)
    await audit(deps.pool, identity.orgId, identity.userId,
      'agent.namespace.create', r.row.namespace, { created: r.created, generic })
    return c.json(
      {
        namespace: r.row.namespace, owner: r.row.ownerUserId,
        created: r.created, genericMessage: generic,
      },
      r.created ? 201 : 200,
    )
  })

  r.get('/agent/events', async (c) => {
    const namespace = c.req.query('namespace')
    return c.json({
      events: await listEventDecls(deps.pool, org(c), namespace || undefined),
    })
  })

  r.get('/agent/events/:key', async (c) => {
    const ev = await getEventDecl(deps.pool, org(c), c.req.param('key'))
    return ev ? c.json(ev) : c.json({ error: 'NOT_FOUND' }, 404)
  })

  r.post('/agent/events', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      key?: string
      title?: string
      description?: string
      scope?: { key: string; label?: string }
      payload?: Record<string, unknown>
      recipients?: Record<string, unknown>
      defaults?: { recipient: string; template: string; channels: string[] }
    } | null
    if (!body?.key || !body.title || !body.payload || !body.recipients) {
      return c.json({ error: 'AGENT_EVENT_INVALID_BODY' }, 400)
    }
    if (!isAgentEventKey(body.key)) return c.json({ error: 'AGENT_EVENT_KEY_INVALID' }, 400)
    if (isAgentMessageKey(body.key)) return c.json({ error: 'AGENT_EVENT_RESERVED' }, 400)
    const parts = body.key.split('.')
    if (parts.length !== 3 || !parts[1]) {
      return c.json({ error: 'AGENT_EVENT_KEY_INVALID' }, 400)
    }
    const namespace = parts[1]
    const identity = c.get('identity') as Identity
    const ns = await getAgentNamespace(deps.pool, identity.orgId, namespace)
    if (!ns) return c.json({ error: 'AGENT_NAMESPACE_NOT_FOUND' }, 404)
    if (ns.status !== 'active') return c.json({ error: 'AGENT_NAMESPACE_DISABLED' }, 409)
    if (ns.ownerUserId !== identity.userId) {
      return c.json({ error: 'AGENT_NAMESPACE_FORBIDDEN' }, 403)
    }

    const decl: NotificationEventDecl = {
      key: body.key,
      title: body.title,
      description: body.description,
      scope: body.scope,
      payload: body.payload as NotificationEventDecl['payload'],
      recipients: body.recipients as NotificationEventDecl['recipients'],
      defaults: body.defaults,
    }
    const issues = validateAgentEventDecl(decl)
    if (issues.length > 0) {
      return c.json({ error: 'AGENT_EVENT_INVALID', issues }, 400)
    }

    const res = await upsertEventDecl(deps.pool, identity.orgId, namespace, decl, identity.userId)
    if (!res.ok) {
      return c.json({ error: 'AGENT_EVENT_SCHEMA_BREAKING', issues: res.issues }, 409)
    }
    await audit(deps.pool, identity.orgId, identity.userId,
      'agent.event.upsert', decl.key, { version: res.version, created: res.created })
    return c.json(
      { key: decl.key, version: res.version, created: res.created },
      res.created ? 201 : 200,
    )
  })

  // ── agent 模板 / 规则 / 通用消息（N2）──────────────────────────────────────
  r.get('/agent/templates', async (c) => {
    const namespace = c.req.query('namespace')
    const templates = (await listTemplates(deps.pool, org(c)))
      .filter((t) => namespace ? t.ownerNamespace === namespace : t.ownerNamespace != null)
    return c.json({ templates })
  })

  r.post('/agent/templates', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      namespace?: string
      key?: string
      name?: string
      eventKey?: string
      contents?: Record<string, Record<string, string>>
      publish?: boolean
    } | null
    if (!b?.namespace || !b.key || !b.name || !b.eventKey || !b.contents) {
      return c.json({ error: 'AGENT_TEMPLATE_INVALID_BODY' }, 400)
    }
    if (!AGENT_TEMPLATE_KEY_RE.test(b.key)) {
      return c.json({ error: 'AGENT_TEMPLATE_KEY_INVALID' }, 400)
    }
    const identity = c.get('identity') as Identity
    if (!await ownsNamespace(org(c), b.namespace, identity)) {
      return c.json({ error: 'AGENT_NAMESPACE_FORBIDDEN' }, 403)
    }
    if (!b.eventKey.startsWith(`ext.${b.namespace}.`) || isAgentMessageKey(b.eventKey)) {
      return c.json({ error: 'AGENT_EVENT_NOT_OWNED' }, 400)
    }
    const decl = await getEventDecl(deps.pool, org(c), b.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    const issues = validateContents(b.contents, decl, Object.keys(b.contents))
    if (issues.length > 0) return c.json({ error: 'TEMPLATE_INVALID', issues }, 400)

    const created = await createTemplate(deps.pool, org(c), {
      key: b.key, name: b.name, eventKey: b.eventKey,
      ownerNamespace: b.namespace, actor: identity.userId,
    })
    if (!created.ok) return c.json({ error: 'TEMPLATE_KEY_TAKEN' }, 409)
    const rev = await createTemplateRevision(
      deps.pool, org(c), b.key, b.contents, identity.userId)
    let published = false
    if (b.publish === true) {
      if (!identity.hasScope('notify:publish')) {
        return c.json({ error: 'PUBLISH_FORBIDDEN' }, 403)
      }
      await publishTemplateRevision(deps.pool, org(c), b.key, rev.revision, identity.userId)
      published = true
    }
    await audit(deps.pool, org(c), identity.userId, 'agent.template.upsert', b.key, {
      revision: rev.revision, published,
    })
    return c.json(
      { key: b.key, revision: rev.revision, published },
      created.created ? 201 : 200,
    )
  })

  r.get('/agent/rules', async (c) => {
    const namespace = c.req.query('namespace')
    const rules = (await listRules(deps.pool, org(c)))
      .filter((r) => namespace ? r.ownerNamespace === namespace : r.ownerNamespace != null)
    return c.json({ rules })
  })

  r.post('/agent/rules', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      namespace?: string
      id?: string
      eventKey?: string
      scope?: string
      recipientKey?: string
      recipientLiteral?: string[] | null
      recipientDepts?: string[] | null
      templateKey?: string
      channels?: string[]
      cooldownMinutes?: number | null
    } | null
    if (!b?.namespace || !b.eventKey || !b.recipientKey || !b.templateKey || !b.channels) {
      return c.json({ error: 'AGENT_RULE_INVALID_BODY' }, 400)
    }
    const identity = c.get('identity') as Identity
    const ns = await getAgentNamespace(deps.pool, org(c), b.namespace)
    if (!ns || ns.status !== 'active' || ns.ownerUserId !== identity.userId) {
      return c.json({ error: 'AGENT_NAMESPACE_FORBIDDEN' }, 403)
    }
    const policy = parseAgentPolicy(ns.policy)
    if (!b.eventKey.startsWith(`ext.${b.namespace}.`) || isAgentMessageKey(b.eventKey)) {
      return c.json({ error: 'AGENT_EVENT_NOT_OWNED' }, 400)
    }
    const decl = await getEventDecl(deps.pool, org(c), b.eventKey)
    if (!decl) return c.json({ error: 'EVENT_NOT_DECLARED' }, 400)
    const tpl = await getTemplate(deps.pool, org(c), b.templateKey)
    if (!tpl || tpl.ownerNamespace !== b.namespace) {
      return c.json({ error: 'AGENT_TEMPLATE_NOT_OWNED' }, 400)
    }
    if (b.id && (b.id.startsWith('derived:') || b.id.startsWith('manual:'))) {
      return c.json({ error: 'RULE_ID_RESERVED' }, 403)
    }
    if (b.id) {
      const existing = (await listRules(deps.pool, org(c))).find((r) => r.id === b.id)
      if (existing?.ownerNamespace && existing.ownerNamespace !== b.namespace) {
        return c.json({ error: 'RULE_NOT_OWNED' }, 403)
      }
    }

    const disallowed = b.channels.filter((id) => !policy.allowed_channels.includes(id))
    if (disallowed.length > 0) {
      return c.json({ error: 'CHANNEL_NOT_ALLOWED', channels: disallowed }, 403)
    }
    const channelRows = await Promise.all(
      b.channels.map((id) => getChannel(deps.pool, org(c), id)))
    if (channelRows.some((ch) => ch === null)) {
      return c.json({ error: 'CHANNEL_UNKNOWN' }, 400)
    }
    const external = channelRows.some(
      (ch) => ch !== null && isExternalProvider(ch.provider))

    const [channels, templates, rules] = await Promise.all([
      listEnabledChannelIds(deps.pool, org(c)),
      listPublishedTemplateKeys(deps.pool, org(c)),
      listRules(deps.pool, org(c)),
    ])
    const existingRule = b.id ? rules.find((r) => r.id === b.id) : undefined
    if (existingRule?.enabled !== true) {
      const active = await countActiveAgentRules(deps.pool, org(c), b.namespace)
      if (active >= policy.max_active_rules) {
        return c.json({ error: 'RULE_QUOTA_EXCEEDED' }, 429)
      }
    }
    const bad = validateRule({
      eventKey: b.eventKey,
      scope: b.scope ?? '*',
      recipientKey: b.recipientKey,
      recipientLiteral: b.recipientLiteral ?? null,
      recipientDepts: b.recipientDepts ?? null,
      templateKey: b.templateKey,
      channels: b.channels,
      cooldownMinutes: b.cooldownMinutes ?? null,
      origin: 'manual',
    }, decl, channels, templates)
    if (bad) return c.json({ error: bad }, 400)

    const id = b.id ?? `rule:${randomUUID()}`
    const alreadyApproved = external
      ? await hasApprovedRuleApproval(deps.pool, org(c), id)
      : true
    const needsApproval = external && !policy.auto_publish_external && !alreadyApproved
    await upsertRule(deps.pool, org(c), {
      id,
      enabled: !needsApproval,
      eventKey: b.eventKey,
      scope: b.scope ?? '*',
      recipientKey: b.recipientKey,
      recipientLiteral: b.recipientLiteral ?? null,
      recipientDepts: b.recipientDepts ?? null,
      templateKey: b.templateKey,
      channels: b.channels,
      cooldownMinutes: b.cooldownMinutes ?? null,
      origin: 'manual',
      ownerNamespace: b.namespace,
    }, identity.userId)

    const approvalDetail = {
      eventKey: b.eventKey, templateKey: b.templateKey, channels: b.channels,
    }
    let approvalId: string | undefined
    if (needsApproval) {
      const pending = (await listApprovals(deps.pool, org(c), 'pending'))
        .find((a) => a.kind === 'rule' && a.targetId === id)
      if (pending) {
        approvalId = pending.id
      } else {
        const ap = await createApproval(deps.pool, org(c), {
          namespace: b.namespace, kind: 'rule', targetId: id,
          requestedBy: identity.userId, detail: approvalDetail,
        })
        approvalId = ap.id
        await enqueueEvent(deps.pool, {
          org: identity.orgId,
          eventId: `approval:${ap.id}:pending`,
          eventKey: 'notify.approval.pending',
          scope: b.namespace,
          payload: {
            approvalId: ap.id, namespace: b.namespace, kind: 'rule',
            targetId: id, requestedBy: identity.userId,
            summary: `${b.eventKey} → ${b.channels.join(', ')}`,
          },
          producer: 'notify',
        })
      }
    } else if (external && !alreadyApproved) {
      const ap = await createApproval(deps.pool, org(c), {
        namespace: b.namespace, kind: 'rule', targetId: id,
        requestedBy: identity.userId, status: 'approved',
        decidedBy: 'system:policy', reason: 'auto_publish_external',
        detail: approvalDetail,
      })
      approvalId = ap.id
    }

    const status = needsApproval ? 'pending' : 'enabled'
    await audit(deps.pool, org(c), identity.userId, 'agent.rule.upsert', id, {
      ...approvalDetail, status, approvalId: approvalId ?? null,
    })
    return c.json({ id, status, approvalId }, needsApproval ? 202 : 201)
  })

  r.post('/agent/messages', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      namespace?: string
      eventId?: string
      to?: string | string[]
      title?: string
      body?: string
      link?: string
    } | null
    if (!b?.namespace || !b.to || !b.title || !b.body) {
      return c.json({ error: 'AGENT_MESSAGE_INVALID_BODY' }, 400)
    }
    const identity = c.get('identity') as Identity
    const ns = await getAgentNamespace(deps.pool, org(c), b.namespace)
    if (!ns || ns.status !== 'active' || ns.ownerUserId !== identity.userId) {
      return c.json({ error: 'AGENT_NAMESPACE_FORBIDDEN' }, 403)
    }
    const policy = parseAgentPolicy(ns.policy)
    if (!policy.allowed_channels.includes('inapp_default')) {
      return c.json({ error: 'CHANNEL_NOT_ALLOWED', channels: ['inapp_default'] }, 403)
    }
    const to = Array.isArray(b.to) ? b.to : [b.to]
    if (to.length === 0 || to.some((x) => typeof x !== 'string' || x.trim() === '')) {
      return c.json({ error: 'AGENT_MESSAGE_INVALID_RECIPIENT' }, 400)
    }
    if (to.length > policy.max_recipients_per_message) {
      return c.json({ error: 'RECIPIENT_QUOTA_EXCEEDED' }, 429)
    }
    if (await countAgentMessagesToday(deps.pool, org(c), b.namespace)
        >= policy.max_messages_per_day) {
      return c.json({ error: 'MESSAGE_QUOTA_EXCEEDED' }, 429)
    }
    if ([...b.title].length > 64) return c.json({ error: 'AGENT_MESSAGE_TITLE_TOO_LONG' }, 400)
    if ([...b.body].length > 500) return c.json({ error: 'AGENT_MESSAGE_BODY_TOO_LONG' }, 400)
    if (b.link !== undefined && !/^https:\/\//.test(b.link)) {
      return c.json({ error: 'AGENT_MESSAGE_LINK_INVALID' }, 400)
    }

    await ensureAgentMessageDefaults(deps.pool, org(c), b.namespace, identity.userId)
    const eventKey = agentMessageKey(b.namespace)
    const decl = await getEventDecl(deps.pool, org(c), eventKey)
    if (!decl) return c.json({ error: 'AGENT_MESSAGE_NOT_READY' }, 500)
    const payload = {
      to,
      title: b.title,
      body: b.body,
      ...(b.link === undefined ? {} : { link: b.link }),
    }
    const bad = validatePayload(decl, payload)
    if (bad) return c.json({ error: 'PAYLOAD_INVALID', detail: bad }, 400)

    const eventId = b.eventId ?? `agent-msg:${randomUUID()}`
    const result = await enqueueEvent(deps.pool, {
      org: identity.orgId,
      eventId,
      eventKey,
      scope: '*',
      payload,
      producer: `ext:${b.namespace}`,
    })
    await audit(deps.pool, identity.orgId, identity.userId, 'agent.message.send', eventKey, {
      eventId, recipients: to.length,
    })
    return c.json({ accepted: result.accepted, eventId }, 202)
  })

  // ── 爆炸半径策略与审批（N3）──────────────────────────────────────────────
  r.patch('/agent/namespaces/:namespace/policy', async (c) => {
    const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
    if (!b) return c.json({ error: 'POLICY_INVALID' }, 400)
    for (const k of ['max_recipients_per_message', 'max_active_rules', 'max_messages_per_day']) {
      if (k in b && (typeof b[k] !== 'number' || !Number.isInteger(b[k]) || (b[k] as number) <= 0)) {
        return c.json({ error: 'POLICY_INVALID', field: k }, 400)
      }
    }
    if ('auto_publish_external' in b && typeof b.auto_publish_external !== 'boolean') {
      return c.json({ error: 'POLICY_INVALID', field: 'auto_publish_external' }, 400)
    }
    if ('allowed_channels' in b) {
      const v = b.allowed_channels
      if (!Array.isArray(v) || v.length === 0
          || v.some((x) => typeof x !== 'string' || x.length === 0)) {
        return c.json({ error: 'POLICY_INVALID', field: 'allowed_channels' }, 400)
      }
    }

    const namespace = c.req.param('namespace')
    const ns = await getAgentNamespace(deps.pool, org(c), namespace)
    if (!ns) return c.json({ error: 'AGENT_NAMESPACE_NOT_FOUND' }, 404)
    const next = mergeAgentPolicy(parseAgentPolicy(ns.policy), b)
    for (const id of next.allowed_channels) {
      const ch = await getChannel(deps.pool, org(c), id)
      if (!ch || !ch.enabled) {
        return c.json({ error: 'CHANNEL_UNKNOWN', channel: id }, 400)
      }
    }
    await setAgentNamespacePolicy(deps.pool, org(c), namespace, next)
    const identity = c.get('identity') as Identity
    await audit(deps.pool, org(c), identity.userId, 'agent.policy.update', namespace, next)
    return c.json({ namespace, policy: next })
  })

  r.get('/approvals', async (c) => {
    const status = c.req.query('status')
    return c.json({
      approvals: await listApprovals(deps.pool, org(c), status === undefined ? undefined : status),
    })
  })

  r.post('/approvals/:id/decide', async (c) => {
    const b = (await c.req.json().catch(() => null)) as {
      approve?: boolean
      reason?: string
    } | null
    if (!b || typeof b.approve !== 'boolean') {
      return c.json({ error: 'APPROVAL_INVALID_BODY' }, 400)
    }
    const identity = c.get('identity') as Identity
    const id = c.req.param('id')
    const a = await getApproval(deps.pool, org(c), id)
    if (!a) return c.json({ error: 'APPROVAL_NOT_FOUND' }, 404)
    if (a.status !== 'pending') return c.json({ error: 'APPROVAL_NOT_PENDING' }, 409)
    const decided = await decideApproval(
      deps.pool, org(c), id, b.approve, identity.userId, b.reason ?? null)
    if (!decided) return c.json({ error: 'APPROVAL_NOT_PENDING' }, 409)
    if (b.approve && decided.kind === 'rule') {
      await setRuleEnabled(deps.pool, org(c), decided.targetId, true)
    }
    await audit(deps.pool, org(c), identity.userId, 'approval.decide', decided.targetId, {
      approvalId: decided.id, approve: b.approve, kind: decided.kind,
    })
    return c.json({ approval: decided })
  })

  registerNotifyMcpManage(r, {
    pool: deps.pool, events: deps.events, addresses: deps.addresses,
  })

  return r
}
