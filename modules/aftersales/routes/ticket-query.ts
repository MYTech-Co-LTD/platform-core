// ticket-query.ts — 管理端工单查询的**共享筛选面**（列表 / 计数 / 导出 / 附件清单共用）。
//
// 为什么单独一个文件：2026-11-26 起 `GET /tickets`、`/tickets/counts`、`/tickets/export`、
// `/tickets/export-manifest` 必须用**同一套**筛选语义。复制四份就是四个事实源——改一处
// （例如时间范围的时区口径）另一处不生效，症状是「列表 3 条、导出 5 条」这种最贵的错。
import type { TicketStatus } from '../domain/ticket'

/** 品牌是**派生维度**，不落列：按工单快照的 `store_name` 前缀判断。
 *  - 熊喵 220 家 / 品品甜 89 家（生产 374 家门店实测，2026-11-26）；
 *  - 其余 65 家（仓储中心、管理中心这类）没有品牌前缀 ⇒ `''`，不进品牌筛选。
 *  用快照而不是当前门店表：历史单的品牌不随门店改名漂移。 */
export const BRAND_SQL = `case
  when store_name like '熊喵%' then 'xiongmao'
  when store_name like '品品甜%' then 'pptd'
  else ''
end`

export type Brand = 'xiongmao' | 'pptd'

export interface TicketFilters {
  status: '' | TicketStatus
  brand: '' | Brand
  code: string
  product: string
  store: string
  relatedOrder: string
  opinion: string
  /** `YYYY-MM-DD`；按 Asia/Shanghai 整天、两端都含 */
  processedFrom: string
  processedTo: string
}

const STATUSES: readonly TicketStatus[] = ['pending', 'completed', 'cancelled']
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** ILIKE 的 `%` `_` 在用户输入里是通配符——转义掉，否则输入 `%` 等于匹配全部。 */
export const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (m) => `\\${m}`)

/** `YYYY-MM-DD` 且是**真实日期**（2026-02-30 会被 Date 滚到 3 月 2 日 ⇒ ISO 比较能抓住）。 */
export function isDateOnly(s: string): boolean {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export type ParsedFilters =
  | { ok: true; filters: TicketFilters }
  | { ok: false; error: string }

/**
 * 读查询参数并校验。**非法值不静默忽略**：`status=foo` 若被当成「不过滤」，
 * 用户看到的是全量而不是报错，属于「把红改成绿」的反面教材。
 */
export function parseTicketFilters(get: (name: string) => string | undefined): ParsedFilters {
  const status = (get('status') ?? '').trim()
  const brand = (get('brand') ?? '').trim()
  const processedFrom = (get('processedFrom') ?? '').trim()
  const processedTo = (get('processedTo') ?? '').trim()

  if (status && !STATUSES.includes(status as TicketStatus)) return { ok: false, error: 'INVALID_STATUS' }
  if (brand && brand !== 'xiongmao' && brand !== 'pptd') return { ok: false, error: 'INVALID_BRAND' }
  if (processedFrom && !isDateOnly(processedFrom)) return { ok: false, error: 'INVALID_DATE' }
  if (processedTo && !isDateOnly(processedTo)) return { ok: false, error: 'INVALID_DATE' }

  return {
    ok: true,
    filters: {
      status: status as '' | TicketStatus,
      brand: brand as '' | Brand,
      code: (get('code') ?? '').trim(),
      product: (get('product') ?? '').trim(),
      store: (get('store') ?? '').trim(),
      relatedOrder: (get('relatedOrder') ?? '').trim(),
      opinion: (get('opinion') ?? '').trim(),
      processedFrom,
      processedTo,
    },
  }
}

/**
 * 拼 where + 参数。参数从 $2 开始（$1 恒为 org），调用方在末尾继续追加自己的参数
 * （分页 / 导出上限）时，用 `params.length + 1` 接着编号即可。
 */
export function ticketWhere(org: string, f: TicketFilters): { sql: string; params: unknown[] } {
  const where = ['org = $1']
  const params: unknown[] = [org]

  if (f.status) {
    params.push(f.status)
    where.push(`status = $${params.length}`)
  }
  if (f.brand) {
    params.push(f.brand)
    where.push(`(${BRAND_SQL}) = $${params.length}`)
  }
  for (const [key, value] of [
    ['code', f.code],
    ['product', f.product],
    ['store', f.store],
    ['relatedOrder', f.relatedOrder],
    ['opinion', f.opinion],
  ] as const) {
    if (!value) continue
    params.push(`%${escapeLike(value)}%`)
    const col = key === 'product' ? 'product_name'
      : key === 'store' ? 'store_name'
        : key === 'relatedOrder' ? 'related_order'
          : key // code / opinion
    where.push(`${col} ilike $${params.length}`)
  }
  if (f.processedFrom) {
    params.push(f.processedFrom)
    where.push(`processed_at >= ($${params.length}::date)::timestamp at time zone 'Asia/Shanghai'`)
  }
  if (f.processedTo) {
    params.push(f.processedTo)
    // 上界是「包含当天」⇒ < 次日 00:00（Asia/Shanghai）。两端都含。
    where.push(
      `processed_at < ((($${params.length}::date) + 1)::timestamp at time zone 'Asia/Shanghai')`,
    )
  }
  return { sql: where.join(' and '), params }
}
