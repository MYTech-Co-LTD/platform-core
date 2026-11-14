// query-stats.ts — 全链路查询性能统计（R4 p95 基线）。
//
// 数据源 = `data.query_audit`（每次查询天然一行；053 起带 `duration_ms`）。为什么不再新开
// 遥测表：审计已经是「谁在何时查了什么」的唯一事实源，耗时只是同一行上的一个分项——多一张表
// 就多一份要维护的一致性。
//
// 口径：
//  · `p95Ms` 只对**有耗时的样本**（duration_ms not null）计算；旧行/未测路径缺席 ⇒ null。
//  · `slow` = duration_ms ≥ `QUERY_SLOW_MS`（与 query-service 的慢查询日志同一阈值）。
//  · `slowRate` 分母 = total（含旧行缺耗时）——「慢查询占比」看的是整条链路。
//  · `breaches` 由服务端算好（阈值单一事实源），console 只画越线。
import type { Pool } from 'pg'

/** 慢查询阈值：与 query-service 的慢查询日志同一口径（`[data/query] slow`）。 */
export const QUERY_SLOW_MS = 500

/** 查询性能 SLO（R4）。口径见文件头；console 面板与将来的告警读同一份。 */
export const QUERY_SLO = {
  p95Ms: 3_000,
  slowRate: 0.1,
} as const

export type QuerySloBreach = 'p95' | 'slow_rate'

export interface QueryStats {
  days: number
  total: number
  /** 有耗时样本的查询数（旧行不算）。 */
  sampled: number
  p95Ms: number | null
  slow: number
  slowRate: number | null
  breaches: QuerySloBreach[]
  slo: typeof QUERY_SLO
  byMetric: Array<{ metricId: string; total: number; slow: number; p95Ms: number | null }>
  byDay: Array<{ day: string; total: number; p95Ms: number | null }>
}

const num = (v: string | null | undefined): number => (v === null || v === undefined ? 0 : Number(v))
const numOrNull = (v: string | null | undefined): number | null =>
  v === null || v === undefined ? null : Number(v)

/** 只读聚合；`days` 由调用方夹在 1..90。 */
export async function queryStats(pool: Pool, org: string, days: number): Promise<QueryStats> {
  const since = `now() - ($2::int * interval '1 day')`
  const main = await pool.query<{
    total: string; sampled: string; slow: string; p95: string | null
  }>(
    `select count(*)::text as total,
            count(*) filter (where duration_ms is not null)::text as sampled,
            count(*) filter (where duration_ms >= ${QUERY_SLOW_MS})::text as slow,
            percentile_cont(0.95) within group (order by duration_ms)
              filter (where duration_ms is not null)::text as p95
       from data.query_audit
      where org = $1 and created_at >= ${since}`,
    [org, days],
  )
  const r = main.rows[0]
  const total = num(r?.total)
  const slow = num(r?.slow)
  const p95Ms = numOrNull(r?.p95)
  const slowRate = total === 0 ? null : slow / total
  const breaches: QuerySloBreach[] = []
  if (p95Ms !== null && p95Ms > QUERY_SLO.p95Ms) breaches.push('p95')
  if (slowRate !== null && slowRate > QUERY_SLO.slowRate) breaches.push('slow_rate')

  const byMetric = await pool.query<{
    metric_id: string; total: string; slow: string; p95: string | null
  }>(
    `select metric_id,
            count(*)::text as total,
            count(*) filter (where duration_ms >= ${QUERY_SLOW_MS})::text as slow,
            percentile_cont(0.95) within group (order by duration_ms)
              filter (where duration_ms is not null)::text as p95
       from data.query_audit
      where org = $1 and created_at >= ${since}
      group by metric_id
      order by percentile_cont(0.95) within group (order by duration_ms) desc nulls last
      limit 10`,
    [org, days],
  )
  const byDay = await pool.query<{ day: string; total: string; p95: string | null }>(
    `select to_char((created_at at time zone 'Asia/Shanghai')::date, 'YYYY-MM-DD') as day,
            count(*)::text as total,
            percentile_cont(0.95) within group (order by duration_ms)
              filter (where duration_ms is not null)::text as p95
       from data.query_audit
      where org = $1 and created_at >= ${since}
      group by 1
      order by 1`,
    [org, days],
  )

  return {
    days,
    total,
    sampled: num(r?.sampled),
    p95Ms,
    slow,
    slowRate,
    breaches,
    slo: QUERY_SLO,
    byMetric: byMetric.rows.map((x) => ({
      metricId: x.metric_id, total: num(x.total), slow: num(x.slow), p95Ms: numOrNull(x.p95),
    })),
    byDay: byDay.rows.map((x) => ({ day: x.day, total: num(x.total), p95Ms: numOrNull(x.p95) })),
  }
}
