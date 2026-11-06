// private-measure.ts — 私有测度档（W2，`basis='column_agg'`）的白名单与三道 fail-closed 闸。
//
// 私有测度 = **基于源数据实际列的单列聚合**（B11：无复合表达式、无 join）。写入期由
// `semantic-compiler.compileColumnAgg` 编译成与 L1 同形的 select_sql ⇒ 运行期零新路径。
// 本文件的职责是**写入前的准入判定**：编译本身是纯的（semantic-compiler），
// 这里负责需要 DB 的两件事——白名单与「实际列」。
//
// ── 三道闸（fail-closed，返回带 code 的判别式结果，**不抛**）─────────────────────────
//   ① relation ∈ L1 已用 marts：由 L1 树形行的 select_sql 用**同一份** `parseL1Select`
//      反解关系集合。每次调用现算（不跨请求缓存）——L1 撤掉一条关系后必须立刻不可用，
//      缓存会让「已撤销的 mart」在进程生命周期内继续可写。
//   ② column ∈ 该 relation 的**实际列**（`information_schema.columns`，不是契约列——
//      实测契约列与 mart 列只重合约一半，spec §0.5 A3）。聚合函数决定类型约束：
//      sum/avg/min/max 要求数值列，count/count_distinct 不限。
//      ★ measure 列**不得命中任何值级掩码**（`MEASURE_MASKED`）：编译产物用裸列名
//        （`sum(cost)`），而运行期 `maskedSelectSql` 按**限定名逐字**匹配（声明是
//        `fct_x.cost`）⇒ 编译产物命中不了 ⇒ 聚合会绕过值级掩码。fail-closed：拒绝。
//      ★ 该 relation 上有**整值掩码**的 L1（`column === null`，默认档合成）同样拒绝
//        （`RELATION_MASKED`）：整值掩码只从**本行** `mask_spec` 取，不跨 L2 行传播，
//        私有测度行的 `mask_spec` 恒 null ⇒ 运行期无法把整值掩码传到它身上。
//   ③ dims ⊆ 实际列；dims 不得含 measure 列；dims 不得含**被掩码列**（spec §4.2-3：
//      维度列不套掩码，运行期 GROUP BY 用的是未掩码列名 ⇒ 掩码维度会拼出语义错位的 SQL）。
//
// ── 「私有测度不可被 L2 ref 引用」落在哪里 ──────────────────────────────────────────
// 主断言在 `semantic-compiler.resolveL1Base`（只认 `source='l1'` **且** `basis='l1_tree'`）。
// 本文件这一侧只保证：**column_agg 行不授予白名单**（不给私有测度自举的机会）。
//
// ⚠️ 平台库与数据面是**两张库**（生产 `platform` vs `warehouse`）：白名单读 `data.metrics`
//    （平台库，`deps.pool`），实际列读 mart（数据面，`deps.warehouse`，缺省 = `warehousePool()`）。
//    把两者混成一个池在本地单库部署上「碰巧对」，生产上会静默查不到列（→ COLUMNS_UNAVAILABLE）。
import type { Pool } from 'pg'
import type { MaskSpec } from './authz'
import type { MetricRow } from './metric-store'
import { loadPlatformCatalog } from './metric-store'
import { warehousePool } from './warehouse'
import {
  COLUMN_AGG_FUNCS,
  RELATION_NAME_RE,
  SemanticCompileError,
  compileColumnAgg,
  parseL1Select,
} from './semantic-compiler'
import type { ColumnAggDeclaration, ColumnAggFunc } from './semantic-compiler'

/**
 * 关系列（information_schema 的归一形状）。`dataType` 用 PG 的 `data_type` 字面量
 * （numeric / integer / text / date …），不引入第二套类型词表。
 */
export interface RelationColumn {
  name: string
  dataType: string
}

/** 准入失败的分类码（**可机检**：调用方按 code 映射 HTTP 状态与文案，不解析 detail）。 */
export type PrivateMeasureErrorCode =
  | 'BAD_INPUT'             // 声明形状不对（缺字段 / dims 非数组 / 标识符越界）
  | 'UNKNOWN_AGG'           // 聚合函数不在闭集
  | 'RELATION_NOT_ALLOWED'  // 闸①：relation 不在 L1 已用 marts
  | 'COLUMNS_UNAVAILABLE'   // 闸②：关系在 L1 白名单但库侧看不到任何列（环境/可见性问题）
  | 'COLUMN_NOT_FOUND'      // 闸②：measure 列不在实际列
  | 'COLUMN_NOT_NUMERIC'    // 闸②：sum/avg/min/max 要求数值列
  | 'MEASURE_MASKED'        // 闸②：measure 列命中值级掩码（裸列名产物运行期命中不了限定名声明）
  | 'RELATION_MASKED'       // 闸②：该 relation 上有整值掩码的 L1（整值不跨 L2 行传播）
  | 'DIM_NOT_FOUND'         // 闸③：dim 不在实际列
  | 'DIM_IS_MEASURE'        // 闸③：dim 含 measure 列
  | 'DIM_MASKED'            // 闸③：dim 是被掩码列（spec §4.2-3）

/** 判别式结果。`detail` 只用于排障/文案，**判定一律读 code**。 */
export type PrivateMeasureValidation =
  | { ok: true }
  | { ok: false; code: PrivateMeasureErrorCode; detail?: string }

/**
 * 依赖（显式注入，域层不碰 Hono）。
 *
 * `loadCatalog` / `loadColumns` 是**测试缝**：纯用例不需要真库，且「白名单每次现算」这条
 * 性质只能靠可替换的加载器钉住（缓存一次就跨调用泄漏）。
 */
export interface PrivateMeasureDeps {
  /** 平台库：读 L1 词表（`data.metrics` 在平台库）。 */
  pool: Pool
  /** 数据面池：读 mart 实际列；缺省 = `warehousePool()`（生产里与平台库是两张库）。 */
  warehouse?: Pool
  /** L1 词表加载器；缺省 = `loadPlatformCatalog(pool)`。 */
  loadCatalog?: (pool: Pool) => Promise<MetricRow[]>
  /** 列清单加载器；缺省 = `loadRelationColumns(warehouse, relation)`。 */
  loadColumns?: (pool: Pool, relation: string) => Promise<RelationColumn[]>
}

/** 私有测度声明（与编译点同一形状；这里只做运行期收严）。 */
export type PrivateMeasureInput = ColumnAggDeclaration

/**
 * 数值类型白名单（PG `information_schema.columns.data_type` 的字面量）。
 * 导出给候选生成（Task 5）复用：两处对「什么算数值列」必须同一份判据，否则候选会生成一批
 * adopt 时必被闸②拒掉的组合（假候选）。
 */
export const NUMERIC_DATA_TYPES = new Set([
  'smallint', 'integer', 'bigint', 'decimal', 'numeric', 'real', 'double precision', 'money',
])

/** 要求数值列的聚合（count / count_distinct 对文本、日期同样有意义）。 */
const NUMERIC_REQUIRED_AGGS = new Set<ColumnAggFunc>(['sum', 'avg', 'min', 'max'])

/**
 * 加载**实际列**（`information_schema.columns`）。
 *
 * 关系名先经 `to_regclass` **按运行期同一套规则**解析（裸名走会话 `search_path`，限定名走
 * 显式 schema），再按解析到的 (schema, table) 取列。为什么不直接
 * `where table_name = $1 and table_schema = any(current_schemas(false))`：同名的关系可能出现在
 * 多个 schema 里，那样会把**别的 schema 的列**并进来——白名单放行一个运行期 SQL 解析不到的列，
 * 症状会推迟到「查询时 SQL 报错」，正是 fail-closed 要消灭的形态。
 *
 * 表不存在 / 无列权限 ⇒ 空数组（调用方给 COLUMNS_UNAVAILABLE，与「列名写错」可区分）；
 * 关系名不合法 ⇒ **抛**（本函数可被单独调用，注入防线不靠上游）。
 */
export async function loadRelationColumns(pool: Pool, relation: string): Promise<RelationColumn[]> {
  if (!RELATION_NAME_RE.test(relation)) {
    throw new Error(`loadRelationColumns: 关系名不合法（只许 \`标识符\` 或 \`schema.标识符\`）：${relation}`)
  }
  const r = await pool.query(
    `with rel as (
       select n.nspname as schema_name, k.relname as table_name
         from pg_class k
         join pg_namespace n on n.oid = k.relnamespace
        where k.oid = to_regclass($1)
     )
     select c.column_name, c.data_type
       from information_schema.columns c
       join rel on c.table_schema = rel.schema_name and c.table_name = rel.table_name
      order by c.ordinal_position`,
    [relation],
  )
  return r.rows.map((row) => ({
    name: String((row as { column_name?: unknown }).column_name ?? ''),
    dataType: String((row as { data_type?: unknown }).data_type ?? ''),
  }))
}

/**
 * 白名单关系集：**每次调用现算**（不缓存）。
 *
 * 只从 L1 **树形**行反解：`source !== 'l1'` 或 `basis !== 'l1_tree'` 的行一律不授予关系
 * （私有测度行不能给自己发白名单）。坏 select_sql 的行**跳过不抛**——它不授予任何东西，
 * 方向是「少授权」= fail-closed；抛会让一行历史脏数据把整个写入面打死。
 */
export function whitelistedRelations(catalog: readonly MetricRow[]): Set<string> {
  const out = new Set<string>()
  for (const row of catalog) {
    if (row.source !== 'l1' || row.basis !== 'l1_tree') continue
    try {
      out.add(parseL1Select(row.selectSql).relation)
    } catch {
      // 不合形状契约的 L1 行：不授予关系（跳过，不猜）
    }
  }
  return out
}

/**
 * 列掩码目标（**排除整值**）：`relation` 为 null = 声明没带关系前缀。
 *
 * 声明写的是 `关系.列`（如 `fct_retail_sale.cost`），最后一段才是列名。保留关系前缀是
 * 给 `MEASURE_MASKED` 用的：measure 列被掩码 ⇒ 运行期裸列名命中不了限定名声明 ⇒ 必须拒。
 */
interface ColumnMaskTarget {
  relation: string | null
  column: string
}

function columnMaskTargets(catalog: readonly MetricRow[]): ColumnMaskTarget[] {
  const out: ColumnMaskTarget[] = []
  for (const row of catalog) {
    for (const spec of (row.masks ?? []) as MaskSpec[]) {
      if (spec.column === null) continue   // 整值掩码不是列目标
      const parts = spec.column.split('.')
      const column = parts[parts.length - 1] ?? spec.column
      out.push({ relation: parts.length > 1 ? parts.slice(0, -1).join('.') : null, column })
    }
  }
  return out
}

/**
 * 被掩码的列名（**最后一段**，限定名与否都拦）。
 *
 * 为什么按最后一段：L1 掩码声明写的是 `关系.列`（如 `fct_retail_sale.cost`），而私有测度的
 * 编译产物用裸列名（`sum(cost)`）。保守取最后一段 ⇒ 宁可多拒（fail-closed），
 * 不让一个「维度列被掩码」的私有测度拼出 GROUP BY 与 SELECT 语义错位的 SQL。
 */
export function maskedTargets(catalog: readonly MetricRow[]): Set<string> {
  return new Set(columnMaskTargets(catalog).map((t) => t.column))
}

/**
 * 有**整值掩码**声明（`mask_spec` 里 `column === null`）的 L1 关系集合。
 *
 * 消费方：W6 的 `explore_query`——整值掩码关系上的自由聚合会看到原值（与私有测度同一个
 * 道理：整值掩码只从本行取），所以整表拒。判定口径与 `relationHasWholeValueMask` 同一份。
 */
export function wholeValueMaskedRelations(catalog: readonly MetricRow[]): Set<string> {
  const out = new Set<string>()
  for (const row of catalog) {
    if (row.source !== 'l1' || row.basis !== 'l1_tree') continue
    if (!((row.masks ?? []) as MaskSpec[]).some((spec) => spec.column === null)) continue
    try {
      out.add(parseL1Select(row.selectSql).relation)
    } catch {
      // 坏行不授予任何东西（方向：少读）
    }
  }
  return out
}

/**
 * measure 列是否命中值级掩码（`MEASURE_MASKED` 的判据）。
 *
 * 匹配规则（fail-closed）：
 *   · 目标列最后一段 == measure 列；
 *   · **且** 目标带关系前缀时前缀与 `relation` 逐字相等；目标无前缀时视为同关系（保守）。
 *
 * 为什么必须拒：`compileColumnAgg` 产出裸列名（`sum(cost)`），运行期 `maskedSelectSql`
 * 按**限定名逐字**匹配（`fct_x.cost`）⇒ 裸列名命中不了 ⇒ 聚合会看到原值，绕过值级掩码。
 * 可选修法是「限定名 SQL + 掩码传播」，那要同时改编译产物与运行期掩码识别，**本波不做**。
 */
function measureIsMasked(
  catalog: readonly MetricRow[], relation: string, column: string,
): ColumnMaskTarget | undefined {
  return columnMaskTargets(catalog).find(
    (t) => t.column === column && (t.relation === null || t.relation === relation),
  )
}

/**
 * 该 relation 是否有**整值掩码**的 L1 行（`RELATION_MASKED` 的判据）。
 *
 * 整值掩码（`mask_spec` 里 `column === null`）只由默认档合成、且 `effectiveMasks` **只从
 * 本行**取整值声明（不跨行按列传播）。私有测度行恒无 `mask_spec` ⇒ 运行期拿不到整值掩码
 * ⇒ 读敏感 mart 的私有测度会看到原值。fail-closed：该关系上不许建私有测度。
 *
 * 关系比对用 L1 行 `select_sql` 里解析出的 relation（与闸①同一份 `parseL1Select`）；
 * 坏行跳过（它不授予任何东西，方向是「少授权」）。
 */
function relationHasWholeValueMask(
  catalog: readonly MetricRow[], relation: string,
): boolean {
  for (const row of catalog) {
    if (row.source !== 'l1' || row.basis !== 'l1_tree') continue
    let rowRelation: string
    try {
      rowRelation = parseL1Select(row.selectSql).relation
    } catch {
      continue
    }
    if (rowRelation !== relation) continue
    if (((row.masks ?? []) as MaskSpec[]).some((spec) => spec.column === null)) return true
  }
  return false
}

/** 形状收严（DB 之前）。复用 compileColumnAgg ⇒ 标识符/聚合函数**同一套规则**，不另写一份。 */
function shapeOf(input: unknown):
  | { ok: true; value: { agg: ColumnAggFunc; column: string; dims: string[]; relation: string } }
  | { ok: false; code: PrivateMeasureErrorCode; detail?: string } {
  if (input === null || typeof input !== 'object') {
    return { ok: false, code: 'BAD_INPUT', detail: '私有测度声明不是对象' }
  }
  const raw = input as Record<string, unknown>
  if (typeof raw.agg !== 'string' || !(COLUMN_AGG_FUNCS as readonly string[]).includes(raw.agg)) {
    return {
      ok: false, code: 'UNKNOWN_AGG',
      detail: `聚合函数不在闭集（${COLUMN_AGG_FUNCS.join('|')}）内：${JSON.stringify(raw.agg)}`,
    }
  }
  let compiled: ReturnType<typeof compileColumnAgg>
  try {
    compiled = compileColumnAgg(raw as unknown as ColumnAggDeclaration)
  } catch (e) {
    if (e instanceof SemanticCompileError) return { ok: false, code: 'BAD_INPUT', detail: e.message }
    throw e
  }
  // 归一后的 dims（去重保序）——与编译产物 groupBy 同一份，避免两处各算一遍
  const dims = compiled.groupBy === '' ? [] : compiled.groupBy.split(', ')
  return {
    ok: true,
    value: {
      agg: raw.agg as ColumnAggFunc,
      column: raw.column as string,
      dims,
      relation: raw.relation as string,
    },
  }
}

/** 列清单加载（缺省走数据面 `warehousePool()`；注入时用 `warehouse ?? pool`）。 */
async function columnsOf(deps: PrivateMeasureDeps, relation: string): Promise<RelationColumn[]> {
  if (deps.loadColumns !== undefined) return deps.loadColumns(deps.warehouse ?? deps.pool, relation)
  return loadRelationColumns(deps.warehouse ?? warehousePool(), relation)
}

/**
 * 私有测度的准入判定（写入路径调用；**纯校验，不写库**）。
 *
 * 顺序：形状 → 闸①（白名单）→ 闸②（整值掩码关系 / measure 列 + 掩码 + 类型）→ 闸③（dims）。
 * 「先形状后 DB」是有意的：非法输入不该触发任何查询（也少一个注入面触达点）。
 */
export async function validatePrivateMeasure(
  deps: PrivateMeasureDeps, input: PrivateMeasureInput,
): Promise<PrivateMeasureValidation> {
  // ① 形状：标识符 / 聚合函数 / dims 数组
  const shape = shapeOf(input)
  if (!shape.ok) return shape
  const { agg, column, dims, relation } = shape.value

  // ② 闸①：relation ∈ L1 已用 marts（**每次现算**，不缓存跨请求）
  const catalog = await (deps.loadCatalog ?? loadPlatformCatalog)(deps.pool)
  const allowed = whitelistedRelations(catalog)
  if (!allowed.has(relation)) {
    const list = [...allowed].sort().join(', ') || '（空：L1 词表里没有可反解的关系）'
    return {
      ok: false, code: 'RELATION_NOT_ALLOWED',
      detail: `relation \`${relation}\` 不在 L1 已用 marts 里（允许：${list}）`,
    }
  }

  // ③ 闸②：该 relation 上若有**整值掩码**的 L1 ⇒ 直接拒。
  //    整值掩码不进 L2 `mask_spec`（`effectiveMasks` 只从本行取），运行期无法传播到私有测度行。
  if (relationHasWholeValueMask(catalog, relation)) {
    return {
      ok: false, code: 'RELATION_MASKED',
      detail: `relation \`${relation}\` 上有整值掩码的 L1：整值掩码只从本行 mask_spec 取、不跨 L2 行传播，私有测度行运行期拿不到它（fail-closed）`,
    }
  }

  // ④ 闸②：measure 列必须是该 relation 的**实际列**（不是契约列）
  const columns = await columnsOf(deps, relation)
  if (columns.length === 0) {
    return {
      ok: false, code: 'COLUMNS_UNAVAILABLE',
      detail: `relation \`${relation}\` 在 L1 白名单里，但数据面查不到它的列（schema/search_path 或数据面连接问题）`,
    }
  }
  const byName = new Map(columns.map((c) => [c.name, c]))
  const measure = byName.get(column)
  if (measure === undefined) {
    const names = columns.map((c) => c.name).join(', ')
    return { ok: false, code: 'COLUMN_NOT_FOUND', detail: `列 \`${column}\` 不在 \`${relation}\` 的实际列里（实际列：${names}）` }
  }
  // ★ measure 列被掩码 ⇒ 拒。编译产物是裸列名（`sum(cost)`），运行期按限定名逐字匹配
  //   （声明是 `关系.列`）⇒ 命中不了 ⇒ 聚合会绕过值级掩码。本波不做「限定名 SQL + 掩码传播」。
  const maskedMeasure = measureIsMasked(catalog, relation, column)
  if (maskedMeasure !== undefined) {
    return {
      ok: false, code: 'MEASURE_MASKED',
      detail: `measure 列 \`${column}\` 命中值级掩码（声明：\`${maskedMeasure.relation === null ? column : `${maskedMeasure.relation}.${maskedMeasure.column}`}\`）：私有测度的聚合 SQL 用裸列名，运行期掩码按限定名逐字匹配会命中不了 ⇒ 聚合会读到原值（fail-closed）`,
    }
  }
  if (NUMERIC_REQUIRED_AGGS.has(agg) && !NUMERIC_DATA_TYPES.has(measure.dataType.toLowerCase())) {
    return {
      ok: false, code: 'COLUMN_NOT_NUMERIC',
      detail: `聚合 \`${agg}\` 要求数值列，\`${column}\` 的类型是 \`${measure.dataType}\`（count/count_distinct 不受此限）`,
    }
  }

  // ④ 闸③：dims ⊆ 实际列；不得含 measure 列；不得含被掩码列
  const masked = maskedTargets(catalog)
  for (const dim of dims) {
    if (byName.get(dim) === undefined) {
      return { ok: false, code: 'DIM_NOT_FOUND', detail: `维度 \`${dim}\` 不在 \`${relation}\` 的实际列里` }
    }
    if (dim === column) {
      return { ok: false, code: 'DIM_IS_MEASURE', detail: `维度 \`${dim}\` 与 measure 列同名：它不能同时是被聚合的列和分组维度` }
    }
    if (masked.has(dim)) {
      return {
        ok: false, code: 'DIM_MASKED',
        detail: `维度 \`${dim}\` 是被掩码列：运行期 GROUP BY 用未掩码的列名，会拼出 SELECT 与 GROUP BY 语义错位的 SQL（spec §4.2-3）`,
      }
    }
  }

  return { ok: true }
}
