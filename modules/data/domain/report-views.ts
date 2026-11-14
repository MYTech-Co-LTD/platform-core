// report-views.ts — 报表访问台账与「30 天零访问」提醒（R6）。
//
// 口径（写进实现，不靠人记）：
//  · **访问 = 观看面渲染已发布报表**（`GET /published-spec` 成功回包）。管理清单/列表不算。
//  · 台账每个 (org, report_id) 一行；重复访问只推进 `last_viewed_at` 与计数。
//  · 「零访问」= `max(last_viewed_at, reports.created_at)` 早于 now − days。从未被访问的
//    报表从**创建时刻**起算——刚建出来就报「零访问」是噪声，不是治理信号。
//  · 只提醒、不自动归档：归档/删除是资产动作，必须由人做（R6 的「提醒归档」）。
import type { Pool } from 'pg'

/** 访问台账写入（best-effort）：失败只告警，绝不影响观看面。 */
export async function recordReportView(
  pool: Pool, org: string, reportId: string, userId: string,
): Promise<void> {
  try {
    await pool.query(
      `insert into data.report_views (org, report_id, last_viewed_at, last_viewed_by, view_count)
       values ($1, $2, now(), $3, 1)
       on conflict (org, report_id) do update
         set last_viewed_at = now(),
             last_viewed_by = excluded.last_viewed_by,
             view_count = data.report_views.view_count + 1`,
      [org, reportId, userId],
    )
  } catch (e) {
    console.warn(`[data/report-views] record failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface StaleReport {
  id: string
  title: string
  renderer: string
  /** 最后一次观看；null = 自从台账上线以来从未被观看。 */
  lastViewedAt: string | null
  viewCount: number
  /** 距「最后一次观看」或「创建」的天数（取较近者）。 */
  daysSince: number
}

export interface StaleReportReport {
  days: number
  /** 早于阈值、按「最久没动」升序（最该归档的在前）。 */
  stale: StaleReport[]
}

/** `days` 由调用方夹在 1..365；这里是唯一实现。 */
export async function staleReports(pool: Pool, org: string, days: number): Promise<StaleReportReport> {
  const r = await pool.query<{
    id: string; title: string; renderer: string
    last_viewed_at: Date | null; view_count: string | null; days_since: string
  }>(
    `select r.id, r.title, r.renderer,
            v.last_viewed_at,
            v.view_count::text as view_count,
            floor(extract(epoch from (now() - coalesce(v.last_viewed_at, r.created_at))) / 86400)::text as days_since
       from data.reports r
       left join data.report_views v on v.org = r.org and v.report_id = r.id
      where r.org = $1
        and coalesce(v.last_viewed_at, r.created_at) < now() - ($2::int * interval '1 day')
      order by coalesce(v.last_viewed_at, r.created_at) asc
      limit 100`,
    [org, days],
  )
  return {
    days,
    stale: r.rows.map((x) => ({
      id: x.id,
      title: x.title,
      renderer: x.renderer,
      lastViewedAt: x.last_viewed_at === null ? null : x.last_viewed_at.toISOString(),
      viewCount: x.view_count === null ? 0 : Number(x.view_count),
      daysSince: Number(x.days_since),
    })),
  }
}
