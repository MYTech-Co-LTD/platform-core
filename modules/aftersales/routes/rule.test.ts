import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-rule'

describePg('规则域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    { pool },
  )

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket_rule where org = $1', [ORG])
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_rule where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const post = (body: unknown) =>
    app.request('/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  it('新建规则 ⇒ 201，比例按【小数】落 numeric(6,4)', async () => {
    const res = await post({ name: '常规售后', refundRatio: 0.1, remark: '' })
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select name, refund_ratio from aftersales.ticket_rule where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ name: '常规售后', refund_ratio: '0.1000' })
  })

  it('四舍五入到 4 位小数（源侧保存走 .toFixed(4)，列型 numeric(6,4) 对齐）', async () => {
    const res = await post({ name: '多位小数', refundRatio: 0.123456789 })
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select refund_ratio from aftersales.ticket_rule where id = $1', [id])
    expect(row.rows[0].refund_ratio).toBe('0.1235')
  })

  it('比例越界 ⇒ 400（与工单处理共用 normalizeRatio 一条口径）', async () => {
    for (const bad of [1.5, -0.2]) {
      const res = await post({ name: '越界', refundRatio: bad })
      expect(res.status).toBe(400)
      expect((await res.json()) as { error: string }).toMatchObject({ error: 'INVALID_AMOUNT' })
    }
  })

  it('列表只回本 org，且恒有 org 过滤（租户隔离）', async () => {
    const res = await app.request('/rules')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string }[] }
    expect(body.items.map((r) => r.name)).toContain('常规售后')

    const other = makeIdentity({ orgId: 'test-aftersales-rule-other', scopes: ['aftersales:manage'] })
    const otherRes = await buildTestApp(mod, other, { pool }).request('/rules')
    expect((await otherRes.json()) as { items: unknown[] }).toMatchObject({ items: [] })
  })

  it('改规则 ⇒ 200；跨 org 改别人的规则 ⇒ 404（不是 403，避免泄露存在性）', async () => {
    const created = await post({ name: '待改', refundRatio: 0.2 })
    const { id } = (await created.json()) as { id: number }

    const ok = await app.request(`/rules/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '改过了', refundRatio: 0.25 }),
    })
    expect(ok.status).toBe(200)

    const other = makeIdentity({ orgId: 'test-aftersales-rule-other', scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, { pool }).request(`/rules/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '越权改', refundRatio: 0.3 }),
    })
    expect(cross.status).toBe(404)
    // 回读：值没被跨租户改掉
    const row = await pool.query('select name from aftersales.ticket_rule where org = $1 and id = $2', [ORG, id])
    expect(row.rows[0].name).toBe('改过了')
  })

  it('删规则 ⇒ 200；再删同一条 ⇒ 404', async () => {
    const created = await post({ name: '待删', refundRatio: 0.05 })
    const { id } = (await created.json()) as { id: number }
    expect((await app.request(`/rules/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect((await app.request(`/rules/${id}`, { method: 'DELETE' })).status).toBe(404)
  })
})
