// keys.test.ts — 个人 Key 路由（GET/POST/DELETE /keys）的路由层测试。
// 模块壳（buildTestApp）不挂宿主门卫与三通道中间件——那部分归 T10 的端到端；
// 这里验：明文 token 只在创建响应出现一次、Key 归属 (org, casdoorUser) 钉死、
// 参数面拒（名称长度 / id 形状）、M3 守卫下的入口行为。
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与 metrics/query 的测试互不相同，避免互相擦数据。 */
const ORG = 'org-t7-keys'
const TENANT = 9004

describePg('个人 Key 路由（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  beforeEach(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.query_keys where org = $1', [ORG])
  })
  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  /**
   * casdoorUser 取 requesterOf(c).userId（三通道统一：会话 sub / PAT casdoorUser / 企微 userid），
   * 所以测试里用 userId 扮人。第 4 参是 T1 的 DataTenant 对象（不是裸数字）。
   */
  function app(casdoorUser = 'alice') {
    return buildTestApp(
      mod,
      makeIdentity({ orgId: ORG, userId: casdoorUser }),
      { pool },
      { id: TENANT, casdoor_org: ORG },
    )
  }

  it('建 key → 201 + 明文 token（dkq_ 前缀），响应带 id/name', async () => {
    const res = await app().request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '我的 agent' }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.token.startsWith('dkq_')).toBe(true)
    expect(body.name).toBe('我的 agent')
    expect(typeof body.id).toBe('number')
  })

  it('列 key → 只有自己的，且列表**不含**明文 token', async () => {
    await app('alice').request('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'a' }) })
    await app('bob').request('/keys', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'b' }) })
    const res = await app('alice').request('/keys')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.keys).toHaveLength(1)
    expect(body.keys[0].name).toBe('a')
    expect(body.keys[0]).toMatchObject({ revoked: false, lastUsedAt: null })
    // 明文绝不回列表面（库里只有 sha256，PatKeyRow 本就没有 token 字段）
    expect(JSON.stringify(body)).not.toContain('dkq_')
  })

  it('吊销 → 204；再吊销同一 id → 404；非数字 id → 404', async () => {
    const created = await (await app().request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'k' }),
    })).json()
    expect((await app().request(`/keys/${created.id}`, { method: 'DELETE' })).status).toBe(204)
    expect((await app().request(`/keys/${created.id}`, { method: 'DELETE' })).status).toBe(404)
    expect((await app().request('/keys/not-a-number', { method: 'DELETE' })).status).toBe(404)
  })

  it('吊销**别人的** id → 404，且对方的 key 原样健在（不越权、不给存在性探针）', async () => {
    const created = await (await app('bob').request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bob 的' }),
    })).json()
    // alice 拿 bob 的 id 去吊销：WHERE 带 casdoor_user 查不中 → false → 404
    expect((await app('alice').request(`/keys/${created.id}`, { method: 'DELETE' })).status).toBe(404)
    const bobList = await (await app('bob').request('/keys')).json()
    expect(bobList.keys).toHaveLength(1)
    expect(bobList.keys[0].revoked).toBe(false)
  })

  it('名称空 / 纯空白 / 超 64 → 400 INVALID_BODY', async () => {
    const bad = (name: string) => app().request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }),
    })
    expect((await bad('')).status).toBe(400)
    expect((await bad('   ')).status).toBe(400)
    expect((await bad('x'.repeat(65))).status).toBe(400)
  })

  it('M3 守卫（身份 orgId 为空串）：GET → 空列表不报错；POST → 403 拒绝（fail-closed）', async () => {
    const emptyOrg = buildTestApp(
      mod,
      makeIdentity({ orgId: '', userId: 'alice' }),
      { pool },
      { id: TENANT, casdoor_org: ORG },
    )
    const listed = await emptyOrg.request('/keys')
    expect(listed.status).toBe(200)
    expect((await listed.json()).keys).toEqual([])
    const created = await emptyOrg.request('/keys', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    })
    expect(created.status).toBe(403)
    expect((await created.json()).error).toBe('UNAUTHENTICATED')
  })
})
