// store-profiles.test.ts — 门店画像写面 HTTP 形状（#2924）。
// 模块壳不挂宿主门卫（data:store 的 403 由宿主按 manifest 施加）；这里验入参/状态码/响应形状。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = `org-store-route-${Math.random().toString(36).slice(2, 8)}`
let pool: Pool

const appFor = (userId = 'alice') => buildTestApp(
  mod,
  makeIdentity({ orgId: ORG, userId, scopes: ['data:query', 'data:store'] }),
  { pool } as never,
  { id: 1, casdoor_org: ORG },
)

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describePg('store-profiles 路由（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    await clean()
    await pool.query(
      `insert into data.dim_branch(org, code, name, enable, source_book, snapshot)
       values ($1,'S1','一店',true,'3120',current_date)`,
      [ORG],
    )
    await pool.query(
      `insert into data.brand_registry(org, code, name) values ($1,'xiongmao','熊喵')`,
      [ORG],
    )
    await pool.query(
      `insert into data.store_level_registry(org, code, name, sort) values ($1,'A','一级',1)`,
      [ORG],
    )
  })

  afterAll(async () => {
    await clean().catch(() => {})
    await pool.end().catch(() => {})
  })

  async function clean(): Promise<void> {
    await pool.query('delete from data.store_profile_audit where org = $1', [ORG])
    await pool.query('delete from data.store_profile where org = $1', [ORG])
    await pool.query('delete from data.brand_registry where org = $1', [ORG])
    await pool.query('delete from data.store_level_registry where org = $1', [ORG])
    await pool.query('delete from data.dim_branch where org = $1', [ORG])
  }

  it('PUT：设置品牌/等级，返回 v_store_profile 形状', async () => {
    const res = await appFor().request('/store-profiles/S1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandCode: 'xiongmao', levelCode: 'A' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      storeCode: 'S1', storeName: '一店',
      brandCode: 'xiongmao', brandName: '熊喵', brandSource: 'manual',
      levelCode: 'A', levelName: '一级', levelSource: 'manual',
    })
  })

  it('PUT：空 body / 未知门店 / 非法字段类型 ⇒ 400', async () => {
    const empty = await appFor().request('/store-profiles/S1', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    expect(empty.status).toBe(400)
    expect((await empty.json()).error).toBe('INVALID_BODY')

    const unknown = await appFor().request('/store-profiles/NOPE', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandCode: 'xiongmao' }),
    })
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toBe('INVALID_STORE')

    const bad = await appFor().request('/store-profiles/S1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ brandCode: 123 }),
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()).error).toBe('INVALID_BODY')
  })

  it('import：dryRun 必填；dry-run 返回逐行结果', async () => {
    const missing = await appFor().request('/store-profiles/import', json({
      rows: [{ storeCode: 'S1', brandCode: 'xiongmao' }],
    }))
    expect(missing.status).toBe(400)
    expect((await missing.json()).error).toBe('INVALID_BODY')

    const res = await appFor().request('/store-profiles/import', json({
      dryRun: true,
      rows: [
        { storeCode: 'S1', brandCode: 'xiongmao', levelCode: 'A' },
        { storeCode: 'NOPE', brandCode: 'xiongmao' },
      ],
    }))
    expect(res.status).toBe(200)
    const body = await res.json() as { dryRun: boolean; total: number; errors: number }
    expect(body).toMatchObject({ dryRun: true, total: 2, errors: 1 })
  })

  it('store-levels：create 201 / duplicate 409 / PATCH 200', async () => {
    const created = await appFor().request('/store-levels', json({
      code: 'B', name: '二级', sort: 2,
    }))
    expect(created.status).toBe(201)
    expect(await created.json()).toMatchObject({ code: 'B', name: '二级', sort: 2, enabled: true })

    const dup = await appFor().request('/store-levels', json({ code: 'B', name: '重复' }))
    expect(dup.status).toBe(409)
    expect((await dup.json()).error).toBe('DUP_CODE')

    const patched = await appFor().request('/store-levels/B', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(patched.status).toBe(200)
    expect(await patched.json()).toMatchObject({ code: 'B', enabled: false })
  })
})
