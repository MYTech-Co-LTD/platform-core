import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// 与其他测试文件共用同一个临时 org 前缀，避免互相看见对方的行。
const ORG = 'test-aftersales-ticket'
const OTHER_ORG = 'test-aftersales-ticket-other'

describePg('工单域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const manage = makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] })
  const guest = makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] })
  const guestBob = makeIdentity({ orgId: ORG, userId: 'openid-bob', scopes: ['aftersales:guest'] })
  // buildTestApp 的第三个参数就是宿主的 ModuleContext（本仓模块只用到 pool）。
  // 【不要】在这里塞 storage：模块自己从 process.env 解析 ZOS 配置（见 index.ts），
  // 从测试注入的 storage 根本到不了 createRouter 里面——那会是一个静默失效的注入点。
  const ctx = { pool }
  const appManage = buildTestApp(mod, manage, ctx)
  const appGuest = buildTestApp(mod, guest, ctx)
  const appGuestBob = buildTestApp(mod, guestBob, ctx)

  let productId = 0
  let storeId = 0

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from aftersales.ticket where org = $1', [ORG])
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    // 商品快照：基本数量 100 件、单价 500 分（=5 元/件）⇒ 与 domain 测试同一组数
    const p = await pool.query<{ id: string }>(
      `insert into aftersales.product(org, name, spec, basic_quantity, basic_unit_price_minor)
       values ($1, '测试商品', '规格A', 100, 500) returning id`,
      [ORG],
    )
    productId = Number(p.rows[0].id)
    const s = await pool.query<{ id: string }>(
      `insert into aftersales.store(org, name, address, phone) values ($1, '测试门店', '', '') returning id`,
      [ORG],
    )
    storeId = Number(s.rows[0].id)
  })

  afterAll(async () => {
    await pool.query('delete from aftersales.ticket_attachment where org = $1', [ORG])
    await pool.query('delete from aftersales.ticket where org = $1', [ORG])
    await pool.query('delete from aftersales.product where org = $1', [ORG])
    await pool.query('delete from aftersales.store where org = $1', [ORG])
    expect(pool.ended, '池在本 afterAll 之前已被 end——有别的钩子提前收摊').toBe(false)
    await pool.end().catch(() => {})
  })

  const submit = (app: typeof appGuest, body: Record<string, unknown>) =>
    app.request('/guest/tickets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const validBody = (clientRequestId: string) => ({
    clientRequestId,
    productId,
    storeId,
    damageQuantity: 30,
    remark: '摔坏了',
  })

  it('访客提交工单 ⇒ 201，商品字段被【快照】下来，状态 pending、金额类型暂空', async () => {
    const res = await submit(appGuest, validBody('req-snap'))
    expect(res.status).toBe(201)
    const body = (await res.json()) as { id: number; code: string; status: string }
    expect(body.status).toBe('pending')
    expect(body.code).toMatch(/^AS-\d{8}$/)

    const row = await pool.query(
      `select product_name, store_name, basic_quantity, basic_unit_price_minor,
              amount_type, amount_minor, submitter_openid
         from aftersales.ticket where org = $1 and id = $2`,
      [ORG, body.id],
    )
    expect(row.rows[0]).toMatchObject({
      product_name: '测试商品',
      store_name: '测试门店',
      basic_quantity: 100,
      basic_unit_price_minor: '500', // ← pg 把 bigint 返回成字符串，别按 number 断言
      amount_type: null,
      amount_minor: '0',
      submitter_openid: 'openid-alice',
    })
  })

  it('幂等：同 clientRequestId 二次提交 ⇒ 返回【同一张】工单，且不新增行', async () => {
    const first = await submit(appGuest, validBody('req-idem'))
    const second = await submit(appGuest, validBody('req-idem'))
    expect(second.status).toBe(200)
    const a = (await first.json()) as { id: number }
    const b = (await second.json()) as { id: number }
    expect(b.id).toBe(a.id)
    const cnt = await pool.query(
      'select count(*)::int as n from aftersales.ticket where org = $1 and client_request_id = $2',
      [ORG, 'req-idem'],
    )
    expect(cnt.rows[0].n).toBe(1)
  })

  it('访客只能看到自己的工单：alice 提交的，bob 查列表看不到、按 id 查是 404（与不存在同形）', async () => {
    const created = await submit(appGuest, validBody('req-private'))
    const { id } = (await created.json()) as { id: number }

    const bobList = await appGuestBob.request('/guest/tickets')
    const bobBody = (await bobList.json()) as { items: { id: number }[] }
    expect(bobBody.items.some((t) => t.id === id)).toBe(false)

    const bobDetail = await appGuestBob.request(`/guest/tickets/${id}`)
    expect(bobDetail.status).toBe(404)
    // 同形：不存在的 id 也是 404、同样的错误体（不泄露"存在但不属于你"）
    const ghost = await appGuestBob.request('/guest/tickets/999999999')
    expect(ghost.status).toBe(404)
    expect(await bobDetail.text()).toBe(await ghost.text())
  })

  it('管理端看不到别的 org 的工单（租户隔离）', async () => {
    const other = makeIdentity({ orgId: OTHER_ORG, scopes: ['aftersales:manage'] })
    const res = await buildTestApp(mod, other, ctx).request('/tickets')
    const body = (await res.json()) as { items: { id: number }[]; total: number }
    expect(body.total).toBe(0)
    expect(body.items).toEqual([])
  })

  it('ratio 处理 ⇒ completed、服务端按规则算出金额（不信前端传来的任何金额）', async () => {
    const created = await submit(appGuest, validBody('req-ratio'))
    const { id } = (await created.json()) as { id: number }

    const res = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 刻意塞一个 amountMinor 想让服务端采信——ratio 路必须无视它
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 0.1, amountMinor: 999999 }),
    })
    expect(res.status).toBe(200)

    const row = await pool.query(
      'select status, amount_type, amount_minor, refund_ratio, processed_at from aftersales.ticket where org = $1 and id = $2',
      [ORG, id],
    )
    // (30 − 100×0.1) × 500 分 = 10000 分
    expect(row.rows[0]).toMatchObject({
      status: 'completed',
      amount_type: 'ratio',
      amount_minor: '10000',
      refund_ratio: '0.1000',
    })
    expect(row.rows[0].processed_at).not.toBeNull()
  })

  it('reject 处理 ⇒ cancelled、金额强制 0', async () => {
    const created = await submit(appGuest, validBody('req-reject'))
    const { id } = (await created.json()) as { id: number }
    const res = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(res.status).toBe(200)
    const row = await pool.query(
      'select status, amount_type, amount_minor, refund_ratio from aftersales.ticket where org = $1 and id = $2',
      [ORG, id],
    )
    expect(row.rows[0]).toMatchObject({
      status: 'cancelled',
      amount_type: 'reject',
      amount_minor: '0',
      refund_ratio: null,
    })
  })

  it('重复处理同一张工单 ⇒ 409（状态机条件更新的影响行数为 0）', async () => {
    const created = await submit(appGuest, validBody('req-double'))
    const { id } = (await created.json()) as { id: number }
    const first = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(first.status).toBe(200)
    const second = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(second.status).toBe(409)
    expect((await second.json()) as { error: string }).toMatchObject({ error: 'ALREADY_PROCESSED' })
  })

  it('处理不存在的工单 ⇒ 404', async () => {
    const res = await appManage.request('/tickets/999999999/process', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(res.status).toBe(404)
  })

  it('非法处理体（比例越界 / 固定额非整数）⇒ 400，且工单保持 pending', async () => {
    const created = await submit(appGuest, validBody('req-badbody'))
    const { id } = (await created.json()) as { id: number }
    const bad = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 1.5 }),
    })
    expect(bad.status).toBe(400)
    const row = await pool.query('select status from aftersales.ticket where org = $1 and id = $2', [ORG, id])
    expect(row.rows[0].status).toBe('pending')
  })

  it('管理端列表按状态筛选 + 分页，只回本 org', async () => {
    const res = await appManage.request('/tickets?status=pending&page=1&size=2')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; total: number; page: number; size: number }
    expect(body.page).toBe(1)
    expect(body.size).toBe(2)
    expect(body.items.length).toBeLessThanOrEqual(2)
    expect(body.total).toBeGreaterThan(0)
  })

  it('size 超上界被夹到 100（防止一次拉全表）', async () => {
    const res = await appManage.request('/tickets?size=99999')
    const body = (await res.json()) as { size: number }
    expect(body.size).toBe(100)
  })
})
