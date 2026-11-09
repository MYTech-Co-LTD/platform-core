// evidence.ts —— W6 Task 1：证据包契约（纯函数，零 IO）。
//
// 为什么要有它：分析结论最贵的不是数字，是「这个数字凭什么」。证据包把四件事钉在同一个
// 对象上——**锚点**（哪条指标 / 什么参数与切片 / 算出来多少）、**SQL**（能原样复跑）、
// **数据截至**（水位，不是「现在」）、**对账**（有没有独立复算文件、状态如何）。缺一块就
// 不算证据：宁可显示「未接入 / 未知」，也不拿默认值冒充事实。
//
// 口径词汇不另造：新鲜度状态直接用 `query-service.ts` 的 `FreshnessStatus`
// （normal / late / alert / unknown），与问数面同一个词表——两套词表会在界面上打架。
import type { FreshnessStatus } from '../query-service'

/** 锚点对账容差（路线图 W6 出口判据 ①：容差 0.1%）。 */
export const ANCHOR_TOLERANCE = 0.001

export interface EvidenceAnchor {
  metricId: string
  params: Record<string, unknown>
  slicing: { dimensions?: string[]; filters?: Record<string, unknown>; limit?: number }
  /** 真实查询结果；null = 没算出来（不是 0）。 */
  value: number | null
}

export interface EvidencePack {
  anchor: EvidenceAnchor
  sql: string
  /** 人可读的 SQL（值已内联）；缺省 = sql 原文。 */
  sqlPreview: string
  /** 数据截至（水位日 `YYYY-MM-DD`）；null = 未知，不冒充最新。 */
  dataAsOf: string | null
  freshness: { status: FreshnessStatus; slaDays: number | null }
  caliber: {
    tier: 'certified' | 'draft'
    basis: 'l1_tree' | 'column_agg' | 'declared'
    certifiedBy: string | null
    version: number | null
  }
  reconcile: { auditFile: string | null; status: 'ok' | 'missing' | 'unknown' }
  generatedAt: string
}

export interface EvidenceInput {
  metricId: string
  params?: Record<string, unknown>
  slicing?: EvidenceAnchor['slicing']
  value: number | null
  sql: string
  sqlPreview?: string
  dataAsOf: string | null
  freshness: { status: FreshnessStatus; slaDays: number | null }
  caliber: EvidencePack['caliber']
  reconcile: EvidencePack['reconcile']
  now?: Date
}

/**
 * 锚点对账：`|current - baseline| / max(|baseline|, 1e-9) <= tolerance`。
 *
 * 任一侧缺失或非有限数 ⇒ **false**：对账的意义是「我复算过且对得上」，拿不到数不能算通过。
 * 基线为 0 时用 1e-9 兜底分母（避免 NaN）；此时只有「恰好相等」才通过——这是有意的严。
 */
export function anchorMatches(
  baseline: number | null | undefined,
  current: number | null | undefined,
  tolerance: number = ANCHOR_TOLERANCE,
): boolean {
  if (typeof baseline !== 'number' || typeof current !== 'number') return false
  if (!Number.isFinite(baseline) || !Number.isFinite(current)) return false
  if (!Number.isFinite(tolerance) || tolerance < 0) return false
  const diff = Math.abs(current - baseline)
  const denom = Math.max(Math.abs(baseline), 1e-9)
  return diff / denom <= tolerance
}

/** 组装证据包。`dataAsOf` 缺失时把新鲜度降为 `unknown`——没有截至时间就没有资格谈 SLA。 */
export function buildEvidencePack(input: EvidenceInput): EvidencePack {
  const dataAsOf = input.dataAsOf === '' ? null : input.dataAsOf
  return {
    anchor: {
      metricId: input.metricId,
      params: input.params ?? {},
      slicing: input.slicing ?? {},
      value: input.value,
    },
    sql: input.sql,
    sqlPreview: input.sqlPreview ?? input.sql,
    dataAsOf,
    freshness: {
      status: dataAsOf === null ? 'unknown' : input.freshness.status,
      slaDays: input.freshness.slaDays,
    },
    caliber: { ...input.caliber },
    reconcile: { ...input.reconcile },
    generatedAt: (input.now ?? new Date()).toISOString(),
  }
}
