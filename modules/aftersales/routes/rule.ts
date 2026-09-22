import { z } from 'zod'
import type { Paged, RuleItem } from '../api-types'
import { AmountValidationError, normalizeRatio, toRatioOrNull } from '../domain/ticket'
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, parseIdParam, parsePageParam } from './context'
import type { ModuleHono, RouteCtx } from './context'

const RuleBody = z.object({
  name: z.string().min(1).max(200),
  refundRatio: z.number(),
  remark: z.string().max(2000).optional(),
})

export function registerRule(r: ModuleHono, ctx: RouteCtx): void {
  r.get('/rules', async (c) => {
    const org = c.get('identity').orgId
    // 【#155】与 /products 同一口径（context.ts 的 parsePageParam）：回 total 可真分页。
    // 原先的 `MAX_RULES=500` 硬上界随之退役——size 已被 MAX_PAGE_SIZE 夹住。
    const page = parsePageParam(c.req.query('page'), 1, Number.MAX_SAFE_INTEGER)
    const size = parsePageParam(c.req.query('size'), DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE)

    const totalRes = await ctx.pool.query<{ n: number }>(
      'select count(*)::int as n from aftersales.ticket_rule where org = $1',
      [org],
    )
    const res = await ctx.pool.query(
      `select id, name, refund_ratio, remark, created_at
         from aftersales.ticket_rule where org = $1 order by id
         limit $2 offset $3`,
      [org, size, (page - 1) * size],
    )
    // 响应形状与 console 共用同一份类型（api-types.ts）——改这里会同时影响两端
    const body: Paged<RuleItem> = {
      items: res.rows.map((r) => ({
        id: Number(r.id),
        name: r.name,
        // numeric 在 pg 里是【字符串】——出口统一转 number（见 domain/ticket.ts）
        refundRatio: toRatioOrNull(r.refund_ratio),
        remark: r.remark,
        createdAt: r.created_at,
      })),
      total: totalRes.rows[0]!.n,
      page,
      size,
    }
    return c.json(body)
  })

  r.post('/rules', async (c) => {
    const org = c.get('identity').orgId
    const parsed = RuleBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, remark } = parsed.data
    let refundRatio: number

    try {
      // 与工单处理共用同一条口径（T4 的 normalizeRatio）——比例合法性与 4 位小数的唯一事实源。
      // 【落库必须用它的返回值】：assertValidRatio 只是它丢弃返回值的薄封装，
      // 用 void 封装等于「校验在 JS、量化交给 pg 列型」，又变成两套实现。
      refundRatio = normalizeRatio(parsed.data.refundRatio)
    } catch (err) {
      if (err instanceof AmountValidationError) {
        return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
      }
      throw err
    }

    const res = await ctx.pool.query<{ id: string }>(
      `insert into aftersales.ticket_rule(org, name, refund_ratio, remark)
       values ($1, $2, $3, $4) returning id`,
      [org, name, refundRatio, remark ?? ''],
    )
    return c.json({ id: Number(res.rows[0].id) }, 201)
  })

  r.put('/rules/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    const parsed = RuleBody.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: 'INVALID_BODY' }, 400)
    const { name, remark } = parsed.data
    let refundRatio: number

    try {
      refundRatio = normalizeRatio(parsed.data.refundRatio)
    } catch (err) {
      if (err instanceof AmountValidationError) {
        return c.json({ error: 'INVALID_AMOUNT', message: err.message }, 400)
      }
      throw err
    }

    const res = await ctx.pool.query(
      `update aftersales.ticket_rule set name = $3, refund_ratio = $4, remark = $5
        where org = $1 and id = $2`,
      [org, id, name, refundRatio, remark ?? ''],
    )
    // 跨租户改别人的规则同样是 rowCount 0 ⇒ 404：与"不存在"同形，不泄露存在性
    if (res.rowCount === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true, id })
  })

  r.delete('/rules/:id', async (c) => {
    const org = c.get('identity').orgId
    const id = parseIdParam(c.req.param('id'))
    if (id === null) return c.json({ error: 'NOT_FOUND' }, 404)

    // 硬删是刻意的：这是配置表不是流水表，源侧也没有软删语义（spec §3.3 实证表：
    // "仅 group_buying_batch 有 is_deleted"）。历史工单不受影响——它落的是金额快照。
    const res = await ctx.pool.query('delete from aftersales.ticket_rule where org = $1 and id = $2', [org, id])
    if (res.rowCount === 0) return c.json({ error: 'NOT_FOUND' }, 404)
    return c.json({ ok: true, id })
  })
}
