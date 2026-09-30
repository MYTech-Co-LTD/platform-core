// authz.ts — 问数授权核心（**纯函数**，三通道共用，全仓唯一一份权限判定）。
//
// 不变量（spec §5）：
//   1. 词表裁剪：scopes 之外的指标对调用方**不可见**（不是报错）
//   2. 主体钉死：SQL 里的主体值只来自 Requester.orgId；请求参数里出现保留键一律拒
//   3. fail-closed：未声明 / 未授权 / 参数非法，一律拒并给出可解释 reason
//   4. 回包带钉死主体（plan.subject）——客户端能独立验证
//
// 原型实测 11/11：/tmp/iam-lab/mcp_authz_server.py + run_matrix.py（同序拒绝链）。
// 本文件**不得** import 任何 pool / env / Hono —— 它是纯的，才能被三通道共用且可单测。

export type MetricParamType = 'date' | 'string' | 'number'
export interface MetricParamDef {
  /** 参数落到 SQL 里的列名（参数名 ≠ 列名是常态，如 day_from → day） */
  column: string
  type: MetricParamType
  required?: boolean
}

export interface MetricDef {
  id: string
  title: string
  description: string
  /** null = 拿到本模块即可见 */
  requiredScope: string | null
  subjectColumn: string
  /** 不含 WHERE / GROUP BY / LIMIT 的 SELECT */
  selectSql: string
  /** 不含前导空格；空串 = 不分组 */
  groupBy: string
  params: Record<string, MetricParamDef>
}

/**
 * 带**源维度**的词表行 = 授权契约 + `sourceSystem`（裁剪时读的第三维）。
 *
 * 为什么是这里的**结构化最小形状**，而不是直接 import `metric-store` 的 `MetricRow`：
 *   · 本文件是**纯的**（头注：不得 import pool / env / Hono），不认识存储层；
 *   · `MetricRow` 还带 `source`（l1/l2 分层）——那是「谁写的、谁能改」，与授权判定无关；
 *   · 用泛型（见 `visibleMetrics`）保子类型：传 `MetricRow[]` 出去仍是 `MetricRow[]`，
 *     调用方不需要任何断言。
 *
 * `sourceSystem` 的语义（spec §3⑧）：**L1 行** = 声明的 `source`（如 `lemeng`）；
 * **L2 行** = `null`（本租户自己写的，没有源维度 ⇒ 不受裁剪影响）。
 */
export interface SourceTaggedMetric extends MetricDef {
  sourceSystem: string | null
}

export type Channel = 'session' | 'pat' | 'wecom'

export interface Requester {
  userId: string
  /** 主体值（SQL 里 WHERE <subjectColumn> = '<orgId>'）——**只**来自身份解析 */
  orgId: string
  channel: Channel
  /** 仅 pat 通道 */
  keyId: number | null
  scopes: string[]
  hasScope: (code: string) => boolean
}

/** 单次查询行数上界（原型用 10 是演示；产品面 1000，超出即 truncated）。 */
export const MAX_QUERY_ROWS = 1000

/**
 * 主体保留键：请求参数里出现即拒。
 * 这是**唯一**保证「客户端无法指定主体」的地方——DB 连接是跨主体的（pg_duckdb 一条连接
 * 看得到所有租户），SQL 的正确性全靠这里。
 */
export const SUBJECT_RESERVED_KEYS = [
  'org', 'subject', 'tenant', 'tenant_id', 'org_id', 'casdoor_org',
] as const

export type DenyReason =
  | 'metric_not_declared'
  | 'metric_not_authorized'
  | 'subject_pinned_by_platform'
  | 'bad_param'

export type AuthzResult =
  | { ok: true; plan: { sql: string; metricId: string; subject: string } }
  | { ok: false; reason: DenyReason; metricId: string; detail?: string }

/**
 * 词表裁剪：**看不见**，不是调了报错（spec §5 约束 3）。
 *
 * 两个维度**都要**过才可见（`&&`，不是二选一）：
 *   ① `requiredScope`：无门槛（null）或调用方持有该码；
 *   ② `sourceSystem`（spec §3⑧ 的源维度）：**L1 行**只在「本租户已接入该源」时可见；
 *      **L2 行**（`sourceSystem === null`）**恒可见**——它是本租户自己写的声明，没有源维度。
 *
 * 第三参**必填**（不是可选 + 默认空集）：漏传是编译错。若给它一个「恒空 / 不裁」的默认值，
 * 「某个消费通道忘了接投影」就退化成**静默错答**——而它的两种错法都不可观测：
 * 默认空集 ⇒ 该通道整片平台指标消失（fail-closed 但仍无声）；默认不裁 ⇒ 放行未接入源的指标
 * （fail-open，正是 spec 要堵的）。故这里没有默认值这个选项。
 *
 * 收口一处：四个消费方（`routes/metrics.ts`、`routes/mcp.ts`、`domain/agent-loop.ts`、
 * `domain/query-service.ts`）**都**经本函数；机器判据在 `catalog-consumers.test.ts`
 * （来源守卫 + 四通道行为一致，防将来新增第五个消费方绕开）。
 */
export function visibleMetrics<T extends SourceTaggedMetric>(
  catalog: readonly T[],
  requester: Requester,
  adoptedSources: ReadonlySet<string>,
): T[] {
  return catalog.filter((m) =>
    (m.requiredScope === null || requester.hasScope(m.requiredScope)) &&
    (m.sourceSystem === null || adoptedSources.has(m.sourceSystem)))
}

/** 单引号双写（SQL 标准转义）。**只**用于已通过类型校验的值。 */
export function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const NUMBER_RE = /^-?\d+(\.\d+)?$/

/** 参数值 → SQL 字面量；非法返回 null（调用方转 bad_param）。 */
function literal(param: MetricParamDef, value: unknown): string | null {
  switch (param.type) {
    case 'date':
      return typeof value === 'string' && DATE_RE.test(value) ? `${sqlQuote(value)}::date` : null
    case 'number': {
      const s = typeof value === 'number' ? String(value) : value
      return typeof s === 'string' && NUMBER_RE.test(s) ? s : null
    }
    case 'string':
      return typeof value === 'string' ? sqlQuote(value) : null
    default:
      // 越界 type 必须在这里显式收口（fail-closed），不能指望「union 已闭合 + 无 default」兜底：
      // 穿透 switch 会返回 **`undefined`**，而调用方的判据是 `lit === null` ——
      // `undefined === null` 为 false ⇒ 越界值被**当合法值放行**，拼出 `AND <col> = undefined`：
      // 结果是 `ok: true` + 一条必然报错的 SQL（线上表现为 500 + 误导性 Postgres 语法错误），
      // 而不是可解释的 `bad_param`。类型层（闭合 union）只能挡编译期字面量，挡不住运行时数据——
      // 词表若来自未校验的外部输入（如 T3 `loadOrgCatalog` 读到的 `type: 'DATE'`）就会走到这里。
      return null
  }
}

/**
 * 授权 + 出计划。拒绝链顺序**照原型**（未声明 → 未授权 → 主体钉死 → 参数），
 * 顺序是有意义的：未授权者拿到的 reason 不泄露「这个指标存在哪些参数」。
 */
export function authorize(
  catalog: MetricDef[],
  requester: Requester,
  metricId: string,
  args: Record<string, unknown>,
): AuthzResult {
  const metric = catalog.find((m) => m.id === metricId)
  if (!metric) return { ok: false, reason: 'metric_not_declared', metricId }
  if (metric.requiredScope !== null && !requester.hasScope(metric.requiredScope)) {
    return { ok: false, reason: 'metric_not_authorized', metricId }
  }

  for (const key of Object.keys(args)) {
    if ((SUBJECT_RESERVED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, reason: 'subject_pinned_by_platform', metricId }
    }
  }

  const filters: string[] = []
  for (const [name, value] of Object.entries(args)) {
    const param = metric.params[name]
    if (!param) return { ok: false, reason: 'bad_param', metricId, detail: `unknown_param:${name}` }
    if (value === undefined || value === null || value === '') continue
    const lit = literal(param, value)
    if (lit === null) return { ok: false, reason: 'bad_param', metricId, detail: `invalid_value:${name}` }
    filters.push(` AND ${param.column} = ${lit}`)
  }
  for (const [name, param] of Object.entries(metric.params)) {
    const v = args[name]
    if (param.required && (v === undefined || v === null || v === '')) {
      return { ok: false, reason: 'bad_param', metricId, detail: `missing_param:${name}` }
    }
  }

  // 主体值只来自 requester.orgId —— 本行是本文件存在的理由
  const subject = requester.orgId
  const sql =
    `${metric.selectSql} WHERE ${metric.subjectColumn} = ${sqlQuote(subject)}` +
    filters.join('') +
    (metric.groupBy ? ` GROUP BY ${metric.groupBy}` : '') +
    ` LIMIT ${MAX_QUERY_ROWS}`

  return { ok: true, plan: { sql, metricId, subject } }
}
