// audit-store.ts — 统一审计（三通道一张表）。
//
// 只写不读：审计的读侧（平台运营面）不在本模块，故这里没有 query 函数——别顺手加。
import type { Pool } from 'pg'
import type { Channel } from './authz'

export interface AuditEntry {
  /** 隔离键 `org`（text）= 审计里的主体值，**一列两义**（见 T1 的 001_init.sql 注记）。
   *  早期版本的独立 `orgId` 字段已并入本字段——别再加回来。 */
  org: string; userId: string; channel: Channel
  keyId: number | null; metricId: string; params: Record<string, unknown>
  rowCount: number | null; verdict: 'ok' | 'denied' | 'error'; reason: string | null
}

/**
 * 写一条审计。**每条问数都要落**（含 denied / error）——审计是失败也要留痕的地方，
 * 调用方（T4 的 runQuery）不得因为查询失败就省掉这一写。
 *
 * ⚠️ `rowCount: null` 与 `0` 是两回事：null = 没有行数可记（被拒/未执行），0 = 执行了但零行。
 *    传值时不写 `?? 0` 之类的兜底，否则两者在库里被抹平成同一个值。
 */
export async function writeAudit(pool: Pool, entry: AuditEntry): Promise<void> {
  await pool.query(
    `insert into data.query_audit
       (org, user_id, channel, key_id, metric_id, params, row_count, verdict, reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.org, entry.userId, entry.channel, entry.keyId, entry.metricId,
      // jsonb 参数位接受字符串（pg 侧 parse 成 jsonb）；显式 stringify 让线上格式不依赖驱动行为
      JSON.stringify(entry.params), entry.rowCount, entry.verdict, entry.reason,
    ],
  )
}
