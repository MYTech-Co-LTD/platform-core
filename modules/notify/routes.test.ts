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
    await pool.end()
  })
  beforeEach(async () => {
    await cleanup()
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
    expect(body.channels[0]!.configured).toBe(false)

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
