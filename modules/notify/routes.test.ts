// routes-v2.test.ts — v2 端点（规则/投递/外部 emit/收件箱）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { declaredScopeGate } from '@platform/sdk'
import { Pool } from 'pg'
import type { ChannelAddressResolver, Identity, NotificationEventDecl } from '@platform/sdk'
import notifyV2 from './index'
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-routes2'

const decl: NotificationEventDecl = {
  key: 'm.a.b',
  title: 't',
  payload: { u: { type: 'user', required: true }, link: { type: 'url', required: true } },
  recipients: { approver: { kind: 'field', field: 'u' } },
}
const events = {
  get: (k: string) => (k === 'm.a.b' ? decl : undefined),
  list: () => [decl],
}
const addresses: ChannelAddressResolver = {
  resolve: async ({ provider, casdoorName }) =>
    provider === 'wecom_chat' ? `wecom-${casdoorName}` : casdoorName,
}

describePg('routes v2', () => {
  let pool: Pool
  let app: ReturnType<typeof buildTestApp>

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
    app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG, userId: 'u1', scopes: ['notify:view', 'notify:manage', 'notify:emit'] }),
      { pool, events, addresses },
    )
  })
  afterAll(async () => {
    await cleanup()
    delete process.env.WECOM_BRIDGE_URL__X
    await pool.end()
  })
  beforeEach(async () => {
    await cleanup()
    // 通道「已配置」= secret_refs 指向的 env 键在本进程可见（2026-10-31 起未配置的通道
    // 不再算可送达）。测试壳里把它点上，否则每个用例都会落 blocked=no_channel。
    process.env.WECOM_BRIDGE_URL__X = 'http://bridge.test/send'
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{}','{"bridge_url":"WECOM_BRIDGE_URL__X"}','u')`, [ORG])
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t1','T','m.a.b','published','tenant',1,'u')`, [ORG])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t1',1,'{"wecom_chat":{"text":"hi"}}','h1','approved','u')`, [ORG])
  })

  async function cleanup() {
    await pool.query('delete from notify.rule where org=$1', [ORG])
    await pool.query('delete from notify.event where org=$1', [ORG])
    await pool.query('delete from notify.inbox where org=$1', [ORG])
    await pool.query('delete from notify.template_revision where org=$1', [ORG])
    await pool.query('delete from notify.template where org=$1', [ORG])
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query('delete from notify.delivery where org=$1', [ORG])
    await pool.query('delete from notify.audit where org=$1', [ORG])
  }

  const post = (path: string, body: unknown) => app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('规则：合法创建、列表、启停、删除', async () => {
    const created = await post('/rules', {
      eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1',
      channels: ['wecom_default'],
    })
    expect(created.status).toBe(201)
    const { id } = await created.json() as { id: string }

    const list = await app.request('/rules')
    expect(((await list.json()) as { rules: unknown[] }).rules).toHaveLength(1)

    const off = await app.request(`/rules/${encodeURIComponent(id)}/enabled`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(off.status).toBe(200)

    const del = await app.request(`/rules/${encodeURIComponent(id)}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
  })

  it('规则：未知事件 / 未知收件人 / 未发布模板 ⇒ 400', async () => {
    expect((await post('/rules', {
      eventKey: 'm.x.y', recipientKey: 'approver', templateKey: 't1', channels: ['wecom_default'],
    })).status).toBe(400)

    expect((await post('/rules', {
      eventKey: 'm.a.b', recipientKey: 'nope', templateKey: 't1', channels: ['wecom_default'],
    })).status).toBe(400)

    expect((await post('/rules', {
      eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 'nope', channels: ['wecom_default'],
    })).status).toBe(400)
  })

  it('外部 emit：202 + 幂等 + 非法 payload 400', async () => {
    const ok = await post('/emit', {
      eventId: 'e1', eventKey: 'm.a.b', payload: { u: 'u1', link: 'https://x' },
    })
    expect(ok.status).toBe(202)
    expect(await ok.json()).toEqual({ accepted: true })

    const dup = await post('/emit', {
      eventId: 'e1', eventKey: 'm.a.b', payload: { u: 'u1', link: 'https://x' },
    })
    expect(await dup.json()).toEqual({ accepted: false, reason: 'duplicate' })

    const bad = await post('/emit', { eventId: 'e2', eventKey: 'm.a.b', payload: { u: 'u1' } })
    expect(bad.status).toBe(400)
  })

  it('收件箱：只读自己的、未读筛选、标记已读', async () => {
    await pool.query(
      `insert into notify.inbox(org,id,recipient,event_id,event_key,template_key,revision,title,body)
       values ($1,'i1','u1','e1','m.a.b','t1',1,'T','B')`, [ORG])
    await pool.query(
      `insert into notify.inbox(org,id,recipient,event_id,event_key,template_key,revision,title,body)
       values ($1,'i2','other','e2','m.a.b','t1',1,'T','B')`, [ORG])

    const all = await app.request('/inbox')
    expect(((await all.json()) as { items: unknown[] }).items).toHaveLength(1)

    const unread = await app.request('/inbox?unread=1')
    expect(((await unread.json()) as { items: unknown[] }).items).toHaveLength(1)

    expect((await app.request('/inbox/i1/read', { method: 'POST' })).status).toBe(200)
    const after = await app.request('/inbox?unread=1')
    expect(((await after.json()) as { items: unknown[] }).items).toHaveLength(0)
  })

  it('事件目录：列表与单项；未知 404', async () => {
    const list = await app.request('/events')
    expect(((await list.json()) as { events: unknown[] }).events).toHaveLength(1)
    expect((await app.request('/events/m.a.b')).status).toBe(200)
    expect((await app.request('/events/nope')).status).toBe(404)
  })

  it('模板：草稿 → 预览 → 发布；未知变量 400', async () => {
    const draft = await post('/templates/t1/revisions', {
      contents: { wecom_chat: { text: 'v2 {{u}}' } },
    })
    expect(draft.status).toBe(201)
    expect(await draft.json()).toEqual({ revision: 2 })

    const preview = await post('/templates/t1/preview', {
      contents: { wecom_chat: { text: '{{u}}' } },
      payload: { u: 'u1', link: 'https://x' },
    })
    expect(preview.status).toBe(200)
    expect(((await preview.json()) as { rendered: { wecom_chat: { text: string } } })
      .rendered.wecom_chat.text).toBe('u1')

    expect((await post('/templates/t1/preview', {
      contents: { wecom_chat: { text: '{{nope}}' } },
      payload: { u: 'u1', link: 'https://x' },
    })).status).toBe(400)

    const pub = await post('/templates/t1/publish', { revision: 2 })
    expect(pub.status).toBe(200)
    const t = await app.request('/templates/t1')
    expect(((await t.json()) as { publishedRevision: number }).publishedRevision).toBe(2)
  })

  it('通道：列表只回 env 键名；patch 拒密钥、允许 enabled', async () => {
    const list = await app.request('/channels')
    const body = (await list.json()) as {
      channels: { id: string; secretRefs: Record<string, string>; configured: boolean }[]
    }
    expect(body.channels[0]!.secretRefs).toEqual({ bridge_url: 'WECOM_BRIDGE_URL__X' })
    // env 键在 ⇒ 已配置；摘掉 ⇒ 立刻未配置（同一函数、同一份 env 口径，两个方向都咬住）
    expect(body.channels[0]!.configured).toBe(true)
    delete process.env.WECOM_BRIDGE_URL__X
    const un = (await (await app.request('/channels')).json()) as {
      channels: { configured: boolean }[]
    }
    expect(un.channels[0]!.configured).toBe(false)
    process.env.WECOM_BRIDGE_URL__X = 'http://bridge.test/send'

    const bad = await app.request('/channels/wecom_default', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret_refs: { bridge_url: 'X' } }),
    })
    expect(bad.status).toBe(400)

    const ok = await app.request('/channels/wecom_default', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(ok.status).toBe(200)
  })

  it('测试发送：只给自己；第 6 次 429', async () => {
    const body = {
      templateKey: 't1', channel: 'wecom_default', payload: { u: 'u1', link: 'https://x' },
      recipient: 'other', // 必须被忽略
    }
    for (let i = 0; i < 5; i++) {
      expect((await post('/test-send', body)).status).toBe(202)
    }
    expect((await post('/test-send', body)).status).toBe(429)

    const { rows } = await pool.query(
      'select distinct recipient, is_test from notify.delivery where org=$1', [ORG])
    expect(rows).toEqual([{ recipient: 'u1', is_test: true }])
  })

  it('publish 缺 notify:publish ⇒ 403（宿主门卫）', async () => {
    const declared = [{ method: 'POST', path: '/templates/:key/publish', scope: 'notify:publish' }]
    const guarded = new Hono<{ Variables: { identity: Identity } }>()
    guarded.use('*', async (c, next) => {
      c.set('identity', makeIdentity({ orgId: ORG, userId: 'u1', scopes: ['notify:manage'] }))
      await next()
    })
    guarded.use('/templates/:key/publish', declaredScopeGate(declared))
    guarded.route('/', notifyV2.createRouter({ pool, events, addresses }))

    const res = await guarded.request('/templates/t1/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision: 1 }),
    })
    expect(res.status).toBe(403)
  })

  it('POST /inbox/read-all 只标记自己的', async () => {
    await pool.query(
      `insert into notify.inbox(org,id,recipient,event_id,event_key,template_key,revision,title,body)
       values ($1,'i1','u1','e1','m.a.b','t1',1,'T','B'),
              ($1,'i2','u1','e2','m.a.b','t1',1,'T','B'),
              ($1,'i3','other','e3','m.a.b','t1',1,'T','B')`, [ORG])

    const res = await app.request('/inbox/read-all', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ marked: 2 })

    const { rows } = await pool.query(
      `select recipient, count(*) filter (where read_at is not null)::int n
         from notify.inbox where org=$1 group by recipient order by recipient`, [ORG])
    expect(rows).toEqual([
      { recipient: 'other', n: 0 },
      { recipient: 'u1', n: 2 },
    ])
  })

  it('webhook 通道健康：env 未配 ⇒ error（不假装 ok）', async () => {
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'webhook_ops','webhook',true,'{}',
               '{"url":"NOTIFY_WEBHOOK_URL__NOPE__OPS","key":"NOTIFY_WEBHOOK_KEY__NOPE__OPS"}','u')`,
      [ORG])

    const res = await app.request('/channels/webhook_ops/health', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false })

    const { rows } = await pool.query(
      "select health from notify.channel where org=$1 and id='webhook_ops'", [ORG])
    expect(String(rows[0].health)).toMatch(/^error/)
  })

  // ── D3 可送达性预检（只读）────────────────────────────────────────────────
  async function createRule(): Promise<string> {
    const res = await post('/rules', {
      eventKey: 'm.a.b', recipientKey: 'approver', templateKey: 't1',
      channels: ['wecom_default'],
    })
    expect(res.status).toBe(201)
    return ((await res.json()) as { id: string }).id
  }

  it('resolve：sample 模式能解析出 field 收件人；带 sample 局限 warning', async () => {
    const id = await createRule()
    const res = await app.request(`/rules/${encodeURIComponent(id)}/resolve`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      mode: string; blocked: string | null
      recipients: Array<{ name: string; source: string }>; warnings: string[]
    }
    expect(body.mode).toBe('sample')
    expect(body.blocked).toBeNull()
    expect(body.recipients).toHaveLength(1)
    expect(body.warnings).toContain('sample_mode_field_recipients_unverified')
  })

  it('resolve：payload 模式缺字段 ⇒ no_recipient', async () => {
    const id = await createRule()
    const res = await app.request(`/rules/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ payload: {} }),
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { blocked: string }).blocked).toBe('no_recipient')
  })

  it('resolve：未知 id ⇒ 404；缺 payload ⇒ 400', async () => {
    expect((await app.request('/rules/nope/resolve')).status).toBe(404)
    expect((await app.request('/rules/x/resolve', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })).status).toBe(400)
  })

  it('批量 deliverability：每条规则给人数（不被 :id 抢先匹配）', async () => {
    const id = await createRule()
    const res = await app.request('/rules/deliverability')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      rules: Array<{ ruleId: string; blocked: string | null; recipientCount: number }>
    }
    const mine = body.rules.find((x) => x.ruleId === id)
    expect(mine).toMatchObject({ blocked: null, recipientCount: 1 })
  })

  it('预检只读：不产生任何 delivery', async () => {
    const id = await createRule()
    const before = (await pool.query(
      'select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
    await app.request(`/rules/${encodeURIComponent(id)}/resolve`)
    await app.request('/rules/deliverability')
    const after = (await pool.query(
      'select count(*)::int n from notify.delivery where org=$1', [ORG])).rows[0].n
    expect(after).toBe(before)
  })

  it('投递重试：仅 failed/dead 可重试', async () => {
    await pool.query(
      `insert into notify.delivery
         (org,event_id,event_key,rule_id,recipient,channel,address,template_key,revision,rendered,status,attempts)
       values ($1,'e-r','m.a.b','r1','u1','wecom_default','wecom-u1','t1',1,'{}','failed',3)`, [ORG])
    const ok = await post('/deliveries/retry', {
      eventId: 'e-r', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
    })
    expect(ok.status).toBe(200)
    const { rows } = await pool.query(
      "select status from notify.delivery where org=$1 and event_id='e-r'", [ORG])
    expect(rows[0].status).toBe('pending')

    expect((await post('/deliveries/retry', {
      eventId: 'e-r', ruleId: 'r1', recipient: 'u1', channel: 'wecom_default',
    })).status).toBe(404)
  })
})

// ── 部门收件人（组织架构 Phase C；spec 2026-10-30 §3.5；#1174）──────────────────────
describePg('routes: 部门收件人', () => {
  const ORG2 = 'org-routes2-dept'
  const declDept: NotificationEventDecl = {
    key: 'm.a.b',
    title: 't',
    payload: { u: { type: 'user', required: true }, link: { type: 'url', required: true } },
    recipients: {
      approver: { kind: 'field', field: 'u' },
      byDept: { kind: 'dept', label: '按部门' },
    },
  }
  const eventsDept = {
    get: (k: string) => (k === 'm.a.b' ? declDept : undefined),
    list: () => [declDept],
  }

  let pool: Pool
  /** 每个用例可改：选择器数据源（undefined = 宿主没注入） */
  let orgNodes: Array<{ extId: string; name: string; parentExtId: string | null; memberCount: number }> | undefined
  let app: ReturnType<typeof buildTestApp>

  const addresses = (): ChannelAddressResolver => ({
    resolve: async ({ provider, casdoorName }) =>
      provider === 'wecom_chat' ? `wecom-${casdoorName}` : casdoorName,
    ...(orgNodes === undefined ? {} : { listOrgNodes: async () => orgNodes! }),
    resolveDeptMembers: async (_org, ids) => ({
      names: ['alice'], depts: [...ids], members: 3, excluded: 1, unresolved: 1,
    }),
  })

  const rebuild = () => {
    app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG2, userId: 'u1', scopes: ['notify:view', 'notify:manage'] }),
      { pool, events: eventsDept, addresses: addresses() },
    )
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    delete process.env.WECOM_BRIDGE_URL__X
    await pool.query('delete from notify.rule where org=$1', [ORG2]).catch(() => {})
    await pool.query('delete from notify.template_revision where org=$1', [ORG2]).catch(() => {})
    await pool.query('delete from notify.template where org=$1', [ORG2]).catch(() => {})
    await pool.query('delete from notify.channel where org=$1', [ORG2]).catch(() => {})
    await pool.end()
  })
  beforeEach(async () => {
    process.env.WECOM_BRIDGE_URL__X = 'http://bridge.test/send'
    await pool.query('delete from notify.rule where org=$1', [ORG2])
    await pool.query('delete from notify.channel where org=$1', [ORG2])
    await pool.query('delete from notify.template where org=$1', [ORG2])
    await pool.query('delete from notify.template_revision where org=$1', [ORG2])
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{}','{"bridge_url":"WECOM_BRIDGE_URL__X"}','u')`, [ORG2])
    await pool.query(
      `insert into notify.template(org,key,name,event_key,status,origin,published_revision,created_by)
       values ($1,'t1','T','m.a.b','published','tenant',1,'u')`, [ORG2])
    await pool.query(
      `insert into notify.template_revision(org,key,revision,contents,body_hash,review_status,created_by)
       values ($1,'t1',1,'{"wecom_chat":{"text":"hi"}}','h1','approved','u')`, [ORG2])
    orgNodes = [{ extId: 'D1', name: '共享中心', parentExtId: null, memberCount: 3 }]
    rebuild()
  })

  const postRule = (body: Record<string, unknown>) => app.request('/rules', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventKey: 'm.a.b', templateKey: 't1', channels: ['wecom_default'], ...body }),
  })

  it('★ 建部门规则：合法 id ⇒ 201，落库带 recipient_depts', async () => {
    const res = await postRule({ recipientKey: 'byDept', recipientDepts: ['D1'] })
    expect(res.status).toBe(201)
    const { id } = await res.json() as { id: string }
    const row = (await pool.query(
      'select recipient_depts from notify.rule where org=$1 and id=$2', [ORG2, id],
    )).rows[0]
    expect(row.recipient_depts).toEqual(['D1'])
  })

  it('★ 配置期 fail-closed：未知部门 400 / 组织架构未同步 409 / 解析器没注入 409', async () => {
    const unknown = await postRule({ recipientKey: 'byDept', recipientDepts: ['NOPE'] })
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).toMatchObject({ error: 'RULE_DEPT_UNKNOWN', unknown: ['NOPE'] })

    orgNodes = []                       // 组织架构未同步
    rebuild()
    const unsynced = await postRule({ recipientKey: 'byDept', recipientDepts: ['D1'] })
    expect(unsynced.status).toBe(409)
    expect(await unsynced.json()).toMatchObject({ error: 'ORG_NOT_SYNCED' })

    orgNodes = undefined                // 宿主没注入选择器
    rebuild()
    const noResolver = await postRule({ recipientKey: 'byDept', recipientDepts: ['D1'] })
    expect(noResolver.status).toBe(409)
    expect(await noResolver.json()).toMatchObject({ error: 'ORG_RESOLVER_UNAVAILABLE' })

    // 一行都没落（拒在写之前）
    expect((await pool.query('select 1 from notify.rule where org=$1', [ORG2])).rowCount).toBe(0)
  })

  it('部门档没选部门 ⇒ 400 RULE_DEPTS_REQUIRED', async () => {
    const res = await postRule({ recipientKey: 'byDept' })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'RULE_DEPTS_REQUIRED' })
  })

  it('★ 预检：部门规则回展开三数 + 收件人（「将发送给 N 人」的数据源）', async () => {
    const created = await postRule({ recipientKey: 'byDept', recipientDepts: ['D1'] })
    const { id } = await created.json() as { id: string }
    const res = await app.request(`/rules/${encodeURIComponent(id)}/resolve`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toMatchObject({
      blocked: null,
      recipients: [{ name: 'alice', source: 'dept' }],
      deptExpansion: { names: ['alice'], depts: ['D1'], members: 3, excluded: 1, unresolved: 1 },
    })
    // 解析器都在 ⇒ 不该出 unavailable 警告
    expect(body.warnings).not.toContain('dept_resolver_unavailable')
  })

  it('预检：宿主没注入部门解析器 ⇒ 规则阻塞 + 显式 warning', async () => {
    // 先用正常解析器建好规则，再把 app 换成「只有 resolve」的宿主面
    const created = await postRule({ recipientKey: 'byDept', recipientDepts: ['D1'] })
    const { id } = await created.json() as { id: string }
    app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG2, userId: 'u1', scopes: ['notify:view', 'notify:manage'] }),
      { pool, events: eventsDept, addresses: { resolve: async () => null } },
    )
    const body = await (await app.request(`/rules/${encodeURIComponent(id)}/resolve`)).json() as Record<string, unknown>
    expect(body.blocked).toBe('dept_resolver_unavailable')
    expect(body.warnings).toContain('dept_resolver_unavailable')
    expect(body.warnings).toContain('scope_holders_unavailable')
  })

  it('GET /org-depts：注入 ⇒ 平表 + available；没注入 ⇒ available=false（前端据此禁用）', async () => {
    const ok = await (await app.request('/org-depts')).json() as { depts: unknown[]; available: boolean }
    expect(ok.available).toBe(true)
    expect(ok.depts).toEqual([{ extId: 'D1', name: '共享中心', parentExtId: null, memberCount: 3 }])

    app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG2, userId: 'u1', scopes: ['notify:view', 'notify:manage'] }),
      { pool, events: eventsDept, addresses: { resolve: async () => null } },
    )
    const none = await (await app.request('/org-depts')).json() as { depts: unknown[]; available: boolean }
    expect(none.available).toBe(false)
    expect(none.depts).toEqual([])
  })
})
