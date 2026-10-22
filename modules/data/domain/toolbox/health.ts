// health.ts —— 健康面三工具（spec §5 后三行；§11 未决 #2 默认：血缘/质量读 dbt manifest）。
// 「无结论必须显式未知」（spec §5 get_quality 验收锚）：seam 缺席/坏形状一律 unknown——
// 未知 ≠ 通过 ≠ 编数字。manifest 投递链（随 data-plane.lock）未验证，待真机案例沉淀。
import { visibleMetrics } from '../authz'
import { loadMergedCatalog } from '../metric-store'
import { freshnessLineOf, freshnessStatusOf, watermarkSqlFor } from '../query-service'
import { readFileSync } from 'node:fs'
import type { ToolImpl, ToolImplResult, ToolboxDeps } from './registry'

export interface DbtManifestView {
  dependsOnOf(model: string): string[]
  childrenOf(name: string): string[]
  testCountOf(model: string): number
}

type ManifestNode = { resource_type?: string; name?: string; depends_on?: { nodes?: unknown } }

/** child_map 的 id 列表 → 模型名列表（未知 id 原样返回）。 */
function depsOfKeys(
  childMap: Map<string, string[]>, nodes: Map<string, ManifestNode>, key: string,
): string[] {
  return (childMap.get(key) ?? []).map((id) => {
    const n = nodes.get(id)?.name
    return typeof n === 'string' && n !== '' ? n : id
  })
}

export function parseDbtManifest(raw: unknown): DbtManifestView | null {
  if (typeof raw !== 'object' || raw === null) return null
  const nodesRaw = (raw as { nodes?: unknown }).nodes
  if (typeof nodesRaw !== 'object' || nodesRaw === null) return null
  const nodes = new Map<string, ManifestNode>()
  for (const [k, v] of Object.entries(nodesRaw as Record<string, unknown>)) {
    if (typeof v === 'object' && v !== null) nodes.set(k, v as ManifestNode)
  }
  const childMap = new Map<string, string[]>()
  const cm = (raw as { child_map?: unknown }).child_map
  if (typeof cm === 'object' && cm !== null) {
    for (const [k, v] of Object.entries(cm as Record<string, unknown>)) {
      if (Array.isArray(v)) childMap.set(k, v.filter((x): x is string => typeof x === 'string'))
    }
  }
  const keyOf = (name: string): string | null => {
    for (const [k, n] of nodes) if (n.name === name) return k
    return null
  }
  const depsOf = (name: string): string[] => {
    const key = keyOf(name)
    if (key === undefined || key === null) return []
    const depsRaw = nodes.get(key)?.depends_on?.nodes
    const ids = Array.isArray(depsRaw) ? depsRaw.filter((x): x is string => typeof x === 'string') : []
    // depends_on.nodes / child_map 存的是**完整节点 id**（如 model.d.stg）——映射回模型名再出；
    // 图里没有的 id 原样返回（外部图不因本视图的命名假设而被裁掉）。
    return ids.map((id) => {
      const n = nodes.get(id)?.name
      return typeof n === 'string' && n !== '' ? n : id
    })
  }
  return {
    dependsOnOf: (model) => depsOf(model),
    childrenOf: (name) => {
      const key = keyOf(name)
      return key === null ? [] : depsOfKeys(childMap, nodes, key)
    },
    testCountOf: (model) => (childMap.get(keyOf(model) ?? '') ?? [])
      .filter((k) => nodes.get(k)?.resource_type === 'test').length,
  }
}

export function defaultDbtManifest(env: Record<string, string | undefined> = process.env): () => Promise<unknown> {
  const p = env.DATA_DBT_MANIFEST_PATH?.trim()
  if (!p) return async () => null
  return async () => {
    try { return parseDbtManifest(JSON.parse(readFileSync(p, 'utf8'))) } catch { return null }
  }
}

const WATERMARK_RE = /^\d{4}-\d{2}-\d{2}$/
/** 全局水位 SQL（先按关系取最新一行再聚合——#844 同语义；metrics 级走 watermarkSqlFor）。 */
const GLOBAL_LATEST_SQL = "select distinct on (relation) relation, max_bizday, materialized_at from data.load_log where status = 'ok' and relation is not null order by relation, materialized_at desc"
const shanghaiToday = (now: () => Date): string => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(now())

const unknownOf = (reason: string, extra: Record<string, unknown> = {}): ToolImplResult => ({
  payload: { status: 'unknown', reason, ...extra }, isError: false, auditRowCount: null,
})

export const freshnessImpl: ToolImpl = async (deps, args) => {
  const now = deps.now ?? (() => new Date())
  const scope = typeof args.scope === 'string' && args.scope !== '' ? args.scope : null
  if (scope === null) {
    // 全局支：最新物化时刻（max materialized_at）+ 全量关系水位（木桶短板）
    try {
      const latest = await deps.wh(GLOBAL_LATEST_SQL)
      const marks: string[] = []
      let lastRun: Date | null = null
      for (const row of latest.rows) {
        if (typeof row[1] === 'string' && WATERMARK_RE.test(row[1])) marks.push(row[1])
        if (row[2] instanceof Date) {
          if (lastRun === null || row[2] > lastRun) lastRun = row[2]
        }
      }
      const min = [...marks].sort()[0]
      if (min === undefined) return unknownOf('no_load_log')
      const asOf: Record<string, unknown> = { scope: 'global', dataThrough: min, watermark: min }
      if (lastRun !== null) {
        asOf.lastDbtRun = lastRun
        asOf.freshnessLagSeconds = Math.max(0, Math.floor((now().getTime() - lastRun.getTime()) / 1000))
      }
      return { payload: asOf, isError: false, auditRowCount: null }
    } catch {
      return unknownOf('load_log_unavailable')
    }
  }
  // 指标支：可见词表（裁剪走 visibleMetrics）→ 链路水位 + 状态 + 固定展示行（与 query-service 同源判据）
  if (deps.requester === null) return { payload: { status: 'denied', reason: 'unauthenticated' }, isError: true, auditRowCount: null }
  const all = await loadMergedCatalog(deps.pool, deps.org)
  const m = visibleMetrics(all, deps.requester, deps.adoptedSources).find((x) => x.id === scope)
  if (m === undefined) return unknownOf('scope_not_found', { scope })
  const relations = Array.isArray(m.freshnessRelations) ? m.freshnessRelations.filter((r) => r !== '') : []
  if (m.slaDays === null || relations.length === 0) return unknownOf('no_freshness_chain', { scope })
  try {
    const r = await deps.wh(watermarkSqlFor(relations))
    const w = r.rows[0]?.[0]
    const matAt = r.rows[0]?.[1]
    if (typeof w !== 'string' || !WATERMARK_RE.test(w) || !(matAt instanceof Date)) {
      return unknownOf('watermark_unavailable', { scope })
    }
    const today = shanghaiToday(now)
    const fs = freshnessStatusOf(w, m.slaDays, today)
    return {
      payload: {
        status: 'ok', scope, dataThrough: w, watermark: w,
        freshnessLagSeconds: Math.max(0, Math.floor((now().getTime() - matAt.getTime()) / 1000)),
        lastDbtRun: matAt, freshness_status: fs, line: freshnessLineOf(fs, w, matAt, today),
      },
      isError: false, auditRowCount: null,
    }
  } catch {
    return unknownOf('watermark_unavailable', { scope })
  }
}

/** seam 读取：注入优先；缺省走 defaultDbtManifest({})——**空 env**（确定性 null），不偷读进程 env。 */
const seamOf = async (deps: ToolboxDeps): Promise<DbtManifestView | null> => {
  const load = deps.dbtManifest ?? defaultDbtManifest({})
  let raw: unknown = null
  try { raw = await load() } catch { return null }
  return raw === null ? null : parseDbtManifest(raw)
}

export const qualityImpl: ToolImpl = async (deps, args) => {
  const model = typeof args.model === 'string' && args.model !== '' ? args.model : null
  const view = await seamOf(deps)
  if (view === null) return unknownOf('dbt_manifest_unavailable')
  return {
    payload: {
      status: 'ok', ...(model !== null ? { model, testsDeclared: view.testCountOf(model) } : {}),
      note: '声明清单来自 dbt manifest；最近一次运行的结论不在本数据源内——没有结论 ≠ 通过。',
    },
    isError: false, auditRowCount: null,
  }
}

export const lineageImpl: ToolImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  const depth = args.depth === undefined ? 1 : args.depth
  if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 1 || depth > 3) {
    return { payload: { status: 'denied', reason: 'bad_param', detail: 'invalid_depth' }, isError: true, auditRowCount: null }
  }
  const view = await seamOf(deps)
  if (view === null) return unknownOf('dbt_manifest_unavailable', { id })
  const expand = (step: (name: string) => string[]): string[] => {
    let frontier = new Set([id])
    const seen = new Set([id])
    const out = new Set<string>()
    for (let i = 0; i < depth; i++) {
      const next = new Set<string>()
      for (const n of frontier) {
        for (const x of step(n)) if (!seen.has(x)) { seen.add(x); out.add(x); next.add(x) }
      }
      frontier = next
    }
    return [...out]
  }
  return {
    payload: {
      status: 'ok', id,
      upstream: expand((n) => view.dependsOnOf(n)),
      downstream: expand((n) => view.childrenOf(n)),
    },
    isError: false, auditRowCount: null,
  }
}
