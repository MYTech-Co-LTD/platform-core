// explore.ts —— W6 Task 2：受约束的只读聚合器（纯函数：校验 + 编译成参数化 SQL）。
//
// ★ 为什么**不**收自由 SQL：仓库里所有执行口都要求 SQL 由平台拼（runQuery 走指标、
//   discovery 走固定模板、sandbox 走 duckle 管线）。一旦开一个「SQL 文本进、行集出」的洞，
//   租户隔离、掩码、行数限额就全靠调用方自觉——而调用方是模型。所以这里只收**结构化 spec**：
//   表 / 度量 / 维度 / 过滤 / 排序 / 上限，标识符必须命中运行时列清单，值一律走 $n 占位符。
//
// 失败码是机检面（调用方按 code 映射文案，不解析 detail）。所有拒绝都是 fail-closed：
// 不确定就拒，不猜。
import { MAX_QUERY_ROWS } from '../authz'

/** 只允许打 marts（dbt 物化落点 schema，实测 59 张表都在这里）。 */
export const EXPLORE_SCHEMA = 'staging'
/** 缺省行数（不传 limit 时）。 */
export const EXPLORE_DEFAULT_LIMIT = 200

export const EXPLORE_AGGS = ['sum', 'avg', 'min', 'max', 'count', 'count_distinct'] as const
export type ExploreAgg = typeof EXPLORE_AGGS[number]

export const EXPLORE_FILTER_OPS = ['eq', 'neq', 'in', 'gte', 'lte', 'between'] as const
export type ExploreFilterOp = typeof EXPLORE_FILTER_OPS[number]

export type ExploreErrorCode =
  | 'BAD_SPEC'
  | 'RELATION_NOT_ALLOWED'
  | 'NO_ORG_COLUMN'
  | 'COLUMN_NOT_FOUND'
  | 'COLUMN_NOT_NUMERIC'
  | 'COLUMN_MASKED'
  | 'RELATION_MASKED'
  | 'AGG_NOT_ALLOWED'
  | 'BAD_FILTER'

export interface ExploreSpec {
  relation: string
  measures: Array<{ agg: ExploreAgg; column: string; as?: string }>
  dimensions?: string[]
  filters?: Array<{ column: string; op: ExploreFilterOp; value: unknown }>
  orderBy?: { key: string; desc?: boolean }
  limit?: number
}

export interface RelationColumn { name: string; dataType: string }

export interface ExploreContext {
  /** 允许的表（仓内 marts 模型名；大小写敏感）。 */
  allowedRelations: ReadonlySet<string>
  /** relation → 运行时列清单（`information_schema.columns` 快照）。 */
  columns: ReadonlyMap<string, readonly RelationColumn[]>
  /** 命中值级掩码的列名（最后一段）。 */
  maskedColumns: ReadonlySet<string>
  /** 有整值掩码的关系（整表拒）。 */
  maskedRelations: ReadonlySet<string>
}

export interface ExploreCompiledOk {
  ok: true
  sql: string
  params: unknown[]
  /** 值已内联的人读形态（只用于展示/证据包，**不执行**）。 */
  preview: string
}

export type ExploreCompiled = ExploreCompiledOk | { ok: false; code: ExploreErrorCode; detail?: string }

const NUMERIC_TYPES = new Set([
  'smallint', 'integer', 'bigint', 'numeric', 'decimal', 'real',
  'double precision', 'money',
])
const IDENT_RE = /^[a-z_][a-z0-9_]*$/

const fail = (code: ExploreErrorCode, detail?: string): ExploreCompiled => ({ ok: false, code, ...(detail === undefined ? {} : { detail }) })

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** 字段名即身份：这些键一旦出现就说明调用方想塞 SQL 文本（fail-closed）。 */
const SQL_SMELL_KEYS = ['sql', 'query', 'rawsql', 'raw', 'where', 'having']

const isPrimitive = (v: unknown): boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** 人读预览：只用于展示。字符串按 SQL 单引号规则转义（`'` 双写），不做别的加工。 */
function literalOf(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  return `'${String(v).replace(/'/g, "''")}'`
}

/** `$1` 是 org（由执行层注入，编译期不知道值）；过滤值从 `$2` 起。 */
function previewOf(sql: string, params: readonly unknown[]): string {
  let out = sql.replace(/\$1(?!\d)/g, "'<org>'")
  params.forEach((p, i) => {
    const value = Array.isArray(p) ? p.map(literalOf).join(', ') : literalOf(p)
    out = out.replace(new RegExp(`\\$${i + 2}(?!\\d)`, 'g'), value)
  })
  return out
}

/**
 * 编译 explore spec。
 *
 * 顺序（先便宜后贵，且先拒「形状不对」再拒「越权」）：spec 形状 → 表白名单/org 列 →
 * 列存在/类型 → 掩码 → 组装 SQL。
 */
export function compileExplore(spec: unknown, ctx: ExploreContext): ExploreCompiled {
  const s = asRecord(spec)
  if (Object.keys(s).some((k) => SQL_SMELL_KEYS.includes(k.toLowerCase()))) {
    return fail('BAD_SPEC', '不接受 SQL 文本字段；请用 relation/measures/dimensions/filters')
  }

  const relation = typeof s.relation === 'string' ? s.relation.trim() : ''
  if (relation === '' || !IDENT_RE.test(relation)) return fail('BAD_SPEC', 'relation 必须是 marts 模型名')
  if (!ctx.allowedRelations.has(relation)) return fail('RELATION_NOT_ALLOWED', relation)
  const cols = ctx.columns.get(relation)
  if (cols === undefined || cols.length === 0) return fail('RELATION_NOT_ALLOWED', `${relation} 在库侧不可见`)
  if (!cols.some((c) => c.name === 'org')) return fail('NO_ORG_COLUMN', `${relation} 没有 org 列，拒绝跨租户读`)
  if (ctx.maskedRelations.has(relation)) return fail('RELATION_MASKED', relation)

  const colOf = new Map(cols.map((c) => [c.name, c]))
  const checkColumn = (name: string): ExploreCompiled | null => {
    if (!IDENT_RE.test(name) || !colOf.has(name)) return fail('COLUMN_NOT_FOUND', name)
    if (ctx.maskedColumns.has(name)) return fail('COLUMN_MASKED', name)
    return null
  }

  // ── 度量 ────────────────────────────────────────────────────────────────
  const rawMeasures = Array.isArray(s.measures) ? s.measures : []
  if (rawMeasures.length === 0) return fail('BAD_SPEC', 'measures 不能为空')
  if (rawMeasures.length > 10) return fail('BAD_SPEC', 'measures 最多 10 项')
  const selects: string[] = []
  const aliases = new Set<string>()
  for (const raw of rawMeasures) {
    const m = asRecord(raw)
    const agg = typeof m.agg === 'string' ? m.agg : ''
    if (!(EXPLORE_AGGS as readonly string[]).includes(agg)) return fail('AGG_NOT_ALLOWED', agg)
    const column = typeof m.column === 'string' ? m.column : ''
    const bad = checkColumn(column)
    if (bad !== null) return bad
    const dataType = colOf.get(column)!.dataType
    if (['sum', 'avg', 'min', 'max'].includes(agg) && !NUMERIC_TYPES.has(dataType)) {
      return fail('COLUMN_NOT_NUMERIC', `${column}(${dataType})`)
    }
    const alias = typeof m.as === 'string' && m.as !== '' ? m.as : `${agg}_${column}`
    if (!IDENT_RE.test(alias) || aliases.has(alias)) return fail('BAD_SPEC', `别名非法或重复：${alias}`)
    aliases.add(alias)
    selects.push(`${agg === 'count_distinct' ? 'count(distinct' : agg}(${column})${agg === 'count_distinct' ? ')' : ''} as ${alias}`)
  }

  // ── 维度 ────────────────────────────────────────────────────────────────
  const dimsRaw = Array.isArray(s.dimensions) ? s.dimensions : []
  if (dimsRaw.length > 4) return fail('BAD_SPEC', 'dimensions 最多 4 个')
  const dims: string[] = []
  for (const d of dimsRaw) {
    if (typeof d !== 'string') return fail('BAD_SPEC', 'dimensions 必须是字符串数组')
    const bad = checkColumn(d)
    if (bad !== null) return bad
    if (aliases.has(d)) return fail('BAD_SPEC', `维度与度量别名重名：${d}`)
    if (!dims.includes(d)) dims.push(d)
  }

  // ── 过滤 ────────────────────────────────────────────────────────────────
  const rawFilters = Array.isArray(s.filters) ? s.filters : []
  if (rawFilters.length > 10) return fail('BAD_FILTER', 'filters 最多 10 项')
  const where: string[] = ['org = $1']
  const params: unknown[] = []
  const push = (v: unknown): string => { params.push(v); return `$${params.length + 1}` }
  for (const raw of rawFilters) {
    const f = asRecord(raw)
    const column = typeof f.column === 'string' ? f.column : ''
    const op = typeof f.op === 'string' ? f.op : ''
    const bad = checkColumn(column)
    if (bad !== null) return bad
    const value = f.value
    if (!(EXPLORE_FILTER_OPS as readonly string[]).includes(op)) return fail('BAD_FILTER', `未知 op：${op}`)
    if (op === 'in') {
      if (!Array.isArray(value) || value.length === 0 || value.length > 200 || !value.every(isPrimitive)) {
        return fail('BAD_FILTER', 'in 需要非空基本类型数组（≤200）')
      }
      where.push(`${column} = any(${push(value)})`)
    } else if (op === 'between') {
      if (!Array.isArray(value) || value.length !== 2 || !value.every(isPrimitive)) {
        return fail('BAD_FILTER', 'between 需要 [起, 止]')
      }
      where.push(`${column} between ${push(value[0])} and ${push(value[1])}`)
    } else {
      if (!isPrimitive(value)) return fail('BAD_FILTER', `${op} 需要基本类型值`)
      const sqlOp = { eq: '=', neq: '<>', gte: '>=', lte: '<=' }[op]
      where.push(`${column} ${sqlOp} ${push(value)}`)
    }
  }

  // ── 排序 / 上限 ──────────────────────────────────────────────────────────
  const limitRaw = s.limit
  let limit = EXPLORE_DEFAULT_LIMIT
  if (limitRaw !== undefined && limitRaw !== null) {
    if (typeof limitRaw !== 'number' || !Number.isInteger(limitRaw) || limitRaw < 1) {
      return fail('BAD_SPEC', 'limit 必须是正整数')
    }
    // 不夹紧：夹紧会让调用方以为拿到了全量。
    if (limitRaw > MAX_QUERY_ROWS) return fail('BAD_SPEC', `limit 上限 ${MAX_QUERY_ROWS}`)
    limit = limitRaw
  }

  const orderRaw = asRecord(s.orderBy)
  let orderSql = ''
  if (s.orderBy !== undefined && s.orderBy !== null) {
    const key = typeof orderRaw.key === 'string' ? orderRaw.key : ''
    const orderable = aliases.has(key) || dims.includes(key)
    if (!orderable) return fail('BAD_SPEC', `orderBy.key 必须是维度或度量别名：${key}`)
    orderSql = ` order by ${key}${orderRaw.desc === false ? ' asc' : ' desc'}`
  }

  const groupSql = dims.length > 0 ? ` group by ${dims.join(', ')}` : ''
  const selectSql = [...dims, ...selects].join(', ')
  const sql = `select ${selectSql} from ${EXPLORE_SCHEMA}.${relation} where ${where.join(' and ')}${groupSql}${orderSql} limit ${limit}`
  return { ok: true, sql, params, preview: previewOf(sql, params) }
}
