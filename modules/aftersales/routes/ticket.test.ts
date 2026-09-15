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

  // ── 修复轮 1/5（裁决 B）：访客列表此前【内联】算 page/size、不做整数守卫 ──
  // 非法值直接落进 pg 的 limit/offset 参数位 ⇒ 22P02 ⇒ 500。以下用例先红后绿。
  it('【回归】访客列表：?page=1.5&size=1 ⇒ 200（不是 500），回显整数 1/1', async () => {
    const res = await appGuest.request('/guest/tickets?page=1.5&size=1')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { page: number; size: number }
    expect(body.page).toBe(1)
    expect(body.size).toBe(1)
  })

  it('【回归】访客列表：其余非法分页形状一律 200，且回显必为整数（不得回显 2.5/Infinity）', async () => {
    for (const qs of ['page=2.5&size=3', 'page=Infinity&size=20', 'size=1.5', 'page=2.5', 'size=abc']) {
      const res = await appGuest.request(`/guest/tickets?${qs}`)
      expect(res.status, `?${qs} 应为 200`).toBe(200)
      const body = (await res.json()) as { page: number; size: number }
      expect(Number.isInteger(body.page), `?${qs} 的 page 应为整数，实为 ${body.page}`).toBe(true)
      expect(Number.isInteger(body.size), `?${qs} 的 size 应为整数，实为 ${body.size}`).toBe(true)
      expect(body.page).toBeGreaterThanOrEqual(1)
      expect(body.size).toBeGreaterThanOrEqual(1)
    }
  })

  it('【回归】?size=-5：管理端与访客端必须回同一个值（一份常量 + 一份解析，不许漂移）', async () => {
    const guestRes = await appGuest.request('/guest/tickets?size=-5')
    const manageRes = await appManage.request('/tickets?size=-5')
    expect(guestRes.status).toBe(200)
    expect(manageRes.status).toBe(200)
    const guestBody = (await guestRes.json()) as { size: number }
    const manageBody = (await manageRes.json()) as { size: number }
    // 计划既定口径：非法值【回落默认值】
    expect(manageBody.size).toBe(20)
    expect(guestBody.size).toBe(manageBody.size)
  })

  // ── 修复轮 1/5（裁决 C）：列缺席 ⇒ 别名字段缺席，不得替「没查的列」编造 null ──
  // 访客列表是有意的【窄 SELECT】（不含 product_id / store_id / refund_ratio），而
  // normalizeTicketRow 曾无条件映射这三列：productId/storeId 变 Number(undefined)=NaN 被
  // JSON.stringify 写成 null，refundRatio 走 toRatioOrNull(undefined) → null。后者最重：
  // T4 契约里 refundRatio:null 的语义是「fixed/reject 路，没有比例」（domain/ticket.ts）
  // ⇒ 访客端把「按 0.1235 赔 8825 分」显示成与「驳回、无比例」同形。
  it('【回归】ratio 工单：访客列表没 SELECT 的三列不得被编造成 null，管理端/详情仍是真值', async () => {
    const created = await submit(appGuest, validBody('req-alias-ratio'))
    const { id } = (await created.json()) as { id: number }
    const proc = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'ratio', refundRatio: 0.1235 }),
    })
    expect(proc.status).toBe(200)

    const guestList = (await (await appGuest.request('/guest/tickets?size=100')).json()) as {
      items: Record<string, unknown>[]
    }
    const manageList = (await (await appManage.request('/tickets?size=100')).json()) as {
      items: Record<string, unknown>[]
    }
    const detail = (await (await appGuest.request(`/guest/tickets/${id}`)).json()) as Record<string, unknown>
    const li = guestList.items.find((i) => i.id === id)
    const mi = manageList.items.find((i) => i.id === id)
    expect(li, `访客列表里应有工单 ${id}`).toBeDefined()
    expect(mi, `管理端列表里应有工单 ${id}`).toBeDefined()

    // ① 访客列表：这三列不在 SELECT 里 ⇒ 别名字段【必须缺席】（`'键' in item === false`）。
    //    这是本轮 F2 的正主——修前这里是 `refundRatio:null` / `productId:null`。
    expect('refundRatio' in li!).toBe(false)
    expect('productId' in li!).toBe(false)
    expect('storeId' in li!).toBe(false)

    // ② 缺席为何无害：访客仍能靠金额类型/金额判别「按比例赔」——缺席的不是判别依据。
    //    注意键名：本接口的金额类型就是 snake_case 的 `amount_type`（normalizeTicketRow 只给
    //    amount_minor 起了 camelCase 别名，没给 amount_type 起），故按【实际契约】断言。
    expect(li!.amount_type).toBe('ratio')
    expect(li!.amountMinor).toBe(8825)

    // ③ 对照：访客详情是宽 SELECT，必须给出真值（修前就正确，别弱化）。
    expect(detail.refundRatio).toBe(0.1235)
    expect(detail.productId).toBe(productId)

    // ④ 管理端列表也是宽 SELECT ⇒ 必须仍是真值（钉住「没把管理端一起弄成缺席」）。
    expect(mi!.refundRatio).toBe(0.1235)
    expect(mi!.productId).toBe(productId)
  })

  it('【回归】reject 工单：null 的语义必须保住（详情 + 管理端列表），访客列表该键必然缺席', async () => {
    const created = await submit(appGuest, validBody('req-alias-reject'))
    const { id } = (await created.json()) as { id: number }
    const proc = await appManage.request(`/tickets/${id}/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amountType: 'reject' }),
    })
    expect(proc.status).toBe(200)

    const manageList = (await (await appManage.request('/tickets?size=100')).json()) as {
      items: Record<string, unknown>[]
    }
    const detail = (await (await appGuest.request(`/guest/tickets/${id}`)).json()) as Record<string, unknown>
    const mi = manageList.items.find((i) => i.id === id)
    expect(mi, `管理端列表里应有工单 ${id}`).toBeDefined()

    // 列【在场且为 null】⇒ 别名必须是 null（**不是缺席**）：这就是 fixed/reject 路的表达。
    expect('refundRatio' in detail).toBe(true)
    expect(detail.refundRatio).toBeNull()
    expect('refundRatio' in mi!).toBe(true)
    expect(mi!.refundRatio).toBeNull()

    // 访客列表（窄 SELECT）不含该列 ⇒ 键必然缺席，故这里【不】断言该键：
    // 断言 null 会假红，断言缺席才是本轮的约定——已在上一张 ratio 工单的用例里钉住。
  })

  // ── 终审修复轮 1（C-1，Critical）：附件认领语句缺【所有权谓词】 ──
  // 修前 ticket-guest.ts 的 `update aftersales.ticket_attachment … where` 只有
  // `org / id = any(…) / client_request_id / ticket_id is null`——**没有 uploader_openid**。
  // 失败场景（终审已端到端实测，那条 UPDATE rowCount=1）：同租户内另一个访客只要把
  // clientRequestId 猜/撞成受害者那一个，就能认领【别人】尚未提交的附件，再经
  // GET /guest/tickets/:id 拿到该附件的 objectKey（配好 ZOS 的真机上还带完整预签名 GET URL），
  // 而受害者侧 total=0、零可观测迹象。被突破的是**授权面**，故定 Critical。
  //
  // 这里【直接用 SQL 造受害者的附件行】而不走 POST /guest/attachments：后者要 ZOS 凭证
  // （本文件没 stub，没配就 503），而本用例要钉的是【认领语句的谓词】，与预签名可用性无关。
  // 落库形状与 routes/attachment.ts 的 insert 逐字一致。
  const seedAttachment = async (clientRequestId: string, uploaderOpenid: string, suffix: string) => {
    const objectKey = `aftersales/${ORG}/${clientRequestId}/00000000-0000-4000-8000-0000000000${suffix}`
    const res = await pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(
         org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid)
       values ($1, null, $2, $3, 'image/jpeg', 1024, $4) returning id`,
      [ORG, clientRequestId, objectKey, uploaderOpenid],
    )
    return { id: Number(res.rows[0].id), objectKey }
  }

  it('【回归·安全 C-1】同租户另一访客用同一 clientRequestId 认领 ⇒ 抢不走别人的附件', async () => {
    const REQ = 'req-c1-shared'
    // 受害者 bob 先传了图、还【没提交工单】——这正是「先传图后提交」的正常时序（spec §2.3）
    const victim = await seedAttachment(REQ, 'openid-bob', 'c1')

    // 攻击者 alice 用【同一个 clientRequestId】提交工单，并把这个 id 列进 attachmentIds
    const attack = await submit(appGuest, { ...validBody(REQ), attachmentIds: [victim.id] })
    expect(attack.status).toBe(201)
    const attackerTicketId = ((await attack.json()) as { id: number }).id

    // ① 库里（最强的一条）：受害者的行【没被认领】，且 uploader 仍是 bob
    const row = await pool.query(
      'select ticket_id, uploader_openid from aftersales.ticket_attachment where org = $1 and id = $2',
      [ORG, victim.id],
    )
    expect(row.rows[0]).toMatchObject({ ticket_id: null, uploader_openid: 'openid-bob' })

    // ② 接口面（泄露面本身）：攻击者的工单详情里【不得】出现受害者的 objectKey
    const detail = (await (await appGuest.request(`/guest/tickets/${attackerTicketId}`)).json()) as {
      attachments: { objectKey: string }[]
    }
    expect(detail.attachments.map((a) => a.objectKey)).not.toContain(victim.objectKey)
    expect(detail.attachments).toEqual([])
  })

  it('【回归·安全 C-1·对照】上传者认领【自己的】附件 ⇒ 仍然认领得到（修复不得误伤正常路径）', async () => {
    const REQ = 'req-c1-own'
    const mine = await seedAttachment(REQ, 'openid-alice', 'c2')

    const res = await submit(appGuest, { ...validBody(REQ), attachmentIds: [mine.id] })
    expect(res.status).toBe(201)
    const ticketId = ((await res.json()) as { id: number }).id

    const row = await pool.query(
      'select ticket_id, uploader_openid from aftersales.ticket_attachment where org = $1 and id = $2',
      [ORG, mine.id],
    )
    expect(Number(row.rows[0].ticket_id)).toBe(ticketId)
    expect(row.rows[0].uploader_openid).toBe('openid-alice')

    const detail = (await (await appGuest.request(`/guest/tickets/${ticketId}`)).json()) as {
      attachments: { objectKey: string }[]
    }
    expect(detail.attachments.map((a) => a.objectKey)).toEqual([mine.objectKey])
  })

})
