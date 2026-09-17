import { z } from 'zod'
import { TENANT_STORAGE } from '@platform/sdk'
import { storageCandidatesFor, storageResolverFor, warnUnresolvedRef } from '../storage'
import type { ZosStorage } from '../storage'
import {
  AmountValidationError,
  isProcessable,
  resolveProcess,
  toMinor,
  toRatioOrNull,
} from '../domain/ticket'
import type { TicketStatus } from '../domain/ticket'
// 分页常量与解析器在 routes/context.ts（四域共享层）——本文件不再留本地副本，
// 避免与管理端/访客端两份实现静默漂移（见 context.ts 的 parsePageParam 注释）。
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

const ProcessBody = z.discriminatedUnion('amountType', [
  z.object({ amountType: z.literal('ratio'), refundRatio: z.number(), remark: z.string().max(2000).optional() }),
  z.object({
    amountType: z.literal('fixed'),
    amountMinor: z.number().int(),
    remark: z.string().max(2000).optional(),
  }),
  z.object({ amountType: z.literal('reject'), remark: z.string().max(2000).optional() }),
])

interface TicketRow {
  id: string
  status: TicketStatus
  damage_quantity: number
  basic_quantity: number
  basic_unit_price_minor: string
}

export function registerTicketManage(r: ModuleHono, ctx: RouteCtx): void {
  // GET /tickets —— 管理端列表：服务端分页 + 状态筛选（spec §0.3：不搬「全量拉取+前端过滤」）
  r.get('/tickets', async (c) => {
    const org = c.get('identity').orgId
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)
    const status = c.req.query('status')

    const where = ['org = $1']
    const params: unknown[] = [org]
    if (status) {
      params.push(status)
      where.push(`status = $${params.length}`)
    }

    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.ticket where ${where.join(' and ')}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, code, product_id, product_name, store_id, store_name,
              damage_quantity, status, amount_type, amount_minor, refund_ratio,
              operator, remark, related_order, created_at, processed_at
         from aftersales.ticket
        where ${where.join(' and ')}
        order by id desc
        limit $${params.length + 1} offset $${params.length + 2}`,
      [...params, size, (page - 1) * size],
    )

    return c.json({
      items: listRes.rows.map(normalizeTicketRow),
      total: totalRes.rows[0].n,
      page,
      size,
    })
  })

  // GET /tickets/:id —— 管理端详情，附件带预签名 GET URL
  r.get('/tickets/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'INVALID_ID' }, 400)

    const res = await ctx.pool.query(
      `select id, code, submitter_openid, product_id, product_name, store_id, store_name,
              damage_quantity, basic_quantity, basic_unit_price_minor,
              status, amount_type, amount_minor, refund_ratio,
              operator, remark, related_order, created_at, processed_at
         from aftersales.ticket where org = $1 and id = $2`,
      [org, id],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)

    return c.json({
      ...normalizeTicketRow(row),
      // 本请求的候选集（注入值 + 平台默认）穿进加载器：每行按它自己的 storage_ref 解析
      attachments: await loadAttachments(ctx, org, id, storageResolverFor(storageCandidatesFor(c.get(TENANT_STORAGE)))),
    })
  })

  // POST /tickets/:id/process —— 状态机条件更新（spec §2.2：影响行数 0 ⇒ 409）
  r.post('/tickets/:id/process', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'INVALID_ID' }, 400)

    const parsed = ProcessBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const body = parsed.data

    const client = await ctx.pool.connect()
    try {
      await client.query('begin')

      // 先读工单的快照字段算金额；再条件更新当守卫。
      // 这里【不加 for update】：真正的并发守卫是下面 update 的 where status='pending'——
      // 两个并发处理请求都会读到 pending、都算出一份金额，但只有一个 update 能落，另一份影响行数 0 ⇒ 409。
      const cur = await client.query<TicketRow>(
        `select id, status, damage_quantity, basic_quantity, basic_unit_price_minor
           from aftersales.ticket where org = $1 and id = $2`,
        [org, id],
      )
      const row = cur.rows[0]
      if (!row) {
        await client.query('rollback')
        return c.json({ error: 'NOT_FOUND' }, 404)
      }
      if (!isProcessable(row.status)) {
        await client.query('rollback')
        return c.json({ error: 'ALREADY_PROCESSED', status: row.status }, 409)
      }

      let outcome
      try {
        outcome = resolveProcess(
          {
            damageQuantity: Number(row.damage_quantity),
            basicQuantity: Number(row.basic_quantity),
            // pg 把 bigint 与 numeric 都返回成字符串——不转就是字符串算术（见 domain/ticket.ts）
            basicUnitPriceMinor: toMinor(row.basic_unit_price_minor),
          },
          body,
        )
      } catch (err) {
        await client.query('rollback')
        if (err instanceof AmountValidationError) {
          return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
        }
        throw err
      }

      const upd = await client.query(
        `update aftersales.ticket
            set status = $3, amount_type = $4, amount_minor = $5, refund_ratio = $6,
                operator = $7, remark = coalesce($8, remark), processed_at = now()
          where org = $1 and id = $2 and status = 'pending'`,
        [
          org,
          id,
          outcome.status,
          outcome.amountType,
          outcome.amountMinor,
          outcome.refundRatio,
          c.get('identity').displayName,
          body.remark ?? null,
        ],
      )
      if (upd.rowCount === 0) {
        await client.query('rollback')
        return c.json({ error: 'ALREADY_PROCESSED' }, 409)
      }

      await client.query('commit')
      return c.json({
        ok: true,
        id,
        status: outcome.status,
        amountType: outcome.amountType,
        amountMinor: outcome.amountMinor,
      })
    } catch (err) {
      await client.query('rollback').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  })
}

/** 列在场时的 bigint/numeric → number。列【缺席】（undefined）由调用点自己判并原样返回 undefined。 */
function toNullableInt(v: unknown): number | null {
  return v === null ? null : Number(v)
}

/**
 * bigint/numeric 在 pg 里都是字符串：出口统一转成 number 或 null，别把字符串漏给前端。
 *
 * 【列缺席 ⇒ 别名字段缺席】—— 与 basic_unit_price_minor 同一条约定（`row.x === undefined` 时返回
 * undefined，`JSON.stringify` 会把整个键丢掉）：**不许替「本查询没 SELECT 的列」编造值**。
 * 访客列表是有意的窄 SELECT（不含 product_id / store_id / refund_ratio），无条件映射会把「没查」
 * 说成「没有值」：productId/storeId 变 Number(undefined)=NaN 被序列化成 null，更重的是
 * refundRatio 走 toRatioOrNull(undefined) → null —— 而 T4 契约里 refundRatio:null 的语义是
 * 「fixed/reject 路，没有比例」⇒ 访客端把「按 0.1235 赔 8825 分」显示成与「驳回、无比例」同形。
 *
 * 列【在场】时才转换；在场且值为 null ⇒ **保持 null**（那个 null 是 fixed/reject 的表达，不能丢）。
 *
 * ⚠️「键缺席」是 **`JSON.stringify` 之后**的性质（值是 `undefined` 时序列化会把键丢掉），
 * 不是函数返回对象上的性质：返回对象里键**仍在场**（`'refundRatio' in item === true`，
 * 值为 `undefined`）。当前 4 个调用点都经 `c.json`（= JSON 序列化）故成立；
 * 若将来有人直接读该对象的键（不吃序列化），**前提就不成立了** —— 那里要显式判 `undefined`。
 */
export function normalizeTicketRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...row,
    id: Number(row.id),
    productId: row.product_id === undefined ? undefined : toNullableInt(row.product_id),
    storeId: row.store_id === undefined ? undefined : toNullableInt(row.store_id),
    basicUnitPriceMinor: row.basic_unit_price_minor === undefined ? undefined : toMinor(row.basic_unit_price_minor as string),
    amountMinor: toMinor(row.amount_minor as string),
    refundRatio: row.refund_ratio === undefined ? undefined : toRatioOrNull(row.refund_ratio as string | null),
  }
}

/**
 * 附件行 + 预签名 GET URL。**逐行按它自己的 `storage_ref` 解析**（第 4 参 `resolve`）：
 * 签不出来时该项 url 回 null 而不是整个端点 503——工单本身的数据仍然有用，附件拉不到是
 * 「降级」不是「失败」（附件专用端点才是 503）。
 */
export async function loadAttachments(
  ctx: RouteCtx,
  org: string,
  ticketId: number,
  resolve: (ref: string) => ZosStorage | null,
): Promise<{ id: number; objectKey: string; contentType: string; sizeBytes: number; url: string | null }[]> {
  const res = await ctx.pool.query(
    `select id, object_key, content_type, size_bytes, storage_ref
       from aftersales.ticket_attachment
      where org = $1 and ticket_id = $2
      order by id`,
    [org, ticketId],
  )
  return Promise.all(
    res.rows.map(async (a) => {
      const storage = resolve(a.storage_ref as string)
      // 单件失败**只让该项 url 为 null**。降级在此正当：失败可单独补救（人工迁移 / 重配）且
      // 不该阻断「看工单详情」；条件是**日志里显式可见**（deploy-verify §3：不许用容错掩盖失败）。
      if (!storage) warnUnresolvedRef(org, a.storage_ref as string)
      return {
        id: Number(a.id),
        objectKey: a.object_key as string,
        contentType: a.content_type as string,
        sizeBytes: toMinor(a.size_bytes as string),
        url: storage ? await storage.presignGet(a.object_key as string) : null,
      }
    }),
  )
}
