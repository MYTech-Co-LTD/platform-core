// health.ts —— 体系健康五数（W5 Task 1，路线图 G7「可回溯、不黑盒」/ #1449）。
//
// 为什么是这五个数：它们回答「这套体系现在能不能信」，而且**都能从既有事实源机械算出**
// （不新增埋点、不存快照）：
//   · 实体绑定率   ← l1_metrics.yml 的 metric.entity（W4 起 100%）
//   · 对账覆盖率   ← dbt/tests 文件名按 metricToAuditFileName 映射（唯一事实源，不另写规则）
//   · 零使用指标   ← query_audit 近 30 天按 metric_id 聚合
//   · 未消解需求   ← demand_signals.dismissed_at IS NULL
//   · 口径事故数   ← metric_audit 近 90 天的变更/拒绝计数（由调用方给数）
//
// 纯函数：不做 IO，百分比四舍五入到 1 位；空集合返回 0（不产生 NaN——NaN 会让面板显示 "NaN%"）。
// 与 propose-metric.ts 同款：scripts 是 .mjs 无声明文件，唯一事实源仍是那边（不抄第二把尺）。
// @ts-expect-error TS7016: Could not find a declaration file for module '../../../../scripts/check-data-models.mjs'
import { metricToAuditFileName } from '../../../../scripts/check-data-models.mjs'

export interface HealthMetric {
  id: string
  /** `certified` | `draft`（读侧推导后的值） */
  certified: string
  /** null / '' 都算未绑定 */
  entity: string | null
  /** `l1_tree` | `column_agg` */
  basis: string
}

export interface HealthInput {
  metrics: readonly HealthMetric[]
  /** 对账测试文件名或全路径（取 basename 比对） */
  auditTests: readonly string[]
  /** metric_id → 近 30 天查询次数（缺键 = 0） */
  usage: Readonly<Record<string, number>>
  demands: readonly { kind: string; dismissedAt: string | null }[]
  /** 近 90 天口径事故计数（调用方按 metric_audit 判定后传入） */
  incidents: number
}

export interface HealthSummary {
  metricTotal: number
  entityBound: number
  entityBoundPct: number
  auditCovered: number
  auditCoveredPct: number
  zeroUse: number
  openDemands: number
  incidents: number
}

/** @param {number} n @param {number} total */
const pctOf = (n: number, total: number): number =>
  total === 0 ? 0 : Math.round((n / total) * 1000) / 10

/** @param {string} p */
const basenameOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export function healthOf(input: HealthInput): HealthSummary {
  const total = input.metrics.length
  const entityBound = input.metrics.filter((m) => (m.entity ?? '').trim() !== '').length
  const tests = new Set(input.auditTests.map(basenameOf))
  const auditCovered = input.metrics.filter((m) => tests.has(metricToAuditFileName(m.id))).length
  const zeroUse = input.metrics.filter((m) => (input.usage[m.id] ?? 0) === 0).length
  const openDemands = input.demands.filter((d) => d.dismissedAt === null).length
  return {
    metricTotal: total,
    entityBound,
    entityBoundPct: pctOf(entityBound, total),
    auditCovered,
    auditCoveredPct: pctOf(auditCovered, total),
    zeroUse,
    openDemands,
    incidents: input.incidents,
  }
}
