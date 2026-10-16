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
// ── 表达力档位（**别私自放宽**）───────────────────────────────────────────────
// 两档：`op.kind = 'refine'`（A 薄档：裁剪 / 别名 / 过滤 / 目标值）
// 与 `op.kind = 'expr'`（B 中档：受限算术组合多条 L1）。C 厚档仍排除。
// **B 中档的允许面以这份增补为准**（它同时订正了正典 §10 拍板 5 下本注释旧有的「写权限」读法）：
// docs/superpowers/specs/2026-10-12-l2-expressiveness-b-tier-design.md
// 再加档位要**先改那份增补**：档位不许先在码里放开。
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
  | 'OP_UNSUPPORTED'  // 档位不支持：op.kind 不在闭集（refine/expr）内，或 expr 声明了 filters（v1 边界）
  | 'L1_BASE_NOT_FOUND' // baseMetric 不在 L1 词表里（只有 L1 能当 base）
  | 'UNKNOWN_DIM'     // 引用了 L1 没声明的维度（机检：维度只能来自 L1 的 grain）
  | 'BAD_FILTER'      // 过滤子句形状不对（'=' 多值 / 'in' 空值 / op 越界）
  | 'BAD_BASE_SQL'    // L1 行的 select_sql 不合形状契约（见下「形状契约」节）
  // expr 档新增：参与运算的 refs 不在同一关系/grain/主体列上
  | 'MIXED_BASE'
  // expr 档新增：树超深或 ref 出现次数超量
  | 'EXPR_DEPTH_EXCEEDED'

export class SemanticCompileError extends Error {
  readonly code: CompileErrorCode
  constructor(code: CompileErrorCode, message: string) {
    super(message)
    this.name = 'SemanticCompileError'
    this.code = code
  }
}

/**
 * A 薄档（refine）的声明形状。**字段面与旧 `L2Declaration` 逐字相同**（这次只换名字）。
 */
export interface L2RefineDeclaration {
  baseMetric: string
  op: { kind: 'refine' }
  alias?: string
  visibility?: { dims: string[] }
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]
  target?: number
}

/**
 * B 中档（expr）的声明形状：用受限算术把**多条 L1** 组合成新测度。
 *
 * `filters?` **在这里，是故意的**（增补 §3.1）：声明了再由编译器以 `OP_UNSUPPORTED` 拒 ——
 * 调用方多半是从 refine 声明拷来的，要给的信号是「这个 op 还不支持 filters」，
 * 而不是「不认识这个键」。空数组也算「声明了」。
 */
export interface L2ExprDeclaration {
  op: { kind: 'expr'; expr: ExprNode }
  alias?: string
  visibility?: { dims: string[] }
  filters?: { dim: string; op: '=' | 'in'; values: string[] }[]
}

/**
 * L2 声明：以 `op.kind` 为判别键的**判别式 union**。
 * 两支的 `op.kind` 字面量互斥 ⇒ 不会歧义匹配；union **按各自 member** 校验宽容度
 * （refine 去宽、expr 从严），互不影响。
 */
export type L2Declaration = L2RefineDeclaration | L2ExprDeclaration

/** 维度名只许是 PG 标识符（白名单外的字符一律进不了 SQL——它们在 L1 的 grain 里也不存在）。 */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 表达式节点（增补 §2.2，**闭集**）。
 *
 * 为什么不给函数名 / 不给字符串表达式：节点集**就是**「能产生什么 SQL」的词表 ——
 * 它等于 zod schema 本身，可以被单测穷举断言；换成表达式字符串就是把「禁任意 SQL」
 * 这条安全属性换成「解析器恰好正确」这条赌注（增补 §2.1）。
 * 除零守卫由编译器注入（见 `renderExprNode`），不作为租户可选项 —— 少一个校验面。
 */
export type ExprNode =
  | { kind: 'ref'; id: string }
  | { kind: 'num'; value: number }
  | { kind: 'add' | 'sub' | 'mul' | 'div'; left: ExprNode; right: ExprNode }

/**
 * A 薄档的写时校验。**字段面与宽容度逐字保留**原 `L2DeclarationSchema` ——
 * 它就是那一份，只多了名字（非 strict：多余的键被 strip，与旧行为一致）。
 */
export const L2RefineDeclarationSchema = z.object({
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
 * 表达式节点的 zod 形状。`z.lazy` 是递归 schema 的唯一写法（节点自引用）。
 * 每个成员 `.strict()`：多带任何键（如 `{kind:'ref', id:'x', fn:'sum'}`）都拒 ——
 * 节点集就是词表，词表外的键不该被静默 strip。
 */
export const ExprNodeSchema: z.ZodType<ExprNode> = z.lazy(() => z.union([
  z.object({ kind: z.literal('ref'), id: z.string().min(1).max(128) }).strict(),
  z.object({ kind: z.literal('num'), value: z.number().finite() }).strict(),
  z.object({
    kind: z.enum(['add', 'sub', 'mul', 'div']),
    left: ExprNodeSchema,
    right: ExprNodeSchema,
  }).strict(),
]))

/**
 * B 中档的写时校验。与 refine 支**故意不同**：这里 `.strict()`（多带 `baseMetric`/`target` ⇒ 拒），
 * 但 `filters` **声明**为 optional —— 由编译器以 `OP_UNSUPPORTED` 拒（增补 §3.1，理由见 L2ExprDeclaration）。
 */
export const L2ExprDeclarationSchema = z.object({
  op: z.object({ kind: z.literal('expr'), expr: ExprNodeSchema }).strict(),
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
}).strict()

/**
 * L2 声明的写时校验（**唯一事实源**）：按 `op.kind` 判别。
 * 用 union 而不是 `.extend()` 拼单支：ZodUnion 没有 `.extend()`，
 * 而且两支的宽容度不同，本来就必须分开校验。
 */
export const L2DeclarationSchema = z.union([L2RefineDeclarationSchema, L2ExprDeclarationSchema])

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
// 导出是为了让测试能直接断言"编译产物永不含 DDL/DML 关键字"这条不变量（B 中档的随机树 fuzz 也用它）。
export const FORBIDDEN_SQL_RE = /\b(insert|update|delete|drop|create|alter|grant|truncate|copy|attach|vacuum)\b/i

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
 * 断言一份 grain 的每个维度都是干净标识符（授权层会把它**原样**拼进 GROUP BY）。
 * refine 与 expr 共用：两档的维度都来自 L1 行，而行可能是手写/历史行（不都是 sync 生成的）。
 * 返回维度列表，省掉调用方再查一次。
 */
function assertCleanDims(base: MetricDef): string[] {
  const dims = dimensionNamesOf(base)
  for (const d of dims) {
    if (!IDENT_RE.test(d)) {
      throw new SemanticCompileError('BAD_BASE_SQL', `L1 指标 \`${base.id}\` 的 group_by 里 \`${d}\` 不是合法列名`)
    }
  }
  return dims
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

/**
 * 生效可见维度：省略 `visibility` = 继承 L1 全部维度；显式给（含空数组）= 按白名单，且只少不多。
 * 去重但保序（`[...new Set(...)]`）—— 重复维度不该出现在 GROUP BY 里两次。
 */
function visibleDimsOf(
  decl: Pick<L2Declaration, 'visibility'>,
  baseDims: readonly string[],
  baseId: string,
): string[] {
  if (decl.visibility === undefined) return [...baseDims]
  const dims = decl.visibility.dims.map((d) => {
    assertDim(d, baseDims, baseId)
    return d
  })
  return [...new Set(dims)]
}

/** 规模上限（可调常量，与 schema 同文件 —— 增补 §2.7）。 */
const EXPR_MAX_DEPTH = 8
/** `ref` 的**出现次数**上限。注意：同一个 id 出现两次算两次（增补 §2.7 的「ref 总数」）。 */
const EXPR_MAX_REFS = 16

/**
 * 入口**结构嵌套**预检上限（#593）。口径：信封 3 层 + expr 上限 8 层的二叉展开 ⇒ 合法声明 ≤ ~20 层；
 * 而递归 schema 的爆点实测在 1600~3200 层之间。取 **64**：对合法面 3 倍余量、对爆点 25 倍以上余量。
 */
export const MAX_BODY_NESTING = 64

/**
 * 线性（**迭代**）判「结构嵌套是否超过 `limit` 层」——数组与对象的每一层都算一层。
 *
 * 为什么必须有它：`ExprNodeSchema` 是 `z.lazy` **递归** schema，其校验**先于** `scanExpr` 的迭代
 * 深度闸执行 ⇒ 病态深输入在 zod 里**爆栈**（`RangeError`）冒成 500（实测 1600 层过、3200 层爆）。
 * 本函数用**显式栈**，自己不会爆；把它插在 schema 之前，zod 就永远拿不到能爆栈的形状。
 *
 * @param {unknown} root
 * @param {number} [limit]
 * @returns {boolean} true = 过深（调用方转干净 400）
 */
export function exceedsNesting(root: unknown, limit: number = MAX_BODY_NESTING): boolean {
  /** @type {{ v: unknown; d: number }[]} */
  const stack = [{ v: root, d: 0 }]
  while (stack.length > 0) {
    const top = stack.pop()
    if (top === undefined) break
    const { v, d } = top
    if (d > limit) return true
    if (Array.isArray(v)) {
      for (const x of v) stack.push({ v: x, d: d + 1 })
    } else if (v !== null && typeof v === 'object') {
      for (const x of Object.values(v)) stack.push({ v: x, d: d + 1 })
    }
  }
  return false
}

/**
 * 走一遍表达式树：形状校验 + 深度 + ref 去重/计数。**一遍做完**，且用显式栈 ——
 * 深树不会打爆调用栈（zod 那关可能先爆，那是另一条边界，见 README 已知边界）。
 *
 * 为什么形状校验也在这里（不是只靠 zod）：编译器的入参在**类型上**已经是 `L2Declaration`，
 * 但类型可以用 `as` 绕过，而 zod 只校验入口。编译器是拼 SQL 的地方，必须 fail-closed ——
 * 「面级拒绝」和「编译期拒绝」是两道，不是一道（见「为什么这样切」⑥）。
 *
 * 报错时机：**先走完整棵树再报量纲**，这样错误信息里带得出「实际多少」（比走到一半就抛更好排障）。
 */
function scanExpr(root: unknown): { refIds: string[]; refCount: number; depth: number } {
  const stack: { node: unknown; level: number }[] = [{ node: root, level: 1 }]
  const refIds: string[] = []
  const seen = new Set<string>()
  let refCount = 0
  let depth = 0

  while (stack.length > 0) {
    const top = stack.pop()
    if (top === undefined) break
    const node = top.node
    const level = top.level
    if (node === null || typeof node !== 'object') {
      throw new SemanticCompileError('BAD_DECL', `表达式节点不是对象：${typeof node}`)
    }
    depth = Math.max(depth, level)
    const kind = (node as { kind?: unknown }).kind

    if (kind === 'num') {
      const value = (node as { value?: unknown }).value
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new SemanticCompileError('BAD_DECL', `表达式里的数字字面量必须是有限数，收到 \`${String(value)}\``)
      }
      continue
    }
    if (kind === 'ref') {
      const id = (node as { id?: unknown }).id
      if (typeof id !== 'string' || id === '') {
        throw new SemanticCompileError('BAD_DECL', '表达式里的 ref 必须带非空 id')
      }
      refCount += 1
      if (!seen.has(id)) {
        seen.add(id)
        refIds.push(id)
      }
      continue
    }
    if (kind === 'add' || kind === 'sub' || kind === 'mul' || kind === 'div') {
      // LIFO ⇒ 先压 right 再压 left，弹出顺序才是 left → right（ref 次序可复现）
      stack.push({ node: (node as { right?: unknown }).right, level: level + 1 })
      stack.push({ node: (node as { left?: unknown }).left, level: level + 1 })
      continue
    }
    throw new SemanticCompileError('BAD_DECL', `表达式节点 kind 不在闭集内，收到 \`${String(kind)}\``)
  }

  if (refCount > EXPR_MAX_REFS) {
    throw new SemanticCompileError(
      'EXPR_DEPTH_EXCEEDED',
      `表达式里的 ref 出现 ${refCount} 次，超过上限 ${EXPR_MAX_REFS}（同一 id 出现两次算两次）`,
    )
  }
  if (depth > EXPR_MAX_DEPTH) {
    throw new SemanticCompileError('EXPR_DEPTH_EXCEEDED', `表达式树深 ${depth}，超过上限 ${EXPR_MAX_DEPTH}`)
  }
  return { refIds, refCount, depth }
}

/** 二元算符 → SQL 拼写。**放在 renderExprNode 之外**：门禁⑧-d 只扫函数体，这里的 `add:` 之类不该混进 case 集。 */
const EXPR_OP_SQL: Record<'add' | 'sub' | 'mul', string> = { add: '+', sub: '-', mul: '*' }

/**
 * 表达式节点 → SQL 片段。**唯一渲染点**（树里每个字节都出自这里 ⇒ 可穷举断言）。
 *
 * `div` 的除零守卫由**编译器注入**：`(a) / NULLIF((b), 0)` ⇒ 0 分母得 NULL（不是 0 —— 0 会污染
 * 下游均值/累计）。租户看不到也控制不了它（增补 §2.4）。
 *
 * `switch` 是**穷尽的**：`default` 把 node 赋给 `never` ⇒ 节点集一改，typecheck 当场红
 * （这是「节点集是闭集」在类型层的落点，别删）。
 */
export function renderExprNode(node: ExprNode, refExpr: ReadonlyMap<string, string>): string {
  switch (node.kind) {
    case 'num':
      return String(node.value)
    case 'ref': {
      const expr = refExpr.get(node.id)
      if (expr === undefined) {
        throw new SemanticCompileError('BAD_DECL', `表达式引用了未解析的 L1 \`${node.id}\`（内部错误：ref 解析表缺项）`)
      }
      return expr
    }
    case 'add':
    case 'sub':
    case 'mul':
      return `(${renderExprNode(node.left, refExpr)}) ${EXPR_OP_SQL[node.kind]} (${renderExprNode(node.right, refExpr)})`
    case 'div':
      return `(${renderExprNode(node.left, refExpr)}) / NULLIF((${renderExprNode(node.right, refExpr)}), 0)`
    default: {
      const unknownNode: never = node
      throw new SemanticCompileError('BAD_DECL', `表达式节点 kind 不在闭集内：${JSON.stringify(unknownNode)}`)
    }
  }
}

/**
 * 一条声明用到的全部 L1 ref id（去重保序）—— 写路径的 adopted 闸按它**逐个**校验（增补 §4.2）。
 *
 * **宽容**：形状不对时返回 `[]` 而**不抛**。它服务于「先算闸、再编译」的顺序；形状错该由
 * schema / 编译器响亮地拒 —— 在这里抛会把一个 zod 该报的错伪装成编译错。
 */
export function collectRefIds(decl: L2Declaration): string[] {
  if (decl === null || typeof decl !== 'object') return []
  const op = (decl as { op?: unknown }).op
  const kind = (op !== null && typeof op === 'object') ? (op as { kind?: unknown }).kind : undefined
  if (kind === 'refine') {
    const base = (decl as { baseMetric?: unknown }).baseMetric
    return typeof base === 'string' ? [base] : []
  }
  if (kind !== 'expr') return []

  const stack: unknown[] = [(op as { expr?: unknown }).expr]
  const out: string[] = []
  const seen = new Set<string>()
  while (stack.length > 0) {
    const node = stack.pop()
    if (node === null || typeof node !== 'object') continue
    const nk = (node as { kind?: unknown }).kind
    if (nk === 'ref') {
      const id = (node as { id?: unknown }).id
      if (typeof id === 'string' && id !== '' && !seen.has(id)) {
        seen.add(id)
        out.push(id)
      }
      continue
    }
    if (nk === 'add' || nk === 'sub' || nk === 'mul' || nk === 'div') {
      stack.push((node as { right?: unknown }).right)
      stack.push((node as { left?: unknown }).left)
    }
  }
  return out
}

/**
 * 编译产物 = 行的**全部派生字段**（路由只负责落库，不再自己推导 —— 见「为什么这样切」③）。
 *
 * 比旧版多 `description` / `subjectColumn`：expr 的基是**树里多个** ref，路由拿不到「那一个 base」；
 * 让路由自己挑一个来继承主体列 / 拼派生关系，就有了第二个事实源。
 */
export interface CompiledL2 {
  selectSql: string
  title: string
  description: string
  subjectColumn: string
  groupBy: string
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
 * A 薄档（refine）的编译。原 `compileL2` 的行为逐字保留。
 * 返回的 `selectSql` 可直接交给 `domain/authz.ts` 的 authorize 续 WHERE。
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
function compileRefine(l1Catalog: readonly MetricRow[], decl: L2RefineDeclaration): CompiledL2 {
  const base = resolveL1Base(l1Catalog, decl.baseMetric)

  const shape = parseL1Select(base.selectSql)
  const baseDims = assertCleanDims(base)
  const visibleDims = visibleDimsOf(decl, baseDims, base.id)

  const filters = decl.filters ?? []
  for (const f of filters) {
    assertDim(f.dim, baseDims, base.id)
  }

  const title = decl.alias ?? base.title
  const description = `L2 派生自 ${base.id}`

  if (filters.length === 0) {
    const dimSelect = visibleDims.length > 0 ? `, ${visibleDims.join(', ')}` : ''
    return {
      selectSql: `select ${shape.expression} as value${dimSelect} from ${shape.relation}`,
      title,
      description,
      subjectColumn: base.subjectColumn,
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
    description,
    subjectColumn: base.subjectColumn,
    groupBy: visibleDims.join(', '),
  }
}

/**
 * B 中档（expr）的编译。
 *
 * 产物形状与 refine **同形**：`select <树> as value[, 可见维度] from <关系>` ——
 * 只是 `<表达式>` 由「单条 L1 的 expression」换成「树的内联渲染」（增补 §4.1，表列不变）。
 */
function compileExpr(l1Catalog: readonly MetricRow[], decl: L2ExprDeclaration): CompiledL2 {
  // ① filters 是 v1 已知边界（增补 §2.5）。判据是「**声明了**」而不是「非空」：
  //    空数组也拒 —— 「声明了却什么都不做」比拒绝更难查（调用方以为切片生效了）。
  if (decl.filters !== undefined) {
    throw new SemanticCompileError(
      'OP_UNSUPPORTED',
      'expr 声明暂不支持 filters（v1 边界）：比例/比率不可加，对派生表重聚合 sum 是错的'
      + '（增补 §2.5）—— 请先在 L1 侧切片',
    )
  }

  // ② 形状 + 量纲闸（一遍走完；越深/越量在这里响亮拒绝）
  const { refIds } = scanExpr(decl.op.expr)

  // ③ 逐个 ref 解析 + 同基校验（关系 / grain / 主体列 三者逐字相等）
  const firstId = refIds[0]
  if (firstId === undefined) {
    // 只有字面量的树（如 num:3）拼不出 from 子句 —— 这不是 MIXED_BASE 也不是词表问题
    throw new SemanticCompileError('BAD_DECL', 'expr 至少要引用一条 L1（只有字面量时算不出关系，拼不出 from 子句）')
  }
  const first = resolveL1Base(l1Catalog, firstId)
  const sharedShape = parseL1Select(first.selectSql)
  const sharedDims = assertCleanDims(first)
  const refExpr = new Map<string, string>([[first.id, sharedShape.expression]])

  for (const id of refIds.slice(1)) {
    const other = resolveL1Base(l1Catalog, id)
    const otherShape = parseL1Select(other.selectSql)
    const otherDims = assertCleanDims(other)
    if (
      otherShape.relation !== sharedShape.relation
      || otherDims.join(', ') !== sharedDims.join(', ')
      || other.subjectColumn !== first.subjectColumn
    ) {
      throw new SemanticCompileError(
        'MIXED_BASE',
        `表达式的 ref 不在同一基上 —— \`${first.id}\`(关系 ${sharedShape.relation} / grain ${sharedDims.join(', ')} / 主体列 ${first.subjectColumn})`
        + ` vs \`${other.id}\`(关系 ${otherShape.relation} / grain ${otherDims.join(', ')} / 主体列 ${other.subjectColumn})：`
        + '跨关系 / 跨粒度 / 跨主体列拼不出合法且有意义的 SELECT（例如跨粒度的比值，分母是另一粒度的部分和）',
      )
    }
    refExpr.set(other.id, otherShape.expression)
  }

  const visibleDims = visibleDimsOf(decl, sharedDims, first.id)
  const dimSelect = visibleDims.length > 0 ? `, ${visibleDims.join(', ')}` : ''
  return {
    selectSql: `select ${renderExprNode(decl.op.expr, refExpr)} as value${dimSelect} from ${sharedShape.relation}`,
    title: decl.alias ?? `派生(${refIds.join(' / ')})`,
    description: `L2 派生自 (${refIds.join(', ')})`,
    subjectColumn: first.subjectColumn,
    groupBy: visibleDims.join(', '),
  }
}

/**
 * L2 声明的唯一编译点：按 `op.kind` 分派到档位编译函数。
 *
 * ★ 判别键**两段式读**：`decl.op` 在类型上一定有，但**运行时**可能不是对象
 *   （调用方 `as` 绕过 / 历史数据）⇒ 读之前先收形状，不能直接点。
 * ★ 这里**只**分派，不编译 —— 每个档位的产物形状由它自己的函数负责。
 */
export function compileL2(l1Catalog: readonly MetricRow[], decl: L2Declaration): CompiledL2 {
  if (decl === null || typeof decl !== 'object') {
    throw new SemanticCompileError('BAD_DECL', 'L2 声明不是对象')
  }
  const op: unknown = (decl as { op?: unknown }).op
  const opKind = (op !== null && typeof op === 'object') ? (op as { kind?: unknown }).kind : undefined
  if (opKind === 'refine') return compileRefine(l1Catalog, decl as L2RefineDeclaration)
  if (opKind === 'expr') return compileExpr(l1Catalog, decl as L2ExprDeclaration)
  throw new SemanticCompileError(
    'OP_UNSUPPORTED',
    `op.kind 只支持 'refine'（A 薄档）| 'expr'（B 中档），收到 \`${String(opKind)}\`——C 厚档要经 spec 增补`,
  )
}
