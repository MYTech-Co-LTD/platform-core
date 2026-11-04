// private-measure-lifecycle.ts — W2 私有测度的热度淘汰（30 天零使用 ⇒ 归档）与归档读面。
//
// 口径（spec 2026-11-04 §4.4）：
//   · 只作用于 `source='l2'` + `basis='column_agg'` + 未归档的行；
//     L1（`source='l1'`，平台桶）与树形 L2 的生命周期不由本动作管；
//   · 「30 天零使用」= 窗口内 `query_audit.metric_id` 无记录，且**这行已活满 30 天**——
//     否则一条刚建出来、还没来得及被问的私有测度会在下一次 job 立刻被淘汰；
//   · 归档是**隐藏不是删除**：`archived_at = now()`，行与审计保留（读面三个词表加载器过滤）；
//   · 回归重放（`REGRESSION_USER_ID`）是系统自检，不算业务使用（与 metricUsageStats 同一口径）。
//
// 租户隔离：所有 SQL 都带 `org = $1`。注意 `scripts/check-tenant-isolation.mjs` **只对账
// 「每张表有 not null 的 org 列」这一列存在性**，并不校验查询级隔离——查询级隔离靠评审与
// 本文件/SQL 的形状保证，别把那道门禁当成运行时判据。
import type { Pool } from 'pg'
import { REGRESSION_USER_ID } from './metric-usage'

/** 淘汰窗口的缺省天数（spec §4.4 钉死 30；次数阈值不在这里编）。 */
export const PRIVATE_MEASURE_ARCHIVE_DAYS = 30

/**
 * 把本 org 中「活满 N 天且窗口内零使用」的私有测度置为归档。
 * 返回本次**新归档**的 metric id（已归档的行不会重复出现在返回值里）。
 *
 * 写成一条 UPDATE + NOT EXISTS 而不是「先查再逐行写」：淘汰是幂等的批量动作，
 * 逐行写会把「读与写之间被查了一次」的竞态带进来（虽然无害，但多一个要解释的状态）。
 */
export async function archiveStalePrivateMeasures(
  pool: Pool, org: string, days: number = PRIVATE_MEASURE_ARCHIVE_DAYS,
): Promise<string[]> {
  if (!Number.isInteger(days) || days < 1) {
    throw new Error(`archiveStalePrivateMeasures: days 必须是正整数（收到 ${String(days)}）`)
  }
  const r = await pool.query(
    `with recent as (
       select distinct metric_id
         from data.query_audit
        where org = $1
          and created_at >= now() - make_interval(days => $2::int)
          and user_id <> $3
     )
     update data.metrics m
        set archived_at = now(), updated_at = now()
      where m.org = $1
        and m.source = 'l2'
        and m.basis = 'column_agg'
        and m.archived_at is null
        -- 年龄闸：刚建出来/刚复活的行不在「30 天零使用」的定义域里。
        -- 复活锚点（035）优先于首次创建锚点：复活 = 观察窗口重新起算，否则下一次 job 立刻再归档。
        and coalesce(m.revived_at, m.created_at) <= now() - make_interval(days => $2::int)
        and not exists (select 1 from recent r where r.metric_id = m.id)
      returning m.id`,
    [org, days, REGRESSION_USER_ID],
  )
  return r.rows.map((row) => String((row as { id: unknown }).id))
}

/**
 * 归档行读面（管理面）：本 org 已归档的私有测度，按归档时间倒序。
 *
 * 为什么需要它：`loadMergedCatalog` 等消费面会滤掉 `archived_at`，管理面因此「看不见
 * 自己归档了什么」（Task 1 评审遗留：`archivedAt` 当前不可达）。这里只读，不复活——
 * 复活是写动作（重走 `POST /metrics/private`，见 metric-write.ts 的 creator 闸）。
 */
export interface ArchivedPrivateMeasure {
  id: string
  title: string
  description: string
  createdBy: string | null
  /** 建行时刻（ISO）——判断「活满 30 天」的锚。 */
  createdAt: string
  /** 归档时刻（ISO）；本读面恒非 null（只列 archived_at is not null 的行）。 */
  archivedAt: string
  /** 历史上最近一次被查（ISO）；从未用过 = null。窗口不设限（这是「曾经有没有人用」）。 */
  lastUsedAt: string | null
}

export async function listArchivedPrivateMeasures(
  pool: Pool, org: string,
): Promise<ArchivedPrivateMeasure[]> {
  const r = await pool.query(
    `select m.id, m.title, m.description, m.created_by, m.created_at, m.archived_at,
            (select max(qa.created_at) from data.query_audit qa
              where qa.org = m.org and qa.metric_id = m.id and qa.user_id <> $2) as last_used_at
       from data.metrics m
      where m.org = $1
        and m.source = 'l2'
        and m.basis = 'column_agg'
        and m.archived_at is not null
      order by m.archived_at desc, m.id`,
    [org, REGRESSION_USER_ID],
  )
  return r.rows.map((row) => {
    const x = row as Record<string, unknown>
    return {
      id: String(x.id),
      title: String(x.title),
      description: String(x.description ?? ''),
      createdBy: (x.created_by ?? null) as string | null,
      createdAt: new Date(x.created_at as string | Date).toISOString(),
      archivedAt: new Date(x.archived_at as string | Date).toISOString(),
      lastUsedAt: x.last_used_at === null || x.last_used_at === undefined
        ? null
        : new Date(x.last_used_at as string | Date).toISOString(),
    }
  })
}
