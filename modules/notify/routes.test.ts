// routes-v2.test.ts — v2 端点（规则/投递/外部 emit/收件箱）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import type { NotificationEventDecl } from '@platform/sdk'
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

describePg('routes v2', () => {
  let pool: Pool
  let app: ReturnType<typeof buildTestApp>

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
    app = buildTestApp(
      notifyV2,
      makeIdentity({ orgId: ORG, userId: 'u1', scopes: ['notify:view', 'notify:manage', 'notify:emit'] }),
      { pool, events },
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
       values ($1,'wecom_default','wecom_chat',true,'{}','{}','u')`, [ORG])
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
})
