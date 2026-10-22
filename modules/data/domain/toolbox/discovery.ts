// discovery.ts —— 发现面四工具（spec §5 search/describe/sample 三行 + dataset 列）。
// 权限判定不自建：词表裁剪只走 visibleMetrics；sample 的主体过滤只走 authorizeCore（授权核心）。
// 仓库读一律 deps.wh（分析师面 = 只读池）。
import { authorizeCore, paramFaceOf, sqlQuote, visibleMetrics } from '../authz'
import type { MetricRow } from '../metric-store'
import { loadMergedCatalog } from '../metric-store'
import { watermarkSqlFor } from '../query-service'
import { SAMPLE_MAX_ROWS, type ToolImpl, type ToolImplResult, type ToolboxDeps } from './registry'

const SEARCH_LIMIT = 20
/** 数据集面不暴露的 schema（平台内部库表不属于分析师面）。 */
export const DATASET_SCHEMA_DENYLIST = ['pg_catalog', 'information_schema', 'data', 'platform']
const DATASET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/
/** 维度名 = 干净标识符（授权核心对 L1 grain 已保证；此处对**用户输入**的维度名再查一次）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const WATERMARK_RE = /^\d{4}-\d{2}-\d{2}$/

const tierOf = (m: MetricRow): 'certified' | 'custom' => (m.source === 'l1' ? 'certified' : 'custom')
const ownerOf = (m: MetricRow, org: string): string => (m.source === 'l1' ? 'data-platform' : org)
const oneLinerOf = (m: MetricRow): string => (m.description.split('\n')[0] ?? '').slice(0, 120)

const denied = (reason: string, detail: string | undefined, metricId: string): ToolImplResult => ({
  payload: { status: 'denied', reason, ...(detail !== undefined ? { detail } : {}), metricId },
  isError: true, auditMetricId: metricId, auditRowCount: null,
})

/** 可见词表（裁剪只走 visibleMetrics；requester null 的防御分支兜底 fail-closed）。 */
const visibleRows = async (deps: ToolboxDeps): Promise<MetricRow[]> => {
  if (deps.requester === null) return []
  return visibleMetrics(await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources)
}

/** 指标链路水位（声明了 freshnessRelations 才查；查不到/未声明 ⇒ undefined，未知≠编造）。 */
async function watermarkOf(
  deps: ToolboxDeps, m: MetricRow,
): Promise<{ dataThrough: string; status: string } | undefined> {
  const relations = Array.isArray(m.freshnessRelations) ? m.freshnessRelations.filter((r) => r !== '') : []
  if (m.slaDays === null || relations.length === 0) return undefined
  try {
    const r = await deps.wh(watermarkSqlFor(relations))
    const w = r.rows[0]?.[0]
    if (typeof w !== 'string' || !WATERMARK_RE.test(w)) return undefined
    // status 判据与发布面对齐表同源（query-service 的 freshnessStatusOf 同一公式）：
    // 水位 ≥ 今天-sla normal / < 且 ≥ sla-2 late / 更早 alert。slaDays null 已在上面短路。
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format((deps.now ?? (() => new Date()))())
    const dayMs = (iso: string): number => {
      const [y, m2, d] = iso.split('-').map(Number)
      return Date.UTC(y, (m2 ?? 1) - 1, d ?? 1)
    }
    const lateBy = (dayMs(today) - dayMs(w)) / 86_400_000 - (m.slaDays ?? 0)
    const status = lateBy <= 0 ? 'normal' : lateBy <= 2 ? 'late' : 'alert'
    return { dataThrough: w, status }
  } catch {
    return undefined
  }
}

export const searchImpl: ToolImpl = async (deps, args) => {
  const q = typeof args.q === 'string' && args.q !== '' ? args.q.toLowerCase() : null
  const tierFilter = args.tier === 'certified' ? 'l1' : args.tier === 'custom' ? 'l2' : null
  if (args.kind !== 'dataset') {
    const results = (await visibleRows(deps))
      .filter((m) => tierFilter === null || m.source === tierFilter)
      .filter((m) => q === null || m.id.toLowerCase().includes(q)
        || m.title.toLowerCase().includes(q) || m.description.toLowerCase().includes(q))
      .slice(0, SEARCH_LIMIT)
      .map((m) => ({ id: m.id, title: m.title, tier: tierOf(m), owner: ownerOf(m, deps.org), oneLiner: oneLinerOf(m) }))
    return { payload: { results }, isError: false, auditRowCount: null }
  }
  const r = await deps.wh('select table_schema, table_name from information_schema.tables order by table_schema, table_name')
  const results = r.rows
    .map((row) => ({ schema: String(row[0] ?? ''), name: String(row[1] ?? '') }))
    .filter((x) => !DATASET_SCHEMA_DENYLIST.includes(x.schema))
    .filter((x) => q === null || x.name.toLowerCase().includes(q))
    .slice(0, SEARCH_LIMIT)
    .map((x) => ({ id: `${x.schema}.${x.name}`, title: x.name, tier: 'raw', owner: '', oneLiner: `${x.schema} 关系` }))
  return { payload: { results }, isError: false, auditRowCount: null }
}

export const describeMetricImpl: ToolImpl = async (deps, args) => {
  const id = typeof args.id === 'string' ? args.id : ''
  const m = id === '' ? undefined : (await visibleRows(deps)).find((x) => x.id === id)
  if (m === undefined) {
    // 404 语义（spec §5：未接入源指标 = 源投影裁剪后「看不见」）——isError 供客户端可辨
    return { payload: { status: 'not_found', metricId: id }, isError: true, auditMetricId: id, auditRowCount: null }
  }
  const asOf = await watermarkOf(deps, m)
  return {
    payload: {
      status: 'ok', id, title: m.title, definition: m.description,
      grain: m.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== ''),
      params: paramFaceOf(m.params),
      owner: ownerOf(m, deps.org), tier: tierOf(m), version: m.version,
      ...(asOf !== undefined ? { asOf } : {}),
    },
    isError: false, auditMetricId: id, auditRowCount: null,
  }
}

export const describeDatasetImpl: ToolImpl = async (deps, args) => {
  const dataset = typeof args.dataset === 'string' ? args.dataset : ''
  const parts = dataset.split('.')
  if (parts.length !== 2 || !DATASET_NAME_RE.test(dataset) || DATASET_SCHEMA_DENYLIST.includes(parts[0]!)) {
    return { payload: { status: 'not_found', dataset }, isError: true, auditRowCount: null }
  }
  const [schema, table] = parts as [string, string]
  const r = await deps.wh(
    `select column_name, data_type from information_schema.columns`
    + ` where table_schema = ${sqlQuote(schema)} and table_name = ${sqlQuote(table)} order by ordinal_position`)
  const columns = r.rows.map((row) => ({ name: String(row[0] ?? ''), dataType: String(row[1] ?? '') }))
  if (columns.length === 0) return { payload: { status: 'not_found', dataset }, isError: true, auditRowCount: null }
  let freshness: { dataThrough: string } | undefined
  try {
    const w = await deps.wh(`select max(max_bizday)::text as watermark from data.load_log where status = 'ok' and relation = ${sqlQuote(table)}`)
    const v = w.rows[0]?.[0]
    if (typeof v === 'string' && WATERMARK_RE.test(v)) freshness = { dataThrough: v }
  } catch { /* 缺席：新鲜度未知（未知 ≠ 编造） */ }
  return {
    payload: { status: 'ok', dataset, org: deps.org, columns, ...(freshness !== undefined ? { freshness } : {}) },
    isError: false, auditRowCount: null,
  }
}

export const sampleDimensionValuesImpl: ToolImpl = async (deps, args) => {
  const metricId = typeof args.metricId === 'string' ? args.metricId : ''
  const dimension = typeof args.dimension === 'string' ? args.dimension : ''
  if (args.limit !== undefined && (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit <= 0)) {
    return denied('bad_param', 'invalid_limit', metricId)
  }
  const limit = Math.min(typeof args.limit === 'number' ? args.limit : SAMPLE_MAX_ROWS, SAMPLE_MAX_ROWS)
  if (deps.requester === null) return denied('unauthenticated', undefined, metricId)
  // 词表裁剪 + 主体钉死全部出自 authorizeCore：本文件不拼任何 WHERE 主语（授权核心单实现）。
  const all = await loadMergedCatalog(deps.pool, deps.org)
  const catalog = visibleMetrics(all, deps.requester, deps.adoptedSources)
  const toolArgs = typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args)
    ? args.args as Record<string, unknown> : {}
  const core = authorizeCore(catalog, deps.requester, metricId, toolArgs, all, [])
  if (!core.ok) return denied(core.reason, core.detail, metricId)
  const grain = core.metric.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== '')
  if (!grain.includes(dimension) || !IDENT_RE.test(dimension)) {
    return denied('bad_param', `unknown_dimension:${dimension}`, metricId)
  }
  const q = typeof args.q === 'string' && args.q !== '' ? `%${args.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null
  // ★ 外层别名不得与内层列名相撞（#991）。内层 select 的固定度量列名就叫 `value`
  //   （buildSelectSql 给 expression 的别名），而本查询原先把维度别名也起成 `value` ⇒
  //   `group by value` 被 PG 解析为**输入列** t.value（PG 在别名与输入列同名时优先输入列），
  //   于是维度列既不在 GROUP BY 也不在聚合里 ⇒ 真库执行必炸
  //   `column "t.<dim>" must appear in the GROUP BY clause or be used in an aggregate function`。
  //   同源次生错：`where value like '%q%'` 过滤的是**度量值**而非维度值。
  //   修法三条：①维度列一律写原名（不带别名）；②输出别名改 `dim_value`（不与内层任何列名相撞）；
  //   ③ORDER BY 用列位号（2=count desc, 1=维度 asc），彻底不与列名/别名争解析。
  const sql = `select ${dimension} as dim_value, count(*) as n from ( ${core.inner} ) t`
    + (q !== null ? ` where cast(${dimension} as text) like ${sqlQuote(q)}` : '')
    + ` group by ${dimension} order by 2 desc, 1 limit ${limit}`
  const r = await deps.wh(sql)
  // 响应保证 ≤50（spec §5「行数≤50」）：SQL LIMIT 之外响应侧再截一次（工程保护，防执行器不守约）。
  const values = r.rows.slice(0, limit).map((row) => ({ value: row[0], n: Number(row[1] ?? 0) }))
  return {
    payload: { status: 'ok', metricId, dimension, values, truncated: values.length === limit, limit },
    isError: false, auditMetricId: metricId, auditRowCount: values.length,
  }
}
