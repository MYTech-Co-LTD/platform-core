// worker-deps.test.ts — 组合根：env → secret_refs、provider 分发、in-app 落库
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations, makeIdentity } from './test-util'
import { buildWorkerDeps } from './worker-deps'
import { isForbiddenHost } from './domain/net-guard'
import type { DeliveryRow } from './storage'

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

    const deps = buildWorkerDeps(pool, async () => null, { WECOM_BRIDGE_URL__ORG_WD2: 'https://bridge/wecom/x?t=tok' })
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
    const deps = buildWorkerDeps(pool, async () => null, {})
    expect(await deps.send(row())).toMatchObject({ ok: false, kind: 'permanent', code: 'secret_missing' })
  })

  it('★ wecom 直连：**不要求桥的 env**（退役依赖不该变成新前置）', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'wecom_default','wecom_chat',true,'{"transport":"direct"}','{"bridge_url":"MISSING_KEY"}','u')`,
      [ORG])
    const { upsertCredential } = await import('./domain/credential-store')
    const env = { NOTIFY_CRED_KEK: 'a'.repeat(64) }
    await upsertCredential(pool, ORG, 'wecom', { appKey: 'ww-wd2', agentId: '100', secret: 's' }, 'u', env)

    let captured: { url: string; body: string } | null = null
    const orig = globalThis.fetch
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      const url = String(u)
      if (url.includes('/cgi-bin/gettoken')) {
        return new Response(JSON.stringify({ errcode: 0, access_token: 'tok', expires_in: 7200 }), { status: 200 })
      }
      captured = { url, body: String(init?.body) }
      return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
    }) as typeof fetch
    try {
      const { __resetTokenCache } = await import('./domain/im/wecom-direct')
      __resetTokenCache()
      expect(await buildWorkerDeps(pool, async () => null, env).send(row())).toEqual({ ok: true })
    } finally {
      globalThis.fetch = orig
      await pool.query('delete from notify.channel_credential where org=$1', [ORG])
    }
    // 走的是企微官方 send 端点，且 tou user 是收件地址
    expect(captured!.url).toContain('qyapi.weixin.qq.com/cgi-bin/message/send')
    expect(JSON.parse(captured!.body)).toMatchObject({ touser: 'wecom-u1', agentid: 100 })
  })

  it('in_app：写收件箱', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'inapp_default','in_app',true,'{}','{}','u')`,
      [ORG])
    const deps = buildWorkerDeps(pool, async () => null, {})
    const r = await deps.send(row({
      channel: 'inapp_default', address: 'u1',
      rendered: { title: 'T', body: 'B', link: 'https://x' },
    }))
    expect(r).toEqual({ ok: true })
    const { rows } = await pool.query('select title,body from notify.inbox where org=$1', [ORG])
    expect(rows[0]).toEqual({ title: 'T', body: 'B' })
  })

  it('webhook：从 secret_refs 取 url/key 并发送', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'webhook_ops','webhook',true,'{}',
               '{"url":"NOTIFY_WEBHOOK_URL__ORG_WD2__OPS","key":"NOTIFY_WEBHOOK_KEY__ORG_WD2__OPS"}','u')`,
      [ORG])

    const deps = buildWorkerDeps(pool, async () => null, {
      NOTIFY_WEBHOOK_URL__ORG_WD2__OPS: 'https://hooks.example.com/x',
      NOTIFY_WEBHOOK_KEY__ORG_WD2__OPS: 'secret',
    }, async () => ['93.184.216.34'])

    let captured: { url: string; body: string } | null = null
    const orig = globalThis.fetch
    globalThis.fetch = (async (u: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(u), body: String(init?.body) }
      return new Response(null, { status: 204 })
    }) as typeof fetch
    try {
      const r = await deps.send(row({
        channel: 'webhook_ops', address: '', rendered: { text: 'hello' },
      }))
      expect(r).toEqual({ ok: true })
      expect(captured!.url).toBe('https://hooks.example.com/x')
      expect(captured!.body).toContain('"rendered":{"text":"hello"}')
    } finally {
      globalThis.fetch = orig
    }
  })

  it('webhook：私网 URL ⇒ permanent，不外发', async () => {
    await pool.query(
      `insert into notify.channel(org,id,provider,enabled,config,secret_refs,created_by)
       values ($1,'webhook_intranet','webhook',true,'{}',
               '{"url":"NOTIFY_WEBHOOK_URL__ORG_WD2__IN","key":"NOTIFY_WEBHOOK_KEY__ORG_WD2__IN"}','u')`,
      [ORG])
    const deps = buildWorkerDeps(pool, async () => null, {
      NOTIFY_WEBHOOK_URL__ORG_WD2__IN: 'https://10.0.0.7/hook',
      NOTIFY_WEBHOOK_KEY__ORG_WD2__IN: 'secret',
    })
    const r = await deps.send(row({ channel: 'webhook_intranet', address: '' }))
    expect(r).toMatchObject({ ok: false, kind: 'permanent', code: 'unsafe_url' })
    expect(isForbiddenHost('10.0.0.7')).toBe(true)
  })

  it('scope_holders v1 返回空（literal 兜底）', async () => {
    const deps = buildWorkerDeps(pool, async () => null, {})
    expect(await deps.resolveScopeHolders(ORG, 'approvers', {
      key: 'm.a.b', title: '', payload: {}, recipients: {},
    })).toEqual([])
  })

  it('scope_holders：未注入解析器 ⇒ 空 + warn；注入后按权限码解析', async () => {
    const decl = {
      key: 'm.a.b', title: '',
      payload: {},
      recipients: { approvers: { kind: 'scope_holders', scope: 'aftersales:manage' } },
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const noResolver = buildWorkerDeps(pool, async () => null, {})
      expect(await noResolver.resolveScopeHolders(ORG, 'approvers', decl as never)).toEqual([])
      expect(warn.mock.calls.some((c) => String(c[0]).includes('scope_holders 未注入'))).toBe(true)
    } finally {
      warn.mockRestore()
    }

    const calls: Array<[string, string]> = []
    const withResolver = buildWorkerDeps(pool, async () => null, {}, undefined,
      async (org, code) => { calls.push([org, code]); return ['alice', 'bob'] })
    expect(await withResolver.resolveScopeHolders(ORG, 'approvers', decl as never))
      .toEqual(['alice', 'bob'])
    expect(calls).toEqual([[ORG, 'aftersales:manage']])
  })

  it('scope_holders：recipient 不是 scope_holders ⇒ 不调解析器', async () => {
    const decl = { key: 'm.a.b', title: '', payload: {}, recipients: { u: { kind: 'field', field: 'x' } } }
    const calls: unknown[] = []
    const deps = buildWorkerDeps(pool, async () => null, {}, undefined,
      async () => { calls.push(1); return ['x'] })
    expect(await deps.resolveScopeHolders(ORG, 'u', decl as never)).toEqual([])
    expect(calls).toEqual([])
  })

  it('测试脚手架可用（makeIdentity 未被用到时也不报错）', () => {
    expect(makeIdentity({ orgId: ORG }).orgId).toBe(ORG)
  })
})
