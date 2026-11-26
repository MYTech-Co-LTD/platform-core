import { z } from 'zod'
import { TENANT_STORAGE } from '@platform/sdk'
import { storageCandidatesFor, storageResolverFor, warnUnresolvedRef } from '../storage'
import type { ZosStorage } from '../storage'
import {
  AmountValidationError,
  computeDamageAmountMinor,
  isProcessable,
  resolveProcess,
  toMinor,
  toRatioOrNull,
} from '../domain/ticket'
import type { TicketStatus } from '../domain/ticket'
import { writeAudit } from '../domain/audit'
// 分页常量与解析器在 routes/context.ts（四域共享层）——本文件不再留本地副本，
// 避免与管理端/访客端两份实现静默漂移（见 context.ts 的 parsePageParam 注释）。
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam , consoleBaseUrl} from './context'
import { BRAND_SQL, parseTicketFilters, ticketWhere } from './ticket-query'
import type { ModuleHono, RouteCtx } from './context'

/** 水印日期：`YYYY-MM-DD` 且真实存在（2026-02-30 会被 Date 滚到 3 月 2 日 ⇒ ISO 比较能抓住）。 */
const DateOnly = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'watermarkAt 必须是 YYYY-MM-DD')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`)
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
  }, 'watermarkAt 不是有效日期')

/**
 * 处理动作（2026-11-26 改，issue #2884）：三路金额 + 两件必填事实。
 *
 * `opinion`（处理人售后意见，≤500 字）与 `watermarkAt`（水印日期）替代原来的自由 `remark`：
 * `remark` 是**店员填的报损原因**，处理再写它就是把人家的事实覆盖掉（spec §3.1 的旧缺陷）。
 * 历史客户端若仍传 `remark`，zod 默认剥掉——不报错、不落库。
 */
const ProcessBody = z.discriminatedUnion('amountType', [
  z.object({
    amountType: z.literal('ratio'),
    refundRatio: z.number(),
    opinion: z.string().trim().min(1).max(500),
    watermarkAt: DateOnly,
  }),
  z.object({
    amountType: z.literal('fixed'),
    amountMinor: z.number().int(),
    opinion: z.string().trim().min(1).max(500),
    watermarkAt: DateOnly,
  }),
  z.object({
    amountType: z.literal('reject'),
    opinion: z.string().trim().min(1).max(500),
    watermarkAt: DateOnly,
  }),
])

/** 预览只关心金额三路，不要求 opinion/watermarkAt（弹窗里还没填完）。 */
const QuoteBody = z.discriminatedUnion('amountType', [
  z.object({ amountType: z.literal('ratio'), refundRatio: z.number() }),
  z.object({ amountType: z.literal('fixed'), amountMinor: z.number().int() }),
  z.object({ amountType: z.literal('reject') }),
])

interface TicketRow {
  id: string
  status: TicketStatus
  /** numeric(12,2)（迁移 010）——pg 返回字符串，算钱前必须 Number() */
  damage_quantity: string
  /** numeric(14,6)（迁移 010）——同上 */
  basic_quantity: string
  basic_unit_price_minor: string
  settlement_price_minor: string | null
}

export function registerTicketManage(r: ModuleHono, ctx: RouteCtx): void {
  // GET /tickets —— 管理端列表：服务端分页 + 筛选（spec §0.3：不搬「全量拉取+前端过滤」）
  // 2026-11-26（#2884）：补品牌、五个搜索项、处理时间范围；行补品牌/报损金额/售后意见/
  // 水印时间/图片视频数。筛选语义集中在 routes/ticket-query.ts，与计数/导出共用。
  r.get('/tickets', async (c) => {
    const org = c.get('identity').orgId
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const parsed = parseTicketFilters((k) => c.req.query(k))
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)
    const { sql: where, params } = ticketWhere(org, parsed.filters)

    const totalRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.ticket where ${where}`,
      params,
    )
    const listRes = await ctx.pool.query(
      `select id, code, product_id, product_name, store_id, store_name,
              product_code, store_code,
              damage_quantity, status, amount_type, amount_minor, refund_ratio,
              operator, remark, opinion, related_order, arrival_at, created_at, processed_at,
              watermark_at::text as watermark_at,
              -- 归属一致性快照（ADR 2026-11-24 §7 P1-a）：信息性，供管理端展示异常
              store_affiliation,
              -- 品牌（派生）：按工单快照 store_name 前缀，不新增存储列。
              (${BRAND_SQL}) as brand,
              -- 报损金额（毛额，整数分）：pending 也显示「损失多少」，与赔付额不同。
              round(damage_quantity * coalesce(settlement_price_minor, basic_unit_price_minor))::bigint
                as damage_amount_minor,
              (select count(*) from aftersales.ticket_attachment a
                where a.org = t.org and a.ticket_id = t.id and a.content_type like 'image/%')::int
                as image_count,
              (select count(*) from aftersales.ticket_attachment a
                where a.org = t.org and a.ticket_id = t.id and a.content_type like 'video/%')::int
                as video_count
         from aftersales.ticket t
        where ${where}
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

  // GET /tickets/counts —— 状态胶囊与品牌胶囊的计数（2026-11-26 / #2884）
  // 语义（spec §2.3）：状态计数**全局**（不受任何筛选影响）；品牌计数**只跟随 status**
  // （否则点一个品牌后另一个品牌归零，胶囊点不回去）。
  // ⚠️ 必须注册在 `/tickets/:id` 之前，否则 `counts` 被当成 id。
  r.get('/tickets/counts', async (c) => {
    const org = c.get('identity').orgId
    const status = (c.req.query('status') ?? '').trim()
    if (status && status !== 'pending' && status !== 'completed' && status !== 'cancelled') {
      return c.json({ error: 'INVALID_STATUS' }, 400)
    }
    const params: unknown[] = [org]
    let brandWhere = 'org = $1'
    if (status) {
      params.push(status)
      brandWhere += ' and status = $2'
    }

    const [statusRes, brandRes] = await Promise.all([
      ctx.pool.query<{ status: TicketStatus; n: number }>(
        'select status, count(*)::int as n from aftersales.ticket where org = $1 group by status',
        [org],
      ),
      ctx.pool.query<{ brand: string; n: number }>(
        `select (${BRAND_SQL}) as brand, count(*)::int as n
           from aftersales.ticket where ${brandWhere} group by 1`,
        params,
      ),
    ])
    const byStatus = { pending: 0, completed: 0, cancelled: 0 }
    for (const row of statusRes.rows) byStatus[row.status] = row.n
    const brand = { xiongmao: 0, pptd: 0, none: 0 }
    for (const row of brandRes.rows) {
      if (row.brand === 'xiongmao') brand.xiongmao = row.n
      else if (row.brand === 'pptd') brand.pptd = row.n
      else brand.none = row.n
    }
    return c.json({
      status: { all: byStatus.pending + byStatus.completed + byStatus.cancelled, ...byStatus },
      brand,
    })
  })

  // GET /tickets/:id —— 管理端详情，附件带预签名 GET URL
  r.get('/tickets/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'INVALID_ID' }, 400)

    const res = await ctx.pool.query(
      `select id, code, submitter_openid, product_id, product_name, store_id, store_name,
              product_code, store_code,
              damage_quantity, basic_quantity, basic_unit_price_minor,
              settlement_source, settlement_order_no, settlement_item_code, settlement_line_key,
              settlement_price_minor, settlement_bizday,
              status, amount_type, amount_minor, refund_ratio,
              operator, remark, opinion, related_order, arrival_at, created_at, processed_at,
              watermark_at::text as watermark_at, store_affiliation,
              (${BRAND_SQL}) as brand,
              round(damage_quantity * coalesce(settlement_price_minor, basic_unit_price_minor))::bigint
                as damage_amount_minor
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

  // POST /tickets/:id/quote —— 金额预览（2026-11-26 / #2884）：只算不写，与处理共用 resolveProcess。
  // 不落库 ⇒ 不需要事务；只读快照 + 纯函数，预览值与提交后的落库值必然一致。
  r.post('/tickets/:id/quote', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'INVALID_ID' }, 400)

    const parsed = QuoteBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)

    const res = await ctx.pool.query<TicketRow>(
      `select id, status, damage_quantity, basic_quantity, basic_unit_price_minor, settlement_price_minor
         from aftersales.ticket where org = $1 and id = $2`,
      [org, id],
    )
    const row = res.rows[0]
    if (!row) return c.json({ error: 'NOT_FOUND' }, 404)
    if (!isProcessable(row.status)) return c.json({ error: 'ALREADY_PROCESSED', status: row.status }, 409)

    const damageQuantity = Number(row.damage_quantity)
    const basicUnitPriceMinor = toMinor(row.settlement_price_minor ?? row.basic_unit_price_minor)
    let outcome
    try {
      outcome = resolveProcess(
        {
          damageQuantity,
          basicQuantity: Number(row.basic_quantity),
          basicUnitPriceMinor,
        },
        parsed.data,
      )
    } catch (err) {
      if (err instanceof AmountValidationError) {
        return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
      }
      throw err
    }

    return c.json({
      status: outcome.status,
      amountType: outcome.amountType,
      amountMinor: outcome.amountMinor,
      refundRatio: outcome.refundRatio,
      // 固定金额输入框的 UI 上限来源：前端不再自己乘。
      damageAmountMinor: computeDamageAmountMinor(damageQuantity, basicUnitPriceMinor),
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
      const cur = await client.query<TicketRow & { code: string; submitter_openid: string; product_name: string; store_code: string | null }>(
        // code / submitter_openid 是**处理结果通知**（#2805）的收件人与单号来源；
        // 只多读两列，不参与任何金额判定。
        `select id, status, damage_quantity, basic_quantity, basic_unit_price_minor, settlement_price_minor,
                code, submitter_openid, product_name, store_code
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
            // 单价来源（#500 段③）：挂原单的新单读 settlement_price_minor（按单结算价冻结值）；
            // 存量 pending 的老单没有该列值，回落 basic_unit_price_minor（旧档案价）——这是
            // **存量兼容桥**，不是取价 fallback：新单永远有 settlement_price_minor（建单 fail-closed）。
            // pg 把 bigint 与 numeric 都返回成字符串——不转就是字符串算术（见 domain/ticket.ts）
            basicUnitPriceMinor: toMinor(row.settlement_price_minor ?? row.basic_unit_price_minor),
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
        // 2026-11-26：售后意见写 opinion（不动 remark——那是店员填的报损原因）；
        // 水印日期必填，与处理事实一起落库。
        `update aftersales.ticket
            set status = $3, amount_type = $4, amount_minor = $5, refund_ratio = $6,
                operator = $7, opinion = $8, watermark_at = $9::date, processed_at = now()
          where org = $1 and id = $2 and status = 'pending'`,
        [
          org,
          id,
          outcome.status,
          outcome.amountType,
          outcome.amountMinor,
          outcome.refundRatio,
          c.get('identity').displayName,
          body.opinion,
          body.watermarkAt,
        ],
      )
      if (upd.rowCount === 0) {
        await client.query('rollback')
        return c.json({ error: 'ALREADY_PROCESSED' }, 409)
      }

      // 审计与业务写同事务（评审 P0-2：写钱必须有痕）；commit 前落行，rollback 时一并消失
      await writeAudit(client, {
        org, actor: c.get('identity').userId, action: 'ticket.process', target: String(id),
        detail: {
          fromStatus: row.status, toStatus: outcome.status,
          amountType: outcome.amountType, amountMinor: outcome.amountMinor,
          refundRatio: outcome.refundRatio, watermarkAt: body.watermarkAt,
        },
      })
      await client.query('commit')

      // 处理结果通知（#2805 / 2026-11-25 改口径）：发给**该门店所有已审批员工**
      // （不再只有提交人）。收件人集合在事务外查（只读，且失败不该影响已提交的结果）。
      if (ctx.notify) {
        try {
          const members = await ctx.pool.query<{ open_id: string }>(
            `select distinct e.open_id
               from aftersales.employee e
               join aftersales.employee_store s
                 on s.org = e.org and s.employee_id = e.id
              where e.org = $1 and s.store_code = $2
                and e.approve_status = 'approved' and e.open_id <> ''`,
            [org, row.store_code ?? ''],
          )
          const recipients = members.rows.map((m) => m.open_id)
          if (recipients.length === 0) recipients.push(row.submitter_openid) // 兜底：至少给提交人
          await ctx.notify.emit(c.get('identity'), {
            eventKey: 'aftersales.ticket.processed',
            eventId: `aftersales.ticket:${row.code}:processed`,
            scope: row.code,
            payload: {
              user: recipients,
              storeCode: row.store_code ?? '',
              ticketCode: row.code,
              productName: row.product_name,
              time: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16),
              result: outcome.status === 'completed' ? '已通过' : '已驳回',
              // 金额按「分 → 元」展示（与 console `formatMinor` 同口径：两位小数）
              amountText: outcome.amountMinor !== null ? `¥${(outcome.amountMinor / 100).toFixed(2)}` : '',
              // 通知模板的 payload 键仍叫 remark（模板契约已发布），值改取 opinion——
              // 处理备注从此是处理人的售后意见，不是店员的报损原因。
              remark: body.opinion,
              link: `${consoleBaseUrl()}/app/aftersales`,
            },
          })
        } catch (e) {
          console.warn('[aftersales] ticket processed notify failed（不阻断业务）:', e instanceof Error ? e.message : e)
        }
      }

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
    // 迁移 010 起 damage_quantity/basic_quantity 是 numeric ⇒ pg 返回字符串。
    // 列缺席时不造键（同下面的纪律）；在场就必须是 number，别把字符串漏给前端。
    damage_quantity: row.damage_quantity === undefined ? undefined : Number(row.damage_quantity),
    basic_quantity: row.basic_quantity === undefined ? undefined : Number(row.basic_quantity),
    // 报损金额（毛额）是 bigint ⇒ 字符串；只有管理端列表/详情会 SELECT 它。
    // snake_case 与 camelCase 两个出口都要转，别让前端拿到 '900' 这种字符串。
    damage_amount_minor: row.damage_amount_minor === undefined ? undefined : toMinor(row.damage_amount_minor as string),
    damageAmountMinor: row.damage_amount_minor === undefined ? undefined : toMinor(row.damage_amount_minor as string),
    productId: row.product_id === undefined ? undefined : toNullableInt(row.product_id),
    storeId: row.store_id === undefined ? undefined : toNullableInt(row.store_id),
    basicUnitPriceMinor: row.basic_unit_price_minor === undefined ? undefined : toMinor(row.basic_unit_price_minor as string),
    // 挂原单冻结价（#500 段③）：bigint→string，别名出 camelCase 供 console/mobile 直读
    settlementPriceMinor: row.settlement_price_minor === undefined || row.settlement_price_minor === null
      ? undefined
      : toMinor(row.settlement_price_minor as string),
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
