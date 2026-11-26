// ticket-export.ts — 工单导出（Excel）与附件打包清单（2026-11-26 / issue #2884，spec §2.6/§5.1）。
//
// 两条纪律：
//  ① Excel 由**服务端**生成（前端不写第二份数据整形），数值单元格照 data 模块的做法；
//  ② 附件包**不经过应用服务器**：清单端点只回对象存储的预签名 GET，浏览器直连下载后
//     用 fflate 打包——应用服务器出口只有 5–6 Mbps，走它会慢一个数量级。
//
// 范围参数（两端点共用）：`range=selected|filtered|all` + （selected）`ids` + 列表筛选参数。
// 上限 20,000 行：保护 exceljs 的内存与响应时间；超过就提示缩小范围，而不是让服务端 OOM。
import { TENANT_STORAGE } from '@platform/sdk'
import { storageCandidatesFor, storageResolverFor, warnUnresolvedRef } from '../storage'
import { ticketsXlsx } from '../domain/xlsx'
import type { XlsxRow } from '../domain/xlsx'
import { EXPORT_FIELDS } from '../export-fields'
import { BRAND_SQL, parseTicketFilters, ticketWhere } from './ticket-query'
import type { TicketFilters } from './ticket-query'
import type { ModuleHono, RouteCtx } from './context'

export const MAX_EXPORT_ROWS = 20_000
/** 附件清单的预签名 TTL：批量下载可能耗时，比单次查看的 600 秒长。 */
export const EXPORT_URL_TTL_SECONDS = 3600

type ExportRange = 'selected' | 'filtered' | 'all'

const STATUS_LABEL: Record<string, string> = { pending: '待处理', completed: '已处理', cancelled: '已驳回' }
const BRAND_LABEL: Record<string, string> = { xiongmao: '熊喵', pptd: '品品甜', '': '无' }
const AMOUNT_TYPE_LABEL: Record<string, string> = { ratio: '按比例', fixed: '固定金额', reject: '驳回' }
const AFFIL_LABEL: Record<string, string> = { matched: '一致', mismatch: '门店不一致', unregistered: '未登记' }

/** 导出列白名单从模块根共用（`export-fields.ts`）：console 的字段勾选读**同一份** key/表头。 */
export const EXPORT_COLUMNS = EXPORT_FIELDS

interface ExportRow {
  id: string
  code: string
  status: string
  store_name: string
  product_name: string
  related_order: string
  damage_quantity: string
  amount_minor: string | null
  amount_type: string | null
  refund_ratio: string | null
  operator: string | null
  opinion: string
  watermark_at: string | null
  created_at: string
  processed_at: string | null
  arrival_at: string | null
  store_affiliation: string | null
  brand: string
  damage_amount_minor: string
  attachment_count: number
}

type RangeParse =
  | { ok: true; range: ExportRange; filters: TicketFilters; ids: number[] }
  | { ok: false; error: string }

/** 解析 `range` / `ids` / 列表筛选。`range` 缺省 = filtered（导出当前筛选结果）。 */
function parseRange(get: (name: string) => string | undefined): RangeParse {
  const raw = (get('range') ?? 'filtered').trim()
  if (raw !== 'selected' && raw !== 'filtered' && raw !== 'all') return { ok: false, error: 'INVALID_RANGE' }

  const parsed = parseTicketFilters(get)
  if (!parsed.ok) return { ok: false, error: parsed.error }

  if (raw !== 'selected') return { ok: true, range: raw, filters: parsed.filters, ids: [] }

  const idsRaw = (get('ids') ?? '').trim()
  if (!idsRaw) return { ok: false, error: 'INVALID_IDS' }
  const ids: number[] = []
  for (const part of idsRaw.split(',')) {
    const s = part.trim()
    if (!/^\d+$/.test(s)) return { ok: false, error: 'INVALID_IDS' }
    const n = Number(s)
    if (!Number.isSafeInteger(n) || n <= 0) return { ok: false, error: 'INVALID_IDS' }
    ids.push(n)
  }
  const unique = [...new Set(ids)]
  if (unique.length === 0 || unique.length > 100) return { ok: false, error: 'INVALID_IDS' }
  return { ok: true, range: 'selected', filters: parsed.filters, ids: unique }
}

function rangeWhere(org: string, r: Extract<RangeParse, { ok: true }>): { sql: string; params: unknown[] } {
  if (r.range === 'all') return { sql: 'org = $1', params: [org] }
  if (r.range === 'selected') return { sql: 'org = $1 and id = any($2::bigint[])', params: [org, r.ids] }
  return ticketWhere(org, r.filters)
}

const TICKET_COLUMNS_SQL = `
  select id, code, status, store_name, product_name, related_order,
         damage_quantity, amount_minor, amount_type, refund_ratio, operator, opinion,
         watermark_at::text as watermark_at, created_at, processed_at, arrival_at,
         store_affiliation,
         (${BRAND_SQL}) as brand,
         round(damage_quantity * coalesce(settlement_price_minor, basic_unit_price_minor))::bigint
           as damage_amount_minor,
         (select count(*) from aftersales.ticket_attachment a
           where a.org = t.org and a.ticket_id = t.id)::int as attachment_count
    from aftersales.ticket t`

/** CST 的 `YYYY-MM-DD HH:mm`。`sv-SE` 的输出恰好是 ISO 形状（比手拼时区稳）。 */
function cstDateTime(v: string | null): string | null {
  if (!v) return null
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return v
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)
}

function toYuan(minor: string | number | null): number | null {
  if (minor === null || minor === undefined) return null
  const n = Number(minor)
  return Number.isFinite(n) ? n / 100 : null
}

function rowToXlsx(r: ExportRow): XlsxRow {
  return {
    code: r.code,
    status: STATUS_LABEL[r.status] ?? r.status,
    brand: BRAND_LABEL[r.brand] ?? '',
    productName: r.product_name,
    storeName: r.store_name,
    relatedOrder: r.related_order,
    arrivalAt: cstDateTime(r.arrival_at),
    damageQuantity: Number(r.damage_quantity),
    damageAmount: toYuan(r.damage_amount_minor),
    refundAmount: toYuan(r.amount_minor),
    amountType: r.amount_type ? (AMOUNT_TYPE_LABEL[r.amount_type] ?? r.amount_type) : '',
    // Excel 的百分比格式吃「小数比例」：0.1 显示 10.00%，不是 0.10。
    refundRatio: r.refund_ratio === null ? null : Number(r.refund_ratio),
    operator: r.operator ?? '',
    opinion: r.opinion,
    watermarkAt: r.watermark_at,
    attachments: r.attachment_count,
    createdAt: cstDateTime(r.created_at),
    processedAt: cstDateTime(r.processed_at),
    storeAffiliation: r.store_affiliation ? (AFFIL_LABEL[r.store_affiliation] ?? r.store_affiliation) : '',
  }
}

function fileStamp(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    .replace(/\D/g, '').slice(0, 12)
}

export function registerTicketExport(r: ModuleHono, ctx: RouteCtx): void {
  // GET /tickets/export —— 服务端生成 Excel（必须在 /tickets/:id 之前注册）。
  r.get('/tickets/export', async (c) => {
    const org = c.get('identity').orgId
    const parsed = parseRange((k) => c.req.query(k))
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    // 列白名单：未知 key 直接 400（静默忽略会导出「少了几列」的假成功）。
    const allKeys = EXPORT_COLUMNS.map((x) => x.key)
    const rawColumns = (c.req.query('columns') ?? '').trim()
    const keys = rawColumns ? rawColumns.split(',').map((s) => s.trim()).filter(Boolean) : allKeys
    if (keys.length === 0 || keys.some((k) => !allKeys.includes(k))) return c.json({ error: 'INVALID_COLUMNS' }, 400)
    const columns = EXPORT_COLUMNS.filter((x) => keys.includes(x.key))

    const { sql: where, params } = rangeWhere(org, parsed)
    const countRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.ticket t where ${where}`,
      params,
    )
    const n = countRes.rows[0]?.n ?? 0
    if (n > MAX_EXPORT_ROWS) {
      return c.json({ error: 'EXPORT_TOO_LARGE', detail: { rows: n, limit: MAX_EXPORT_ROWS } }, 400)
    }

    const rowsRes = await ctx.pool.query<ExportRow>(
      `${TICKET_COLUMNS_SQL}
        where ${where}
        order by id desc
        limit $${params.length + 1}`,
      [...params, MAX_EXPORT_ROWS],
    )
    const buf = await ticketsXlsx(columns, rowsRes.rows.map(rowToXlsx))
    const filename = `售后工单_${fileStamp()}.xlsx`
    return c.body(new Uint8Array(buf), 200, {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      // 中文文件名按 RFC 5987 编码；ASCII 兜底给老客户端。
      'content-disposition': `attachment; filename="aftersales-tickets.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'cache-control': 'no-store',
      'x-row-count': String(rowsRes.rows.length),
    })
  })

  // GET /tickets/export-manifest —— 附件打包清单：每单 × 每个附件的预签名 GET URL。
  // 只列**有附件**的工单（减少响应体积）；无附件工单不出现。
  r.get('/tickets/export-manifest', async (c) => {
    const org = c.get('identity').orgId
    const parsed = parseRange((k) => c.req.query(k))
    if (!parsed.ok) return c.json({ error: parsed.error }, 400)

    const { sql: where, params } = rangeWhere(org, parsed)
    // 与 export 同一行数上限：清单超限直接 400，不静默截断（截断会让用户以为附件包是全的）。
    const countRes = await ctx.pool.query<{ n: number }>(
      `select count(*)::int as n from aftersales.ticket t where ${where}`,
      params,
    )
    const n = countRes.rows[0]?.n ?? 0
    if (n > MAX_EXPORT_ROWS) {
      return c.json({ error: 'EXPORT_TOO_LARGE', detail: { rows: n, limit: MAX_EXPORT_ROWS } }, 400)
    }

    const ticketsRes = await ctx.pool.query<{ id: string; code: string }>(
      `select id, code from aftersales.ticket t
        where ${where} and exists (
          select 1 from aftersales.ticket_attachment a
           where a.org = t.org and a.ticket_id = t.id
        )
        order by id desc
        limit $${params.length + 1}`,
      [...params, MAX_EXPORT_ROWS],
    )
    const ids = ticketsRes.rows.map((x) => Number(x.id))
    if (ids.length === 0) return c.json({ tickets: [] })

    const attRes = await ctx.pool.query<{
      ticket_id: string; id: string; object_key: string; content_type: string
      size_bytes: string; storage_ref: string
    }>(
      `select ticket_id, id, object_key, content_type, size_bytes, storage_ref
         from aftersales.ticket_attachment
        where org = $1 and ticket_id = any($2::bigint[])
        order by ticket_id, id`,
      [org, ids],
    )
    const resolve = storageResolverFor(storageCandidatesFor(c.get(TENANT_STORAGE)))
    const byTicket = new Map<number, {
      id: number; objectKey: string; contentType: string; sizeBytes: number; url: string | null
    }[]>()
    await Promise.all(attRes.rows.map(async (a) => {
      const storage = resolve(a.storage_ref)
      // 解析不出来只让该项 url 为 null（与详情同口径：不把整张清单打成 503），
      // 但必须显式告警——「附件打不开」不能静默。
      if (!storage) warnUnresolvedRef(org, a.storage_ref)
      const item = {
        id: Number(a.id),
        objectKey: a.object_key,
        contentType: a.content_type,
        sizeBytes: Number(a.size_bytes),
        url: storage ? await storage.presignGet(a.object_key, EXPORT_URL_TTL_SECONDS) : null,
      }
      const list = byTicket.get(Number(a.ticket_id)) ?? []
      list.push(item)
      byTicket.set(Number(a.ticket_id), list)
    }))

    return c.json({
      tickets: ticketsRes.rows
        .map((t) => ({ id: Number(t.id), code: t.code, attachments: byTicket.get(Number(t.id)) ?? [] }))
        .filter((t) => t.attachments.length > 0),
    })
  })
}
