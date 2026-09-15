import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { DEFAULT_PAGE_SIZE } from './context'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'test-aftersales-md'

describePg('主数据域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = buildTestApp(
    mod,
    makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] }),
    { pool },
  )

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.employee where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    await pool.query(
      `insert into aftersales.store(org, name, address, phone) values ($1,'上海门店','', ''), ($1,'北京门店','','')`,
      [ORG],
    )
    await pool.query(
      `insert into aftersales.product(org, name, spec, basic_quantity, basic_unit_price_minor)
       values ($1,'苹果','规格A',100,500), ($1,'梨','规格B',50,300)`,
      [ORG],
    )
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.employee where org = $1', [ORG])
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const json = (body: unknown) => ({
    method: 'POST' as const,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  it('门店列表只回本 org', async () => {
    const res = await app.request('/stores')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: { name: string }[] }
    expect(body.items.map((s) => s.name).sort()).toEqual(['上海门店', '北京门店'])
  })

  it('商品按名搜索（服务端过滤，不搬源侧「全量 13767 行 + 前端过滤」）', async () => {
    const hit = await app.request('/products?q=苹果')
    const hitBody = (await hit.json()) as { items: { name: string }[] }
    expect(hitBody.items.map((p) => p.name)).toEqual(['苹果'])

    const miss = await app.request('/products?q=不存在的名字')
    expect(((await miss.json()) as { items: unknown[] }).items).toEqual([])
  })

  it('商品分页：size 被夹到 100，单价以整数分回（bigint 已转 number）', async () => {
    const res = await app.request('/products?size=99999')
    const body = (await res.json()) as { size: number; items: { basicUnitPriceMinor: number }[] }
    expect(body.size).toBe(100)
    const apple = body.items.find((p) => p.basicUnitPriceMinor === 500)
    expect(apple).toBeDefined()
  })

  // 分页口径与管理端/访客端**同一份** parsePageParam（context.ts）。两条边界必须钉住：
  // ① 非法值回落默认（**不是 500**——非法值直接进 pg 的 limit/offset 会抛 22P02 被 Hono 兜成 500）；
  // ② page 上界不得去掉（去掉则 ?page=1e21 的 offset 溢出 pg bigint ⇒ 500）。
  it('商品分页：非法 page/size 回落默认值，不 500', async () => {
    for (const qs of ['size=-5', 'size=1.5', 'size=abc', 'size=', 'page=1.5', 'page=0', 'page=']) {
      const res = await app.request(`/products?${qs}`)
      expect(res.status, `?${qs}`).toBe(200)
      const body = (await res.json()) as { page: number; size: number }
      expect(Number.isInteger(body.page), `?${qs} page`).toBe(true)
      expect(Number.isInteger(body.size), `?${qs} size`).toBe(true)
    }
    const fallback = (await (await app.request('/products?size=-5&page=0')).json()) as { page: number; size: number }
    expect(fallback).toMatchObject({ page: 1, size: DEFAULT_PAGE_SIZE })
  })

  it('商品分页：page 上界存在（极大 page 不 500，offset 不溢出 pg bigint）', async () => {
    const res = await app.request('/products?page=1e21&size=100')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { page: number }
    expect(body.page).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('员工注册 ⇒ 201、审批态默认 pending', async () => {
    const res = await app.request('/employees', json({ name: '张三', phone: '13800000000' }))
    expect(res.status).toBe(201)
    const { id } = (await res.json()) as { id: number }
    const row = await pool.query('select approve_status, open_id from aftersales.employee where id = $1', [id])
    expect(row.rows[0]).toMatchObject({ approve_status: 'pending', open_id: '' })
  })

  it('员工列表可按审批态筛选，open_id 被带出来（它是移动端身份锚）', async () => {
    const res = await app.request('/employees?approveStatus=pending')
    const body = (await res.json()) as { items: { name: string; approveStatus: string; openId: string }[] }
    expect(body.items.every((e) => e.approveStatus === 'pending')).toBe(true)
    expect(body.items.find((e) => e.name === '张三')?.openId).toBe('')
  })

  it('审批通过 ⇒ 200 且状态落 approved；非法审批值 ⇒ 400', async () => {
    const created = await app.request('/employees', json({ name: '李四', phone: '13900000000' }))
    const { id } = (await created.json()) as { id: number }

    const bad = await app.request(`/employees/${id}/approve`, json({ approveStatus: 'maybe' }))
    expect(bad.status).toBe(400)

    const ok = await app.request(`/employees/${id}/approve`, json({ approveStatus: 'approved' }))
    expect(ok.status).toBe(200)
    const row = await pool.query('select approve_status from aftersales.employee where id = $1', [id])
    expect(row.rows[0].approve_status).toBe('approved')
  })

  it('跨 org 审批别人的员工 ⇒ 404（rowCount 0 与不存在同形）', async () => {
    const created = await app.request('/employees', json({ name: '王五', phone: '13700000000' }))
    const { id } = (await created.json()) as { id: number }
    const other = makeIdentity({ orgId: 'test-aftersales-md-other', scopes: ['aftersales:manage'] })
    const cross = await buildTestApp(mod, other, { pool }).request(
      `/employees/${id}/approve`,
      json({ approveStatus: 'approved' }),
    )
    expect(cross.status).toBe(404)
    const row = await pool.query('select approve_status from aftersales.employee where id = $1', [id])
    expect(row.rows[0].approve_status).toBe('pending')
  })

  it('员工注册带门店时，门店必须属于本 org（跨租户门店 id ⇒ 400，不是静默落 null）', async () => {
    const other = makeIdentity({ orgId: 'test-aftersales-md-other', scopes: ['aftersales:manage'] })
    const otherStore = await pool.query<{ id: string }>(
      `insert into aftersales.store(org, name, address, phone) values ($1,'别人的门店','','') returning id`,
      ['test-aftersales-md-other'],
    )
    const res = await app.request(
      '/employees',
      json({ name: '赵六', phone: '13600000000', storeId: Number(otherStore.rows[0].id) }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'STORE_NOT_FOUND' })
    await pool.query('delete from aftersales.store where org = $1', ['test-aftersales-md-other'])
  })
})
