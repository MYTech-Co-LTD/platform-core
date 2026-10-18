// mask.ts — 值级掩码的运行期展开（spec 2026-10-17 §5.3）：**纯函数**，不认识 pool / env / Hono。
//
// 授权时刻（authz.authorize）把声明面（MetricDef.masks）**定点展开**进 selectSql 的列引用上
// ——掩码必须包在聚合**内部**（`sum(round(x, -n))`，不是 `round(sum(x), -n)`）：掩的是每一行
// 参与聚合的值，不是聚合结果。展开只作用于本函数返回的 SQL 副本，**绝不回写库**
// （Global Constraint 6：select_sql 是编译产物，掩码进它会被 L2 编译原样带出去）。
//
// 词表（MASK_KINDS / MaskKind / MaskSpec）**唯一定义**在 ./authz，这里只消费——别另立一份。
import type { MaskSpec, MetricDef } from './authz'

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
 * `as` 与固定别名之间的**尾锚**：允许空白；别名之后**必须**紧跟 `,` 或 `from`（词边界）。
 * ★ 尾锚（T2-m3①，issue #824）：无它则 `select x as value_added …` 这类**别名不是 `value`**
 *   的串也会命中，改写后产出的列别名不是 `value`，下游按 `value` 取列的地方全错。
 *   `(?=…)` 只断言不消费 ⇒ 命中末端仍精确止于别名本身。
 */
const AS_VALUE_TAIL_RE = new RegExp(`^\\s+${VALUE_ALIAS}(?=\\s*(?:,|from\\b))`, 'i')

/** 别名位判据：匹配处**紧跟在 `as ` 之后** ⇒ 那是别名，不是列引用（大小写不敏感）。 */
const ALIAS_BEFORE_RE = /\bas\s+$/i

/**
 * 顶层 `… as value` 头的三段偏移。**深度与单引号感知**——PR #827 评审 M6 实测：
 * 非贪婪正则会在 `select (select 1 as value from x) + sum(t.y) as value from t` 上
 * 命中**内层**那个 `as value`（其后正好是 ` from`，lookahead 成立）⇒ 产出垃圾 SQL。
 * 形状与 `L1_SELECT_RE`（semantic-compiler.ts）同源：`select <表达式> as value[, 维度…] from …`。
 *
 * ★ **尾锚**（T2-m3①，issue #824）：`value` 之后**必须**是形状契约的续接（`,` 起维度表，
 *   或直接 `from`）——否则 `select x as value_added …` 这类**别名不是 `value`** 的串也会命中。
 *
 * @returns null = 形状不合（无顶层 `… as value`）⇒ 调用方「不改、不记」。
 */
export function topLevelValueHead(sql: string): { exprStart: number; aliasStart: number; aliasEnd: number } | null {
  // 要点：① 只扫到第一个顶层 `from` 为止；② `as` 与 `value` 之间允许空白；
  //       ③ `value` 之后必须紧跟 `,` 或 `from`（词边界）；④ 大小写不敏感。
  const head = /^select\s+/i.exec(sql)
  if (head === null) return null
  const exprStart = head[0].length
  let depth = 0
  let inQuote = false
  let i = exprStart
  while (i < sql.length) {
    const ch = sql.charAt(i)
    if (inQuote) {
      if (ch === "'") {
        // SQL 标准转义：`''` 是一个字面引号，不结束字面量
        if (sql.charAt(i + 1) === "'") { i += 2; continue }
        inQuote = false
      }
      i += 1
      continue
    }
    if (ch === "'") { inQuote = true; i += 1; continue }
    if (ch === '(') { depth += 1; i += 1; continue }
    if (ch === ')') { depth -= 1; i += 1; continue }
    if (depth === 0) {
      // 顶层 `from` 已到 ⇒ 头区间结束，此前没找到头 ⇒ 形状不合
      if (keywordAt(sql, i, 'from')) return null
      if (keywordAt(sql, i, 'as')) {
        const tail = AS_VALUE_TAIL_RE.exec(sql.slice(i + 'as'.length))
        if (tail !== null) {
          const aliasStart = i + 'as'.length + tail[0].length - VALUE_ALIAS.length
          return { exprStart, aliasStart, aliasEnd: aliasStart + VALUE_ALIAS.length }
        }
      }
    }
    i += 1
  }
  return null
}

/** 位置 `i` 处是否为关键字 `kw`（前后词边界；大小写不敏感）。 */
function keywordAt(sql: string, i: number, kw: string): boolean {
  if (sql.slice(i, i + kw.length).toLowerCase() !== kw) return false
  return !/[A-Za-z0-9_]/.test(sql.charAt(i - 1)) && !/[A-Za-z0-9_]/.test(sql.charAt(i + kw.length))
}

/**
 * 值级掩码展开（spec §5.3）：按声明逐条消费，返回改写后的 SQL 与「生效记录」。
 *
 * - `hasScope(spec.grantedBy)` 为真 ⇒ **看原值**（豁免方向与 requiredScope 相反）：该条不掩，
 *   但**在场时记进 `exempted`**（「这个人这次看的是原值」也是审计要能回答的问题，spec §4.4.1）。
 * - 按列掩码：限定列引用以 `\b` 词边界在 selectSql 里逐字查找（`cost` 不得命中 `cost_money`
 *   ——子串误伤 = 把没声明的列也掩了）；**不在** selectSql 里 ⇒ 不改、不记（L2 编译已把
 *   契约列展开成 marts 列的情形，声明侧拦不到、运行期静默跳过）。
 * - 整值掩码：`… as value` 的表达式整个替换（spec §4.1.1 默认档——契约列根本不出现在
 *   selectSql 里，按列替换一个都命中不了）。
 *
 * ★ **在场先于豁免**（T7，#823）：先判「这条声明到底有没有命中（改了没改）」，再决定记
 *   `applied` 还是 `exempted`——否则「豁免了、但目标根本不在 SQL 里」的声明会被**假记**成
 *   exempted（它其实什么都没发生）。所有判定读的都是**当前** `sql`（可能已被前一条掩码改过），
 *   与 `applied` 的记法一致（记的是「这次实际改没改」）。
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
): { sql: string; applied: Record<string, string>; exempted: string[] } {
  const applied: Record<string, string> = {}
  const exempted: string[] = []
  if (!masks || masks.length === 0) return { sql: selectSql, applied, exempted }
  let sql = selectSql
  for (const spec of masks) {
    const exempt = hasScope(spec.grantedBy)
    if (spec.column === null) {
      // 整值掩码：只动 selectSql 的副本（上面的 `let sql`），绝不回写库。
      // 头区间由 topLevelValueHead 给（深度/引号感知，M6）：`exprStart` 之前是 `select ` 前缀、
      // `aliasEnd` 之后是 `, 维度… from …`，两段都原样保留 ⇒ 只换表达式那一整段。
      const h = topLevelValueHead(sql)
      if (h === null) continue   // 形状不合（无顶层 `… as value` 头）⇒ 不改、不记（★ 在场先于豁免）
      if (exempt) { exempted.push(WHOLE_VALUE_KEY); continue }
      sql = sql.slice(0, h.exprStart) + maskExpr(spec) + ` as ${VALUE_ALIAS}` + sql.slice(h.aliasEnd)
      applied[WHOLE_VALUE_KEY] = notationOf(spec)
      continue
    }
    // 按列掩码：词边界防子串误伤；g 正则替换全部出现处（同一列被引用多次都要掩）。
    // ★ 别名位跳过（T2-m3②，issue #824）：`… as value` 的 `value` 是**固定记号**、不是列引用。
    //   声明里若有个恰好叫 `value` 的列（`\bvalue\b` 会命中别名本身），替换它 = 把别名换成
    //   掩码表达式 ⇒ 坏 SQL。判据是「匹配处**紧跟在 `as ` 之后**」——它在构造上同时覆盖
    //   顶层与内层别名（M1②：`(select 1 AS VALUE) + sum(t.y) as value` 里内层那个 `AS VALUE`
    //   也不是列引用）。⚠️ 别改用 topLevelValueHead 的 aliasStart 当双保险：它只标**顶层**
    //   别名位，内层那个会被放过。
    //   ⚠️ 跳过带来的后果是「只命中别名的声明会静默不掩码」（fail-open）——那由声明门禁拦掉
    //     （masksOf 的 presence 检查改调 sqlMentionsColumn，与这里同一份实现），运行期不在这里兜。
    // ★ **在场先于豁免**（T7，#823）：**先算「改了没改」，再决定记 applied 还是 exempted**。
    //   「在场」的判定就是展开本身（`next !== sql`）——**不调 `sqlMentionsColumn`**：
    //   那个谓词的定义是「跑一遍本函数看 applied」⇒ 在此调用 = **自递归爆栈**。
    const colRe = new RegExp(`\\b${escapeRe(spec.column)}\\b`, 'g')
    const next = sql.replace(colRe, (match, offset: number) =>
      ALIAS_BEFORE_RE.test(sql.slice(0, offset)) ? match : maskExpr(spec))
    if (next === sql) continue   // 不在（或只命中别名位）⇒ 不改、不记
    if (exempt) { exempted.push(spec.column); continue }
    sql = next
    applied[spec.column] = notationOf(spec)
  }
  return { sql, applied, exempted }
}

/**
 * 「这一列会不会被掩码展开命中」——**唯一 token 化**（#830）。
 *
 * 实现方式刻意是「**问展开器自己**」而不是另写一份正则：传 `hasScope = () => false`
 * （= 谁都没豁免）跑一次 `maskedSelectSql`，看 `applied` 里有没有这一列。
 * `applied` 只在**替换真的改动了 SQL** 时才记（`next !== sql`）⇒ 这个谓词与运行期
 * 的命中判定**构造上同一份**，不可能不同尺。别名位跳过、词边界、`$&` 回调等
 * 既有语义全部自动继承。
 *
 * ⚠️ **不要**传整值 spec（`column: null`）——它的键是 `<value>`，语义不同。
 * ⚠️ **反向依赖是禁止的**：`maskedSelectSql` 里**绝不能**调本函数——本谓词的定义就是
 *   「跑一遍 `maskedSelectSql`、看 `applied` 里有没有这一列」⇒ 展开器再回头调它 =
 *   **自递归爆栈**。展开器判「在场」用它自己的 `next !== sql`——那是**同一个事实的另一种
 *   读法**，不是第二份实现（`applied` 本来就是按 `next !== sql` 记的）。
 */
export function sqlMentionsColumn(selectSql: string, column: string): boolean {
  const probe = maskedSelectSql(selectSql, [{ column, kind: 'nullify', grantedBy: 'probe' }], () => false)
  return Object.prototype.hasOwnProperty.call(probe.applied, column)
}

/**
 * 按列解析本次查询的掩码集（spec §5.3.1 R10 裁决 C，堵 #820）。
 *
 * `掩码集 = ⋃{ 声明 d : d.column 逐字出现在 metric.selectSql 里 }`，d 取自**全量 catalog**。
 *
 * ★ 为什么取全量（含调用者看不见的行）：掩码**只会减少信息**⇒ 拿「我看不见的行」上的掩码
 *   来掩自己，是 fail-closed 的正确方向；并集 ⊇ 原集合 ⇒ **行为只增不减**。
 * ★ 为什么 L2 自动被覆盖：L2 的 `select_sql` **逐字保留** L1 的列引用（实测见 spec §5.3.1）
 *   ⇒ L2 查的列在 L1 行里声明过 ⇒ 命中。不需要血缘列、不需要反向检查、**无过期状态**。
 * ★ 整值（`column === null`）**不跨指标按列传播** ⇒ 只取本行的整值声明（默认档合成的那些）。
 *
 * @param catalog 全量 catalog（**未**经 visibleMetrics 裁剪）
 * @param metric  本次查询的指标行
 */
export function effectiveMasks(catalog: MetricDef[], metric: MetricDef): MaskSpec[] {
  const byColumn = new Map<string, MaskSpec>()
  for (const row of catalog) {
    for (const spec of row.masks ?? []) {
      if (spec.column === null) continue                                  // 整值不按列传播
      if (byColumn.has(spec.column)) continue                             // 同列单声明由门禁保证；这里防御性取首个
      if (!sqlMentionsColumn(metric.selectSql, spec.column)) continue     // 本指标没查这列 ⇒ 与它无关
      byColumn.set(spec.column, spec)
    }
  }
  const whole = (metric.masks ?? []).filter((s) => s.column === null)
  return [...byColumn.values(), ...whole]
}
