// routes/api-keys.test.ts — /api/platform/keys（issue #894）。
// 组装：tenant/session/identity 三注入替身 + apiKeysRoutes（真实链路 = 租户解析 → 会话中间件）。
// 断言四条：① 个人档免 scope（无任何码也能管自己的）② 管理档 tenant:admin fail-closed
//          ③ 写操作必须 x-csrf-token ④ 归属钉死（拿别人的 id 吊销 ⇒ 404；跨租户看不见）
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { csrfToken, type SessionPayload } from '@platform/auth-core'
import type { Identity } from '@platform/sdk'
import { runMigrations } from '../migrate'
import type { TenantEnv, TenantRow } from '../tenant'
import type { SessionEnv } from '../session-middleware'
import { apiKeyRoutes } from './api-keys'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const SECRET = 'x'.repeat(32)
const ORG = 'org-894-routes'
const OTHER_ORG = 'org-894-other'

const TENANT = { id: 1, slug: 'acme', casdoor_org: ORG } as unknown as TenantRow

describePg('api-key routes（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await runMigrations(pool, 'platform', fileURLToPath(new URL('../migrations', import.meta.url)))
  })
  afterAll(async () => {
    await pool.query('delete from platform.api_key where org = any($1)', [[ORG, OTHER_ORG]])
    await pool.end().catch(() => {})
  })

  function build(scopes: string[], userId = 'alice', org = ORG) {
    const session = { sub: userId, org, name: userId, scopes, exp: 9e9, iat: 0 } as unknown as SessionPayload
    const identity = {
      userId,
      orgId: org,
      displayName: userId,
      scopes,
      hasScope: (code: string) => scopes.includes(code),
    } as Identity
    const app = new Hono<TenantEnv & SessionEnv>()
    app.use('*', async (c, next) => {
      c.set('tenant', { ...TENANT, casdoor_org: org } as TenantRow)
      c.set('session', session)
      c.set('identity', identity)
      await next()
    })
    app.route('/', apiKeyRoutes({ pool, sessionSecret: SECRET }))
    return { app, csrf: csrfToken(session, SECRET) }
  }

  const post = (csrf: string, body: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
    body: JSON.stringify(body),
  })

  it('写操作缺 x-csrf-token ⇒ 403 CSRF', async () => {
    const { app } = build([])
    const r = await app.request('/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' })
    expect(r.status).toBe(403)
    expect((await r.json()).error).toBe('CSRF')
  })

  it('个人档免 scope：无任何权限码也能建自己的 key，明文只回一次', async () => {
    const { app, csrf } = build([]) // ← 空 scopes
    const r = await app.request('/', post(csrf, { name: '我的 key' }))
    expect(r.status).toBe(201)
    const body = await r.json()
    expect(typeof body.token).toBe('string')
    expect(body.token.startsWith('dkq_')).toBe(true)
    const list = await (await app.request('/')).json()
    expect(list.keys.some((k: { id: number }) => k.id === body.id)).toBe(true)
    // 库里只有哈希
    const raw = await pool.query('select token_hash from platform.api_key where id = $1', [body.id])
    expect(raw.rows[0].token_hash).not.toContain(body.token)
  })

  it('名称为空 ⇒ 400', async () => {
    const { app, csrf } = build([])
    expect((await app.request('/', post(csrf, { name: '  ' }))).status).toBe(400)
  })

  it('管理档 fail-closed：无 tenant:admin ⇒ 403', async () => {
    const { app } = build(['data:query'])
    const r = await app.request('/all')
    expect(r.status).toBe(403)
    expect((await r.json()).need).toBe('tenant:admin')
  })

  it('管理档：tenant:admin 看得到全租户的 key', async () => {
    const { app: a, csrf } = build([])
    await a.request('/', post(csrf, { name: 'bob 的 key' }))
    const { app: admin } = build(['tenant:admin'], 'root')
    const list = await (await admin.request('/all')).json()
    expect(list.keys.length).toBeGreaterThan(0)
    expect(list.keys.some((k: { casdoorUser: string }) => k.casdoorUser === 'alice')).toBe(true)
  })

  it('归属钉死：拿别人的 key id 吊销 ⇒ 404（不是 403，不泄露存在性）', async () => {
    const { app: a, csrf } = build([])
    const created = await (await a.request('/', post(csrf, { name: 'alice 的' }))).json()
    const { app: bob, csrf: bobCsrf } = build([], 'bob')
    expect((await bob.request(`/${created.id}`, { method: 'DELETE', headers: { 'x-csrf-token': bobCsrf } })).status).toBe(404)
  })

  it('吊销自己的 ⇒ ok；再吊销 ⇒ 404', async () => {
    const { app, csrf } = build([])
    const created = await (await app.request('/', post(csrf, { name: '待吊销' }))).json()
    const del = () => app.request(`/${created.id}`, { method: 'DELETE', headers: { 'x-csrf-token': csrf } })
    expect((await del()).status).toBe(200)
    expect((await del()).status).toBe(404)
  })

  it('跨租户：别的 org 的 key 在本 org 列表里看不见', async () => {
    const { app: other, csrf: otherCsrf } = build([], 'carol', OTHER_ORG)
    await other.request('/', post(otherCsrf, { name: '别家' }))
    const { app } = build(['tenant:admin'], 'root')
    const list = await (await app.request('/all')).json()
    expect(list.keys.some((k: { casdoorUser: string }) => k.casdoorUser === 'carol')).toBe(false)
  })
})
