import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import { storageRefOf } from '@platform/sdk'
import type { TenantStorageConfig } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

// 与其他测试文件共用同一个临时 org 前缀，避免互相看见对方的行。
const ORG = 'test-aftersales-ticket'
const OTHER_ORG = 'test-aftersales-ticket-other'

/** 本请求注入的存储配置（M3c 步 4）。本文件**不 stub env**：平台默认因此为 null，
 *  于是「ref 解析不出来」是这里的默认情形之一（见末尾那条降级用例）。 */
const TENANT_CFG: TenantStorageConfig = {
  kind: 's3',
  endpoint: 'https://zos.tenant.test',
  region: 'xinan1',
  bucket: 'tenant-b1',
  accessKeyId: 'AKIATENANT',
  secretAccessKey: 'sk-tenant',
}
const TENANT_REF = storageRefOf(TENANT_CFG)
/** 两边都对不上的 ref（模拟「配置换过、旧桶读不了」）。
 *  ⚠️ 下面两条用例**各用一个不同的 ghost ref**：warn 的 60s 去重键是 `org|ref`，
 *  共用同一个 ref 时第二条用例的 warn 会被去重吃掉 ⇒ 断言变成随机成败。 */
const GHOST_REF = 's3|https://zos.ghost.test|ghost-bucket'
const GHOST_REF_2 = 's3|https://zos.ghost2.test|ghost-bucket-2'

describePg('工单域', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const manage = makeIdentity({ orgId: ORG, scopes: ['aftersales:manage'] })
  const guest = makeIdentity({ orgId: ORG, userId: 'openid-alice', scopes: ['aftersales:guest'] })
  const guestBob = makeIdentity({ orgId: ORG, userId: 'openid-bob', scopes: ['aftersales:guest'] })
  // buildTestApp 的第三个参数是宿主的 ModuleContext（本仓模块只用到 pool）。
  // 第 4 参是**本请求的存储配置**（M3c 步 4）：与宿主投影同形状。旧注释说「不要在这里塞
  // storage，模块自己从 process.env 解析」——那句描述的是**装载期形态**，已被本步消灭；
  // 现在的注入点就是它，且是唯一能把配置交给模块的方式。
  const ctx = { pool }
  const appManage = buildTestApp(mod, manage, ctx, TENANT_CFG)
  const appGuest = buildTestApp(mod, guest, ctx, TENANT_CFG)
  const appGuestBob = buildTestApp(mod, guestBob, ctx, TENANT_CFG)

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
  // 这里【直接用 SQL 造受害者的附件行】而不走 POST /guest/attachments：要的是**精确控制行上
  // 的 storage_ref**（被测端点只会写当前注入的 ref），而本用例要钉的是【认领语句的谓词】。
  // 落库形状与 routes/attachment.ts 的 insert 逐字一致（`storage_ref` 默认 '' = 本列引入前的行）。
  const seedAttachment = async (
    clientRequestId: string,
    uploaderOpenid: string,
    suffix: string,
    storageRef = '',
  ) => {
    const objectKey = `aftersales/${ORG}/${clientRequestId}/00000000-0000-4000-8000-0000000000${suffix}`
    const res = await pool.query<{ id: string }>(
      `insert into aftersales.ticket_attachment(
         org, ticket_id, client_request_id, object_key, content_type, size_bytes, uploader_openid, storage_ref)
       values ($1, null, $2, $3, 'image/jpeg', 1024, $4, $5) returning id`,
      [ORG, clientRequestId, objectKey, uploaderOpenid, storageRef],
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

  // ── M3c 步 4：单件附件签不出来 ⇒ **只让该项 url 为 null**（降级语义，既有行为） ──
  // 为什么降级在这里正当：工单本身的数据仍然有用，附件拉不到是「降级」不是「失败」
  // （附件专用端点才是 503）。条件是该失败**在日志里显式可见**（deploy-verify §3：
  // 不许用容错掩盖失败）—— 所以下面第二条用例专门钉那条 warn。
  it('【M3c 步 4】某附件 ref 解析不出来 ⇒ 该项 url=null、其余项照常签，工单本身仍 200', async () => {
    const REQ = 'req-ref-ghost-a'
    const good = await seedAttachment(REQ, 'openid-alice', 'g1', TENANT_REF)
    const ghost = await seedAttachment(REQ, 'openid-alice', 'g2', GHOST_REF)

    const created = await submit(appGuest, { ...validBody(REQ), attachmentIds: [good.id, ghost.id] })
    expect(created.status).toBe(201)
    const ticketId = ((await created.json()) as { id: number }).id

    const res = await appGuest.request(`/guest/tickets/${ticketId}`)
    expect(res.status).toBe(200) // ← 降级：工单数据照常可用，**不是** 503
    const body = (await res.json()) as { attachments: { id: number; url: string | null }[] }
    expect(body.attachments).toHaveLength(2)
    const urlOf = new Map(body.attachments.map((a) => [a.id, a.url]))
    expect(urlOf.get(ghost.id)).toBeNull() // 只这一项
    expect(String(urlOf.get(good.id))).toContain('zos.tenant.test') // 其余项照常，且用的是注入配置
  })

  it('【M3c 步 4】ref 解析不出来 ⇒ 服务端留一条 warn（含 org 与 ref，**不含任何凭据**）', async () => {
    const REQ = 'req-ref-ghost-b'
    const ghost = await seedAttachment(REQ, 'openid-alice', 'g3', GHOST_REF_2)
    const created = await submit(appGuest, { ...validBody(REQ), attachmentIds: [ghost.id] })
    const ticketId = ((await created.json()) as { id: number }).id

    // 客户端只会看到「附件打不开」（预签名是本地计算，平台发不出这个错）⇒ 这条 warn 是
    // 该故障在本仓的**唯一信号**，所以要钉住它真的发了出来、且内容安全。
    const spy = vi.spyOn(console, 'warn')
    try {
      const res = await appGuest.request(`/guest/tickets/${ticketId}`)
      expect(res.status).toBe(200)
      const hit = spy.mock.calls.map((a) => String(a[0])).find((m) => m.includes(GHOST_REF_2))
      expect(hit, '应当为解析不出来的 ref 留一条 warn').toBeTruthy()
      expect(hit).toContain(ORG)
      expect(hit).not.toContain(TENANT_CFG.accessKeyId)
      expect(hit).not.toContain(TENANT_CFG.secretAccessKey)
    } finally {
      spy.mockRestore()
    }
  })

  // ── 终审修复轮 1（I-1）：body 参数面的整数上界，**按目标列的列型分档** ──
  // 修前 `z.number().int()` 的 `int` 就是 `Number.isInteger`，而 `Number.isInteger(1e30) === true`
  // ⇒ 越界值直接进 pg 参数位：`|v| ≥ 1e21` 被序列化成指数记法 ⇒ 22P02；低于 1e21 但超列型 ⇒ 22003
  // ⇒ **Hono 兜成 500**。终审实测 8 条路径全 500（含对外访客面）。
  it('【回归 I-1】访客提交 body 的越界整数 ⇒ 400（不是 500），且不落库', async () => {
    // bigint 列（product_id / store_id / ticket_attachment.id）：上界 = Number.MAX_SAFE_INTEGER
    // integer 列（damage_quantity）：上界 = int4 ⇒ 2147483647
    const cases: Record<string, unknown>[] = [
      { productId: 1e30 },
      { storeId: 1e30 },
      { damageQuantity: 1e30 },
      { damageQuantity: 2147483648 }, // int4 越界 1
      { damageQuantity: Number.MAX_SAFE_INTEGER }, // 是安全整数，却仍超 int4（实测 22003）
      { attachmentIds: [1e30] },
      { productId: Number.MAX_SAFE_INTEGER + 1 }, // 超出安全整数
    ]
    for (const [i, patch] of cases.entries()) {
      const req = `req-i1-bad-${i}`
      const res = await submit(appGuest, { ...validBody(req), ...patch })
      expect(res.status, `${JSON.stringify(patch)} 应为 400，实为 ${res.status}`).toBe(400)
      expect(((await res.json()) as { error: string }).error).toBe('INVALID_BODY')
      const cnt = await pool.query(
        'select count(*)::int as n from aftersales.ticket where org = $1 and client_request_id = $2',
        [ORG, req],
      )
      expect(cnt.rows[0].n, `${JSON.stringify(patch)} 不得落库`).toBe(0)
    }
  })

  it('【回归 I-1·边界对照】合法边界仍被接受：damageQuantity 恰好 2147483647 ⇒ 201', async () => {
    const boundary = await submit(appGuest, { ...validBody('req-i1-max'), damageQuantity: 2147483647 })
    expect(boundary.status).toBe(201)
    // 反向：再大一个就 400（上界是【恰好 int4 上限】，不是更松也不是更紧）
    const over = await submit(appGuest, { ...validBody('req-i1-over'), damageQuantity: 2147483648 })
    expect(over.status).toBe(400)
  })

  // ── 终审修复轮 1（I-2）：7 处 path-param id 守卫收成 routes/context.ts 的 parseIdParam ──
  // 修前内联守卫是 `!Number.isInteger(id) || id <= 0`，而 `Number.isInteger(1e23) === true`
  // ⇒ 超大数字串放行 ⇒ 落进 bigint 参数位 ⇒ 500（实测 `GET …/tickets/1e23` ⇒ 500）；
  // `Number('1.0') === 1`、`Number('1e2') === 100` ⇒ 非规范 id 被【静默接受】。
  // 本用例是【访客面 + 管理面】两条真实路由的端到端连线证据（helper 本身的形状由
  // routes/context.test.ts 的单测钉住）。各处【保留原有的状态码】：管理面 400、访客面 404。
  it('【回归 I-2】路径 id 越界 / 非规范 ⇒ 不是 500，且各站点保留原有状态码', async () => {
    for (const raw of ['1e23', '99999999999999999999999', '1e30', '1.0', '1e2', '-1', 'abc', '0']) {
      const m = await appManage.request(`/tickets/${raw}`)
      expect(m.status, `管理端 GET /tickets/${raw}`).toBe(400)
      expect((await m.json()) as { error: string }, `管理端 /tickets/${raw}`).toMatchObject({
        error: 'INVALID_ID',
      })

      const g = await appGuest.request(`/guest/tickets/${raw}`)
      expect(g.status, `访客端 GET /guest/tickets/${raw}`).toBe(404)
      expect((await g.json()) as { error: string }, `访客端 /guest/tickets/${raw}`).toMatchObject({
        error: 'NOT_FOUND',
      })
    }
  })

  it('【回归 I-2·边界对照】规范 id 仍然放行：不存在的 id=999999999 ⇒ 各自原有语义', async () => {
    // 管理端：行不存在 ⇒ 404 NOT_FOUND（**不是** INVALID_ID——守卫放行了，是查询没命中）
    const m = await appManage.request('/tickets/999999999')
    expect(m.status).toBe(404)
    expect((await m.json()) as { error: string }).toMatchObject({ error: 'NOT_FOUND' })
    // 访客面同理（此前该用例已存在，这里补一条形状一致的对照）
    const g = await appGuest.request('/guest/tickets/999999999')
    expect(g.status).toBe(404)
  })
})
