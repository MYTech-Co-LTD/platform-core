// drill.ts — 明细下钻的**唯一**执行入口（spec 2026-10-21 §2.4/§2.5/§2.6）。
// 聚合与下钻是同一组件集的两种维度子集：内层按原子粒度求组件（drill.expr），外层按请求
// 维度上卷。授权零自建：词表裁剪/拒绝链/主体钉死/参数校验全部复用 authz（与 runQuery 同链）；
// 掩码在场判定按**下钻 SQL**做（spec §2.5 细节 1）——用「换 selectSql 的合成行」复用
// effectiveMasks，不改 mask.ts 一个字。
import type { DrillBinding, DrillColumn, Requester } from './authz'
import { authorize, paramFilters, sqlQuote, visibleMetrics } from './authz'
import { maskingAuditOf, writeAudit } from './audit-store'
import { loadMergedCatalog } from './metric-store'
import { effectiveMasks, maskedSelectSql } from './mask'
import { runWarehouseSql, warehousePool, DATA_WAREHOUSE_UNCONFIGURED } from './warehouse'
import { decorateWithLabels, loadDimensionLookup } from './dimension-labels'
import { DATA_AS_OF_SQL, execWithLakeRaceRetry, formatDataAsOf, isLakeRaceError, type QueryDeps } from './query-service'

/** limit 缺省/上限（spec §2.4：默认 50，上限 500，超出**静默夹紧**）。 */
export const DETAIL_LIMIT_DEFAULT = 50
export const DETAIL_LIMIT_MAX = 500

export interface DetailArgs {
  dimensions?: string[]
  orderBy?: string
  desc?: boolean
  limit?: number
  offset?: number
}

export interface DetailOk {
  status: 'ok'; subject: string; metricId: string
  /** 本次生效的分组维度（= 原子粒度或其子集，声明序）。 */
  dimensions: string[]
  columns: string[]; rows: unknown[][]
  /** 同一 where 的 `count(*)`（**原始视图行数**，不受 limit/dimensions 影响）——「总行数」的唯一权威。 */
  rowCountTotal: number
  truncated: boolean
  /** 明细面时钟 = 查询执行时刻（直读湖，读到即当时湖的全部状态）。 */
  drill_as_of: string
  /** 聚合面时钟（物化钟）——load_log 缺账时缺席。 */
  data_as_of?: string
  /** 两钟差异的平台声明（spec §2.6：不靠模型自觉）。data_as_of 缺席时不附。 */
  clock_note?: string
  /** 口径射程行（与聚合面同规则：声明了才有）。 */
  scope_line?: string
  masking?: Record<string, string>
}
export type DetailOutcome = DetailOk
  | { status: 'denied'; metricId: string; reason: string; detail?: string }
  | { status: 'error'; metricId: string; reason: 'warehouse_unconfigured' | 'warehouse_transient' | 'warehouse_error'; detail: string }

export interface DrillPlan { sql: string; rowCountSql: string; dimensions: string[] }

/** 条件列投影（spec 2026-10-22 §2.3）：`max(<col>) as <col>`，内层与外层同形。
 * 为什么用 max 而不是裸列：外层 group by 通常比原子粒度粗，裸列会 42803（不在 GROUP BY 里）。
 * 原子粒度（缺省请求）下组内恒一行 ⇒ max = 该行原值；粗粒度下是「组内某一行的值」，
 * **不是聚合语义**（spec §5 已知边界）。 */
function columnProjection(columns: readonly DrillColumn[]): string {
  return columns.length === 0 ? '' : `, ${columns.map((c) => `max(${c.col}) as ${c.col}`).join(', ')}`
}

/** 外层上卷：内层产出原子粒度行后按请求维度 rollup + 排序分页。
 * buildDrillSql 与掩码路径共用它——外层形状只有一份（掩码只改内层投影，见 runDetailQuery）。
 * `extra` = 条件列投影串（外层也必须 max：外层 group by 通常比原子粒度粗）。 */
function rollupOver(inner: string, dims: string[], orderBy: string, desc: boolean, limit: number, offset: number, extra = ''): string {
  const d = dims.join(', ')
  return `select ${d}, sum(value) as value${extra} from ( ${inner} ) t group by ${d} order by ${orderBy} ${desc ? 'desc' : 'asc'} limit ${limit} offset ${offset}`
}

/** 两段下钻 SQL（**纯函数**）：内层原子粒度求组件、外层请求维度上卷 + 排序分页；
 * rowCountSql = 同一 where 的裸 count(*)（spec §2.4：rowCountTotal 的唯一来源）。 */
export function buildDrillSql(
  drill: DrillBinding, requested: string[], where: string,
  orderBy: string, desc: boolean, limit: number, offset: number,
  columns: readonly DrillColumn[] = [],
): DrillPlan {
  const atomic = drill.dims.join(', ')
  const extra = columnProjection(columns)
  const inner =
    `select ${atomic}, (${drill.expr}) as value${extra} from ${drill.relation} where ${where} group by ${atomic}`
  const sql = rollupOver(inner, requested, orderBy, desc, limit, offset, extra)
  const rowCountSql = `select count(*) as n from ${drill.relation} where ${where}`
  return { sql, rowCountSql, dimensions: requested }
}

export async function runDetailQuery(
  deps: QueryDeps, org: string, requester: Requester | null,
  metricId: string, args: Record<string, unknown>, detail: DetailArgs,
): Promise<DetailOutcome> {
  const audit = (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
    masking: ReturnType<typeof maskingAuditOf>,
    drillFacet: { dimensions: string[]; rowCountTotal: number; grantedColumns: string[] } | null,
  ) => writeAudit(deps.pool, {
    org, userId: requester?.userId ?? '(anonymous)', channel: requester?.channel ?? 'session',
    keyId: requester?.keyId ?? null, metricId, params: { ...args, ...(detail.dimensions !== undefined ? { dimensions: detail.dimensions } : {}) },
    rowCount, verdict, reason, masking,
    ...(drillFacet !== null ? { drill: drillFacet } : {}),
  })

  if (!requester) {
    await audit('denied', 'unauthenticated', null, null, null)
    return { status: 'denied', metricId, reason: 'unauthenticated' }
  }

  const allMetrics = await loadMergedCatalog(deps.pool, org)
  const catalog = visibleMetrics(allMetrics, requester, deps.adoptedSources)
  // authorize 只是**门**（拒绝链 + 参数校验）；它拼的聚合计划在这里被丢弃——下钻 SQL 由
  // buildDrillSql 另拼，但 where 的参数连接词必须与它同源（paramFilters，Task 1 抽取）。
  const authz = authorize(catalog, requester, metricId, args, allMetrics)
  if (!authz.ok) {
    await audit('denied', authz.reason, null, null, null)
    return { status: 'denied', metricId, reason: authz.reason, detail: authz.detail }
  }
  const metricRow = catalog.find((m) => m.id === metricId)
  const drill = metricRow?.drill
  // 能力陈述，不是权限拒绝（spec §2.6）：L2 行天然落这里（三列恒 NULL）——「Phase 1 不支持
  // L2 下钻」由存储形状涌现，无需特判。
  if (metricRow === undefined || drill === undefined) {
    await audit('denied', 'no_detail_binding', null, null, null)
    return { status: 'denied', metricId, reason: 'no_detail_binding',
      detail: '该指标未声明明细下钻（能力边界，非权限问题）——聚合口径可用 query_metric 查询' }
  }

  // bizday 必传（spec §2.4：直读湖全史 11.14s，随天数线性涨）——参数校验过了 authorize，
  // 但 aggregate 的 bizday 非必填，必填性是下钻面自己的规则。
  const biz = args.bizday
  if (biz === undefined || biz === null || biz === '') {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: 'missing_param:bizday' }
  }

  // 维度校验：缺省 = 原子粒度（声明序）；显式必须 ⊆ 闭集（不许凭空加列 = 注入面）。
  let requested = drill.dims
  if (detail.dimensions !== undefined) {
    const dims = detail.dimensions
    if (!Array.isArray(dims) || dims.length === 0) {
      await audit('denied', 'bad_param', null, null, null)
      return { status: 'denied', metricId, reason: 'bad_param', detail: 'dimensions_empty' }
    }
    for (const d of dims) {
      if (!drill.dims.includes(d)) {
        await audit('denied', 'bad_param', null, null, null)
        return { status: 'denied', metricId, reason: 'bad_param', detail: `unknown_dimension:${d}` }
      }
    }
    requested = [...dims]
  }

  // 条件列（spec 2026-10-22 §2.3）：持 `grantedBy` 才投影；无码 ⇒ 该列**不在场**（缺席，不是 NULL）。
  // 放在维度校验之后、orderBy 之前——它只影响投影，不参与权限拒绝链（拒绝链全在 authorize）。
  const granted = (drill.columns ?? []).filter((c) => requester.hasScope(c.grantedBy))
  const extra = columnProjection(granted)

  // 排序：'value'（缺省，降序——「哪几行贡献最大」是下钻的主问题）或请求维度之一。
  const orderBy = detail.orderBy ?? 'value'
  if (orderBy !== 'value' && !requested.includes(orderBy)) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: `unknown_orderby:${orderBy}` }
  }
  const desc = detail.desc ?? true
  // limit/offset：整数域校验 + 静默夹紧（spec §2.4 明文：上限超出**静默**夹紧，不报错）。
  const limitRaw = detail.limit ?? DETAIL_LIMIT_DEFAULT
  if (!Number.isInteger(limitRaw) || limitRaw <= 0) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: 'invalid_value:limit' }
  }
  const limit = Math.min(limitRaw, DETAIL_LIMIT_MAX)
  const offset = detail.offset ?? 0
  if (!Number.isInteger(offset) || offset < 0) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: 'invalid_value:offset' }
  }

  // where：主体钉死（subjectColumn 上的列，视图由 dbt 注入 org）+ 声明 filter + 参数连接词
  //（与聚合同一 paramFilters 产物；wantTotal=false ⇒ total 对下钻是未知键，fail-closed）。
  const pf = paramFilters(metricRow.params, args, false)
  if (!pf.ok) {
    await audit('denied', pf.reason, null, null, null)
    return { status: 'denied', metricId, reason: pf.reason, detail: pf.detail }
  }
  const where = `${metricRow.subjectColumn} = ${sqlQuote(authz.plan.subject)} AND ${drill.filter}${pf.filters.join('')}`

  const plan = buildDrillSql(drill, requested, where, orderBy, desc, limit, offset, granted)
  // 掩码（spec §2.5 细节 1）：在场判定按**下钻 SQL**——拿合成行（selectSql 换成投影串）复用
  // effectiveMasks，本文件不写第二份掩码判定。只掩**投影串**（value 头与列），WHERE/count
  // 不掩：Phase 1 掩码只有整值形态（value 头）；但**列掩码不再结构性不可达**——投影里含裸条件列，
  // effectiveMasks 的跨 catalog 按列传播可以命中它，语义缺口与裁决见
  // `dbt/semantics/l1_metrics.yml` 的 ⚠️ 掩码块与 issue #995。rowCountTotal 数行数，与值掩码
  // 正交。投影 value-first（dims 在后）——理由见下方
  // rollupOver 处的 ⚠️（终审 C1：mask.ts 头部替换按 value-first 形状设计）。投影串含 from
  //（整值掩码尾锚要求 value 后跟 `,` 或 `from`）。
  const projection = `select (${drill.expr}) as value, ${requested.join(', ')}${extra} from ${drill.relation}`
  const masked = maskedSelectSql(
    projection,
    effectiveMasks(allMetrics, { ...metricRow, selectSql: projection }),
    requester.hasScope,
  )
  // 外层上卷与 buildDrillSql 共用 rollupOver——外层形状只有一份（掩码只改内层投影）。
  // ⚠️ 投影必须 **value-first**（`select (<expr>) as value, <dims> from …`）：mask.ts 整值掩码
  // 的头部替换按聚合 L1 形状（value 头在前）设计，从 `select ` 后一直吃到 `as value`——
  // dims-first 会让替换吞掉维度列 ⇒ 内层只剩 `select cast(null…) as value` ⇒ 外层 42703。
  // （终审 C1，2026-10-22 实机执行 mask 函数证实。）无掩码时 masked.sql 与 buildDrillSql 的
  // inner 仅列序不同，语义等价（外层 sum 后同值）；形状逐字一致的说法只对掩码前的串成立。
  const sql = rollupOver(
    `${masked.sql} where ${where} group by ${drill.dims.join(', ')}`,
    requested, orderBy, desc, limit, offset, extra,
  )

  const execOnce = (q: string) =>
    deps.execute ? deps.execute(q) : runWarehouseSql(warehousePool(), q)
  const toError = async (err: unknown): Promise<DetailOutcome> => {
    const msg = err instanceof Error ? err.message : String(err)
    const reason =
      msg === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured'
      : isLakeRaceError(err) ? 'warehouse_transient'
      : 'warehouse_error'
    await audit('error', reason, null, null, null)
    return { status: 'error', metricId, reason, detail: msg }
  }

  let retried = false
  let rowCountTotal = 0
  let result: { columns: string[]; rows: unknown[][] }
  try {
    const r = await execWithLakeRaceRetry(() => execOnce(sql), deps.raceRetryDelayMs ?? 1_000)
    retried = r.retried
    result = r.result
    const cnt = await execWithLakeRaceRetry(() => execOnce(plan.rowCountSql), deps.raceRetryDelayMs ?? 1_000)
    // ⚠️ brief 草稿此处写 `cnt.rows[0]`——execWithLakeRaceRetry 回的是 `{ result, retried }`，
    // cnt.rows 恒 undefined ⇒ TypeError「reading '0'」（ok 路径整体 500 化）。须取 cnt.result。
    rowCountTotal = Number(cnt.result.rows[0]?.[0] ?? 0)
    // count 腿的竞态也要并入审计 reason（与 query-service「主计划 + totalSql 多处累计」同一
    // 纪律）：count 单独撞 ETag 时，ok 行若记 reason=null，spec §3.5 判「重试是否长期够用」
    // 的数据源就漏了 count 这一半。
    if (cnt.retried) retried = true
  } catch (err) {
    return await toError(err)
  }

  // 维度名称解析（与聚合面同一装饰器；失败 ⇒ 名称列缺席，主结果照常交付）。
  const lookup = await (deps.dimensionLookup
    ?? (() => loadDimensionLookup((q) => runWarehouseSql(warehousePool(), q))))()
  if (lookup !== null) result = decorateWithLabels(result, lookup)

  // 两只时钟（spec §2.6）：data_as_of = 物化钟（聚合面）；drill_as_of = 查询执行时刻（明细面
  // 直读湖）。结构上恒不一致 ⇒ 有 data_as_of 就附平台声明，不靠模型自觉。
  let dataAsOf: string | undefined
  try {
    const fresh = await runWarehouseSql(warehousePool(), DATA_AS_OF_SQL)
    if (fresh.rows[0]?.[0] instanceof Date) dataAsOf = formatDataAsOf(fresh.rows[0][0])
  } catch { /* load_log 缺席 ⇒ 缺席（未知 ≠ 捏造） */ }
  const drillAsOf = formatDataAsOf(new Date())

  const scopeNote = typeof metricRow.scopeNote === 'string' ? metricRow.scopeNote.trim() : ''
  const hasMasking = Object.keys(masked.applied).length > 0
  await audit('ok', retried ? 'lake_race_retry' : null, result.rows.length,
    maskingAuditOf(masked.applied, masked.exempted),
    { dimensions: requested, rowCountTotal, grantedColumns: granted.map((c) => c.col) })

  return {
    status: 'ok',
    subject: authz.plan.subject,
    metricId,
    dimensions: requested,
    columns: result.columns,
    rows: result.rows,
    rowCountTotal,
    truncated: result.rows.length >= limit,
    drill_as_of: drillAsOf,
    ...(dataAsOf !== undefined ? {
      data_as_of: dataAsOf,
      clock_note: `⏱ 明细直读数据湖（查询时刻 ${drillAsOf}），聚合口径截至 ${dataAsOf}——两个时钟不同，逐行相加可能与聚合值不一致，以各自标注为准`,
    } : {}),
    ...(scopeNote !== '' ? { scope_line: `📐 口径：${scopeNote}` } : {}),
    ...(hasMasking ? { masking: masked.applied } : {}),
  }
}
