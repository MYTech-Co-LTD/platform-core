// domain/stats.ts — 运营实时统计（件④ / #2755）：声明式聚合 → 参数化 SQL。
//
// 纪律（与 contract.ts 同款：纯函数、机检错误码、fail-closed）：
// - **只查契约声明过的字段与聚合**：groupBy/measures/where 三处的字段名都先按 `fields` 白名单
//   校验，字段名必须是 SQL 安全标识符；**值一律参数化**，不开放任意 JSON path / 表达式。
// - **org 只来自调用方 identity**（`compileStats` 的第三个参数），请求体里的 org 一律忽略。
// - 上限写死：groupBy ≤3、measures ≤5、where ≤10、limit ≤1000、in ≤50、分组基数 ≤500。
// - 返回 `asOf`（数据快照时刻）与 `truncated`（是否被上限截断）。
//
// 与 contract.ts 的关系：本文件以 `import type` 引用其类型（运行期无环）；contract.ts 在
// 发布门调用本文件的 `validateStatsView`——**发布校验与查询校验是同一套白名单**（单一事实源）。
import type {
  Agg,
  FieldDecl,
  FieldKind,
  StatsFilter,
  StatsInput,
  StatsMeasure,
  StatsViewDecl,
  StatsWhere,
  StatsWhereOp,
} from './contract'
// 类型转出口（contract.ts 以类型导入再转出，供 FieldDecl / 统计入参共用同一组类型名）
export type { Agg, FieldDecl, FieldKind, StatsFilter, StatsInput, StatsMeasure, StatsViewDecl, StatsWhere, StatsWhereOp } from './contract'

/** 聚合算子白名单（字段声明与 `/stats` 入参共用；contract.ts 值导入后转出口）。 */
export const AGGS: readonly Agg[] = ['sum', 'avg', 'count', 'min', 'max']

/** 统计字段名的 SQL 安全形态：只允许标识符（值一律参数化，字段名白名单后才进 SQL）。 */
export const FIELD_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/

const FIELD_KINDS: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'date', 'enum'])

export function isFieldKind(v: unknown): v is FieldKind {
  return typeof v === 'string' && FIELD_KINDS.has(v)
}

/** schema 字段定义 → kind（与 storage/generator 的 kind 映射同构）。 */
export function fieldKindOf(def: unknown): FieldKind | null {
  if (def === null || typeof def !== 'object' || Array.isArray(def)) return null
  const d = def as Record<string, unknown>
  const t = typeof d['type'] === 'string' ? d['type'] : ''
  if (t === 'string' && d['format'] === 'date') return 'date'
  if (t === 'string' && Array.isArray(d['enum'])) return 'enum'
  return isFieldKind(t) ? t : null
}

export const STATS_LIMITS = {
  groupBy: 3,
  measures: 5,
  where: 10,
  limit: 1000,
  inValues: 50,
  /** 分组基数上限（超出置 `truncated: true`）。 */
  cardinality: 500,
} as const

export const DEFAULT_LIMIT = 100
/** 缓存 TTL（计划约束 5–30s）与条目上限。 */
export const STATS_CACHE_TTL_MS = 15_000
export const STATS_CACHE_MAX_ENTRIES = 500

const NUMERIC_AGGS: ReadonlySet<Agg> = new Set(['sum', 'avg', 'min', 'max'])
const NUMERIC_KINDS: ReadonlySet<FieldKind> = new Set(['number', 'integer', 'date'])
const WHERE_OPS: readonly StatsWhereOp[] = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in']
const WHERE_CMP: Record<Exclude<StatsWhereOp, 'in'>, string> = {
  eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=',
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const VIEW_KEY_RE = /^[a-z][a-z0-9_-]{0,63}$/
const LABEL_MAX = 100

/** 机检错误（调用方按 `code` 映射 HTTP 状态，不解析 message）。 */
export class StatsError extends Error {
  constructor(readonly code: string, detail?: string) {
    super(detail ?? code)
    this.name = 'StatsError'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

/** 校验并归一化后的查询（compileStats 的中间产物）。 */
export interface NormalizedStatsQuery {
  groupBy: string[]
  measures: StatsMeasure[]
  where: StatsWhere[]
  submittedFrom?: string
  submittedTo?: string
  /** 生效上限 = min(请求 limit, 分组基数上限)。 */
  limit: number
}

/**
 * 校验 `/stats` 入参（或视图声明）并归一化。不合规一律抛 `StatsError`（机检码）。
 * ⚠️ 字段白名单顺序：**字段声明的 agg 白名单优先于类型相容性**——「字段没声明 sum」比
 * 「string 不能 sum」更准确（前者是契约问题，后者是实现兜底）。
 */
export function normalizeStatsQuery(input: StatsInput, decl: { fields: FieldDecl[] }): NormalizedStatsQuery {
  const byField = new Map(decl.fields.map((f) => [f.field, f]))

  // ── groupBy ──
  const groupByRaw = input.groupBy ?? []
  if (!Array.isArray(groupByRaw)) throw new StatsError('STATS_BAD_SHAPE', 'groupBy 必须是数组')
  if (groupByRaw.length > STATS_LIMITS.groupBy) {
    throw new StatsError('STATS_TOO_MANY_GROUP_BY', `groupBy 最多 ${STATS_LIMITS.groupBy} 维`)
  }
  const groupBy: string[] = []
  for (const g of groupByRaw) {
    if (typeof g !== 'string') throw new StatsError('STATS_BAD_SHAPE', 'groupBy 条目必须是字段名')
    if (!groupBy.includes(g)) groupBy.push(g)
  }
  for (const g of groupBy) {
    const f = byField.get(g)
    if (f === undefined) throw new StatsError('STATS_FIELD_NOT_ALLOWED', `groupBy 字段 ${g} 未在契约中声明`)
    if (f.groupable !== true) throw new StatsError('STATS_NOT_GROUPABLE', `字段 ${g} 未声明可分组`)
  }

  // ── measures ──
  const measuresRaw = input.measures
  if (!Array.isArray(measuresRaw) || measuresRaw.length === 0) {
    throw new StatsError('STATS_NO_MEASURE', '至少需要一个度量（measures）')
  }
  if (measuresRaw.length > STATS_LIMITS.measures) {
    throw new StatsError('STATS_TOO_MANY_MEASURES', `measures 最多 ${STATS_LIMITS.measures} 个`)
  }
  const measures: StatsMeasure[] = measuresRaw.map((m) => {
    if (!isRecord(m) || typeof m['field'] !== 'string' || typeof m['agg'] !== 'string') {
      throw new StatsError('STATS_BAD_SHAPE', 'measure 须是 { field, agg }')
    }
    const field = m['field']
    const agg = m['agg'] as Agg
    if (!(AGGS as readonly string[]).includes(agg)) {
      throw new StatsError('STATS_BAD_AGG', `聚合 ${agg} 不在白名单 ${AGGS.join('/')}`)
    }
    if (field === '*') {
      if (agg !== 'count') throw new StatsError('STATS_AGG_NOT_ALLOWED', "field='*' 只允许 count")
      return { field, agg }
    }
    const f = byField.get(field)
    if (f === undefined) throw new StatsError('STATS_FIELD_NOT_ALLOWED', `度量字段 ${field} 未在契约中声明`)
    if (Array.isArray(f.agg) && !f.agg.includes(agg)) {
      throw new StatsError('STATS_AGG_NOT_ALLOWED', `字段 ${field} 未声明聚合 ${agg}`)
    }
    if (NUMERIC_AGGS.has(agg) && !NUMERIC_KINDS.has(f.kind)) {
      throw new StatsError('STATS_AGG_TYPE_MISMATCH', `字段 ${field}（${f.kind}）不能做 ${agg}`)
    }
    return { field, agg }
  })

  // ── filter.where ──
  if (input.filter !== undefined && input.filter !== null && !isRecord(input.filter)) {
    throw new StatsError('STATS_BAD_FILTER', 'filter 必须是对象')
  }
  const filter = isRecord(input.filter) ? (input.filter as StatsFilter) : {}
  const whereRaw = filter.where ?? []
  if (!Array.isArray(whereRaw)) throw new StatsError('STATS_BAD_FILTER', 'filter.where 必须是数组')
  if (whereRaw.length > STATS_LIMITS.where) {
    throw new StatsError('STATS_TOO_MANY_WHERE', `where 最多 ${STATS_LIMITS.where} 条`)
  }
  const where = whereRaw.map((w) => normalizeWhere(w, byField))

  // ── 日期窗（Asia/Shanghai 日界）──
  const submittedFrom = normalizeDate(filter.submittedFrom, 'submittedFrom')
  const submittedTo = normalizeDate(filter.submittedTo, 'submittedTo')
  if (submittedFrom !== undefined && submittedTo !== undefined && submittedFrom > submittedTo) {
    throw new StatsError('STATS_BAD_FILTER', 'submittedFrom 不能晚于 submittedTo')
  }

  // ── limit ──
  const limitRaw = input.limit ?? DEFAULT_LIMIT
  if (
    typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) ||
    limitRaw < 1 || limitRaw > STATS_LIMITS.limit
  ) {
    throw new StatsError('STATS_LIMIT_TOO_LARGE', `limit 必须是 1..${STATS_LIMITS.limit} 的整数`)
  }

  return {
    groupBy,
    measures,
    where,
    ...(submittedFrom !== undefined ? { submittedFrom } : {}),
    ...(submittedTo !== undefined ? { submittedTo } : {}),
    limit: Math.min(limitRaw, STATS_LIMITS.cardinality),
  }
}

function normalizeDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || !DATE_RE.test(v)) {
    throw new StatsError('STATS_BAD_FILTER', `${name} 必须是 YYYY-MM-DD`)
  }
  return v
}

function normalizeWhere(w: unknown, byField: Map<string, FieldDecl>): StatsWhere {
  if (!isRecord(w) || typeof w['field'] !== 'string' || typeof w['op'] !== 'string') {
    throw new StatsError('STATS_BAD_FILTER', 'where 条目须是 { field, op, value }')
  }
  const field = w['field']
  const op = w['op'] as StatsWhereOp
  if (!WHERE_OPS.includes(op)) {
    throw new StatsError('STATS_BAD_FILTER', `where op ${String(w['op'])} 不在 ${WHERE_OPS.join('/')}`)
  }
  const f = byField.get(field)
  if (f === undefined) throw new StatsError('STATS_FIELD_NOT_ALLOWED', `where 字段 ${field} 未在契约中声明`)
  const value = w['value']
  if (op === 'in') {
    if (!Array.isArray(value)) throw new StatsError('STATS_BAD_FILTER', 'in 的 value 必须是数组')
    if (value.length > STATS_LIMITS.inValues) {
      throw new StatsError('STATS_IN_TOO_LARGE', `in 列表最多 ${STATS_LIMITS.inValues} 项`)
    }
    if (value.length === 0 || !value.every(isScalar)) {
      throw new StatsError('STATS_BAD_FILTER', 'in 的 value 必须是非空标量数组')
    }
    return { field, op, value }
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new StatsError('STATS_BAD_FILTER', `${op} 的 value 必须是字符串或数字`)
    }
  } else if (!isScalar(value)) {
    throw new StatsError('STATS_BAD_FILTER', `${op} 的 value 必须是标量`)
  }
  if (f.kind === 'date' && (typeof value !== 'string' || !DATE_RE.test(value))) {
    throw new StatsError('STATS_BAD_FILTER', `日期字段 ${field} 的 value 必须是 YYYY-MM-DD`)
  }
  if (f.kind === 'boolean' && typeof value !== 'boolean' && value !== 'true' && value !== 'false') {
    throw new StatsError('STATS_BAD_FILTER', `布尔字段 ${field} 的 value 必须是 true/false`)
  }
  return { field, op, value }
}

/** 字段引用 → `payload->>'<field>'`（字段名已过白名单，另加引号包裹兜底）。 */
function extract(field: string): string {
  return `payload->>'${field}'`
}

/** 值占位符（params 顺序即占位符顺序）。 */
type AddParam = (value: unknown) => string

function measureSql(m: StatsMeasure, kind: FieldKind | undefined): string {
  if (m.field === '*') return 'count(*) as "count"'
  const col = extract(m.field)
  const alias = `${m.agg}_${m.field}`
  switch (m.agg) {
    case 'count':
      return `count(${col}) as ${alias}`
    case 'sum':
      return `sum((${col})::numeric) as ${alias}`
    case 'avg':
      return `avg((${col})::numeric) as ${alias}`
    case 'min':
      return `min((${col})::${kind === 'date' ? 'date' : 'numeric'}) as ${alias}`
    case 'max':
      return `max((${col})::${kind === 'date' ? 'date' : 'numeric'}) as ${alias}`
  }
}

function whereSql(w: StatsWhere, kind: FieldKind | undefined, add: AddParam): string {
  const col = extract(w.field)
  if (w.op === 'in') {
    // 计划口径：in 一律按文本数组比较（payload 提取值本身就是 text）
    return `${col} = any(${add((w.value as unknown[]).map((v) => String(v)))}::text[])`
  }
  const cmp = WHERE_CMP[w.op]
  if (kind === 'number' || kind === 'integer') return `(${col})::numeric ${cmp} ${add(w.value)}::numeric`
  if (kind === 'date') return `(${col})::date ${cmp} ${add(w.value)}::date`
  if (kind === 'boolean') return `(${col})::boolean ${cmp} ${add(w.value)}::boolean`
  return `${col} ${cmp} ${add(w.value)}`
}

/**
 * 编译 `/stats` 查询。`scope.org` **只能**来自 identity（路由层传入），不从 input 读。
 * SQL 固定 `org=$1 and kind='form_def' and asset_id=$2`——主体钉死，跨租户不可达。
 */
export function compileStats(
  input: StatsInput,
  decl: { fields: FieldDecl[] },
  scope: { org: string },
): { sql: string; params: unknown[] } {
  const assetId = input.assetId
  if (typeof assetId !== 'string' || assetId.length === 0) {
    throw new StatsError('STATS_BAD_SHAPE', 'assetId 必填')
  }
  const q = normalizeStatsQuery(input, decl)
  const byField = new Map(decl.fields.map((f) => [f.field, f]))
  const params: unknown[] = []
  const add: AddParam = (value) => {
    params.push(value)
    return `$${params.length}`
  }

  const orgP = add(scope.org)
  const assetP = add(assetId)

  const select = [
    ...q.groupBy.map((f) => `${extract(f)} as "${f}"`),
    ...q.measures.map((m) => measureSql(m, m.field === '*' ? undefined : byField.get(m.field)?.kind)),
  ].join(',\n  ')

  const clauses = [`org = ${orgP}`, `kind = 'form_def'`, `asset_id = ${assetP}`]
  if (q.submittedFrom !== undefined) {
    clauses.push(`submitted_at >= (${add(q.submittedFrom)}::date::timestamp at time zone 'Asia/Shanghai')`)
  }
  if (q.submittedTo !== undefined) {
    clauses.push(`submitted_at < (((${add(q.submittedTo)}::date + 1)::timestamp) at time zone 'Asia/Shanghai')`)
  }
  for (const w of q.where) clauses.push(whereSql(w, byField.get(w.field)?.kind, add))

  const limitP = add(q.limit)
  let sql = `select\n  ${select}\nfrom forms.submission\nwhere ${clauses.join('\n  and ')}`
  if (q.groupBy.length > 0) {
    const nums = q.groupBy.map((_, i) => i + 1).join(', ')
    sql += `\ngroup by ${nums}\norder by ${nums}`
  }
  sql += `\nlimit ${limitP}`
  return { sql, params }
}

/** 预声明视图的校验（与 `/stats` 入参同一套；发布门调用）。通过 ⇒ null。 */
export function validateStatsView(
  view: unknown,
  decl: FieldDecl[],
): { code: string; detail: string } | null {
  if (!isRecord(view)) return { code: 'STATS_VIEW_BAD_SHAPE', detail: '统计视图必须是对象' }
  const key = view['key']
  if (typeof key !== 'string' || !VIEW_KEY_RE.test(key)) {
    return { code: 'STATS_VIEW_BAD_SHAPE', detail: `视图 key 须 ^[a-z][a-z0-9_-]{0,63}$：${String(key)}` }
  }
  const label = view['label']
  if (typeof label !== 'string' || label.trim().length === 0 || label.length > LABEL_MAX) {
    return { code: 'STATS_VIEW_BAD_LABEL', detail: `视图 label 必须是非空字符串（≤${LABEL_MAX}）` }
  }
  try {
    normalizeStatsQuery(
      {
        groupBy: view['groupBy'] as string[] | undefined,
        measures: view['measures'] as StatsMeasure[],
        filter: (view['filter'] ?? undefined) as StatsFilter | undefined,
        limit: view['limit'] as number | undefined,
      },
      { fields: decl },
    )
  } catch (e) {
    if (e instanceof StatsError) return { code: e.code, detail: e.message }
    throw e
  }
  return null
}

/**
 * `{ assetId, viewId }` → 视图查询入参：视图给 groupBy/measures/where；请求只能覆盖日期窗。
 * ad-hoc（无 viewId）原样返回。
 */
export function resolveViewRequest(input: StatsInput, views: StatsViewDecl[] | undefined): StatsInput {
  if (input.viewId === undefined) return input
  const view = (views ?? []).find((v) => v.key === input.viewId)
  if (view === undefined) {
    throw new StatsError('STATS_VIEW_NOT_FOUND', `统计视图 ${input.viewId} 未在契约中声明`)
  }
  const filter: StatsFilter = {
    ...(view.filter ?? {}),
    ...(input.filter?.submittedFrom !== undefined ? { submittedFrom: input.filter.submittedFrom } : {}),
    ...(input.filter?.submittedTo !== undefined ? { submittedTo: input.filter.submittedTo } : {}),
  }
  return {
    assetId: input.assetId,
    viewId: view.key,
    groupBy: view.groupBy ?? [],
    measures: view.measures,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(view.limit !== undefined ? { limit: view.limit } : {}),
  }
}

/** 从契约 body 取视图声明（非法形状返回空——发布门已拦，这里是读侧兜底）。 */
export function statsViewsOf(body: unknown): StatsViewDecl[] {
  const dp = isRecord(body) ? body['dataPlane'] : undefined
  const stats = isRecord(dp) ? dp['stats'] : undefined
  const views = isRecord(stats) ? stats['views'] : undefined
  return Array.isArray(views) ? (views as StatsViewDecl[]) : []
}

/** 建议视图的产出（agent 同创统计用；`null` = schema 没有可统计字段）。 */
export interface SuggestedStats {
  fields: FieldDecl[]
  views: StatsViewDecl[]
}

/**
 * 确定性兜底：从 schema 推出「表单 + 统计」。**不猜自由文本做分组**，只：
 * - 数值字段（number/integer）→ 度量 sum/avg；
 * - enum / boolean / date → 一维分组视图；
 * - 至少一条合计视图（groupBy 空，无数值字段时用 count）；
 * - 数组/嵌套/date-time 等不进统计（date-time 按 string 计数，不分组）。
 */
export function suggestStatsViews(schema: unknown): SuggestedStats | null {
  const props = isRecord(schema) ? schema['properties'] : undefined
  if (!isRecord(props)) return null
  const fields: FieldDecl[] = []
  const numeric: string[] = []
  const groupable: Array<{ field: string; title: string }> = []
  for (const [field, def] of Object.entries(props)) {
    if (!FIELD_IDENT_RE.test(field)) continue
    const kind = fieldKindOf(def)
    if (kind === null) continue
    const title = isRecord(def) && typeof def['title'] === 'string' && def['title'].trim().length > 0
      ? def['title'].trim()
      : field
    if (kind === 'number' || kind === 'integer') {
      fields.push({ field, kind, agg: ['sum', 'avg', 'min', 'max', 'count'], groupable: false })
      numeric.push(field)
    } else if (kind === 'enum' || kind === 'boolean' || kind === 'date') {
      fields.push({ field, kind, agg: ['count'], groupable: true })
      groupable.push({ field, title })
    } else {
      fields.push({ field, kind, agg: ['count'], groupable: false })
    }
  }
  if (fields.length === 0) return null

  const measures: StatsMeasure[] = []
  for (const field of numeric) {
    for (const agg of ['sum', 'avg'] as const) {
      if (measures.length >= STATS_LIMITS.measures) break
      measures.push({ field, agg })
    }
  }
  if (measures.length === 0) measures.push({ field: fields[0].field, agg: 'count' })

  const views: StatsViewDecl[] = [{ key: 'total', label: '合计', groupBy: [], measures }]
  const used = new Set(['total'])
  for (const g of groupable) {
    const base = `by_${g.field.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`
    let key = base
    let n = 2
    while (used.has(key)) key = `${base}_${n++}`
    used.add(key)
    views.push({ key, label: `按${g.title}`, groupBy: [g.field], measures: [...measures] })
  }
  return { fields, views }
}
