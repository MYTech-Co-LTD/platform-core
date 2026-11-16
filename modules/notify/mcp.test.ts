// mcp.test.ts — agent 工具面：25 工具（17 消息 + 8 排班）、无 publish/channel、
// 排班不接受通道参数、草稿不发布、试发只给自己；C（wecom）channel 档 + 读面。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import type {
  ChannelAddressResolver, Identity, NotificationEventDecl, RequesterVars,
  SchedulerPortFactory, SchedulerPortLike,
} from '@platform/sdk'
import notifyV2 from './index'
import { callTool, toolDefs } from './mcp'
import { NOTIFY_TOOLS } from './mcp-tools'
import { createAgentNamespace, ensureServiceNamespace, getTemplate, upsertEventDecl } from './storage'
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'

/** 通知工具的 requiredScope 全集（B 的 full 面要看到全部 25 个）。 */
const ALL_SCOPES = ['notify:view', 'notify:manage', 'notify:publish', 'notify:emit']

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-mcp2'

const decl: NotificationEventDecl = {
  key: 'm.a.b', title: 't',
  payload: { u: { type: 'user', required: true }, link: { type: 'url', required: true } },
  recipients: { approver: { kind: 'field', field: 'u' } },
}
const events = { get: (k: string) => (k === 'm.a.b' ? decl : undefined), list: () => [decl] }
const addresses: ChannelAddressResolver = {
  resolve: async ({ provider, casdoorName }) =>
    provider === 'wecom_chat' ? `wecom-${casdoorName}` : casdoorName,
}

describe('notify mcp tool face', () => {
  it('恰 25 个工具，无 publish/channel', () => {
    expect(NOTIFY_TOOLS).toHaveLength(25)
    expect(toolDefs({ channel: 'pat', scopes: ALL_SCOPES })).toHaveLength(25)
    expect(NOTIFY_TOOLS.some((t) => /publish|channel/.test(t.name))).toBe(false)
  })

  it('B（pat/session）仍 24；C（wecom）只见 agent-safe 子集', () => {
    expect(toolDefs({ channel: 'pat', scopes: ALL_SCOPES })).toHaveLength(25)
    expect(toolDefs({ channel: 'session', scopes: ALL_SCOPES })).toHaveLength(25)
    const names = toolDefs({ channel: 'wecom', scopes: ALL_SCOPES }).map((t) => t.name)
    expect(names).toContain('create_agent_rule')
    expect(names).toContain('create_agent_template')
    expect(names).toContain('create_schedule')
    // C 不授 notify:emit ⇒ send_message 不在 C 的 capabilities 里（B 仍有它）。
    expect(names).not.toContain('send_message')
    expect(names).not.toContain('propose_rule')
    expect(names).not.toContain('update_rule')
    expect(names).not.toContain('set_rule_enabled')
    expect(names).not.toContain('draft_template')
  })

  it('读面（mode=read）只投影非 mutating 工具', () => {
    const defs = toolDefs({ channel: 'pat', mode: 'read', scopes: ALL_SCOPES })
    const names = defs.map((t) => t.name)
    expect(names).toContain('list_rules')
    expect(names).toContain('list_schedules')
    expect(names).not.toContain('propose_rule')
    expect(names).not.toContain('send_test')
    expect(defs).toHaveLength(NOTIFY_TOOLS.filter((t) => !t.mutating).length)
  })

  it('tools/list 带 annotations.readOnlyHint（能力网关紧凑索引据此判定 mutating）', () => {
    const defs = toolDefs({ channel: 'pat', scopes: ALL_SCOPES })
    for (const d of defs) {
      expect(d.annotations.readOnlyHint, d.name)
        .toBe(!NOTIFY_TOOLS.find((t) => t.name === d.name)?.mutating)
    }
    // 读面全只读；C 档写工具 readOnlyHint=false（两个消费方看到同一份注解）。
    for (const d of toolDefs({ channel: 'pat', mode: 'read', scopes: ALL_SCOPES })) {
      expect(d.annotations.readOnlyHint, d.name).toBe(true)
    }
    const cWrite = toolDefs({ channel: 'wecom', scopes: ALL_SCOPES })
      .find((d) => d.name === 'create_agent_rule')
    expect(cWrite?.annotations.readOnlyHint).toBe(false)
  })

  it('读面按 requiredScope 裁剪：notify:view 看不到 preview_template', () => {
    const names = toolDefs({
      channel: 'pat', mode: 'read', scopes: ['notify:view'],
    }).map((t) => t.name)
    expect(names).toContain('list_rules')
    expect(names).toContain('list_events')
    expect(names).not.toContain('preview_template')
  })
})

describePg('notify mcp handlers', () => {
  let pool: Pool
  const deps = () => ({
    pool, org: ORG, userId: 'u1', channel: 'pat' as const,
    scopes: ['notify:manage', 'notify:publish', 'notify:emit'],
    events, addresses,
  })
  const depsCh = (channel: 'pat' | 'session' | 'wecom') => ({ ...deps(), channel })

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await cleanup()
    await pool.end()
  })
  beforeEach(async () => {
    await cleanup()
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{}','{}','u')`, [ORG])
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t1','T','m.a.b','published','tenant',1,'u')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t1',1,'{"wecom_chat":{"text":"hi {{u}}"}}','h1','approved','u')`, [ORG])
    await pool.query(
      `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
       values ($1,'r1',true,'m.a.b','*','approver','t1','{wecom_default}','manual','u')
       on conflict (org,id) do nothing`, [ORG])
  })

  async function cleanup() {
    await pool.query('delete from notify.approval where org=$1', [ORG])
    await pool.query('delete from notify.event where org=$1', [ORG])
    await pool.query('delete from notify.event_decl where org=$1', [ORG])
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query('delete from notify.template_revision where org=$1', [ORG])
    await pool.query('delete from notify.template where org=$1', [ORG])
    await pool.query('delete from notify.agent_namespace where org=$1', [ORG])
    await pool.query('delete from notify.audit where org=$1', [ORG])
  }

  it('draft_template 只写 draft，不移动发布指针 + 审计', async () => {
    const before = await getTemplate(pool, ORG, 't1')
    const out = await callTool(deps(), 'draft_template', {
      key: 't1', contents: { wecom_chat: { text: 'v2 {{u}}' } },
    })
    expect(out.isError).toBe(false)
    expect(JSON.parse(out.text)).toMatchObject({ revision: 2, status: 'draft' })

    const after = await getTemplate(pool, ORG, 't1')
    expect(after!.publishedRevision).toBe(before!.publishedRevision)
    expect(after!.revisions.some((r) => r.reviewStatus === 'draft')).toBe(true)

    const a = await pool.query('select action from notify.audit where org=$1 order by id desc limit 1', [ORG])
    expect(a.rows[0].action).toBe('mcp.draft_template')
  })

  it('preview_template 返回渲染结果', async () => {
    const out = await callTool(deps(), 'preview_template', {
      key: 't1', payload: { u: 'u1', link: 'https://x' },
    })
    expect(out.isError).toBe(false)
    expect((JSON.parse(out.text) as { rendered: { wecom_chat: { text: string } } })
      .rendered.wecom_chat.text).toBe('hi u1')
  })

  it('send_test 收件人只能是调用者本人', async () => {
    const out = await callTool(deps(), 'send_test', {
      templateKey: 't1', channel: 'wecom_default',
      payload: { u: 'u1', link: 'https://x' },
      recipient: 'other', // 必须被忽略
    })
    expect(out.isError).toBe(false)
    const { rows } = await pool.query(
      'select distinct recipient, is_test from notify.delivery where org=$1', [ORG])
    expect(rows).toEqual([{ recipient: 'u1', is_test: true }])
  })

  it('send_test webhook：地址解析 null 也可入队（不需要收件人地址）', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'webhook_ops','webhook',true,'{}','{}','u')`, [ORG])
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t-webhook','T','m.a.b','published','tenant',1,'u')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t-webhook',1,'{"webhook":{"text":"hi"}}','h-webhook','approved','u')`, [ORG])

    const out = await callTool({
      ...deps(),
      addresses: { resolve: async () => null },
    }, 'send_test', {
      templateKey: 't-webhook', channel: 'webhook_ops',
      payload: { u: 'u1', link: 'https://x' },
    })
    expect(out.isError).toBe(false)
    const row = await pool.query(
      "select status, address from notify.delivery where org=$1 and channel='webhook_ops'", [ORG])
    expect(row.rows[0]).toMatchObject({ status: 'pending', address: 'u1' })
  })

  it('check_rule 只读：返回 blocked/recipients/warnings，不写任何表', async () => {
    const before = (await pool.query(
      'select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
    const out = await callTool(deps(), 'check_rule', { id: 'r1' })
    expect(out.isError).toBe(false)
    const body = JSON.parse(out.text) as {
      blocked: string | null; recipients: unknown[]; warnings: string[]
    }
    expect(body).toHaveProperty('blocked')
    expect(Array.isArray(body.recipients)).toBe(true)
    expect(body.warnings).toContain('sample_mode_field_recipients_unverified')

    const after = (await pool.query(
      'select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
    expect(after).toBe(before)
  })

  it('check_rule：未知 id ⇒ 错误', async () => {
    const out = await callTool(deps(), 'check_rule', { id: 'nope' })
    expect(out.isError).toBe(true)
  })

  it('N1：list_events/get_event/propose_rule 能看见租户 ext 事件', async () => {
    const decl: NotificationEventDecl = {
      key: 'ext.agent_a.daily',
      title: 'Daily',
      scope: { key: 'day' },
      payload: {
        user: { type: 'user', required: true },
        day: { type: 'string', required: true },
      },
      recipients: { assignee: { kind: 'field', field: 'user' } },
    }
    await createAgentNamespace(pool, ORG, {
      namespace: 'agent_a', displayName: 'A', ownerUserId: 'u1',
    })
    expect(await upsertEventDecl(pool, ORG, 'agent_a', decl, 'u1'))
      .toMatchObject({ ok: true, created: true, version: 1 })

    const list = JSON.parse((await callTool(deps(), 'list_events', {})).text) as {
      events: Array<{ key: string }>
    }
    expect(list.events.map((e) => e.key)).toContain(decl.key)
    expect((await callTool(deps(), 'get_event', { eventKey: decl.key })).isError).toBe(false)
    expect((await callTool(deps(), 'propose_rule', {
      eventKey: decl.key, recipientKey: 'assignee',
      templateKey: 't1', channels: ['wecom_default'],
    })).isError).toBe(false)
  })

  it('N3b：MCP create_agent_template / create_agent_rule / send_message 走同一套 service', async () => {
    const ns = 'agent_a'
    await createAgentNamespace(pool, ORG, {
      namespace: ns, displayName: 'A', ownerUserId: 'u1',
    })
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'inapp_default','in_app',true,'{}','{}','u')
       on conflict (org,id) do nothing`, [ORG])
    const decl: NotificationEventDecl = {
      key: 'ext.agent_a.daily', title: 'D',
      payload: { user: { type: 'user', required: true } },
      recipients: { assignee: { kind: 'field', field: 'user' } },
    }
    expect(await upsertEventDecl(pool, ORG, ns, decl, 'u1'))
      .toMatchObject({ ok: true })

    const tpl = await callTool(deps(), 'create_agent_template', {
      namespace: ns, key: 'agent_a_daily', name: 'D',
      eventKey: decl.key,
      contents: { in_app: { title: 'Hi', body: 'B' } },
      publish: true,
    })
    expect(tpl.isError).toBe(false)
    expect(JSON.parse(tpl.text)).toMatchObject({ key: 'agent_a_daily', published: true })

    const rule = await callTool(deps(), 'create_agent_rule', {
      namespace: ns, eventKey: decl.key, recipientKey: 'assignee',
      templateKey: 'agent_a_daily', channels: ['inapp_default'],
    })
    expect(rule.isError).toBe(false)
    expect(JSON.parse(rule.text)).toMatchObject({ status: 'enabled' })

    const a = await pool.query(
      "select detail from notify.audit where org=$1 and action='agent.rule.upsert' order by id desc limit 1", [ORG])
    expect(a.rows[0].detail.snapshot).toEqual({
      id: (JSON.parse(rule.text) as { id: string }).id, enabled: true,
      eventKey: 'ext.agent_a.daily', scope: '*', recipientKey: 'assignee',
      recipientLiteral: null, recipientDepts: null,
      templateKey: 'agent_a_daily', channels: ['inapp_default'],
      cooldownMinutes: null, origin: 'manual', ownerNamespace: 'agent_a',
    })

    const msg = await callTool(deps(), 'send_message', {
      namespace: ns, to: 'u1', title: 'T', body: 'B',
    })
    expect(msg.isError).toBe(false)
    const ev = await pool.query(
      "select 1 from notify.event where org=$1 and event_key='ext.agent_a.message'", [ORG])
    expect(ev.rowCount).toBe(1)
  })

  it('check_rule 与 HTTP 同源：未配置的通道给出 configured=false + warning', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_bad','wecom_chat',true,'{}','{"bridge_url":"MISSING_ENV_X"}','u')`, [ORG])
    await pool.query(
      `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,template_key,channels,origin,created_by)
       values ($1,'r-bad',true,'m.a.b','*','approver','t1','{wecom_bad}','manual','u')`, [ORG])

    const out = await callTool(deps(), 'check_rule', { id: 'r-bad' })
    expect(out.isError).toBe(false)
    const body = JSON.parse(out.text) as {
      blocked: string | null
      channels: Array<{ id: string; configured?: boolean }>
      warnings: string[]
    }
    expect(body.blocked).toBe('no_channel')
    expect(body.channels[0]).toMatchObject({ id: 'wecom_bad', configured: false })
    expect(body.warnings).toContain('channel_unconfigured:wecom_bad')
  })

  it('check_rule 与 HTTP 同源：部门规则注入 resolver 后可解析', async () => {
    const deptDecl: NotificationEventDecl = {
      key: 'm.dept', title: 't', payload: {},
      recipients: { dept: { kind: 'dept' } },
    }
    const deptEvents = {
      get: (k: string) => (k === 'm.dept' ? deptDecl : undefined),
      list: () => [deptDecl],
    }
    await pool.query(
      `insert into notify.rule(org,id,enabled,event_key,scope,recipient_key,recipient_depts,template_key,channels,origin,created_by)
       values ($1,'r-dept',true,'m.dept','*','dept','["D1"]'::jsonb,'t1','{wecom_default}','manual','u')`, [ORG])

    const without = await callTool({ ...deps(), events: deptEvents }, 'check_rule', { id: 'r-dept' })
    const w1 = JSON.parse(without.text) as { blocked: string | null; warnings: string[] }
    expect(w1.blocked).toBe('dept_resolver_unavailable')
    expect(w1.warnings).toContain('dept_resolver_unavailable')

    const withResolver = await callTool({
      ...deps(),
      events: deptEvents,
      addresses: {
        resolve: async () => null,
        resolveDeptMembers: async () => ({
          names: ['u1'], depts: ['D1'], members: 1, excluded: 0, unresolved: 0,
        }),
      },
    }, 'check_rule', { id: 'r-dept' })
    const w2 = JSON.parse(withResolver.text) as {
      blocked: string | null; recipients: Array<{ name: string; source: string }>
    }
    expect(w2.blocked).toBeNull()
    expect(w2.recipients).toEqual([{ name: 'u1', source: 'dept' }])
  })

  it('propose_rule 走同一套校验并审计', async () => {
    const out = await callTool(deps(), 'propose_rule', {
      eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      templateKey: 't1', channels: ['wecom_default'],
    })
    expect(out.isError).toBe(false)
    const { rules } = JSON.parse(out.text) as { rules?: unknown; id?: string }
    void rules
    const rows = await pool.query('select origin from notify.rule where org=$1', [ORG])
    expect(rows.rows[0].origin).toBe('manual')

    const bad = await callTool(deps(), 'propose_rule', {
      eventKey: 'm.a.b', recipientKey: 'nope', templateKey: 't1', channels: ['wecom_default'],
    })
    expect(bad.isError).toBe(true)
  })

  it('propose_rule 的 audit 含完整 snapshot', async () => {
    const out = await callTool(deps(), 'propose_rule', {
      eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      templateKey: 't1', channels: ['wecom_default'],
    })
    expect(out.isError).toBe(false)
    const { id } = JSON.parse(out.text) as { id: string }
    const { rows } = await pool.query(
      "select detail from notify.audit where org=$1 and action='mcp.propose_rule' order by id desc limit 1", [ORG])
    expect(rows[0].detail.snapshot).toEqual({
      id, enabled: true, eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      recipientLiteral: null, recipientDepts: null, templateKey: 't1',
      channels: ['wecom_default'], cooldownMinutes: null, origin: 'manual',
      ownerNamespace: null,
    })
  })

  it('set_rule_enabled 的 audit 快照 = 原规则 + 新 enabled', async () => {
    const out = await callTool(deps(), 'set_rule_enabled', { id: 'r1', enabled: false })
    expect(out.isError).toBe(false)
    const { rows } = await pool.query(
      "select detail from notify.audit where org=$1 and action='mcp.set_rule_enabled' order by id desc limit 1", [ORG])
    expect(rows[0].detail.snapshot).toEqual({
      id: 'r1', enabled: false, eventKey: 'm.a.b', scope: '*', recipientKey: 'approver',
      recipientLiteral: null, recipientDepts: null, templateKey: 't1',
      channels: ['wecom_default'], cooldownMinutes: null, origin: 'manual',
      ownerNamespace: null,
    })
  })

  it('update_rule 不可覆盖系统预留 id（derived:/manual:）', async () => {
    const out = await callTool(deps(), 'update_rule', {
      id: 'derived:aftersales:m.a.b:*',
      eventKey: 'm.a.b', recipientKey: 'approver',
      templateKey: 't1', channels: ['wecom_default'],
    })
    expect(out.isError).toBe(true)
    expect((JSON.parse(out.text) as { reason: string }).reason).toBe('rule_id_reserved')
  })

  // ── C 档（wecom channel 执法，spec 2026-11-16 §6.4 / R9 / R11）────────────────
  it('wecom 直连不带 profile、伪造 full ⇒ 仍拒 propose_rule', async () => {
    const out = await callTool(depsCh('wecom'), 'propose_rule', {
      eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1', channels: ['wecom_default'],
    })
    expect(out.isError).toBe(true)
    expect((JSON.parse(out.text) as { reason: string }).reason).toBe('c_tool_not_allowed')
  })

  it('C 不授 notify:emit：send_message 对 C 拒绝（B 仍保留）', async () => {
    const c = await callTool(depsCh('wecom'), 'send_message', {
      namespace: 'openclaw_acme', to: 'u1', title: 'T', body: 'B',
    })
    expect(c.isError).toBe(true)
    expect((JSON.parse(c.text) as { reason: string }).reason).toBe('c_tool_not_allowed')
    // B（pat）的工具面仍含 send_message（25 个）。
    expect(toolDefs({ channel: 'pat', scopes: ALL_SCOPES }).map((t) => t.name))
      .toContain('send_message')
  })

  it('读面 callTool 拒 mutating 工具', async () => {
    const out = await callTool({ ...deps(), mode: 'read' }, 'propose_rule', {
      eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1', channels: ['wecom_default'],
    })
    expect(out.isError).toBe(true)
    expect((JSON.parse(out.text) as { reason: string }).reason).toBe('read_only_tool_not_allowed')
  })

  it('notify:view 直连 preview_template ⇒ missing_scope（不只靠 tools/list 裁剪）', async () => {
    const out = await callTool({
      ...deps(), mode: 'read', scopes: ['notify:view'],
    }, 'preview_template', { key: 't1', payload: { u: 'u1', link: 'https://x' } })
    expect(out.isError).toBe(true)
    expect(JSON.parse(out.text)).toMatchObject({
      reason: 'missing_scope', scope: 'notify:manage',
    })
  })

  it('C 的排班工具也钉 namespace：忽略模型传的 namespace', async () => {
    const ns = 'openclaw_acme'
    expect(await ensureServiceNamespace(pool, ORG, ns)).toMatchObject({ ok: true })
    const seen: Array<string | undefined> = []
    const scheduler = ((actor: { namespace?: string }) => {
      seen.push(actor.namespace)
      return {
        listSchedules: async () => [],
      } as unknown as SchedulerPortLike
    }) as SchedulerPortFactory

    process.env.NOTIFY_WECOM_NAMESPACE = ns
    try {
      const out = await callTool({ ...depsCh('wecom'), scheduler }, 'list_schedules', {
        namespace: 'someone-elses', // 必须被覆盖为钉死值
      })
      expect(out.isError).toBe(false)
      expect(JSON.parse(out.text)).toMatchObject({ namespace: ns })
      expect(seen).toEqual([ns])
    } finally {
      delete process.env.NOTIFY_WECOM_NAMESPACE
    }
  })

  it('C 的 create_schedule 用钉死 namespace（别的 namespace 被覆盖）', async () => {
    const ns = 'openclaw_acme'
    expect(await ensureServiceNamespace(pool, ORG, ns)).toMatchObject({ ok: true })
    const decl: NotificationEventDecl = {
      key: 'ext.openclaw_acme.daily', title: 'D', payload: {},
      recipients: { assignee: { kind: 'field', field: 'user' } },
    }
    expect(await upsertEventDecl(pool, ORG, ns, decl, 'u1')).toMatchObject({ ok: true })
    const seen: string[] = []
    const scheduler = ((actor: { namespace?: string }) => {
      seen.push(actor.namespace ?? '')
      return {
        createSchedule: async () => ({ id: 's1', nextRunAt: '2026-01-01T00:00:00.000Z' }),
      } as unknown as SchedulerPortLike
    }) as SchedulerPortFactory

    process.env.NOTIFY_WECOM_NAMESPACE = ns
    try {
      const out = await callTool({ ...depsCh('wecom'), scheduler }, 'create_schedule', {
        namespace: 'someone-elses', // 必须被覆盖为钉死值
        cron: '*/5 * * * *',
        params: { eventKey: decl.key, payload: {} },
      })
      expect(out.isError).toBe(false)
      expect(JSON.parse(out.text)).toMatchObject({ id: 's1', namespace: ns })
      expect(seen).toEqual([ns])
    } finally {
      delete process.env.NOTIFY_WECOM_NAMESPACE
    }
  })

  it('C 的排班工具：未配 NOTIFY_WECOM_NAMESPACE ⇒ namespace_unconfigured', async () => {
    delete process.env.NOTIFY_WECOM_NAMESPACE
    const out = await callTool(depsCh('wecom'), 'list_schedules', { namespace: 'someone-elses' })
    expect(out.isError).toBe(true)
    expect((JSON.parse(out.text) as { reason: string }).reason).toBe('namespace_unconfigured')

    // 非排班工具不受影响（list_events 不读 namespace）。
    expect((await callTool(depsCh('wecom'), 'list_events', {})).isError).toBe(false)
  })

  it('C 可声明自有事件（ext.<namespace>.*），平台事件仍 AGENT_EVENT_NOT_OWNED', async () => {
    const ns = 'openclaw_declare'
    expect(await ensureServiceNamespace(pool, ORG, ns)).toMatchObject({ ok: true })
    process.env.NOTIFY_WECOM_NAMESPACE = ns
    try {
      const out = await callTool(depsCh('wecom'), 'declare_agent_event', {
        namespace: 'someone-elses', // 必须被钉死值覆盖
        key: `ext.${ns}.low_sales`,
        title: '销售额未达标',
        payload: { value: { type: 'number', required: true }, user: { type: 'user', required: true } },
        recipients: { assignee: { kind: 'field', field: 'user' } },
      })
      expect(out.isError).toBe(false)
      expect(JSON.parse(out.text)).toMatchObject({
        key: `ext.${ns}.low_sales`, version: 1, created: true, namespace: ns,
      })
      const row = await pool.query(
        'select namespace, version from notify.event_decl where org=$1 and key=$2',
        [ORG, `ext.${ns}.low_sales`])
      expect(row.rows).toEqual([{ namespace: ns, version: 1 }])

      // 平台事件不归 agent：即使 key 合法也不能声明。
      const bad = await callTool(depsCh('wecom'), 'declare_agent_event', {
        key: 'ext.someone_else.low_sales', title: 'x',
        payload: {}, recipients: { assignee: { kind: 'field', field: 'user' } },
      })
      expect(bad.isError).toBe(true)
      expect((JSON.parse(bad.text) as { reason: string }).reason).toBe('AGENT_EVENT_NOT_OWNED')
    } finally {
      delete process.env.NOTIFY_WECOM_NAMESPACE
    }
  })

  it('wecom create_agent_rule 落 pending，namespace 被钉死（忽略参数）', async () => {
    const ns = 'openclaw_acme'
    expect(await ensureServiceNamespace(pool, ORG, ns)).toMatchObject({ ok: true })
    const decl: NotificationEventDecl = {
      key: 'ext.openclaw_acme.daily', title: 'D',
      payload: { user: { type: 'user', required: true } },
      recipients: { assignee: { kind: 'field', field: 'user' } },
    }
    expect(await upsertEventDecl(pool, ORG, ns, decl, 'u1')).toMatchObject({ ok: true })
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'inapp_default','in_app',true,'{}','{}','u')
       on conflict (org,id) do nothing`, [ORG])
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by,owner_namespace)
       values ($1,'c_daily','C','ext.openclaw_acme.daily','published','tenant',1,'u','openclaw_acme')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'c_daily',1,'{"in_app":{"title":"Hi","body":"B"}}','hc1','approved','u')`, [ORG])

    process.env.NOTIFY_WECOM_NAMESPACE = ns
    try {
      // C 用户 u2（不是 service owner）也能建规则：授权来自 service-owned + C 通道。
      const out = await callTool({ ...depsCh('wecom'), userId: 'u2' }, 'create_agent_rule', {
        // 模型传的 namespace 必须被忽略
        namespace: 'someone-elses', eventKey: decl.key, recipientKey: 'assignee',
        templateKey: 'c_daily', channels: ['inapp_default'],
      })
      expect(out.isError).toBe(false)
      const body = JSON.parse(out.text) as {
        id: string; status: string; approvalId?: string; namespace: string
      }
      expect(body).toMatchObject({ status: 'pending', namespace: ns })
      expect(body.approvalId).toBeTruthy()

      // namespace 行是 service-owned，owner 是部署账号（不是 u1/u2）。
      const nsRow = await pool.query(
        'select owner_user_id, service_owned from notify.agent_namespace where org=$1 and namespace=$2',
        [ORG, ns])
      expect(nsRow.rows).toEqual([{ owner_user_id: 'system:openclaw', service_owned: true }])

      const rs = await pool.query(
        'select id, enabled, owner_namespace from notify.rule where org=$1 and id=$2',
        [ORG, body.id])
      expect(rs.rows).toEqual([{ id: body.id, enabled: false, owner_namespace: ns }])
      const ap = await pool.query(
        "select kind, status, target_id from notify.approval where org=$1", [ORG])
      expect(ap.rows).toEqual([{ kind: 'rule', status: 'pending', target_id: body.id }])

      // B（pat）用同一个 service namespace ⇒ 拒绝（service 只对 C 通道开放）。
      const b = await callTool({ ...deps(), userId: 'u2' }, 'create_agent_rule', {
        namespace: ns, eventKey: decl.key, recipientKey: 'assignee',
        templateKey: 'c_daily', channels: ['inapp_default'],
      })
      expect(b.isError).toBe(true)
      expect((JSON.parse(b.text) as { reason: string }).reason)
        .toBe('AGENT_NAMESPACE_SERVICE_ONLY')
    } finally {
      delete process.env.NOTIFY_WECOM_NAMESPACE
    }
  })

  it('已有同名 human namespace ⇒ namespace_conflict（不静默改写成 service）', async () => {
    const ns = 'human_ns'
    await createAgentNamespace(pool, ORG, {
      namespace: ns, displayName: 'Human', ownerUserId: 'u1',
    })
    process.env.NOTIFY_WECOM_NAMESPACE = ns
    try {
      const out = await callTool(depsCh('wecom'), 'list_events', {})
      expect(out.isError).toBe(true)
      expect((JSON.parse(out.text) as { reason: string }).reason).toBe('namespace_conflict')
      const row = await pool.query(
        'select owner_user_id, service_owned from notify.agent_namespace where org=$1 and namespace=$2',
        [ORG, ns])
      expect(row.rows).toEqual([{ owner_user_id: 'u1', service_owned: false }])
    } finally {
      delete process.env.NOTIFY_WECOM_NAMESPACE
    }
  })

  it('wecom create_agent_template：namespace 钉死且强制 publish=false', async () => {
    const ns = 'openclaw_acme'
    expect(await ensureServiceNamespace(pool, ORG, ns)).toMatchObject({ ok: true })
    const decl: NotificationEventDecl = {
      key: 'ext.openclaw_acme.daily', title: 'D', payload: {},
      recipients: { assignee: { kind: 'field', field: 'user' } },
    }
    expect(await upsertEventDecl(pool, ORG, ns, decl, 'u1')).toMatchObject({ ok: true })

    process.env.NOTIFY_WECOM_NAMESPACE = ns
    try {
      const out = await callTool(depsCh('wecom'), 'create_agent_template', {
        namespace: 'someone-elses', key: 'c_tpl', name: 'C', eventKey: decl.key,
        contents: { in_app: { title: 'Hi', body: 'B' } }, publish: true,
      })
      expect(out.isError).toBe(false)
      expect(JSON.parse(out.text)).toMatchObject({ key: 'c_tpl', published: false })
      const t = await getTemplate(pool, ORG, 'c_tpl')
      expect(t?.ownerNamespace).toBe(ns)
    } finally {
      delete process.env.NOTIFY_WECOM_NAMESPACE
    }
  })

  it('wecom 直连 /mcp-manage（伪造 x-agent-profile: full）仍只回 C-safe、拒 propose_rule', async () => {
    // 手搭通道壳：宿主在 PAT/企微通道会设 REQUESTER_CHANNEL，会话通道不设。
    const app = new Hono<{ Variables: { identity: Identity } & RequesterVars }>()
    app.use('*', async (c, next) => {
      c.set('identity', makeIdentity({
        orgId: ORG, userId: 'u1',
        scopes: ['notify:view', 'notify:manage', 'notify:publish', 'notify:emit'],
      }))
      c.set(REQUESTER_CHANNEL, 'wecom')
      await next()
    })
    app.route('/', notifyV2.createRouter({ pool, events, addresses }))

    const list = await app.request('/mcp-manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-profile': 'full' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const names = ((await list.json()) as { result: { tools: Array<{ name: string }> } })
      .result.tools.map((t) => t.name)
    expect(names).toContain('create_agent_rule')
    expect(names).not.toContain('propose_rule')
    expect(names).not.toContain('set_rule_enabled')

    const call = await app.request('/mcp-manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-profile': 'full' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'propose_rule', arguments: { eventKey: 'm.a.b' } },
      }),
    })
    const body = (await call.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    expect(body.result.isError).toBe(true)
    expect((JSON.parse(body.result.content[0].text) as { reason: string }).reason)
      .toBe('c_tool_not_allowed')
  })

  it('JSON-RPC /mcp-manage tools/list 返回 25 工具', async () => {
    const app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG, userId: 'u1', scopes: ['notify:manage', 'notify:emit'] }),
      { pool, events, addresses },
    )
    const res = await app.request('/mcp-manage', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    const body = await res.json() as { result: { tools: unknown[] } }
    expect(body.result.tools).toHaveLength(25)
  })
})
