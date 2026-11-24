// report-events.ts — 报表事件遥测（N1–N4 的数据基础；迁移 055）。
//
// 三条纪律：
//  ① **best-effort**：事件写入失败不反噬业务请求（创建/发布/观看照常成功），只打日志；
//  ② **不含指标值**：meta 只放可审计的小字段（渲染器/格式/来源），数字仍在各自审计面；
//  ③ **事件是事实、口径是派生**：这里只落事件；N1/N2 的分子分母由 funnelStats 在查询时算。
import type { Pool } from 'pg'

export type ReportEventKind = 'created' | 'spec_edited' | 'published' | 'viewed' | 'exported'
export type ReportEventSource = 'agent' | 'http' | 'system'

export interface ReportEventInput {
  org: string
  reportId: string
  actor?: string | null
  event: ReportEventKind
  source?: ReportEventSource
  meta?: Record<string, unknown>
}

/** 事件写入：绝不抛给调用方（观看/创建/发布不能因为一条遥测失败而失败）。 */
export async function recordReportEvent(pool: Pool, input: ReportEventInput): Promise<void> {
  try {
    await pool.query(
      `insert into data.report_events (org, report_id, actor, event, source, meta)
       values ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        input.org,
        input.reportId,
        input.actor ?? null,
        input.event,
        input.source ?? 'http',
        JSON.stringify(input.meta ?? {}),
      ],
    )
  } catch (e) {
    // 只记日志：事件表不是业务事务的一部分，失败必须可观测但不能阻塞主流程。
    console.warn(`[data/report_events] write failed ${input.event} ${input.reportId}: ${e instanceof Error ? e.message : String(e)}`)
  }
}

export interface ReportFunnelStats {
  days: number
  created: number
  published: number
  /** 窗口内被真实观看的报表数（去重）。 */
  viewedReports: number
  exports: number
  specEdits: number
  createdBySource: Record<string, number>
  /**
   * N2 代理指标：窗口内「首次发布前没有改过规格」的报表数。
   * 判定 = published 事件之前不存在 spec_edited 事件（同一报表）。
   */
  publishedWithoutEdit: number
}

/** 漏斗统计：只数事件，不猜口径；窗口外的发布不计入分母。 */
export async function funnelStats(pool: Pool, org: string, days: number): Promise<ReportFunnelStats> {
  const since = `now() - interval '${Math.max(1, Math.min(days, 365))} days'`
  const counts = await pool.query(
    `select event, source, count(*)::int as n
       from data.report_events
      where org = $1 and created_at >= ${since}
      group by event, source`,
    [org],
  )
  const byEvent = new Map<string, number>()
  const createdBySource: Record<string, number> = {}
  for (const row of counts.rows as Array<{ event: string; source: string; n: number }>) {
    byEvent.set(row.event, (byEvent.get(row.event) ?? 0) + row.n)
    if (row.event === 'created') createdBySource[row.source] = row.n
  }
  const viewedReports = await pool.query(
    `select count(distinct report_id)::int as n from data.report_events
      where org = $1 and event = 'viewed' and created_at >= ${since}`,
    [org],
  )
  // N2 代理：逐报表比较「首次 published」与「其前的 spec_edited」。
  const noEdit = await pool.query(
    `with first_pub as (
       select report_id, min(created_at) as pub_at
         from data.report_events
        where org = $1 and event = 'published' and created_at >= ${since}
        group by report_id
     )
     select count(*)::int as n
       from first_pub p
      where not exists (
        select 1 from data.report_events e
         where e.org = $1 and e.report_id = p.report_id
           and e.event = 'spec_edited' and e.created_at < p.pub_at
      )`,
    [org],
  )
  return {
    days,
    created: byEvent.get('created') ?? 0,
    published: byEvent.get('published') ?? 0,
    viewedReports: (viewedReports.rows[0] as { n: number } | undefined)?.n ?? 0,
    exports: byEvent.get('exported') ?? 0,
    specEdits: byEvent.get('spec_edited') ?? 0,
    createdBySource,
    publishedWithoutEdit: (noEdit.rows[0] as { n: number } | undefined)?.n ?? 0,
  }
}
