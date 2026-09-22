// import.ts — 清洗行 → 目标库（幂等 upsert；source_id 是幂等位，重跑收敛）。
// 导入顺序约束（FK）：region → store → product → employee(含 employee_store) → rule →
// employee_approval → ticket。archive_* 在 T4 并入（同一顺序原则）。
// 跳行纪律：必填枚举（status/amountType/approveType）为 null = 源值不在词表——**跳行并记
// reasons（unknown_*）**，绝不落列缺省（列 default 'pending' 就是当年要消灭的硬映射——与
// clean.ts 的 mapValue 无 fallback 同一条裁决，T3「按 skip 计数对照」以此为实现面）。
// not-null 时间列的缺值不属「词表未知」：按 `?? new Date()` 收口到列缺省语义（created_at → 迁移时刻），
// 避免一行缺值 23502 打断整批。**例外（2026-09-22 裁决）：ticket_rule.refund_ratio 缺值不落 0**——
// 「没有比例的规则」静默落 0 = 替业务写死「无退款」：新行跳行记因（missing_refund_ratio）；
// 已存在行不因源缺值降级（比例列只在源有值时才被写，见 importRule 的等价守卫）。
import type { Pool } from 'pg'
import type {
  CleanEmployee, CleanEmployeeApproval, CleanProduct, CleanRegion, CleanRule, CleanStore, CleanTicket,
} from './clean'

export interface ImportStat {
  table: string
  fetched: number
  imported: number
  skipped: number
  reasons: Record<string, number>
}

function newStat(table: string, fetched: number): ImportStat {
  return { table, fetched, imported: 0, skipped: 0, reasons: {} }
}
function skip(stat: ImportStat, reason: string): void {
  stat.skipped += 1
  stat.reasons[reason] = (stat.reasons[reason] ?? 0) + 1
}

/** 档案 source_id → 库内 id 的映射（FK 解析用）。 */
async function sourceIdMap(pool: Pool, org: string, table: 'region' | 'store' | 'product'): Promise<Map<string, number>> {
  const r = await pool.query<{ source_id: string; id: string }>(
    `select source_id, id from aftersales.${table} where org = $1 and source_id <> ''`, [org])
  return new Map(r.rows.map((row) => [row.source_id, Number(row.id)]))
}

export async function importRegion(pool: Pool, org: string, rows: CleanRegion[]): Promise<ImportStat> {
  const stat = newStat('region', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    await pool.query(
      `insert into aftersales.region (org, source_id, name) values ($1, $2, $3)
       on conflict (org, source_id) where source_id <> '' do update set name = excluded.name`,
      [org, r.sourceId, r.name],
    )
    stat.imported += 1
  }
  return stat
}

export async function importStore(pool: Pool, org: string, rows: CleanStore[]): Promise<ImportStat> {
  const stat = newStat('store', rows.length)
  const regions = await sourceIdMap(pool, org, 'region')
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    const regionId = r.regionSourceId ? regions.get(r.regionSourceId) ?? null : null
    await pool.query(
      `insert into aftersales.store (org, source_id, name, region_id, address, phone)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, region_id = excluded.region_id,
                     address = excluded.address, phone = excluded.phone`,
      [org, r.sourceId, r.name, regionId, r.address, r.phone],
    )
    stat.imported += 1
  }
  return stat
}

export async function importProduct(pool: Pool, org: string, rows: CleanProduct[]): Promise<ImportStat> {
  const stat = newStat('product', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    await pool.query(
      `insert into aftersales.product (org, source_id, name, spec, basic_quantity, basic_unit_price_minor)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, spec = excluded.spec,
                     basic_quantity = excluded.basic_quantity,
                     basic_unit_price_minor = excluded.basic_unit_price_minor`,
      [org, r.sourceId, r.name, r.spec, r.basicQuantity, r.basicUnitPriceMinor ?? 0n],
    )
    stat.imported += 1
  }
  return stat
}

export async function importEmployee(pool: Pool, org: string, rows: CleanEmployee[]): Promise<ImportStat> {
  const stat = newStat('employee', rows.length)
  const stores = await sourceIdMap(pool, org, 'store')
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    if (r.approveStatus === null) { skip(stat, 'unknown_status'); continue }
    // 主门店 = 串里第一个能解析到档案的（§2.5：employee.store_id 保留「主门店」语义，可空）
    const resolved = r.storeSourceIds.map((sid) => stores.get(sid) ?? null)
    const primaryStore = resolved.find((id): id is number => id !== null) ?? null
    // 不可解析段：计入 reasons（信息面，**不增 skipped**——行本身已导入，丢的是「链」不是「行」）。
    // 静默丢段 = 对账黑洞：链表没有源侧计数可对，唯一可见性就是这里的计数。
    const unresolved = resolved.filter((id) => id === null).length
    if (unresolved > 0) stat.reasons['unresolved_store_ref'] = (stat.reasons['unresolved_store_ref'] ?? 0) + unresolved
    const ins = await pool.query<{ id: string }>(
      `insert into aftersales.employee (org, source_id, name, phone, open_id, approve_status, store_id)
       values ($1, $2, $3, $4, $5, $6, $7)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, phone = excluded.phone, open_id = excluded.open_id,
                     approve_status = excluded.approve_status, store_id = excluded.store_id
       returning id`,
      [org, r.sourceId, r.name, r.phone, r.openId, r.approveStatus, primaryStore],
    )
    const employeeId = Number(ins.rows[0].id)
    // 多门店拆行（§2.5 规范化）：先清后插——重跑收敛（快照式导入，源是全量）
    await pool.query(`delete from aftersales.employee_store where org = $1 and employee_id = $2`, [org, employeeId])
    for (const storeId of resolved) {
      if (storeId === null) continue
      await pool.query(
        `insert into aftersales.employee_store (org, employee_id, store_id) values ($1, $2, $3)
         on conflict (org, employee_id, store_id) do nothing`,
        [org, employeeId, storeId],
      )
    }
    stat.imported += 1
  }
  return stat
}

export async function importEmployeeApproval(pool: Pool, org: string, rows: CleanEmployeeApproval[]): Promise<ImportStat> {
  const stat = newStat('employee_approval', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    if (r.status === null) { skip(stat, 'unknown_status'); continue }
    if (r.approveType === null) { skip(stat, 'unknown_approve_type'); continue }
    await pool.query(
      `insert into aftersales.employee_approval
         (org, source_id, open_id, approve_type, status, old_info, new_info, created_at, decided_at, decided_by)
       values ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10)
       on conflict (org, source_id) where source_id <> ''
       do update set status = excluded.status, old_info = excluded.old_info, new_info = excluded.new_info,
                     decided_at = excluded.decided_at, decided_by = excluded.decided_by`,
      [org, r.sourceId, r.openId, r.approveType, r.status,
       JSON.stringify(r.oldInfo), JSON.stringify(r.newInfo),
       r.createdAt ?? new Date(), r.decidedAt, r.decidedBy || null],
    )
    stat.imported += 1
  }
  return stat
}

export async function importRule(pool: Pool, org: string, rows: CleanRule[]): Promise<ImportStat> {
  const stat = newStat('ticket_rule', rows.length)
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    if (r.refundRatio === null) {
      // 裁决（2026-09-22）：缺比例的规则**不新增**——静默落 0 等于替业务写死「无退款」，跳行记因。
      // 重跑例外：库内已有该行（比例已录）不算缺行——其余字段照更新，比例列**不写**。
      // 「源有值才 set」的守卫没法住进单条 upsert：NOT NULL 在 conflict 仲裁**之前**先检，
      // 携 NULL 走 insert 腿必 23502（即便该行命中冲突、根本轮不到 DO UPDATE）——实测如此；
      // 故拆成这条**不碰比例列**的 update 作等价形态（比例只在下方源有值的 upsert 里被写）。
      const exists = await pool.query(
        `select 1 from aftersales.ticket_rule where org = $1 and source_id = $2`, [org, r.sourceId])
      if (exists.rows.length === 0) { skip(stat, 'missing_refund_ratio'); continue }
      await pool.query(
        `update aftersales.ticket_rule set name = $3, remark = $4 where org = $1 and source_id = $2`,
        [org, r.sourceId, r.name, r.remark])
      stat.imported += 1
      continue
    }
    await pool.query(
      `insert into aftersales.ticket_rule (org, source_id, name, refund_ratio, remark)
       values ($1, $2, $3, $4, $5)
       on conflict (org, source_id) where source_id <> ''
       do update set name = excluded.name, refund_ratio = excluded.refund_ratio, remark = excluded.remark`,
      [org, r.sourceId, r.name, r.refundRatio, r.remark],
    )
    stat.imported += 1
  }
  return stat
}

export async function importTicket(pool: Pool, org: string, rows: CleanTicket[]): Promise<ImportStat> {
  const stat = newStat('ticket', rows.length)
  const products = await sourceIdMap(pool, org, 'product')
  const productNames = new Map<string, string>(
    (await pool.query<{ source_id: string; name: string }>(
      `select source_id, name from aftersales.product where org = $1 and source_id <> ''`, [org],
    )).rows.map((row) => [row.source_id, row.name]),
  )
  const stores = await sourceIdMap(pool, org, 'store')
  const storeNames = new Map<string, string>(
    (await pool.query<{ source_id: string; name: string }>(
      `select source_id, name from aftersales.store where org = $1 and source_id <> ''`, [org],
    )).rows.map((row) => [row.source_id, row.name]),
  )
  for (const r of rows) {
    if (!r.sourceId) { skip(stat, 'no_source_id'); continue }
    if (r.status === null) { skip(stat, 'unknown_status'); continue }
    if (r.amountType === null) { skip(stat, 'unknown_amount_type'); continue }
    // 二义洗清（§3.3：product_name 存 ID 或名称）：值命中档案 source_id ⇒ 挂 FK + 以档案名为快照；
    // 否则视为名称快照、不挂 FK。store 同理。
    const productId = products.get(r.productRefRaw) ?? null
    const productName = productId !== null ? productNames.get(r.productRefRaw) ?? '' : r.productRefRaw
    const storeId = stores.get(r.storeRefRaw) ?? null
    const storeName = storeId !== null ? storeNames.get(r.storeRefRaw) ?? '' : r.storeRefRaw
    await pool.query(
      `insert into aftersales.ticket
         (org, source_id, code, submitter_openid, product_id, product_name, store_id, store_name,
          damage_quantity, basic_quantity, basic_unit_price_minor, status, amount_type, amount_minor,
          refund_ratio, operator, remark, related_order, created_at, processed_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       on conflict (org, source_id) where source_id <> ''
       do update set code = excluded.code, submitter_openid = excluded.submitter_openid,
                     product_id = excluded.product_id, product_name = excluded.product_name,
                     store_id = excluded.store_id, store_name = excluded.store_name,
                     damage_quantity = excluded.damage_quantity, basic_quantity = excluded.basic_quantity,
                     basic_unit_price_minor = excluded.basic_unit_price_minor, status = excluded.status,
                     amount_type = excluded.amount_type, amount_minor = excluded.amount_minor,
                     refund_ratio = excluded.refund_ratio, operator = excluded.operator,
                     remark = excluded.remark, related_order = excluded.related_order,
                     processed_at = excluded.processed_at`,
      [org, r.sourceId, r.code, r.submitterOpenid, productId, productName, storeId, storeName,
       r.damageQuantity, r.basicQuantity, r.basicUnitPriceMinor ?? 0n, r.status,
       r.amountType, r.amountMinor ?? 0n, r.refundRatio, r.operator, r.remark, r.relatedOrder,
       r.createdAt ?? new Date(), r.processedAt],
    )
    stat.imported += 1
  }
  return stat
}
