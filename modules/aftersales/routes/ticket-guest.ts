import { z } from 'zod'
import { loadAttachments, normalizeTicketRow } from './ticket-manage'
// 分页常量与解析器在 routes/context.ts：与管理端【同一份】实现、【同一套】语义
// （此前本文件内联算 page/size 且无整数守卫 ⇒ 非法值 500；?size=-5 也与端点间漂移）。
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

const SubmitBody = z.object({
  // 客户端幂等键（spec §2.2）；同时是附件 object key 里的 {ticket_ref}（spec §2.3）
  clientRequestId: z.string().min(1).max(128),
  productId: z.number().int().positive(),
  storeId: z.number().int().positive().optional(),
  damageQuantity: z.number().int().nonnegative(),
  remark: z.string().max(2000).optional(),
  /** 本次提交要一起认领的附件（先传图后提交，见 spec §2.3） */
  attachmentIds: z.array(z.number().int().positive()).max(50).optional(),
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
    const id = Number(c.req.param('id'))
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'NOT_FOUND' }, 404)

    const res = await ctx.pool.query(
      `select id, code, product_id, product_name, store_id, store_name,
              damage_quantity, status, amount_type, amount_minor, refund_ratio,
              remark, related_order, created_at, processed_at
         from aftersales.ticket
        where org = $1 and id = $2 and submitter_openid = $3`,
      [identity.orgId, id, identity.userId],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ...normalizeTicketRow(row), attachments: await loadAttachments(ctx, identity.orgId, id) })
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

      // ② 快照商品与门店：基本数量/单价随工单冻住——规则或商品改价不得改写历史工单的金额依据
      const prod = await client.query<{
        id: string; name: string; basic_quantity: number; basic_unit_price_minor: string
      }>(
        'select id, name, basic_quantity, basic_unit_price_minor from aftersales.product where org = $1 and id = $2',
        [org, body.productId],
      )
      if (!prod.rows[0]) {
        await client.query('rollback')
        return c.json({ error: 'PRODUCT_NOT_FOUND' }, 400)
      }
      const product = prod.rows[0]

      let storeName = ''
      if (body.storeId !== undefined) {
        const st = await client.query<{ name: string }>(
          'select name from aftersales.store where org = $1 and id = $2',
          [org, body.storeId],
        )
        if (!st.rows[0]) {
          await client.query('rollback')
          return c.json({ error: 'STORE_NOT_FOUND' }, 400)
        }
        storeName = st.rows[0].name
      }

      const ins = await client.query<{ id: string }>(
        `insert into aftersales.ticket(
           org, client_request_id, submitter_openid,
           product_id, product_name, store_id, store_name,
           damage_quantity, basic_quantity, basic_unit_price_minor, remark)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         returning id`,
        [
          org, body.clientRequestId, identity.userId,
          body.productId, product.name, body.storeId ?? null, storeName,
          body.damageQuantity, Number(product.basic_quantity), product.basic_unit_price_minor,
          body.remark ?? '',
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

      // ④ 认领附件：把本次幂等键下、尚未归属的附件挂到这张工单上
      if (body.attachmentIds?.length) {
        await client.query(
          `update aftersales.ticket_attachment
              set ticket_id = $3
            where org = $1 and id = any($4::bigint[])
              and client_request_id = $2 and ticket_id is null`,
          [org, body.clientRequestId, ticketId, body.attachmentIds],
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
