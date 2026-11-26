// ticket-query.ts — 管理端工单查询的**共享筛选面**（列表 / 计数 / 导出 / 附件清单共用）。
//
// 为什么单独一个文件：`GET /tickets`、`/tickets/counts`、`/tickets/export`、
// `/tickets/export-manifest` 必须用**同一套**筛选语义。复制四份就是四个事实源——改一处
// （例如时间范围的时区口径）另一处不生效，症状是「列表 3 条、导出 5 条」这种最贵的错。
//
// 2026-11-26（#2892）：品牌从硬编码名称前缀改为**工单快照列** `brand_code`。
// 解析在提单时完成（product > store > 未分类），读侧不再 join；`__unclassified__` 是
// 「未分类」的保留查询值（brand code 的 check 约束禁止 `__` 前缀，避免撞名）。
import type { TicketStatus } from '../domain/ticket'

/** 未分类的保留查询值；不是品牌 code（brand_registry.code 不允许 `__` 开头）。 */
export const UNCLASSIFIED_BRAND = '__unclassified__'
const BRAND_CODE_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

export interface TicketFilters {
  status: '' | TicketStatus
  /** 品牌 code，或 `__unclassified__`；空串 = 不筛 */
  brand: string
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
 *
 * 品牌的**存在性**（是否在本租户字典/历史快照里）需要 DB，由路由层再校验；
 * 这里只校验格式与保留值。
 */
export function parseTicketFilters(get: (name: string) => string | undefined): ParsedFilters {
  const status = (get('status') ?? '').trim()
  const brand = (get('brand') ?? '').trim()
  const processedFrom = (get('processedFrom') ?? '').trim()
  const processedTo = (get('processedTo') ?? '').trim()

  if (status && !STATUSES.includes(status as TicketStatus)) return { ok: false, error: 'INVALID_STATUS' }
  if (brand && brand !== UNCLASSIFIED_BRAND && !BRAND_CODE_RE.test(brand)) {
    return { ok: false, error: 'INVALID_BRAND' }
  }
  if (processedFrom && !isDateOnly(processedFrom)) return { ok: false, error: 'INVALID_DATE' }
  if (processedTo && !isDateOnly(processedTo)) return { ok: false, error: 'INVALID_DATE' }

  return {
    ok: true,
    filters: {
      status: status as '' | TicketStatus,
      brand,
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
    if (f.brand === UNCLASSIFIED_BRAND) {
      // 未分类是 brand_code = ''，不是 NULL（列是 not null default ''）。
      where.push("brand_code = ''")
    } else {
      params.push(f.brand)
      where.push(`brand_code = $${params.length}`)
    }
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

/**
 * 品牌是否可筛：字典里的（含停用，历史可筛）或工单快照里出现过的。
 * 返回 false 时路由层回 400 INVALID_BRAND；与 `__unclassified__` 无关。
 */
export async function brandExists(
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> },
  org: string,
  code: string,
): Promise<boolean> {
  const res = (await db.query(
    `select 1
       from data.v_brand_registry
      where org = $1 and code = $2
      union all
     select 1
       from aftersales.ticket
      where org = $1 and brand_code = $2
      limit 1`,
    [org, code],
  )) as { rows: unknown[] }
  return res.rows.length > 0
}
