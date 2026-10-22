// audit-store.ts — 统一审计（三通道一张表）。
//
// 只写不读：审计的读侧（平台运营面）不在本模块，故这里没有 query 函数——别顺手加。
import type { Pool } from 'pg'
import type { Channel } from './authz'

/**
 * 审计里的掩码形态（spec §4.4.1）：三种**发生的形态** + 它们的**并**。
 *
 * - `null` —— 本次无掩码生效（未声明 / 形状没命中 / 查询未执行）
 * - `{ "net_sales": "round:1000" }` —— 有列被掩
 * - `{ "__exempted__": ["net_sales"] }` —— 有列被豁免（持码看原值）
 * - 混合形 `{ "net_sales": "round:1000", "__exempted__": ["cost"] }` —— 同一次查询里
 *   一列被掩、另一列被豁免（两条声明的 `grantedBy` 不同）⇒ 两个键**同现**。
 *
 * ⚠️ **响应面 `masking` 装不下本类型**（契约是 `Record<string,string>`）——两者必须由
 *    `query-service.ts` 从同一份 `authz.plan` 在一处派生，别各写一遍（会不同尺）。
 */
export type MaskingAudit = Record<string, string | string[]>

/** 审计掩码值的**唯一构造点**（纯函数，可脱库单测）。 */
export function maskingAuditOf(applied: Record<string, string>, exempted: string[]): MaskingAudit | null {
  if (Object.keys(applied).length === 0 && exempted.length === 0) return null
  return { ...applied, ...(exempted.length > 0 ? { __exempted__: [...exempted].sort() } : {}) }
}

export interface AuditEntry {
  /** 隔离键 `org`（text）= 审计里的主体值，**一列两义**（见 T1 的 001_init.sql 注记）。
   *  早期版本的独立 `orgId` 字段已并入本字段——别再加回来。 */
  org: string; userId: string; channel: Channel
  keyId: number | null; metricId: string; params: Record<string, unknown>
  rowCount: number | null; verdict: 'ok' | 'denied' | 'error'; reason: string | null
  /** 本次查询**实际生效**的值级掩码（spec §4.4 / §4.4.1 三态，T7 #823）：见 `MaskingAudit`。
   *  ⚠️ `null` 与 `{}` 是两回事（同 `rowCount: null ≠ 0`）：null = 本次没有任何掩码生效
   *  （指标未声明掩码 / 形状没命中 / 查询未执行），`{}` 在本设计里**不该出现**
   *  ——判据空时调用方传 null，别传空对象。审计要能回答「看到的是原值还是掩码值」：
   *  「有列被豁免」与「压根没声明掩码」都必须可区分（前者记 `__exempted__`）。 */
  masking: MaskingAudit | null
  /** 下钻面（spec 2026-10-21 §2.5 / 2026-10-22 §2.3）：粒度、总数与**本次实际展示的条件列**。
   *  `grantedColumns` 恒在场（空数组 = 未展示）——审计要能回答「哪次查询把价格列给出去了」。
   *  聚合审计为 null。 */
  drill?: { dimensions: string[]; rowCountTotal: number; grantedColumns: string[] } | null
  /**
   * 触发本条审计的 MCP 工具名（spec 2026-10-21 §8）。可空：
   *   · 分析师面 11 工具 / legacy 指标工具（/mcp）恒写工具名；
   *   · HTTP /query、chat 等无工具通路缺省（列落 null）。
   */
  tool?: string | null
}

/**
 * 写一条审计。**每条问数都要落**（含 denied / error）——审计是失败也要留痕的地方，
 * 调用方（T4 的 runQuery）不得因为查询失败就省掉这一写。
 *
 * ⚠️ `rowCount: null` 与 `0` 是两回事：null = 没有行数可记（被拒/未执行），0 = 执行了但零行。
 *    传值时不写 `?? 0` 之类的兜底，否则两者在库里被抹平成同一个值。
 */
export async function writeAudit(pool: Pool, entry: AuditEntry): Promise<{ id: number; createdAt: Date }> {
  const r = await pool.query(
    `insert into data.query_audit
       (org, user_id, channel, key_id, metric_id, params, row_count, verdict, reason, masking, drill, tool)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
     returning id, created_at`,
    [
      entry.org, entry.userId, entry.channel, entry.keyId, entry.metricId,
      // jsonb 参数位接受字符串（pg 侧 parse 成 jsonb）；显式 stringify 让线上格式不依赖驱动行为。
      // masking 的 null 必须原样落 NULL（不是 'null'::jsonb、更不能是 '{}'）——见字段注记。
      JSON.stringify(entry.params), entry.rowCount, entry.verdict, entry.reason,
      entry.masking === null ? null : JSON.stringify(entry.masking),
      entry.drill === undefined || entry.drill === null ? null : JSON.stringify(entry.drill),
      entry.tool ?? null,
    ],
  )
  // 信封的 audit 节要用（spec 2026-10-21 §4：回包可独立核对审计行）；既有调用方不消费返回值。
  return { id: Number(r.rows[0].id), createdAt: r.rows[0].created_at as Date }
}
