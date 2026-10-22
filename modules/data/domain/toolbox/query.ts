// query.ts —— 数值面：preview_query（只编译不执行）/ query_metric（完整信任信封）。
// ★ 不另起执行路径（计划决策 D6）：queryMetricImpl 调 runQuery（tool/warehouseExec/slicing 全透传），
//   掩码/审计/新鲜度/维度名称/竞态重试全部复用，信封只是包装；preview 复用同一条
//   「合并词表 → visibleMetrics → authorize」链（与 runQuery 同序），只算计划、零仓库调用。
import { createHash } from 'node:crypto'
import { authorize, MAX_QUERY_ROWS, visibleMetrics, type SlicingSpec } from '../authz'
import { loadMergedCatalog, type MetricRow } from '../metric-store'
import { runQuery, type QueryOk } from '../query-service'
import { buildEnvelope } from './envelope'
import type { ToolImpl, ToolboxDeps } from './registry'

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex')
const tierOf = (m: MetricRow): 'certified' | 'custom' => (m.source === 'l1' ? 'certified' : 'custom')
const ownerOf = (m: MetricRow, org: string): string => (m.source === 'l1' ? 'data-platform' : org)
/** selectSql 首个 `from <schema>.<name>` 的模型名（血缘 seam 的键）。 */
const modelOf = (selectSql: string): string | null => {
  const m = /from\s+[a-z_][a-z0-9_]*\.([a-z_][a-z0-9_]*)/i.exec(selectSql)
  return m?.[1] ?? null
}

/** 工具面平铺键 → SlicingSpec；filters 并入 args 由 runQuery→authorize 统一校验（保留键/类型）。 */
function slicingOf(args: Record<string, unknown>): { slicing: SlicingSpec | undefined; mergedArgs: Record<string, unknown> } {
  const rawArgs = typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args)
    ? args.args as Record<string, unknown> : {}
  const filters = typeof args.filters === 'object' && args.filters !== null && !Array.isArray(args.filters)
    ? args.filters as Record<string, unknown> : undefined
  const hasSlice = args.dimensions !== undefined || filters !== undefined || args.orderBy !== undefined
    || args.limit !== undefined || args.total !== undefined
  const slicing: SlicingSpec | undefined = hasSlice
    ? {
        ...(Array.isArray(args.dimensions) ? { dimensions: args.dimensions.filter((x): x is string => typeof x === 'string') } : {}),
        ...(filters !== undefined ? { filters } : {}),
        ...(args.orderBy !== undefined ? { orderBy: args.orderBy as SlicingSpec['orderBy'] } : {}),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
        ...(args.total !== undefined ? { total: args.total === true } : {}),
      }
    : undefined
  return { slicing, mergedArgs: { ...rawArgs, ...(filters ?? {}) } }
}

const visibleOf = async (deps: ToolboxDeps) => {
  if (deps.requester === null) return []
  return visibleMetrics(await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources)
}

export const previewImpl: ToolImpl = async (deps, args) => {
  const metricId = typeof args.metricId === 'string' ? args.metricId : ''
  const { slicing, mergedArgs } = slicingOf(args)
  if (deps.requester === null) {
    return { payload: { status: 'denied', reason: 'unauthenticated', metricId }, isError: true, auditMetricId: metricId, auditRowCount: null }
  }
  const all = await loadMergedCatalog(deps.pool, deps.org)
  const catalog = visibleMetrics(all, deps.requester, deps.adoptedSources)
  const authz = authorize(catalog, deps.requester, metricId, mergedArgs, all, slicing)
  if (!authz.ok) {
    return {
      payload: { status: 'denied', reason: authz.reason, ...(authz.detail !== undefined ? { detail: authz.detail } : {}), metricId },
      isError: true, auditMetricId: metricId, auditRowCount: null,
    }
  }
  const capMatch = /LIMIT (\d+)$/.exec(authz.plan.sql)
  return {
    payload: {
      status: 'ok', metricId, sql: authz.plan.sql, params: mergedArgs,
      estimatedRows: capMatch === null ? MAX_QUERY_ROWS : Number(capMatch[1]),
      warnings: [
        'estimatedRows 是行数上限（LIMIT 语义），不是统计估计——实际行数以 query_metric 回包为准。',
        ...(slicing !== undefined && slicing.total !== true ? ['切片后未请求 total：部分合计≠全局合计。'] : []),
      ],
      subject: authz.plan.subject,
    },
    isError: false, auditMetricId: metricId, auditRowCount: null,
  }
}

export const queryMetricImpl: ToolImpl = async (deps, args) => {
  const metricId = typeof args.metricId === 'string' ? args.metricId : ''
  const { slicing, mergedArgs } = slicingOf(args)
  const outcome = await runQuery(
    { pool: deps.pool, execute: deps.wh, warehouseExec: deps.wh, adoptedSources: deps.adoptedSources, tool: 'query_metric' },
    deps.org, deps.requester, metricId, mergedArgs, slicing,
  )
  if (outcome.status !== 'ok') {
    return { payload: outcome as unknown as Record<string, unknown>, isError: true, auditMetricId: metricId, auditRowCount: null }
  }
  const ok = outcome as QueryOk & { sql?: string }
  const metricRow = (await visibleOf(deps)).find((m) => m.id === metricId)
  const model = metricRow === undefined ? null : modelOf(metricRow.selectSql)
  let lineage: Record<string, unknown> | undefined
  if (metricRow !== undefined && model !== null) {
    // seam 缺省 = 恒 null（空 env 的 defaultDbtManifest 语义）；读失败吞成 null = lineage 缺席
    const view = await (deps.dbtManifest ?? (async () => null))().catch(() => null) as { dependsOnOf(m: string): string[] } | null
    if (view !== null) lineage = { model, upstream: view.dependsOnOf(model) }
  }
  const asOf: Record<string, unknown> = {}
  if (ok.watermark !== undefined) asOf.dataThrough = ok.watermark
  if (typeof ok.data_as_of === 'string') {
    asOf.lastDbtRun = ok.data_as_of
    const t = Date.parse(ok.data_as_of.replace(' ', 'T').replace(' ', ''))
    if (!Number.isNaN(t)) {
      asOf.freshnessLagSeconds = Math.max(0, Math.floor((((deps.now ?? (() => new Date()))().getTime()) - t) / 1000))
    }
  }
  const payload = buildEnvelope({
    ...(metricRow !== undefined ? {
      metric: {
        id: metricRow.id, version: metricRow.version,
        definitionHash: `sha256:${sha256(metricRow.selectSql + JSON.stringify(metricRow.params))}`,
        tier: tierOf(metricRow), owner: ownerOf(metricRow, deps.org), title: metricRow.title,
      },
    } : {}),
    subject: { org: ok.subject, source: metricRow?.sourceSystem ?? deps.org, adoptedSources: [...deps.adoptedSources] },
    ...(Object.keys(asOf).length > 0 ? { asOf } : {}),
    query: {
      sql: ok.sql ?? '', params: mergedArgs,
      ...(slicing?.dimensions !== undefined ? { dimensions: slicing.dimensions } : {}),
      rowLimit: MAX_QUERY_ROWS,
      ...(ok.audit !== undefined ? { queryId: `q_${ok.audit.id}` } : {}),
    },
    result: {
      columns: ok.columns, rows: ok.rows, rowCount: ok.rows.length, truncated: ok.truncated,
      ...(ok.total !== undefined ? { total: ok.total } : {}),
    },
    ...(lineage !== undefined ? { lineage } : {}),
    ...(ok.audit !== undefined ? { audit: ok.audit } : {}),
  })
  return { payload, isError: false, auditMetricId: metricId, auditRowCount: ok.rows.length }
}
