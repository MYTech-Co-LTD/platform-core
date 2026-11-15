// monitor-eval.ts — 业务监控判据求值（Wave 7 V1，spec §6/§8）。
//
// 两条判据都**复用既有面**，不新写查询语义：
//   · stale  ⇒ data.metrics.freshness_relations + watermarkSqlFor（读水位，不扫湖）
//   · missing ⇒ authorize(...).plan.sql 外层包 count(*)
// 任何一环判不了 ⇒ `unknown`（**不是** missing）：水位表缺席、词表读不到、编译/执行失败
// 都是「我们不知道」，压成 missing 就是系统性误报（spec §6 明文）。
import type { Pool } from 'pg'
import type { DateRange } from './report-period'
import type { MonitorRow } from './monitor-store'
import type { MonitorOutcome } from './monitor-spec'
import { staleThresholdOf, todayOf, windowOf } from './monitor-spec'
import { authorize, type MetricDef, type Requester } from './authz'
import { loadMergedCatalog, type MetricRow } from './metric-store'
import { watermarkSqlFor, type SqlExecutor } from './query-service'

export interface PanelTarget {
  metricId: string
  args: Record<string, unknown>
}

export interface MonitorEvalDeps {
  /** 仓库只读执行器（生产 = analystPool；测试注入假执行器）。 */
  wh: SqlExecutor
  /** 平台池：读指标词表与报表 spec。 */
  pool: Pool
  /** 面板 → 指标（可注入，默认读 data.reports.spec）。 */
  resolvePanel?: (org: string, reportId: string, panelIndex: number) => Promise<PanelTarget | null>
  /** 词表加载（可注入；默认 loadMergedCatalog）。tick 按 org 复用同一份。 */
  loadCatalog?: (org: string) => Promise<MetricRow[]>
  now?: () => Date
}

/** 求值身份 = 创建者，但**只授予查询码**（监控不需要写面；spec §4.2）。 */
export function monitorRequester(org: string, createdBy: string): Requester {
  return {
    userId: createdBy,
    orgId: org,
    channel: 'pat',
    keyId: null,
    scopes: ['data:query'],
    hasScope: (code: string) => code === 'data:query',
  }
}

/** 默认面板解析：data.reports.spec.panels[panelIndex]（文本/AI 面板没有数据面 ⇒ null）。 */
export async function panelTargetOf(
  pool: Pool, org: string, reportId: string, panelIndex: number,
): Promise<PanelTarget | null> {
  const { rows } = await pool.query<{ spec: { panels?: Array<Record<string, unknown>> } | null }>(
    'select spec from data.reports where org = $1 and id = $2', [org, reportId],
  )
  const panels = rows[0]?.spec?.panels
  if (!Array.isArray(panels)) return null
  const p = panels[panelIndex]
  if (!p || typeof p !== 'object') return null
  if (p.chart === 'text' || p.chart === 'ai_text') return null
  const metricId = typeof p.metricId === 'string' ? p.metricId : ''
  if (metricId === '') return null
  const args = (p.args ?? {}) as Record<string, unknown>
  return { metricId, args }
}

function errText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.slice(0, 500)
}

/**
 * 求值一条监控。
 *
 * 顺序（spec §4 的优先级）：先 `stale`（读水位，便宜），再 `missing`（要跑指标查询，贵）。
 * 但**判据是监控自己选的**：`verdict='stale'` 的规则不做 missing 判定（反之亦然）——
 * 一条规则只回答它被创建时问的那个问题。
 */
export async function evaluateMonitor(deps: MonitorEvalDeps, m: MonitorRow): Promise<MonitorOutcome> {
  const now = (deps.now ?? (() => new Date()))()
  const window = windowOf(m, now)

  // ① 目标解析
  let metricId: string
  let extraArgs: Record<string, unknown> = {}
  try {
    if (m.targetKind === 'metric') {
      metricId = m.metricId ?? ''
      if (metricId === '') return { verdict: 'unknown', error: 'metric_id_missing', watermarkRef: null }
    } else {
      const resolve = deps.resolvePanel ?? ((o, r, i) => panelTargetOf(deps.pool, o, r, i))
      const target = m.reportId === null || m.panelIndex === null
        ? null
        : await resolve(m.org, m.reportId, m.panelIndex)
      if (target === null) return { verdict: 'unknown', error: 'panel_target_missing', watermarkRef: null }
      metricId = target.metricId
      extraArgs = target.args
    }
  } catch (err) {
    return { verdict: 'unknown', error: errText(err), watermarkRef: null }
  }

  // ② 词表（一次加载，尺寸可控；tick 按 org 共享）
  let catalog: MetricRow[]
  try {
    catalog = await (deps.loadCatalog ?? ((org) => loadMergedCatalog(deps.pool, org)))(m.org)
  } catch (err) {
    return { verdict: 'unknown', error: errText(err), watermarkRef: null }
  }
  const metric = catalog.find((r) => r.id === metricId)
  if (!metric) return { verdict: 'unknown', error: `metric_not_declared:${metricId}`, watermarkRef: null }

  // ③ stale：读水位（表缺席 / 无行 / 坏形状一律 unknown）
  if (m.verdict === 'stale') {
    const relations = metric.freshnessRelations ?? []
    if (relations.length === 0) {
      return { verdict: 'unknown', error: 'no_freshness_relations', watermarkRef: null }
    }
    try {
      const out = await deps.wh(watermarkSqlFor(relations))
      const raw = out.rows[0]?.[0]
      const watermark = typeof raw === 'string' ? raw : null
      if (watermark === null || !/^\d{4}-\d{2}-\d{2}$/.test(watermark)) {
        return { verdict: 'unknown', error: 'watermark_unavailable', watermarkRef: null }
      }
      const ref = `load_log:${relations.join(',')}`
      return watermark < staleThresholdOf(todayOf(now), m.windowDays)
        ? { verdict: 'stale', value: null, watermarkRef: ref }
        : { verdict: 'ok', watermarkRef: ref }
    } catch (err) {
      return { verdict: 'unknown', error: errText(err), watermarkRef: null }
    }
  }

  // ④ missing：跑指标查询，窗口内 0 行即 missing
  const bizday: DateRange = { from: window.start, to: window.end }
  const args: Record<string, unknown> = { ...extraArgs, ...m.filters, bizday }
  let sql: string
  try {
    // 第 5 参 = 掩码词表：监控用全量词表（与查询面同源），否则 authorize 内部遍历 catalog 会炸。
    const defs = catalog as MetricDef[]
    const auth = authorize(defs, monitorRequester(m.org, m.createdBy), metricId, args, defs)
    if (!auth.ok) return { verdict: 'unknown', error: `authz:${auth.reason}`, watermarkRef: null }
    // 外层 count：plan.sql 可能有 GROUP BY / ORDER BY，直接看 rows.length 会被 LIMIT/分组骗过。
    sql = `select count(*)::bigint as n from (${auth.plan.sql}) t`
  } catch (err) {
    return { verdict: 'unknown', error: errText(err), watermarkRef: null }
  }
  try {
    const out = await deps.wh(sql)
    const n = Number(out.rows[0]?.[0] ?? 0)
    if (!Number.isFinite(n)) return { verdict: 'unknown', error: 'bad_rowcount', watermarkRef: null }
    return n === 0
      ? { verdict: 'missing', value: 0, watermarkRef: null }
      : { verdict: 'ok', watermarkRef: null }
  } catch (err) {
    return { verdict: 'unknown', error: errText(err), watermarkRef: null }
  }
}
