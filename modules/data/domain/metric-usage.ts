// metric-usage.ts — 使用统计读面（spec 2026-11-01 §10.4.3 P1）：query_audit 按 metricId 聚合 + L2 下线候选。
//
// 为什么以词表为**骨架**而不是以审计为骨架：统计的面是「每条指标被用了多少」，审计只有
// 用过的（没有审计 = 没用过 = 0 次）。从词表出发合并审计 ⇒ 无审计行也是**诚实零**（0 次
// 是统计事实，不是数据缺席）；从审计出发会把「没用过」的指标整条漏掉——而它们恰恰是
// 下线候选的主体。
//
// verdict 口径：**全 verdict 计数**（denied/error 也是使用行为——有人试过就有治理意义）；
// distinct user 按行内 user_id 算（三通道同一身份空间，001 头注）。
import type { Pool } from 'pg'
import { loadMergedCatalog } from './metric-store'
import type { MetricRow } from './metric-store'

/** 单条指标在窗口内的使用聚合。 */
export interface MetricUsageStat {
  metricId: string
  title: string
  source: 'l1' | 'l2'
  /** L2 的创建者（下线候选要能找到人）；L1 恒 null。 */
  createdBy: string | null
  /** 窗口内审计行数（全 verdict：ok/denied/error 都算使用）。 */
  queries: number
  /** 窗口内去重用户数。 */
  users: number
  /** 窗口内最近一次使用的时刻（ISO）；窗口内没用过 = null。 */
  lastUsedAt: string | null
}

/**
 * 本租户合并词表全量行的使用聚合（spec §10.4.3 第一项）。
 * 窗口 =「now() - N 天」起；词表行不在审计里 ⇒ 0 次（诚实零，不是缺席）。
 */
export async function metricUsageStats(
  pool: Pool, org: string, days: number,
): Promise<MetricUsageStat[]> {
  const catalog = await loadMergedCatalog(pool, org)
  if (catalog.length === 0) return []
  // 一次聚合查询（org 列上有序索引，N 天窗口）；骨架合并在内存做——行数 = 词表规模（几十），
  // 把 join 拆给 SQL（outer join jsonb）反而把形状归一这件复杂事拖进数据库。
  const { rows } = await pool.query(
    `select metric_id,
            count(*)::int           as queries,
            count(distinct user_id)::int as users,
            max(created_at)          as last_used
       from data.query_audit
      where org = $1 and created_at >= now() - make_interval(days => $2::int)
      group by metric_id`,
    [org, days],
  )
  const audits = new Map((rows as Record<string, unknown>[]).map((r) => [
    String(r.metric_id),
    { queries: Number(r.queries ?? 0), users: Number(r.users ?? 0), last: r.last_used as Date | null },
  ]))
  return catalog.map((m: MetricRow) => {
    const a = audits.get(m.id)
    return {
      metricId: m.id,
      title: m.title,
      source: m.source,
      createdBy: m.source === 'l2' ? (m.createdBy ?? null) : null,
      queries: a?.queries ?? 0,
      users: a?.users ?? 0,
      lastUsedAt: a?.last !== undefined && a?.last !== null ? new Date(a.last).toISOString() : null,
    }
  })
}

/**
 * 下线候选（spec §10.4.3 第二项，**读面**）：source=l2 且窗口内 0 次使用。
 * L1 是平台口径（改声明走代码评审），永不进候选；候选带 createdBy——下线的第一步是找人。
 * 「下线动作怎么编排」是后续议题（spec D7 口径：出现真实诉求再自动化），这里只出清单。
 */
export interface RetireCandidate {
  metricId: string
  title: string
  /** 恒 'l2'（结构自证：候选集合只从 L2 行筛出，调用方不必信 swear 而可断言它）。 */
  source: 'l2'
  createdBy: string | null
  /** 上次使用（任何窗口）；候选行长给 null（词表期间从没用过）。 */
  lastUsedAt: string | null
}

export async function retireCandidatesOf(pool: Pool, org: string, days: number): Promise<RetireCandidate[]> {
  const stats = await metricUsageStats(pool, org, days)
  return stats
    .filter((s) => s.source === 'l2' && s.queries === 0)
    .map((s) => ({ metricId: s.metricId, title: s.title, source: 'l2' as const, createdBy: s.createdBy, lastUsedAt: s.lastUsedAt }))
}
