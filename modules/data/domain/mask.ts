// mask.ts — 值级掩码的运行期展开（spec 2026-10-17 §5.3）：**纯函数**，不认识 pool / env / Hono。
//
// 授权时刻（authz.authorize）把声明面（MetricDef.masks）**定点展开**进 selectSql 的列引用上
// ——掩码必须包在聚合**内部**（`sum(round(x, -n))`，不是 `round(sum(x), -n)`）：掩的是每一行
// 参与聚合的值，不是聚合结果。展开只作用于本函数返回的 SQL 副本，**绝不回写库**
// （Global Constraint 6：select_sql 是编译产物，掩码进它会被 L2 编译原样带出去）。
//
// 词表（MASK_KINDS / MaskKind / MaskSpec）**唯一定义**在 ./authz，这里只消费——别另立一份。
import type { MaskSpec } from './authz'

/**
 * 整值掩码的 applied 记号键：掩码目标不是一个列，而是「`… as value` 的整个表达式」，
 * 列名键表达不了这个目标，用保留记号占位（响应 masking 面消费方可解释「整个值都是掩过的」）。
 */
export const WHOLE_VALUE_KEY = '<value>'

/**
 * applied 记号值：`round:<step>` / `nullify`。
 *
 * ⚠️ 词表外的 kind（只能来自手改的库/历史行，声明门禁拦得住写侧）在 maskExpr 里落 typed NULL
 * （语义等同 nullify），这里仍**如实回显声明的 kind**——对账面要能一眼看出「声明与词表不符」，
 * 而不是把它伪装成 nullify（T2-m1，issue #824）。
 */
function notationOf(spec: MaskSpec): string {
  return spec.kind === 'round' ? `round:${spec.step}` : spec.kind
}

/**
 * 掩码表达式。返回值只经 replace 的**回调**注入（见 maskedSelectSql）——掩码表达式里将来
 * 若出现 `$`（如 bucket 的标签），字符串形态会被 replace 当替换模式解释，静默产生垃圾 SQL。
 *
 * ★ **穷尽性锚**（T2-m1，issue #824）：`spec.kind` 的类型 `MaskKind` 由 ./authz 的 `MASK_KINDS`
 *   派生 ⇒ 词表新增一个 kind 而这里漏加分支时，`default` 里的 `never` 断言**编译期报错**，
 *   而不是运行期静默把新 kind 当 nullify 掩掉（静默换语义 = 本设计最怕的形态）。
 *   运行期兜底仍保留：库里的 jsonb 可能带词表外的 kind（门禁拦得住写侧，拦不住手改的库），
 *   那时落 typed NULL 是 fail-closed 的正确方向（绝不回原值）。
 */
function maskExpr(spec: MaskSpec): string {
  switch (spec.kind) {
    case 'round':
      // step 由声明侧校验（正整数）且只来自 sync 物化的 jsonb——与 select_sql 同一行、同一写方、
      // 同一信任层级（select_sql 本身就是逐字内联的 SQL 文本）。形状被篡改时（step 缺失/非数字）
      // 展开成必然报错的 SQL（warehouse_error）——仍是 fail-closed：宁可查询失败，不回原值。
      return `round(${spec.column}, -${spec.step})`
    case 'nullify':
      // typed NULL——`sum(NULL)` 无类型会报错，必须带类型。
      return 'cast(null as numeric)'
    default: {
      // 穷尽性锚：MASK_KINDS 加成员而漏分支 ⇒ `spec.kind` 在此**不是 never** ⇒ 本行编译期报错。
      const outOfVocabulary: never = spec.kind
      void outOfVocabulary
      // 词表外的 kind（手改的库/历史行）：整列/整值换 NULL，fail-closed，绝不回原值；
      // applied 如实回显原始 kind 供响应 masking 面对账（见 notationOf）。
      return 'cast(null as numeric)'
    }
  }
}

/** 形状契约里的**固定别名**（`select <表达式> as value`，见 semantic-compiler.ts 的 L1_SELECT_RE）——
 *  它是记号不是列引用，按列掩码必须跳过它（见 maskedSelectSql 的 T2-m3② 注）。 */
const VALUE_ALIAS = 'value'

/** 正则元字符转义：限定列引用里的 `.` 必须按字面匹配（裸 `.` 会命中任意字符）。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 整值掩码（`column === null`）的改写：把 `select <表达式> as value` 的表达式整段换掉，
 * **保留 `as value` 之后的维度列**。形状与 `L1_SELECT_RE`（semantic-compiler.ts）同源
 * ——照它抄，不自创；非全局正则（只有一个 value 头，也不存在 lastIndex 问题）。
 *
 * ★ **尾锚**（T2-m3①，issue #824）：`as value` 之后**必须**是形状契约的续接（`,` 起维度表，
 *   或直接 `from`）——初版只写到 `as\s+value`，`select x as value_added …` 这类**别名不是
 *   `value`** 的串也会命中，替换后产出垃圾 SQL。`(?=…)` 只断言不消费，故 `head[0]` 仍精确
 *   止于 `value`（按列分支靠这个末端反推别名位，见 maskedSelectSql）。
 */
const WHOLE_VALUE_HEAD_RE = /^select\s+([\s\S]+?)\s+as\s+value(?=\s*(?:,|from\b))/i

/**
 * 值级掩码展开（spec §5.3）：按声明逐条消费，返回改写后的 SQL 与「生效记录」。
 *
 * - `hasScope(spec.grantedBy)` 为真 ⇒ **看原值**，该条跳过（豁免方向与 requiredScope 相反）。
 * - 按列掩码：限定列引用以 `\b` 词边界在 selectSql 里逐字查找（`cost` 不得命中 `cost_money`
 *   ——子串误伤 = 把没声明的列也掩了）；**不在** selectSql 里 ⇒ 不改、不记（L2 编译已把
 *   契约列展开成 marts 列的情形，声明侧拦不到、运行期静默跳过）。
 * - 整值掩码：`… as value` 的表达式整个替换（spec §4.1.1 默认档——契约列根本不出现在
 *   selectSql 里，按列替换一个都命中不了）。
 *
 * ⚠️ 带 `g` 的正则只走 `replace`、**不**先 `.test()`（`.test()` 会推进 `lastIndex`，同一
 *    正则复用时会跳过命中）；命中与否用「replace 后比较是否变化」判，避开 lastIndex。
 * ⚠️ replace 的替换值走**回调**：字符串形态下 `$&` / `$1` 会被当替换模式解释，掩码表达式
 *    里出现 `$` 就静默产生垃圾 SQL。
 */
export function maskedSelectSql(
  selectSql: string,
  masks: MaskSpec[] | null | undefined,
  hasScope: (code: string) => boolean,
): { sql: string; applied: Record<string, string> } {
  const applied: Record<string, string> = {}
  if (!masks || masks.length === 0) return { sql: selectSql, applied }
  let sql = selectSql
  for (const spec of masks) {
    if (hasScope(spec.grantedBy)) continue   // 持有豁免码 ⇒ 看原值
    if (spec.column === null) {
      // 整值掩码：只动 selectSql 的副本（上面的 `let sql`），绝不回写库
      const next = sql.replace(WHOLE_VALUE_HEAD_RE, () => `select ${maskExpr(spec)} as value`)
      if (next === sql) continue   // 形状不合（无 `… as value` 头）⇒ 不改、不记
      sql = next
      applied[WHOLE_VALUE_KEY] = notationOf(spec)
      continue
    }
    // 按列掩码：词边界防子串误伤；g 正则替换全部出现处（同一列被引用多次都要掩）。
    // ★ 别名位跳过（T2-m3②，issue #824）：`… as value` 的 `value` 是**固定记号**、不是列引用。
    //   声明里若有个恰好叫 `value` 的列（`\bvalue\b` 会命中别名本身），替换它 = 把别名换成
    //   掩码表达式 ⇒ 坏 SQL。别名区间按头部正则的命中**末端**反推（`head[0]` 止于 `value`）。
    //   ⚠️ 跳过带来的后果是「只命中别名的声明会静默不掩码」（fail-open）——那由声明门禁拦掉
    //     （masksOf 的 presence 检查已把别名位剔出比对基准），运行期不在这里兜。
    const head = WHOLE_VALUE_HEAD_RE.exec(sql)
    const aliasStart = head === null ? -1 : head[0].length - VALUE_ALIAS.length
    const colRe = new RegExp(`\\b${escapeRe(spec.column)}\\b`, 'g')
    const next = sql.replace(colRe, (match, offset: number) =>
      offset === aliasStart ? match : maskExpr(spec))
    if (next === sql) continue   // 列引用不在 selectSql 里 ⇒ 不改、不记
    sql = next
    applied[spec.column] = notationOf(spec)
  }
  return { sql, applied }
}
