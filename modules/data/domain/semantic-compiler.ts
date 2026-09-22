// semantic-compiler.ts — **L2 的唯一编译点**：结构化声明 → `select_sql`。
//
// 背景（拍板 #5 / 全局约束 12）：定义权下放给租户管理员——但**禁任意 SQL** 这条不变。
// 故 L2 的表达面是一份**可机检的结构化声明**（`L2Declaration`），由本文件编译成 SQL。
// 全仓**只有这一处**把用户输入变成 SQL 片段（`domain/authz.ts` 只把**已编译好的**
// select_sql 拼进查询，它不生成 select_sql）。
//
// ── 为什么「唯一编译点」是安全属性，不是整洁癖 ─────────────────────────────────────
// L2 的入参是**租户提供的数据**。任何一处「顺手把入参拼进 SQL」都是注入面，而注入面一旦
// 有第二处，审计就只能靠人记得全部位置。收成一处之后，「L2 能产生什么 SQL」= 本文件的可达
// 输出集合，可被单测穷举断言（见 semantic-compiler.test.ts 的纯 SELECT 断言）。
//
// ── 校验发生在**写时**，不是查询时 ──────────────────────────────────────────────
// `baseMetric` 必须命中 L1 词表、维度名必须 ∈ L1 声明的 grain —— 两者都在**声明落库前**判。
// 若留到查询时才判，坏声明先静默入库，症状会推迟到「某个租户查这个指标时 500」，
// 而那时排查者看到的是 SQL 报错，不是「谁在什么时候写了一条越界声明」。
//
// ── v1 的表达力档位（**别私自放宽**）───────────────────────────────────────────
// 只有 `op.kind = 'refine'`（A 薄档四件事：裁剪 / 别名 / 过滤 / 目标值）。
// spec 的 B 中档（受限表达式，如算术组合）**不在 v1**：拍板原文的「定义权下放」指的是
// **定义新指标/语义的权限**下放，不是表达力档位的扩展。要放开，走 spec 增补。
//
// 本文件**不得** import 任何 pool / env / Hono —— 它是纯的，才能被单测穷举（同 authz.ts 的纪律）。
import { z } from 'zod'
import type { MetricDef } from './authz'
import { sqlQuote } from './authz'
import type { MetricRow } from './metric-store'

/**
 * 编译期拒绝的分类码（**可机检**：调用方按 code 映射 HTTP 状态与文案，不解析 message）。
 */
export type CompileErrorCode =
  | 'BAD_DECL'        // 声明本身形状不对（缺字段/类型错）
  | 'OP_UNSUPPORTED'  // op.kind 不是 refine（B/C 档未开放）
  | 'L1_BASE_NOT_FOUND' // baseMetric 不在 L1 词表里（只有 L1 能当 base）
  | 'UNKNOWN_DIM'     // 引用了 L1 没声明的维度（机检：维度只能来自 L1 的 grain）
  | 'BAD_FILTER'      // 过滤子句形状不对（'=' 多值 / 'in' 空值 / op 越界）
  | 'BAD_BASE_SQL'    // L1 行的 select_sql 不合形状契约（见下「形状契约」节）

export class SemanticCompileError extends Error {
  readonly code: CompileErrorCode
  constructor(code: CompileErrorCode, message: string) {
    super(message)
    this.name = 'SemanticCompileError'
    this.code = code
  }
}

/**
 * L2 结构化声明（可机检、禁任意 SQL 的实现面——拍板 #5）。
 *
 * `baseMetric` 必须引用 **L1** 词表里已存在的 `<域>:<指标>`（编译时校验存在性）。
 * L2 不能以另一条 L2 为 base：否则「一条 L2 叠在另一条 L2 上」会让口径链无限延长，
 * 而每一跳都只看得到上一跳的**编译产物**——出问题时无法定位是哪一跳把口径带偏的。
 */
export interface L2Declaration {
  baseMetric: string
  /** v1 只有 refine：裁剪/别名/过滤/目标值（A 薄档四件事）。 */
  op: { kind: 'refine' }
  /** 别名 → 词表里的展示名（title）。**不等于** id：id 是行的稳定句柄，改别名不动 id。 */
  alias?: string
  /** 可见维度白名单（维度名 ∈ L1 声明的 grain）；省略 = 继承 L1 的全部维度。 */
  visibility?: { dims: string[] }
  /** 固定过滤（维度名 ∈ L1 声明的 grain）——把这条 L2 裁到某个切片上。 */
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]
  /**
   * 目标值。**当前无存储面**（`data.metrics` 没有 target 列，003 只加了 source）⇒ 见
   * routes/metrics.ts 的 `TARGET_NOT_SUPPORTED`：入参被**显式拒绝**而不是静默丢弃。
   * 保留在类型里是因为它是 A 薄档明列的第四件事，删掉会让接口与计划对不上。
   */
  target?: number
}

/** 维度名只许是 PG 标识符（白名单外的字符一律进不了 SQL——它们在 L1 的 grain 里也不存在）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * L2 声明的 zod 形状（**写时校验**的唯一事实源）。
 *
 * 与编译器同源放一个文件（T9 的机检会断言「schema 拒的编译器也拒」，防两处漂移）：
 * schema 管**形状**（类型/必填/长度），编译器管**语义**（base 存在性、维度越界、过滤子句）。
 * 分两层不是重复：schema 拦的是「这不是一份声明」，编译器拦的是「这份声明越界了」。
 */
export const L2DeclarationSchema = z.object({
  baseMetric: z.string().min(1).max(128),
  op: z.object({ kind: z.literal('refine') }),
  alias: z.string().min(1).max(128).optional(),
  visibility: z.object({ dims: z.array(z.string().min(1)).max(64) }).optional(),
  filters: z
    .array(z.object({
      dim: z.string().min(1),
      op: z.enum(['=', 'in']),
      values: z.array(z.string()).min(1),
    }))
    .max(64)
    .optional(),
  target: z.number().optional(),
})

/**
 * L1 `select_sql` 的**形状契约**（sync 脚本物化的产物形状，双方共同遵守）。
 *
 *   `select <表达式> as value[, <维度>…] from <关系>`
 *
 * 为什么必须有这份契约（而不是让编译器随便拼）：`domain/authz.ts` 的 authorize 会做
 *   `<selectSql> WHERE <主体列> = '<org>' [AND 参数过滤] [GROUP BY <columns>] LIMIT n`
 * ——它**在 select_sql 后面直接续 WHERE**。⇒ select_sql 必须恰好是「一个还没有 WHERE 的
 * SELECT 前缀」，任何自带 WHERE / 以分号收尾 / 不以 select 开头的形状都会拼出非法 SQL。
 * 编译器 parse 不出来就**抛**，不猜（猜错的形状会在真库上以语法错的面目出现，排查成本高）。
 *
 * 关系名可带 schema（`dbt.fct_x`）：单租户/私有化形态下 dbt 的落点是显式 schema；
 * 多租户下 schema 由会话 search_path 绑（dbt/README §10），那时写非限定名。
 */
const L1_SELECT_RE =
  /^select\s+([\s\S]+?)\s+as\s+value\s*(?:,\s*[\s\S]+?)?\s+from\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)$/i

/** 产物里**绝不能出现**的词（「禁任意 SQL」的可机检落点）。带 \b 避免误伤 `created_at` 这类列名。 */
const FORBIDDEN_SQL_RE = /\b(insert|update|delete|drop|create|alter|grant|truncate|copy|attach|vacuum)\b/i

export interface L1SelectShape {
  /** `as value` 前的表达式，逐字保留（L2 不许改口径 ⇒ 编译产物里它必须原样出现）。 */
  expression: string
  /** FROM 的关系名（可带 schema）。 */
  relation: string
}

/** 解析 L1 的 select_sql；不合契约 ⇒ 抛 BAD_BASE_SQL（fail-closed，不猜）。 */
export function parseL1Select(selectSql: string): L1SelectShape {
  if (typeof selectSql !== 'string') {
    throw new SemanticCompileError('BAD_BASE_SQL', `L1 的 select_sql 不是字符串：${typeof selectSql}`)
  }
  const sql = selectSql.trim()
  if (sql.includes(';')) {
    throw new SemanticCompileError('BAD_BASE_SQL', 'L1 的 select_sql 含分号：它必须是一个不带分号的 SELECT 前缀')
  }
  if (FORBIDDEN_SQL_RE.test(sql)) {
    throw new SemanticCompileError('BAD_BASE_SQL', `L1 的 select_sql 含写/DDL 关键字：${sql}`)
  }
  const m = L1_SELECT_RE.exec(sql)
  if (m === null) {
    throw new SemanticCompileError(
      'BAD_BASE_SQL',
      `L1 的 select_sql 不合形状契约（应为 \`select <表达式> as value[, <维度>…] from <关系>\`）：${sql}`,
    )
  }
  const expression = m[1].trim()
  if (expression === '') {
    throw new SemanticCompileError('BAD_BASE_SQL', `L1 的 select_sql 值表达式为空：${sql}`)
  }
  return { expression, relation: m[2] }
}

/**
 * L1 声明的维度清单 = `groupBy` 拆出来的列名（**唯一来源**是 MetricDef.groupBy）。
 *
 * 为什么不从 select_sql 里再解析一遍维度：那就成了两个事实源（select 列表与 group_by
 * 可以不一致，而 parse 出来的那份没有机检兜底）。group_by 是授权核心真正拼进 SQL 的那份
 * （authorize 的 `GROUP BY ${metric.groupBy}`），以它为准，两边不可能说两套话。
 */
export function dimensionNamesOf(base: MetricDef): string[] {
  return base.groupBy.split(',').map((d) => d.trim()).filter((d) => d !== '')
}

/**
 * 从 L1 词表里取出 base；取不到 ⇒ 抛 L1_BASE_NOT_FOUND。
 *
 * ★ 只认 `source === 'l1'` 的行：`l1` 这个参数名是「L1 词表」，不是「任意词表」。
 *   若允许拿一条 L2 行当 base，L2 就能在别处 L2 的编译产物上再编译——口径链无上限。
 */
export function resolveL1Base(l1Catalog: readonly MetricRow[], baseMetric: string): MetricRow {
  const hit = l1Catalog.find((m) => m.id === baseMetric && m.source === 'l1')
  if (hit === undefined) {
    throw new SemanticCompileError(
      'L1_BASE_NOT_FOUND',
      `baseMetric \`${baseMetric}\` 不在 L1 词表里：L2 只能 refine 已声明的平台指标（新指标要进 dbt YAML 走 L1）`,
    )
  }
  return hit
}

/** 维度名必须 ∈ L1 声明的 grain（机检即写时校验）。 */
function assertDim(dim: string, baseDims: readonly string[], baseId: string): void {
  if (!baseDims.includes(dim)) {
    throw new SemanticCompileError(
      'UNKNOWN_DIM',
      `维度 \`${dim}\` 不在 L1 指标 \`${baseId}\` 声明的 grain（${baseDims.join(', ') || '（无）'}）里`,
    )
  }
}

/** 过滤子句 → SQL 片段。值一律走 authz 的 sqlQuote（**不另写一份转义**——转义两处写必然漂开）。 */
function filterSql(f: { dim: string; op: '=' | 'in'; values: string[] }): string {
  if (f.op !== '=' && f.op !== 'in') {
    throw new SemanticCompileError('BAD_FILTER', `过滤算子只支持 = / in，收到 \`${String(f.op)}\``)
  }
  if (f.values.length === 0) {
    throw new SemanticCompileError('BAD_FILTER', `过滤 \`${f.dim}\` 的 values 为空（空 in 恒假、空 = 无意义，都拒）`)
  }
  if (f.op === '=' && f.values.length !== 1) {
    throw new SemanticCompileError('BAD_FILTER', `过滤 \`${f.dim}\` 用 = 必须恰好一个值，收到 ${f.values.length} 个`)
  }
  for (const v of f.values) {
    if (typeof v !== 'string') {
      throw new SemanticCompileError('BAD_FILTER', `过滤 \`${f.dim}\` 的值必须是字符串，收到 ${typeof v}`)
    }
  }
  return f.op === '='
    ? `${f.dim} = ${sqlQuote(f.values[0])}`
    : `${f.dim} in (${f.values.map((v) => sqlQuote(v)).join(', ')})`
}

/**
 * 编译一条 L2 声明。返回的 `selectSql` 可直接交给 `domain/authz.ts` 的 authorize 续 WHERE。
 *
 * ── 两种产物形态（都满足上面的形状契约）────────────────────────────────────────
 * ① 无 filters（常见）：
 *      `select <L1 表达式> as value[, <可见维度>…] from <关系>`
 *    —— L1 表达式原样保留：换掉维度只改变**上滚粒度**，口径仍是 L1 那一份
 *       （L1 的 grain 语义 = 「可聚合维度清单」，见 dbt/semantics/l1_metrics.yml）。
 *
 * ② 有 filters：过滤必须**发生在聚合之前**，而 authorize 的 WHERE 槽位已经被主体钉死占用
 *    （`<selectSql> WHERE <主体列> = …`）⇒ 塞不下第二个 WHERE。故把过滤下推进 FROM 派生表：
 *      `select sum(t.value) as value[, t.<可见维度>…] from (
 *         select <L1 表达式> as value[, <L1 维度>…], <主体列>
 *           from <关系> where <过滤> group by <L1 维度>, <主体列>) t`
 *    外层再聚合一次 = 在**已按 L1 grain 聚合**的结果上按可见维度上滚——与 ① 的语义等价
 *    （sum 的 roll-up 满足结合律），且派生表**不改关系名**：L1 表达式里若带 schema 限定
 *    （`dbt.fct_x.col`）仍能解析。派生表把主体列一并选出，authz 的 `WHERE <主体列> = …`
 *    才能作用在外层。
 *
 * `title` = alias ?? base.title（别名只换叫法，不动口径）。
 *
 * 返回值比计划里写的多一个 `groupBy`：计划只列了 `{ selectSql, title }`，但落库时
 * `data.metrics.group_by` 是必填列，而它的值 = 本次编译选定的可见维度。若让路由自己再算一遍
 * 「visibility ?? L1 的 grain」，那个推导就有了**两个事实源**（编译点 + 路由），
 * 两者一旦漂开，SELECT 列表与 GROUP BY 会不一致——那正是「唯一编译点」要消灭的东西。
 * ⇒ 编译的产物把「行的全部派生字段」一并给出，路由只负责落库。
 */
export function compileL2(
  base: MetricDef,
  decl: L2Declaration,
): { selectSql: string; title: string; groupBy: string } {
  if (decl === null || typeof decl !== 'object') {
    throw new SemanticCompileError('BAD_DECL', 'L2 声明不是对象')
  }
  if (decl.op?.kind !== 'refine') {
    throw new SemanticCompileError(
      'OP_UNSUPPORTED',
      `op.kind 只支持 'refine'（v1 的 A 薄档），收到 \`${String(decl.op?.kind)}\`——受限表达式等更高的表达力档位要经 spec 增补`,
    )
  }

  const shape = parseL1Select(base.selectSql)
  const baseDims = dimensionNamesOf(base)
  // L1 行自己的 grain 也必须是干净标识符：authorize 会把它**原样**拼进 GROUP BY，
  // 而它可能来自一条手写/历史行（不是 sync 生成的）。这里顺带兜住。
  for (const d of baseDims) {
    if (!IDENT_RE.test(d)) {
      throw new SemanticCompileError('BAD_BASE_SQL', `L1 指标 \`${base.id}\` 的 group_by 里 \`${d}\` 不是合法列名`)
    }
  }

  // 裁剪：省略 visibility = 继承 L1 全部维度；显式给（含空数组）= 按给定白名单，且只少不多
  const dims = decl.visibility === undefined
    ? [...baseDims]
    : decl.visibility.dims.map((d) => {
        // 先按 L1 声明的维度做成员判定（越界/注入型维度名都在这一步被拒）
        assertDim(d, baseDims, base.id)
        return d
      })
  // 去重但保序（同一个维度写两遍会让 SELECT 列表出现重复列）
  const visibleDims = [...new Set(dims)]

  const filters = decl.filters ?? []
  for (const f of filters) {
    assertDim(f.dim, baseDims, base.id)
  }

  const title = decl.alias ?? base.title

  if (filters.length === 0) {
    const dimSelect = visibleDims.length > 0 ? `, ${visibleDims.join(', ')}` : ''
    return {
      selectSql: `select ${shape.expression} as value${dimSelect} from ${shape.relation}`,
      title,
      groupBy: visibleDims.join(', '),
    }
  }

  const where = filters.map(filterSql).join(' and ')
  const innerDims = [...baseDims, base.subjectColumn]
  const innerSelect = `select ${shape.expression} as value${baseDims.map((d) => `, ${d}`).join('')}, ${base.subjectColumn}` +
    ` from ${shape.relation} where ${where} group by ${innerDims.join(', ')}`
  const outerDims = visibleDims.map((d) => `, t.${d}`).join('')
  return {
    selectSql: `select sum(t.value) as value${outerDims} from (${innerSelect}) t`,
    title,
    groupBy: visibleDims.join(', '),
  }
}
