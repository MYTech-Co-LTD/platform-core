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
import { maskedSelectSql } from './mask'

export type MetricParamType = 'date' | 'date_range' | 'string' | 'number'
export interface MetricParamDef {
  /** 参数落到 SQL 里的列名（参数名 ≠ 列名是常态，如 day_from → day） */
  column: string
  type: MetricParamType
  required?: boolean
}

/**
 * 值级脱敏的 kind 词表（spec 2026-10-17 §5.1「能选不能扩」）。P2 v1 只收 round / nullify：
 * `bucket` 的防护强度 = 桶宽（不是「安全」）且与 `total` 冲突（spec §5.1 附加约束 1），
 * 真要区间展示时再加（spec「已知边界」2）。**加 kind = 改这个常量 + 加 mask.ts 的展开分支
 * + 测试，走 PR。**
 *
 * ★ **唯一定义**：声明面门禁（scripts/sync-data-semantics.mjs 的 masksOf / check-data-models.mjs
 *   的形状核）与运行期展开（domain/mask.ts，T2）都从本文件 import，别两处各列一份——
 *   漂开的那份就是一条静默绕过口。
 */
export const MASK_KINDS = ['round', 'nullify'] as const
export type MaskKind = (typeof MASK_KINDS)[number]

/**
 * 单条值级掩码声明（spec §5.2 声明链；库里 `data.metrics.mask_spec` jsonb 数组的元素）。
 *
 * `column === null` = **整值掩码**：运行期把 `… as value` 的表达式**整个**换成 typed NULL。
 * 为什么必须允许 null（spec §4.1.1 默认档的构造性缺口）：默认档读的敏感值来自**契约列**
 * （如 `lemeng.wholesale_out.cost_money`），而指标的 selectSql 引用的是 **marts 列**
 * （如 `fct_contribution.n_net`）——契约列根本不出现在 selectSql 里，按列替换一个都命中不了
 * ⇒ 掩码静默不生效。整值不给是 fail-closed 的正确语义：读了敏感列又没声明精细策略 ⇒
 * 整个值都别给。整值掩码 kind 只许 `nullify`（对一个整值做 round 没有语义）。
 */
export interface MaskSpec {
  /** 掩码目标的限定列引用（`关系.列`，须**逐字**出现在该指标 selectSql 里）；null = 整值掩码 */
  column: string | null
  kind: MaskKind
  /** round 专用：舍入步长（正整数），运行期展开成 `round(<列>, -step)`；nullify 无此概念 */
  step?: number
  /**
   * 豁免码：**持有它 ⇒ 看原值；否则套掩码**。与 requiredScope 的「默认拒绝」方向相反
   * （masking 与 hiding 的本质区别，spec §5.2）——别把两个字段合成一个。
   */
  grantedBy: string
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
  /**
   * 值级脱敏声明（P2，spec §5.2）：**可选可空**（undefined / null / 空数组 = 无掩码，三态同义
   * ——存储行的 null 就是「未声明」，消费侧统一按 falsy 兜）。真值只来自 L1 物化路径（sync
   * 从声明 `mask` 物化，声明侧已拦「列不在 selectSql 里」的静默失效形态）；L2 行恒 null。
   * ⚠️ 它**不进 select_sql**：运行期在 authorize() 里对 select_sql 做列引用定点替换（T2 接线）
   * ——占位符/掩码进 select_sql 会被 L2 编译（parseL1Select）原样带出去，spec §5.3 订正块。
   */
  masks?: MaskSpec[] | null
  /**
   * 可加指标（spec §8.4）：`expression` 以 `sum(` 开头 ⇒ 任何查询的响应自动附 `total` 合计值。
   * **可选**（缺省 = false = 无自动合计）：合成契约（L2 编译、测试夹具）可以不带——
   * 只有 sync 从声明推导出的 L1 行才带真值；保守缺省不会给不明口径的指标编一个合计。
   */
  totalable?: boolean
  /**
   * 口径射程与排除项（消费面 spec 2026-10-17 §12.6，迁移 020）：空串/缺省 = 未声明射程
   * ⇒ 响应**不带** `scope_line`（未知 ≠ 编一句）。真值只来自 L1 物化路径（sync 从声明
   * `scope_note` 物化）；L2 行恒 ''。
   */
  scopeNote?: string
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
  | {
      ok: true
      plan: {
        sql: string; metricId: string; subject: string; total: boolean
        /**
         * 自动合计计划（spec §8.4）：`metric.totalable === true` 且**非**显式合计模式时在场，
         * 形状与显式合计同一句（`SELECT sum(value) AS total FROM ( <whereAndGroup> ) t`，无
         * LIMIT——截断求和 = 错数）。执行归 query-service；值附到响应 `total` 字段。
         * 显式合计模式（`args.total === true`）不附：plan.sql 本身就是合计，再附 = 重复执行。
         */
        totalSql?: string
        /**
         * 值级掩码展开记录（spec §5.3，P2 T2）：`列 → 记号`（`round:1000` / `nullify`；
         * 整值掩码键为 `<value>`）。**恒在场**（可能为空对象）——空 = 无掩码生效（未声明 /
         * 全部豁免 / 目标未命中）。执行层（query-service）只透传：非空才回包 `masking`。
         */
        applied: Record<string, string>
      }
    }
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

/**
 * 词表参数面投影（spec 2026-10-15 §2.4）：`{<参数名>: { type, required }}`。
 *
 * **两个消费方共用这一份实现**：HTTP 词表（`routes/metrics.ts` 的 `publicView`）与 agent
 * 工具 `list_metrics`（`domain/agent-loop.ts`）——spec §2.4「list_metrics 与 HTTP 词表共用
 * 该投影」的落点。各写一份的后果可预见：将来给参数面加字段/加类型时漂开一边，模型从
 * 工具面拿到的参数说明与词表接口不一致，臆造键名（spec §1 实测的 `biz_date` 就是这么来的）。
 * `column` 是 SQL 内部面（参数名 ≠ 列名是常态），**不**进投影；`required` 缺省投成显式
 * `false`（声明侧恒缺省 = 空参全量），客户端不用处理「字段缺失」这一态。
 */
export type MetricParamFace = Record<string, { type: MetricParamType; required: boolean }>

export function paramFaceOf(
  params: Record<string, MetricParamDef> | undefined | null,
): MetricParamFace {
  const face: MetricParamFace = {}
  for (const [name, p] of Object.entries(params ?? {})) {
    face[name] = { type: p.type, required: p.required ?? false }
  }
  return face
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
 * date_range 参数值校验：{from,to} 闭区间。形状坏与顺序错**分开报**——
 * from>to 是 T2「恒空集且不报错」老坑的结构化修复，必须给可解释 detail（range_invalid）。
 */
function rangeLiteral(
  value: unknown,
): { ok: true; from: string; to: string } | { ok: false; detail: 'shape' | 'order' } {
  if (typeof value !== 'object' || value === null) return { ok: false, detail: 'shape' }
  const { from, to } = value as { from?: unknown; to?: unknown }
  if (typeof from !== 'string' || typeof to !== 'string' || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return { ok: false, detail: 'shape' }
  }
  if (from > to) return { ok: false, detail: 'order' }   // YYYY-MM-DD 字典序即日历序
  return { ok: true, from, to }
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

  // 合计形态（spec §8.1）：`total` 是查询面**保留键**，**仅**布尔 true 被消费；
  // 其余任何值（含字符串 "true"）不消费 → 落进下方参数循环 → `unknown_param:total`（fail-closed）。
  // 它只是聚合形态开关：subject 钉死逻辑不受影响（下方 subject 仍只来自 requester.orgId）。
  const wantTotal = args.total === true

  const filters: string[] = []
  for (const [name, value] of Object.entries(args)) {
    if (wantTotal && name === 'total') continue   // 已消费的保留键不再进参数校验
    const param = metric.params[name]
    if (!param) return { ok: false, reason: 'bad_param', metricId, detail: `unknown_param:${name}` }
    if (value === undefined || value === null || value === '') continue
    if (param.type === 'date_range') {
      const r = rangeLiteral(value)
      if (!r.ok) {
        return {
          ok: false, reason: 'bad_param', metricId,
          detail: (r.detail === 'order' ? 'range_invalid:' : 'invalid_value:') + name,
        }
      }
      filters.push(` AND ${param.column} BETWEEN ${sqlQuote(r.from)}::date AND ${sqlQuote(r.to)}::date`)
      continue
    }
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
  // 值级掩码定点展开（spec §5.3，P2 T2）：授权时刻对内层 select 的**副本**做列引用替换——
  // 掩码包在聚合内部（sum(round(x,-n))，不是 round(sum(x))）。放在 whereAndGroup 拼装之前，
  // 故明细、显式合计、自动合计**读的是同一个内层 select** ⇒ total 与明细行用同一套掩码值
  // （spec §3.2 不变量 2：合计与明细不得一个掩一个不掩）。
  const masked = maskedSelectSql(metric.selectSql, metric.masks, requester.hasScope)
  const whereAndGroup =
    `${masked.sql} WHERE ${metric.subjectColumn} = ${sqlQuote(subject)}` +
    filters.join('') +
    (metric.groupBy ? ` GROUP BY ${metric.groupBy}` : '')
  // 确定性截断（spec §10.3）：明细 SQL 在 GROUP BY 与 LIMIT 之间补 `ORDER BY bizday DESC`——
  // 截断集从「任意子集」变「最新优先」，最新分区不再被 cap 藏掉（与响应 truncated 信号配套）。
  // 仅当分组粒度含 bizday（现行 27 条 L1 全命中）；\b 词边界——`bizday_utc` 这类前缀同形词不误伤。
  // **只**加在明细路径：whereAndGroup 本身一字不动，故 totalSql / 显式合计（都包着 whereAndGroup）
  // 不受影响——聚合无行序语义，排序无意义。
  const detailOrder = /\bbizday\b/.test(metric.groupBy) ? ' ORDER BY bizday DESC' : ''
  const sql = wantTotal
    ? // 合计形态（spec §8.1）：内层（subject + filters + grain 分组）上再 sum——
      // **无外层 LIMIT**：合计必须作用于全量匹配行，截断求和 = 错数。
      // `value` 是 sync 编译器给指标 expression 的固定别名（buildSelectSql：
      // `select <expr> as value, …`），故 sum(value) = 对该指标口径在全量匹配行上再聚合。
      `SELECT sum(value) AS total FROM ( ${whereAndGroup} ) t`
    : `${whereAndGroup}${detailOrder} LIMIT ${MAX_QUERY_ROWS}`

  // 自动伴随（spec §8.4）：totalable 指标的**非显式**查询在计划上附合计 SQL——与显式合计
  // 共用同一形状（无 LIMIT）。subject/filters 与主 sql 同源（同一 whereAndGroup），自动合计
  // 因此同样钉死主体；不改变主 sql 一个字节（明细路径照旧）。显式合计模式不附（plan.sql
  // 本身就是合计，再执行一遍 = 白跑）。
  const totalSql = !wantTotal && metric.totalable === true
    ? `SELECT sum(value) AS total FROM ( ${whereAndGroup} ) t`
    : undefined

  return {
    ok: true,
    plan: {
      sql, metricId, subject, total: wantTotal,
      ...(totalSql !== undefined ? { totalSql } : {}),
      applied: masked.applied,
    },
  }
}
