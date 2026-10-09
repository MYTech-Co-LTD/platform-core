import { z } from 'zod'
import { TENANT_STORAGE } from '@platform/sdk'
import { storageCandidatesFor, storageResolverFor } from '../storage'
import { loadAttachments, normalizeTicketRow } from './ticket-manage'
// 分页常量与解析器在 routes/context.ts：与管理端【同一份】实现、【同一套】语义
// （此前本文件内联算 page/size 且无整数守卫 ⇒ 非法值 500；?size=-5 也与端点间漂移）。
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

/**
 * `ticket.damage_quantity` 是 **int4** 列，上界必须按列型取——**不能**借 bigint 那档的
 * `MAX_SAFE_INTEGER`：`9007199254740991` 是安全整数却仍超 int4（实测 `22003`）。
 */
const MAX_INT4 = 2_147_483_647

const SubmitBody = z.object({
  // 客户端幂等键（spec §2.2）；同时是附件 object key 里的 {ticket_ref}（spec §2.3）
  clientRequestId: z.string().min(1).max(128),
  // 自然键（#500/#476）：门店 = data.dim_branch.code；商品 = data.dim_item.item_code（在售）。
  // 发布契约形状（非空、限长、无通配/注入面字符）；坏值一律 400 INVALID_BODY。
  storeCode: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  itemCode: z.string().regex(/^[0-9A-Za-z_-]{1,64}$/),
  // 挂原单取价（spec §6.2）：MO…/WO… 单号 + 单内商品行键（MO=item_grade_num / WO=order_detail_num）。
  // 行级三元组一起精确锁价——价随单走，票面可追溯到具体那张 MO/WO 的那一行。
  orderNo: z.string().regex(/^(MO|WO)[0-9]{6,}$/),
  lineKey: z.string().regex(/^[0-9A-Za-z_-]{1,32}$/),
  // 这一档走 int4 上界，见 MAX_INT4。
  damageQuantity: z.number().int().nonnegative().max(MAX_INT4),
  remark: z.string().max(2000).optional(),
  /** 本次提交要一起认领的附件（先传图后提交，见 spec §2.3） */
  attachmentIds: z.array(z.number().int().positive().safe()).max(50).optional(),
})

export function registerTicketGuest(r: ModuleHono, ctx: RouteCtx): void {
  // GET /guest/tickets —— 只回自己的（按 submitter_openid 收窄，spec §2.2）
  r.get('/guest/tickets', async (c) => {
    const identity = c.get('identity')
    // 与管理端同一口径（parsePageParam）：非法值回落默认值，超出上界夹住。
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const totalRes = await ctx.pool.query<{ n: number }>(
      'select count(*)::int as n from aftersales.ticket where org = $1 and submitter_openid = $2',
      [identity.orgId, identity.userId],
    )
    const listRes = await ctx.pool.query(
      `select id, code, product_name, store_name, damage_quantity, status,
              amount_type, amount_minor, remark, created_at, processed_at
         from aftersales.ticket
        where org = $1 and submitter_openid = $2
        order by id desc
        limit $3 offset $4`,
      [identity.orgId, identity.userId, size, (page - 1) * size],
    )
    return c.json({
      items: listRes.rows.map(normalizeTicketRow),
      total: totalRes.rows[0].n,
      page,
      size,
    })
  })

  // GET /guest/tickets/:id —— 不是自己的 ⇒ 404（与不存在同形，不泄露"存在但不属于你"）
  r.get('/guest/tickets/:id', async (c) => {
    const identity = c.get('identity')
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const res = await ctx.pool.query(
      `select id, code, product_id, product_name, store_id, store_name,
              product_code, store_code,
              damage_quantity, status, amount_type, amount_minor, refund_ratio,
              settlement_source, settlement_order_no, settlement_item_code, settlement_line_key,
              settlement_price_minor, settlement_bizday,
              remark, related_order, created_at, processed_at
         from aftersales.ticket
        where org = $1 and id = $2 and submitter_openid = $3`,
      [identity.orgId, id, identity.userId],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({
      ...normalizeTicketRow(row),
      // 与 ticket-manage 的详情端点同形：本请求候选集穿进加载器，逐行按 storage_ref 解析
      attachments: await loadAttachments(
        ctx, identity.orgId, id, storageResolverFor(storageCandidatesFor(c.get(TENANT_STORAGE))),
      ),
    })
  })

  // GET /guest/settlement-orders?storeCode=&days= —— 选单页数据源（#500 段③，spec §6.1）。
  // 按店列近期结算单（bizday 倒序），按单分组；days 默认 30、夹到 [1,90]。
  // 消费面 = data.dim_settlement_order_line 单表查询——售后不感知 MO/WO 两源（spec §0 通用性）。
  r.get('/guest/settlement-orders', async (c) => {
    const org = c.get('identity').orgId
    const storeCode = c.req.query('storeCode') ?? ''
    if (!storeCode) return c.json({ error: 'STORE_CODE_REQUIRED' }, 400)
    const daysRaw = Number(c.req.query('days') ?? 30)
    const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.trunc(daysRaw), 1), 90) : 30

    const res = await ctx.pool.query<{
      source: string; order_no: string; order_bizday: string; order_time: string | null
      item_code: string; item_name: string | null; line_key: string
      quantity: string | null; price_minor: string
    }>(
      `select source, order_no, order_bizday::text as order_bizday, order_time,
              item_code, item_name, line_key, quantity, price_minor
         from data.dim_settlement_order_line
        where org = $1 and store_code = $2
          and order_bizday >= current_date - $3::int
        order by order_bizday desc, order_no, item_code, line_key`,
      [org, storeCode, days],
    )
    /** 按单分组：一单 = {orderNo, source, bizday, createTime, lines[]}——选单页的两级选择面。 */
    const orders = new Map<string, {
      orderNo: string; source: string; bizday: string; createTime: string | null
      lines: { itemCode: string; itemName: string | null; lineKey: string; quantity: number | null; priceMinor: number }[]
    }>()
    for (const r of res.rows) {
      let o = orders.get(r.order_no)
      if (!o) {
        o = { orderNo: r.order_no, source: r.source, bizday: r.order_bizday, createTime: r.order_time, lines: [] }
        orders.set(r.order_no, o)
      }
      o.lines.push({
        itemCode: r.item_code,
        itemName: r.item_name,
        lineKey: r.line_key,
        quantity: r.quantity === null ? null : Number(r.quantity),
        priceMinor: Number(r.price_minor),
      })
    }
    return c.json({ orders: [...orders.values()] })
  })

  // POST /guest/tickets —— 提交工单：单端点单事务（spec §0.3、§2.2）
  r.post('/guest/tickets', async (c) => {
    const identity = c.get('identity')
    const org = identity.orgId

    const parsed = SubmitBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const body = parsed.data

    const client = await ctx.pool.connect()
    try {
      await client.query('begin')

      // ① 幂等：同 (org, clientRequestId) 已有 ⇒ 直接回既有工单，不新增行
      const dup = await client.query<{ id: string }>(
        'select id from aftersales.ticket where org = $1 and client_request_id = $2',
        [org, body.clientRequestId],
      )
      if (dup.rows[0]) {
        await client.query('commit')
        return c.json({ id: Number(dup.rows[0].id), duplicated: true }, 200)
      }

      // ② 引用校验（自然键，#476 同源）：门店 = dim_branch.code；商品 = dim_item.item_code（在售）。
      //    消费源 = 发布快照——不再是本地 product/store 副本（#500：那两份副本已断写）。
      const st = await client.query<{ code: string; name: string }>(
        'select code, name from data.dim_branch where org = $1 and code = $2',
        [org, body.storeCode],
      )
      if (!st.rows[0]) {
        await client.query('rollback')
        return c.json({ error: 'STORE_NOT_FOUND' }, 400)
      }
      const store = st.rows[0]

      const it = await client.query<{ item_code: string; name: string }>(
        'select item_code, name from data.dim_item where org = $1 and item_code = $2 and coalesce(sale_cease, false) = false',
        [org, body.itemCode],
      )
      if (!it.rows[0]) {
        await client.query('rollback')
        return c.json({ error: 'PRODUCT_NOT_FOUND' }, 400)
      }
      const item = it.rows[0]

      // ③ 挂原单取价（spec §6.2）：按 (org, order_no, item_code, line_key) 精确取行冻结。
      //    行不存在 ⇒ PRICE_NOT_FOUND（fail-closed，不 fallback 档案价不取 0）；
      //    行在但 store_code ≠ 提交门店 ⇒ ORDER_STORE_MISMATCH（防串店引用别家的单）。
      //    六列随工单定死：后续调价/促销不得改写历史工单的金额依据（与 ② 的快照纪律同一原则）。
      const line = await client.query<{
        source: string; store_code: string; store_name: string | null; bizday: string; price_minor: string
      }>(
        `select source, store_code, store_name, order_bizday::text as bizday, price_minor
           from data.dim_settlement_order_line
          where org = $1 and order_no = $2 and item_code = $3 and line_key = $4`,
        [org, body.orderNo, body.itemCode, body.lineKey],
      )
      if (!line.rows[0]) {
        await client.query('rollback')
        return c.json({ error: 'PRICE_NOT_FOUND' }, 400)
      }
      const settlement = line.rows[0]
      if (settlement.store_code !== body.storeCode) {
        await client.query('rollback')
        return c.json({ error: 'ORDER_STORE_MISMATCH' }, 400)
      }

      const ins = await client.query<{ id: string }>(
        `insert into aftersales.ticket(
           org, client_request_id, submitter_openid,
           product_code, product_name, store_code, store_name,
           damage_quantity, remark,
           settlement_source, settlement_order_no, settlement_item_code, settlement_line_key,
           settlement_price_minor, settlement_bizday)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         returning id`,
        [
          org, body.clientRequestId, identity.userId,
          body.itemCode, item.name, body.storeCode, store.name,
          body.damageQuantity, body.remark ?? '',
          settlement.source, body.orderNo, body.itemCode, body.lineKey,
          Number(settlement.price_minor), settlement.bizday,
        ],
      )
      const ticketId = Number(ins.rows[0].id)

      // ③ 编号：同一事务内补写（不是 generated column）——因为 M2b 迁移要【保留源编号】，
      //    生成列会让源编号落不进来。形状 AS-00000001，8 位补零。
      //    code 与 status 【从同一条 update 的 returning 读回】，不硬编码字面量：
      //    硬写 'pending' 会在将来状态默认值变化时对客户端静默说谎（协调者 T6 裁决 A）。
      const coded = await client.query<{ code: string; status: string }>(
        `update aftersales.ticket set code = 'AS-' || lpad(id::text, 8, '0') where org = $1 and id = $2 returning code, status`,
        [org, ticketId],
      )

      // ④ 认领附件：把本次幂等键下、**属于本上传者**、尚未归属的附件挂到这张工单上。
      //
      // ⚠️ `and uploader_openid = $5` 是【所有权谓词，不是可选项】。`identity.userId` 在本路由
      //    就是访客 openid（见上面 ② 的 `submitter_openid`，用的是同一个值）。
      //    少了它：同租户内任一访客只要把 clientRequestId 猜/撞成同一个值，就能认领【别人】尚未
      //    提交的附件，再经 GET /guest/tickets/:id 拿到该附件**完整的预签名 GET URL**
      //    （受害者侧 total=0，零可观测迹象）。终审已端到端实测（那条 UPDATE rowCount=1）。
      //    三个谓词合起来的语义 =「确实属于本次请求、且属于本上传者」——不必再额外查询。
      if (body.attachmentIds?.length) {
        await client.query(
          `update aftersales.ticket_attachment
              set ticket_id = $3
            where org = $1 and id = any($4::bigint[])
              and client_request_id = $2 and ticket_id is null
              and uploader_openid = $5`,
          [org, body.clientRequestId, ticketId, body.attachmentIds, identity.userId],
        )
      }

      await client.query('commit')
      return c.json(
        { id: ticketId, code: coded.rows[0].code, status: coded.rows[0].status, duplicated: false },
        201,
      )
    } catch (err) {
      await client.query('rollback').catch(() => {})
      // 并发下两个请求可能同时通过 ① 的存在性检查 ⇒ 唯一索引 (org, client_request_id) 让后到的那个
      // 报 23505。这不是错误，是幂等：回读既有工单返回（与 ① 同一语义）。
      if ((err as { code?: string }).code === '23505') {
        const again = await ctx.pool.query<{ id: string }>(
          'select id from aftersales.ticket where org = $1 and client_request_id = $2',
          [org, body.clientRequestId],
        )
        if (again.rows[0]) return c.json({ id: Number(again.rows[0].id), duplicated: true }, 200)
      }
      throw err
    } finally {
      client.release()
    }
  })
}
