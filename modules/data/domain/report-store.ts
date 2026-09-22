// report-store.ts — 报表登记的存储层（双写面的平台侧，spec §4/§7）。
//
// 隔离键一律是 **org（text，值 = 该租户的 Casdoor org）**，不是 tenant_id：
// 正典 docs/module-protocol.md「租户数据隔离」，机器判据 scripts/check-tenant-isolation.mjs。
// 三处读写**全部**带 `where org = $1`——漏一处就是跨租户串数据。
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'

export interface ReportRow {
  id: string
  title: string
  metabaseId: number
  /** 本报表除 `tenant` 外要锁的参数 → 值（`tenant` 的平台保留值不在此列，见 routes/reports.ts）。 */
  embedParams: Record<string, string>
  requiredScope: string | null
}

/** 行 → ReportRow。`metabase_id` 是 int4 ⇒ pg 回 JS number（**bigint 会回 string**，故列类型选 int4）。 */
function toReportRow(row: Record<string, unknown>): ReportRow {
  return {
    id: row.id as string,
    title: row.title as string,
    metabaseId: row.metabase_id as number,
    // embed_params 是 jsonb：pg 已反序列化成对象，**不要**再 JSON.parse（那是第二个事实源）
    embedParams: row.embed_params as Record<string, string>,
    requiredScope: row.required_scope as string | null,
  }
}

/** 本 org 的全部登记。`order by title`：顺序确定，对账差集与 console 列表都不必猜。 */
export async function listReports(pool: Pool, org: string): Promise<ReportRow[]> {
  const r = await pool.query(
    `select id, title, metabase_id, embed_params, required_scope
       from data.reports
      where org = $1
      order by title`,
    [org],
  )
  return r.rows.map(toReportRow)
}

/** 单行读取。**必须带 org**——否则 id 就是跨租户探测句柄。 */
export async function getReport(pool: Pool, org: string, id: string): Promise<ReportRow | null> {
  const r = await pool.query(
    `select id, title, metabase_id, embed_params, required_scope
       from data.reports
      where org = $1 and id = $2`,
    [org, id],
  )
  return r.rowCount === 0 ? null : toReportRow(r.rows[0])
}

/**
 * 幂等登记：**冲突键是 (org, title)**，不是 (org, id)。
 *
 * 为什么按 title 而不是 id：幂等的语义是「同一个报表重跑一次不重复建」，而报表在 Metabase
 * 侧的身份就是它的 name（`API 无按名 upsert`，平台自己按 name 找 → spec §6.5）。按 id 做冲突
 * 键的话，每次 POST 都会生成新 uuid ⇒ 每次都新增一行，正是要防的那个 bug。
 *
 * 二次 POST 覆盖 metabase_id / embed_params / required_scope，但**不换 id**（老 id 保留 ⇒
 * 已经发出去的嵌入 URL 指向的行不会凭空消失），也不碰 created_at（那是「这行什么时候进来的」）。
 * 返回登记行的 id（稳定）。
 */
export async function upsertReport(
  pool: Pool,
  org: string,
  input: { title: string; metabaseId: number; embedParams: Record<string, string>; requiredScope: string | null },
): Promise<string> {
  const r = await pool.query(
    `insert into data.reports (org, id, title, metabase_id, embed_params, required_scope)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (org, title) do update set
       metabase_id    = excluded.metabase_id,
       embed_params   = excluded.embed_params,
       required_scope = excluded.required_scope,
       updated_at     = now()
     returning id`,
    [org, randomUUID(), input.title, input.metabaseId,
      JSON.stringify(input.embedParams), input.requiredScope],
  )
  return r.rows[0].id as string
}

/** 删登记行：返回是否真命中一行（没命中不是错误）。 */
export async function deleteReport(pool: Pool, org: string, id: string): Promise<boolean> {
  const r = await pool.query('delete from data.reports where org = $1 and id = $2', [org, id])
  return (r.rowCount ?? 0) > 0
}
