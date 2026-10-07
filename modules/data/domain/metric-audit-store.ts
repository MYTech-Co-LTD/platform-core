// metric-audit-store.ts — 口径变更审计（**写 + 读**）。
//
// ⚠️ 与 audit-store.ts（`data.query_audit`）的分工，别混：
//   · 那张表是**查询**审计，且**只写不读**——它的读侧＝平台运营面的全局审计视图，不在本模块
//     （见该文件头「别顺手加」）。**不许**把函数加进那个文件。
//   · 本文件是**口径变更**审计，写与读都在本模块——但读侧的范围是「**租户对自己单条口径的历史**」
//     （按 `(org, metric_id)` 限定、门 = `data:manage`），不是运营面的全局视图。
//   理由与取舍见 docs/superpowers/specs/2026-10-07-metric-attribution-design.md §4④/§4⑥。
//
// 与 `query_audit` 分表的第二个理由：两者语义（动作 vs 结果）与频度（低频治理 vs 高频问数）都不同；
// 硬塞进一张表会让 `row_count/verdict/reason` 全部变 nullable，「没有 row_count」将同时表示
// 「这是写行」与「这次查询没出数」——语义立刻模糊。
import type { Pool, PoolClient } from 'pg'
import type { Channel } from './authz'

export type MetricAction = 'create' | 'update' | 'delete'

/** 行的语义快照（前后态同一个形状；`params` 给对象，落库时 stringify）。 */
export interface MetricRowSnapshot {
  title: string
  description: string
  subjectColumn: string
  selectSql: string
  groupBy: string
  params: Record<string, unknown>
}

export interface MetricAuditEntry {
  org: string
  metricId: string
  action: MetricAction
  /** 人（不是 key）——审计的第一读者问的就是「谁」。 */
  userId: string
  channel: Channel
  keyId: number | null
  /** `create` 为 null；`delete` 时是被删的内容。 */
  before: MetricRowSnapshot | null
  /** `delete` 为 null。 */
  after: MetricRowSnapshot | null
}

export interface MetricAuditRow extends MetricAuditEntry {
  id: number
  createdAt: string
}

const snap = (s: MetricRowSnapshot | null): string | null => (s === null ? null : JSON.stringify(s))

/**
 * 写一条口径变更审计。**由 `domain/metric-write` 在同一个事务里调用**——
 * 审计与变更同生共死（spec §4①）。本函数**不自己开事务**，只用调用方给的连接：
 * 自己开事务就等于把「同生共死」这条不变量的实现散到两处。
 */
export async function writeMetricAudit(db: Pool | PoolClient, e: MetricAuditEntry): Promise<void> {
  await db.query(
    `insert into data.metric_audit
       (org, metric_id, action, user_id, channel, key_id, row_before, row_after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.org, e.metricId, e.action, e.userId, e.channel, e.keyId, snap(e.before), snap(e.after)],
  )
}

/** 某条口径的变更史，**时间倒序**（页面抽屉就按这个形状渲染）。 */
export async function listMetricAudit(
  pool: Pool, org: string, metricId: string, limit = 100,
): Promise<MetricAuditRow[]> {
  const r = await pool.query(
    `select id, org, metric_id, action, user_id, channel, key_id, row_before, row_after, created_at
       from data.metric_audit
      where org = $1 and metric_id = $2
      order by created_at desc, id desc
      limit $3`,
    [org, metricId, limit],
  )
  return r.rows.map((row) => ({
    id: Number(row.id),
    org: row.org as string,
    metricId: row.metric_id as string,
    action: row.action as MetricAction,
    userId: row.user_id as string,
    channel: row.channel as Channel,
    keyId: row.key_id === null ? null : Number(row.key_id),
    // jsonb 列由 pg **反序列化成对象**——别再 JSON.parse（那是第二个事实源，见 metric-store 的同款注记）
    before: (row.row_before ?? null) as MetricRowSnapshot | null,
    after: (row.row_after ?? null) as MetricRowSnapshot | null,
    createdAt: (row.created_at as Date).toISOString(),
  }))
}
