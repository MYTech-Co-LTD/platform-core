// classify.ts —— 四类需求的**纯判定**：零 IO、零阈值、零 NLP。
// target 必须跨轮稳定（它是表唯一键的一部分）：audit 行取 metric_id；hunt 取 `会话|时间窗`。
import type { DemandKind } from './store'

export interface AuditRow { id: number | string; metric_id: string; reason: string | null; params: unknown }
export interface ConvRow { session_id: string; seq: number | string; tool_name: string | null; tool_args: string | null }
export interface DemandDraft {
  kind: DemandKind; target: string
  detail: Record<string, unknown>; evidence: unknown[]
}

/**
 * 测试探针前缀（实测 4 条假需求混在生产数据里，2026-11-05）。
 * `w1:test` 不带尾分隔符：真实探针 id 是 `w1:test:by_branch`（W1 回归夹具），
 * 设计文档里写成 `w1:test-` 是记号笔误；不带尾字符才能同时覆盖 `-` / `:` 两种写法。
 */
const PROBE_PREFIXES = ['verify-', 'mcp-probe-', 'w1:test', 'test-'] as const

export const isProbeTarget = (t: string): boolean => {
  const s = t.trim().toLowerCase()
  return PROBE_PREFIXES.some((p) => s.startsWith(p))
}

const segments = (id: string): string[] => id.split(':').filter((s) => s !== '')
const lastSegment = (id: string): string => segments(id).pop() ?? id

const dimsOf = (params: unknown): string[] => {
  if (params === null || typeof params !== 'object') return []
  const d = (params as Record<string, unknown>).dimensions
  return Array.isArray(d) ? d.map(String) : []
}

/**
 * 一行审计 → 一条需求（或 null）。
 * - `metric_not_declared` + 请求不足三段 + 末段命中词表 ⇒ `alias_gap`（补 synonyms）
 * - `metric_not_declared` 其余 ⇒ `new_metric`（三段齐全却无精确匹配 = 用户指定了域，末段撞名不算别名）
 * - `no_detail_binding` ⇒ `drill_gap`（该指标未声明下钻绑定）
 * - 其它 reason 不产出（bad_param/tool_error/warehouse_error 归 #741 撞墙回路）
 */
export function classifyAudit(row: AuditRow, catalogIds: readonly string[]): DemandDraft | null {
  const target = String(row.metric_id ?? '').trim()
  if (target === '' || isProbeTarget(target)) return null
  const evidence = [{ auditId: row.id, reason: row.reason, params: row.params ?? {} }]

  if (row.reason === 'metric_not_declared') {
    const matched = segments(target).length < 3
      ? catalogIds.find((id) => lastSegment(id) === lastSegment(target))
      : undefined
    return matched === undefined
      ? { kind: 'new_metric', target, detail: {}, evidence }
      : { kind: 'alias_gap', target, detail: { matchedMetricId: matched }, evidence }
  }
  if (row.reason === 'no_detail_binding') {
    return { kind: 'drill_gap', target, detail: { dimensions: dimsOf(row.params) }, evidence }
  }
  return null
}

/**
 * 会话口径寻路：同一会话 + 同一 bizday 时间窗出现 ≥2 个不同 `metricId` ⇒ 该问题在词表里
 * **没有唯一答案**。这是结构判据（≥2），不是频次阈值——9 个会话下没有可校准阈值的案例。
 */
export function huntFromConvs(
  rows: readonly ConvRow[],
  stuckBySession: ReadonlyMap<string, unknown[]>,
): DemandDraft[] {
  const seen = new Set<string>()
  const groups = new Map<string, { session: string; window: string; metrics: Set<string> }>()
  for (const r of rows) {
    const key = `${r.session_id}#${String(r.seq)}`
    if (seen.has(key)) continue   // conv 里同一 (session_id, seq) 有 call/result 两行
    seen.add(key)
    if (r.tool_name !== 'query_data' || r.tool_args === null) continue
    let parsed: unknown
    try { parsed = JSON.parse(r.tool_args) } catch { continue }
    const p = parsed as { metricId?: unknown; args?: { bizday?: { from?: unknown; to?: unknown } } }
    const metricId = typeof p?.metricId === 'string' ? p.metricId : null
    const from = typeof p?.args?.bizday?.from === 'string' ? p.args.bizday.from : null
    const to = typeof p?.args?.bizday?.to === 'string' ? p.args.bizday.to : null
    if (metricId === null || from === null || to === null || isProbeTarget(metricId)) continue
    const gk = `${r.session_id}|${from}..${to}`
    const g = groups.get(gk) ?? { session: r.session_id, window: `${from}..${to}`, metrics: new Set<string>() }
    g.metrics.add(metricId)
    groups.set(gk, g)
  }
  const out: DemandDraft[] = []
  for (const [gk, g] of groups) {
    if (g.metrics.size < 2) continue
    out.push({
      kind: 'metric_hunt', target: gk,
      detail: { sessionId: g.session, bizday: g.window, metricIds: [...g.metrics].sort() },
      evidence: stuckBySession.get(g.session) ?? [],
    })
  }
  return out
}
