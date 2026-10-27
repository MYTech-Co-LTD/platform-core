// worker-deps.test.ts — 组合根：env → secret_refs、provider 分发、in-app 落库
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, makeIdentity } from './test-util'
import { buildWorkerDeps } from './worker-deps'
import type { DeliveryRow } from './storage-v2'

const url = process.env.DATABASE_URL
const describePg = url ? describe : describe.skip
const ORG = 'org-wd2'

describePg('buildWorkerDeps', () => {
  let pool: Pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: url })
    await applyMigrations(pool)
  })
  afterAll(async () => {
    await cleanup()
    await pool.end()
  })
  beforeEach(cleanup)

  async function cleanup() {
    await pool.query('delete from notify.channel where org=$1', [ORG])
    await pool.query('delete from notify.inbox where org=$1', [ORG])
  }

  const row = (over: Partial<DeliveryRow> = {}): DeliveryRow => ({
    org: ORG, eventId: 'e1', eventKey: 'm.a.b', ruleId: 'r1', recipient: 'u1',
    channel: 'wecom_default', address: 'wecom-u1', templateKey: 't1', revision: 1,
    rendered: { text: 'hi' }, status: 'pending', attempts: 0, lockedUntil: null,
    ...over,
  })

  it('wecom：从 secret_refs 取 env，直发 bridge（to=address）', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{}','{"bridge_url":"WECOM_BRIDGE_URL__ORG_WD2"}','u')`,
      [ORG])

    const deps = buildWorkerDeps(pool, { WECOM_BRIDGE_URL__ORG_WD2: 'https://bridge/wecom/x?t=tok' })
    let captured: { url: string; body: string } | null = null
    const orig = globalThis.fetch
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(u), body: String(init?.body) }
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      expect(await deps.send(row())).toEqual({ ok: true })
    } finally {
      globalThis.fetch = orig
    }
    expect(captured!.url).toBe('https://bridge/wecom/x?t=tok&to=wecom-u1')
    expect(captured!.body).toBe(JSON.stringify({ content: 'hi' }))
  })

  it('wecom：secret_refs 缺 env ⇒ permanent（不假装成功）', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{}','{"bridge_url":"MISSING_KEY"}','u')`,
      [ORG])
    const deps = buildWorkerDeps(pool, {})
    expect(await deps.send(row())).toMatchObject({ ok: false, kind: 'permanent', code: 'secret_missing' })
  })

  it('in_app：写收件箱', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'inapp_default','in_app',true,'{}','{}','u')`,
      [ORG])
    const deps = buildWorkerDeps(pool, {})
    const r = await deps.send(row({
      channel: 'inapp_default', address: 'u1',
      rendered: { title: 'T', body: 'B', link: 'https://x' },
    }))
    expect(r).toEqual({ ok: true })
    const { rows } = await pool.query('select title,body from notify.inbox where org=$1', [ORG])
    expect(rows[0]).toEqual({ title: 'T', body: 'B' })
  })

  it('scope_holders v1 返回空（literal 兜底）', async () => {
    const deps = buildWorkerDeps(pool, {})
    expect(await deps.resolveScopeHolders(ORG, 'approvers', {
      key: 'm.a.b', title: '', payload: {}, recipients: {},
    })).toEqual([])
  })

  it('测试脚手架可用（makeIdentity 未被用到时也不报错）', () => {
    expect(makeIdentity({ orgId: ORG }).orgId).toBe(ORG)
  })
})
