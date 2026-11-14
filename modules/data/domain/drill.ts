// drill.ts — 明细下钻的**唯一**执行入口（spec 2026-10-21 §2.4/§2.5/§2.6）。
// 聚合与下钻是同一组件集的两种维度子集：内层按原子粒度求组件（drill.expr），外层按请求
// 维度上卷。授权零自建：词表裁剪/拒绝链/主体钉死/参数校验全部复用 authz（与 runQuery 同链）；
// 掩码在场判定按**下钻 SQL**做（spec §2.5 细节 1）——用「换 selectSql 的合成行」复用
// effectiveMasks，不改 mask.ts 一个字。
import type { DrillBinding, DrillColumn, Requester } from './authz'
import { authorize, dimensionFilterFragments, paramFilters, sqlQuote, visibleMetrics } from './authz'
import { maskingAuditOf, writeAudit, type ScopeAudit } from './audit-store'
import { deptContextIfOwned } from './metric-visibility'
import { loadMergedCatalog } from './metric-store'
import { effectiveMasks, maskedSelectSql } from './mask'
import { analystPool, runWarehouseSql, DATA_WAREHOUSE_UNCONFIGURED } from './warehouse'
import { decorateWithLabels, loadDimensionLookup } from './dimension-labels'
import { DATA_AS_OF_SQL, execWithLakeRaceRetry, formatDataAsOf, isLakeRaceError, type QueryDeps } from './query-service'
import { detailProvenance, type DetailProvenance } from './provenance'
import { cacheGet, cacheKey, cacheSet } from './result-cache'
import { DetailGateBusyError, detailGate } from './detail-gate'
import { dataVersionOf } from './data-version'
import { buildScopePlan, loadEffectiveScopes, scopeModeOf, type DataScopePlan } from './scope'

// 兼容旧导入：DetailProvenance 已迁到 provenance.ts（共享来源类型）。
export type { DetailProvenance } from './provenance'

/** limit 缺省/上限（spec §2.4：默认 50，上限 500，超出**静默夹紧**）。 */
export const DETAIL_LIMIT_DEFAULT = 50
export const DETAIL_LIMIT_MAX = 500

export interface DetailArgs {
  dimensions?: string[]
  orderBy?: string
  desc?: boolean
  limit?: number
  offset?: number
  /**
   * 维度等值/IN 过滤（R3 可折叠明细：展开行时定位该行所属分组）。
   * 键必须 ⊆ 本指标的下钻原子粒度（`drill.dims`）；校验与渲染与切片 filters **同一实现**
   * （`dimensionFilterFragments`），本面不另写一份判据。
   */
  filters?: Record<string, unknown>
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
  /** 结果来源（S0）：关系 / 原子粒度键 / 时钟 / 审计行。 */
  provenance: DetailProvenance
}
export type DetailOutcome = DetailOk
  | { status: 'denied'; metricId: string; reason: string; detail?: string; alternative?: { tool: string; args: Record<string, unknown> } }
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


// ── 月感知服务视图（#1916 P2）─────────────────────────────────────────────────────
// 为什么需要：月文件按 `month=` 分区，过滤 `bizday` **用不上分区裁剪**（bizday 是数据列），
// glob `month=*` 会把 52 个月文件全打开（实测 30 天 3.5s）；带上 `month between` 只开 1–2 个
// （实测 600ms）。本函数把「请求的 bizday 范围」翻译成「服务关系 + month 谓词」。
//
// 边界（有意收窄，fail-open 回主视图）：范围缺失/形状不对/跨月数 >MAX_MONTHS ⇒ 原样返回主视图。
// 事项：服务视图与主视图的等价性由 dbt 测试 `assert_serving_view_matches_main` 逐日对账。
export const MONTH_SERVING_VIEW = 'vw_lemeng_retail_order_line_month'
export const MONTH_HISTORY_VIEW = 'vw_lemeng_retail_order_line_month_history'
const MONTH_SERVING_MAX_MONTHS = 5
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** `YYYY-MM-DD` → `YYYY-MM`（纯字符串切片；调用方已校验形状）。 */
function ymOf(day: string): string {
  return day.slice(0, 7)
}

/** 闭区间内跨越的月份数（含首尾）。 */
export function monthsSpanned(from: string, to: string): number {
  const fy = Number(from.slice(0, 4)); const fm = Number(from.slice(5, 7))
  const ty = Number(to.slice(0, 4)); const tm = Number(to.slice(5, 7))
  return (ty - fy) * 12 + (tm - fm) + 1
}

/**
 * 选择下钻关系：范围可换算且跨度 ≤5 个月 ⇒ 用月感知服务视图并附带 `month` 谓词；
 * 否则原样返回（主视图，任何谓词都正确，只是慢）。
 *
 * @param relation 目录里声明的下钻关系（一般 = `vw_lemeng_retail_order_line`）
 * @param bizday   `args.bizday` 的原始值（`date_range` 形状 `{from,to}` 才认）
 */
export function servingRelationFor(
  relation: string,
  bizday: unknown,
  today: string = shanghaiToday(),
): { relation: string; monthFilter: string } {
  const noop = { relation, monthFilter: '' }
  if (relation !== 'vw_lemeng_retail_order_line') return noop
  if (typeof bizday !== 'object' || bizday === null) return noop
  const from = (bizday as { from?: unknown }).from
  const to = (bizday as { to?: unknown }).to
  if (typeof from !== 'string' || typeof to !== 'string') return noop
  if (!ISO_DAY.test(from) || !ISO_DAY.test(to)) return noop
  if (from > to) return noop
  if (monthsSpanned(from, to) > MONTH_SERVING_MAX_MONTHS) return noop
  // 历史范围（to <= 上海今天−2）⇒ 用**只有月文件腿**的视图：省掉热腿/UNION/anti-join
  // （实测 30 天 1.12s → ~0.55s）。边界取 −2 而不是 −1：热腿覆盖今天+昨天，GC 在 2 天后
  // 才删小时文件；to=今天−2 时该日的月文件必已由每日 04:10 的合并重建（积压 >2 天有测试判红）。
  // 值只来自已校验的 ISO 日期 ⇒ 拼接安全（与 paramFilters 同源校验）。
  const historical = to <= addDays(today, -2)
  return {
    relation: historical ? MONTH_HISTORY_VIEW : MONTH_SERVING_VIEW,
    monthFilter: ` AND month BETWEEN '${ymOf(from)}' AND '${ymOf(to)}'`,
  }
}

/** 上海今天（`YYYY-MM-DD`）。下钻按上海业务日判定「历史范围」。 */
export function shanghaiToday(now: Date = new Date()): string {
  // en-CA 的 short 形就是 YYYY-MM-DD；显式给时区，避免服务器时区影响判定。
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** `YYYY-MM-DD` 加减天数（纯 UTC 运算，日期串不受时区影响）。 */
export function addDays(day: string, delta: number): string {
  const t = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
  const d = new Date(t + delta * 86400_000)
  return d.toISOString().slice(0, 10)
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
  // 数据范围判定结果（#1957）：null = 未发生（off/管理员/未认证）。
  let scopeAudit: ScopeAudit | null = null
  const audit = (
    verdict: 'ok' | 'denied' | 'error', reason: string | null, rowCount: number | null,
    masking: ReturnType<typeof maskingAuditOf>,
    drillFacet: { dimensions: string[]; rowCountTotal: number; grantedColumns: string[] } | null,
  ) => writeAudit(deps.pool, {
    org, userId: requester?.userId ?? '(anonymous)', channel: requester?.channel ?? 'session',
    keyId: requester?.keyId ?? null, metricId,
    params: {
      ...args,
      ...(detail.dimensions !== undefined ? { dimensions: detail.dimensions } : {}),
      // 展开行过滤也留痕：事后追溯「这条明细是看哪个分组拉出来的」不能靠猜。
      ...(detail.filters !== undefined ? { filters: detail.filters } : {}),
    },
    rowCount, verdict, reason, masking,
    ...(drillFacet !== null ? { drill: drillFacet } : {}),
    scopePlan: scopeAudit,
    scopeDenial: scopeAudit?.denial ?? null,
  })

  if (!requester) {
    await audit('denied', 'unauthenticated', null, null, null)
    return { status: 'denied', metricId, reason: 'unauthenticated' }
  }

  const allMetrics = await loadMergedCatalog(deps.pool, org)
  // 部门可见（P2 Task 4 接线）：与 runQuery **同一守卫**（deptContextIfOwned）——明细面不得
  // 比聚合面多看一行（「聚合看不到、明细看得到」是 #1957 修过的同一类绕过面）。
  const deptCtx = await deptContextIfOwned(deps.pool, requester.tenantId, requester, allMetrics)
  const catalog = visibleMetrics(allMetrics, requester, deps.adoptedSources, deptCtx)
  // 数据范围门（#1957）：与 runQuery **同一实现**（`buildScopePlan`），否则 enforce 下会出现
  // 「聚合看不到、明细看得到」的绕过面。off 不裁；shadow 只记录；enforce 传入 authorize。
  const scopeMode = scopeModeOf(process.env)
  let scopePlan: DataScopePlan | undefined
  if (scopeMode !== 'off') {
    const metric = catalog.find((m) => m.id === metricId)
    if (metric !== undefined) {
      try {
        const effective = await loadEffectiveScopes(deps.pool, org, requester)
        const plan = buildScopePlan(metric, effective, org, requester, scopeMode)
        scopeAudit = { mode: scopeMode, applied: plan.applied, filters: [...plan.filters], denial: plan.denial }
        if (scopeMode === 'shadow') {
          console.warn(JSON.stringify({
            event: 'data_scope_shadow', org, userId: requester.userId, metricId,
            filters: plan.filters, denial: plan.denial, applied: plan.applied,
          }))
        } else {
          scopePlan = plan
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        if (scopeMode === 'enforce') {
          await audit('denied', 'range_denied:scope_unavailable', null, null, null)
          return { status: 'denied', metricId, reason: 'range_denied', detail: 'scope_unavailable' }
        }
        console.warn(JSON.stringify({ event: 'data_scope_unavailable', org, metricId, error: detail }))
      }
    }
  }
  // authorize 只是**门**（拒绝链 + 参数校验）；它拼的聚合计划在这里被丢弃——下钻 SQL 由
  // buildDrillSql 另拼，但 where 的参数连接词必须与它同源（paramFilters，Task 1 抽取）。
  const authz = authorize(catalog, requester, metricId, args, allMetrics, undefined, scopePlan)
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
    // 替代路径（2026-11-09）：明细不可用不等于 Top-N 不可用——把聚合面的切片写法直接给模型，
    // 免得它拉全量行自己排序（yangwei 采购 Top5 的真实轨迹）。
    // 默认取一个**业务维度**（去掉日期与账套这类分组元维）——「按供应商 Top5」直接可用；
    // 模型也可按问题换/删（alternative 是提示，不是强制）。
    const sliceDims = (metricRow?.groupBy ?? '').split(',').map((d) => d.trim())
      .filter((d) => d !== '' && d !== 'bizday' && d !== 'system_book')
    return {
      status: 'denied', metricId, reason: 'no_detail_binding',
      detail: '该指标未声明明细下钻（能力边界，非权限问题）——聚合口径可用 query_metric 查询',
      ...(sliceDims.length > 0 ? {
        alternative: {
          tool: 'query_data',
          args: { ...args, dimensions: [sliceDims[0]!], orderBy: [{ column: 'value', dir: 'desc' }], limit: 5 },
        },
      } : {}),
    }
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
  // #995（Phase 2 终审 deferred-Important）：条件列被**列级掩码**命中 ⇒ 整列缺席（与上行「缺席 ≠ NULL」
  // 同一语义）。旧行为两向皆坏：裸列名形态会被 maskedSelectSql 换成 max(cast(null as numeric))
  // （列在场、整列 NULL、静默——模型会把 NULL 答成「这行没值」）；限定名形态不命中（fail-open，明文照出）。
  // 判定直接问 catalog：存在 `column === 本列` 的列级掩码声明即视为命中（掩码声明的是列级意图，
  // 与投影里裸名/限定名的写法无关）；请求者持声明的 `grantedBy` ⇒ 豁免方向照旧（看原值，全持才留）。
  // 剔除后投影里根本没有该列 ⇒ maskedSelectSql 结构性够不着它（探针/替换两向缺口同时消灭）。
  const maskedOutColumns: string[] = []
  const effectiveGranted = granted.filter((c) => {
    const hits = allMetrics.flatMap((m) => m.masks ?? []).filter((s) => s.column === c.col)
    if (hits.length === 0 || hits.every((s) => requester.hasScope(s.grantedBy))) return true
    maskedOutColumns.push(c.col)
    return false
  })
  const extra = columnProjection(effectiveGranted)

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
  // 维度等值过滤（R3 可折叠明细）：与切片 filters 同一渲染器、同一注入面收口。
  // 允许集 = **下钻原子粒度**（不是指标粒度）：明细面的 where 作用在 drill.relation 上，
  // 只有 drill.dims 里的列在这里有意义；未知键 fail-closed，不静默丢弃。
  const df = dimensionFilterFragments(drill.dims, detail.filters ?? {})
  if (!df.ok) {
    await audit('denied', 'bad_param', null, null, null)
    return { status: 'denied', metricId, reason: 'bad_param', detail: df.detail }
  }
  const where = `${metricRow.subjectColumn} = ${sqlQuote(authz.plan.subject)} AND ${drill.filter}${pf.filters.join('')}${df.fragments.join('')}`

  // 月感知服务视图：范围可换算 ⇒ 换关系 + 附 month 谓词（分区裁剪）；否则原样。
  const serving = servingRelationFor(drill.relation, args.bizday)
  const drillEff = serving.relation === drill.relation ? drill : { ...drill, relation: serving.relation }
  const whereEff = where + serving.monthFilter
  const plan = buildDrillSql(drillEff, requested, whereEff, orderBy, desc, limit, offset, effectiveGranted)
  // 掩码（spec §2.5 细节 1）：在场判定按**下钻 SQL**——拿合成行（selectSql 换成投影串）复用
  // effectiveMasks，本文件不写第二份掩码判定。只掩**投影串**（value 头与列），WHERE/count
  // 不掩：Phase 1 掩码只有整值形态（value 头）；但**列掩码不再结构性不可达**——投影里含裸条件列，
  // effectiveMasks 的跨 catalog 按列传播可以命中它，语义缺口与裁决见
  // `dbt/semantics/l1_metrics.yml` 的 ⚠️ 掩码块与 issue #995。rowCountTotal 数行数，与值掩码
  // 正交。投影 value-first（dims 在后）——理由见下方
  // rollupOver 处的 ⚠️（终审 C1：mask.ts 头部替换按 value-first 形状设计）。投影串含 from
  //（整值掩码尾锚要求 value 后跟 `,` 或 `from`）。
  const projection = `select (${drill.expr}) as value, ${requested.join(', ')}${extra} from ${drillEff.relation}`
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
    `${masked.sql} where ${whereEff} group by ${drill.dims.join(', ')}`,
    requested, orderBy, desc, limit, offset, extra,
  )

  // 明细执行走**分析师只读池**（`analystPool`：每条连接先 `set default_transaction_read_only=on`）。
  // 2026-11-12 卫生项：此前这里（以及 dataVersion / 维度 lookup / DATA_AS_OF 三处辅助读）走的是
  // 可写池 `warehousePool()` —— 明细面是纯读面，没有任何理由持有可写连接；写池留给 dbt 物化。
  // 池配置（max/timeout）两者同源（`warehousePoolConfig`），换池不改变并发预算。
  const execOnce = (q: string) =>
    deps.execute ? deps.execute(q) : runWarehouseSql(analystPool(), q)
  const toError = async (err: unknown): Promise<DetailOutcome> => {
    const msg = err instanceof Error ? err.message : String(err)
    const reason =
      msg === DATA_WAREHOUSE_UNCONFIGURED ? 'warehouse_unconfigured'
      : isLakeRaceError(err) ? 'warehouse_transient'
      : 'warehouse_error'
    await audit('error', reason, null, null, null)
    return { status: 'error', metricId, reason, detail: msg }
  }

  // 结果缓存（#1945 后续）：键 = 最终 SQL 的 sha256（含 org/掩码/月份谓词/分页）。
  // ⚠️ 只在**生产执行器**上启用：测试注入 `deps.execute` 时不缓存，保证调用次数断言确定。
  const cacheable = deps.execute === undefined
  // 数据版本进键（#1953）：封版/月文件重建后键立即变化，不会在 TTL 窗口里返回旧数。
  // 版本查询自身有 5s 进程内缓存，失败退化为 ''（等价于没有版本戳，不阻断）。
  const ver = cacheable
    ? await dataVersionOf(analystPool()).catch(() => '')
    : ''
  const cacheK = cacheable ? cacheKey(sql, plan.rowCountSql, ver) : ''
  const cached = cacheable ? cacheGet(cacheK) : null

  /** 执行主计划 + count；成功则写缓存。返回统一形状，便于缓存命中走同一路径。 */
  const execAll = async (): Promise<{
    result: { columns: string[]; rows: unknown[][] }
    rowCountTotal: number
    retried: boolean
  }> => {
    const r = await execWithLakeRaceRetry(() => execOnce(sql), deps.raceRetryDelayMs ?? 1_000)
    let retried = r.retried
    const cnt = await execWithLakeRaceRetry(() => execOnce(plan.rowCountSql), deps.raceRetryDelayMs ?? 1_000)
    if (cnt.retried) retried = true
    const rowCountTotal = Number(cnt.result.rows[0]?.[0] ?? 0)
    const out = { result: r.result, rowCountTotal, retried }
    if (cacheable) cacheSet(cacheK, { columns: r.result.columns, rows: r.result.rows, rowCountTotal, retried })
    return out
  }

  let outcome: { result: { columns: string[]; rows: unknown[][] }; rowCountTotal: number; retried: boolean }
  if (cached !== null) {
    outcome = {
      result: { columns: cached.columns, rows: cached.rows },
      rowCountTotal: cached.rowCountTotal,
      retried: cached.retried,
    }
  } else {
    // 并发准入门（#1951）：明细是最吃 DuckDB 内存的一类查询；超预算宁可快速失败（可重试），
    // 也不把 pg_duckdb 推过 mem_limit 让 backend 被 OOM kill。缓存命中不占名额（不执行）。
    let release: (() => void) | null = null
    try {
      release = await detailGate().acquire()
      outcome = await execAll()
    } catch (err) {
      if (err instanceof DetailGateBusyError) {
        await audit('error', 'warehouse_transient', null, null, null)
        return { status: 'error', metricId, reason: 'warehouse_transient', detail: 'warehouse_busy' }
      }
      return await toError(err)
    } finally {
      release?.()
    }
  }
  let { retried, rowCountTotal } = outcome
  let result = outcome.result

  // 维度名称解析（与聚合面同一装饰器；失败 ⇒ 名称列缺席，主结果照常交付）。
  const lookup = await (deps.dimensionLookup
    ?? (() => loadDimensionLookup((q) => runWarehouseSql(analystPool(), q))))()
  if (lookup !== null) result = decorateWithLabels(result, lookup)

  // 两只时钟（spec §2.6）：data_as_of = 物化钟（聚合面）；drill_as_of = 查询执行时刻（明细面
  // 直读湖）。结构上恒不一致 ⇒ 有 data_as_of 就附平台声明，不靠模型自觉。
  let dataAsOf: string | undefined
  try {
    const fresh = await runWarehouseSql(analystPool(), DATA_AS_OF_SQL)
    if (fresh.rows[0]?.[0] instanceof Date) dataAsOf = formatDataAsOf(fresh.rows[0][0])
  } catch { /* load_log 缺席 ⇒ 缺席（未知 ≠ 捏造） */ }
  const drillAsOf = formatDataAsOf(new Date())

  const scopeNote = typeof metricRow.scopeNote === 'string' ? metricRow.scopeNote.trim() : ''
  const hasMasking = Object.keys(masked.applied).length > 0
  const okAudit = await audit('ok', retried ? 'lake_race_retry' : null, result.rows.length,
    maskingAuditOf(masked.applied, masked.exempted),
    { dimensions: requested, rowCountTotal, grantedColumns: effectiveGranted.map((c) => c.col),
      ...(maskedOutColumns.length > 0 ? { maskedOutColumns } : {}) })

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
    provenance: detailProvenance({
      relation: serving.relation,
      keyColumns: [...drill.dims],
      groupedBy: [...requested],
      rowCountTotal,
      drillAsOf,
      ...(dataAsOf !== undefined ? { dataAsOf } : {}),
      auditId: okAudit.id,
    }),
    ...(dataAsOf !== undefined ? {
      data_as_of: dataAsOf,
      clock_note: `⏱ 明细直读数据湖（查询时刻 ${drillAsOf}），聚合口径截至 ${dataAsOf}——两个时钟不同，逐行相加可能与聚合值不一致，以各自标注为准`,
    } : {}),
    ...(scopeNote !== '' ? { scope_line: `📐 口径：${scopeNote}` } : {}),
    ...(hasMasking ? { masking: masked.applied } : {}),
  }
}
