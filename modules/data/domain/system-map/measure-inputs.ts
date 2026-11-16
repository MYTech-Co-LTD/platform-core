// measure-inputs.ts — 「这个聚合度量用了 staging 的哪些列」的解析器。
//
// 为什么需要：marts 的 `<度量>__gen as ( … )` 块只覆盖生成器产出的度量（sale_amount / return_amount）。
// 2026-11-15 实测 `net_amount`（= sale_amount − return_amount，写在最终 select）与 `order_count`
// （走 order_count_cte → base_sale 两层 CTE）都拿不到输入列，页面上「指标由哪些字段聚合而来」直接断链。
//
// 做法（**只做标识符级别的近似，不当血缘证明**）：
//   1. 度量有自己的 `<度量>__gen` / `<度量>__rollup` CTE ⇒ 从块里扫 staging 列；
//   2. 否则解最终 select 里 `… as <度量>` 的表达式：
//      - 表达式里出现别的 `<m>__gen` / `<m>__rollup` ⇒ 记成度量依赖，并递归取它的输入；
//      - 没有度量引用时才按 CTE 名内联（order_count 就是这条路）；
//   3. 结果按 staging 列集过滤，并剔除粒度键（system_book / bizday / branch_num 这类
//      在 group by 里出现、但不构成「度量值来源」的列）。
//
// 纯函数：不读盘、不查库；SQL 与列清单由调用方给。

export interface MeasureInputs {
  /** 度量 → 用到的 staging 列（保留 SQL 里出现的顺序语义：按 staging 列顺序输出） */
  inputs: Record<string, string[]>
  /** 度量 → 它组合出来的其它度量（net_amount → sale_amount / return_amount） */
  deps: Record<string, string[]>
}

export interface ResolveOptions {
  /** 要解析的度量名（= marts 列里不在 staging 的那批） */
  measures: readonly string[]
  /** staging 的列集（唯一事实源：解析结果只保留这里面的名字） */
  stagingColumns: readonly string[]
  /** 不算「值来源」的列：粒度键 / 分区键 */
  exclude?: readonly string[]
}

/** 去掉 Jinja 与 SQL 注释——它们会把标识符扫描带偏。 */
function stripNoise(sql: string): string {
  return sql
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/--[^\n]*/g, ' ')
}

/**
 * 只保留「取值」部分：把 `where` / `having` / `on` 的谓词整段去掉。
 *
 * 为什么：谓词里的列是**过滤条件**，不是度量值的来源。实测 `net_amount` 的链路里
 * `hour` 会被点亮——它来自 `base_return` 的窗口守卫
 * `{% if MAT_CLOSED_BEFORE %} and not (bizday = current_date and hour >= extract(hour …)) {% endif %}`，
 * 用户看到「小时汇入净销售额」是误读。口径里的 CASE 条件（`state = 'FINISHED'`）在
 * select 表达式里，不受影响，仍算来源。
 *
 * 逐字扫描（不用正则一口气替换）：字面量里出现 `where` 之类不会误伤整段。
 */
function valueOnly(text: string): string {
  const CLAUSE_STOP = /^(?:group\s+by|order\s+by|having|limit|window|union|join|left|right|inner|full|cross|select|from)\b/i
  let out = ''
  let i = 0
  while (i < text.length) {
    const re = /\b(where|having|on)\b/gi
    re.lastIndex = i
    const hit = re.exec(text)
    if (hit === null) { out += text.slice(i); break }
    out += text.slice(i, hit.index)
    // 谓词到下一个子句关键字（或当前括号的收尾）为止
    let j = hit.index + hit[0].length
    let depth = 0
    while (j < text.length) {
      const ch = text[j]!
      if (ch === '(') depth += 1
      else if (ch === ')') { if (depth === 0) break; depth -= 1 }
      else if (depth === 0 && CLAUSE_STOP.test(text.slice(j))) break
      j += 1
    }
    i = j
  }
  return out
}

/** `group by` 里出现的列是这一段的粒度，不是度量值的来源。 */
function grainOf(text: string): Set<string> {
  const out = new Set<string>()
  const re = /\bgroup\s+by\b([\s\S]*?)(?=\bhaving\b|\border\s+by\b|\blimit\b|\)|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    for (const t of m[1]!.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) ?? []) out.add(t.toLowerCase())
  }
  return out
}

/** 抽 CTE：`name as ( … )`，按括号配平截取函数体。 */
function extractCtes(sql: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s+as\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    const name = m[1]!.toLowerCase()
    const open = sql.indexOf('(', m.index + m[0].length - 1)
    if (open < 0) continue
    let depth = 0
    let end = -1
    for (let i = open; i < sql.length; i += 1) {
      const ch = sql[i]
      if (ch === '(') depth += 1
      else if (ch === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) continue
    if (!out.has(name)) out.set(name, sql.slice(open + 1, end))
  }
  return out
}

/** 最终 select 里 `… as <name>` 的表达式：从别名往前按括号配平找到表达式的起点。 */
function finalExpression(sql: string, name: string): string | null {
  const re = new RegExp(`\\bas\\s+${name}\\b`, 'gi')
  let last: RegExpExecArray | null = null
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) last = m
  if (last === null) return null
  // 不能用「找上一个逗号」——表达式内部的函数调用里就有逗号，会截断成半个式子。
  let depth = 0
  let i = last.index - 1
  for (; i >= 0; i -= 1) {
    const ch = sql[i]!
    if (ch === ')') depth += 1
    else if (ch === '(') {
      if (depth === 0) break
      depth -= 1
    } else if (depth === 0 && ch === ',') break
    else if (depth === 0 && /select$/i.test(sql.slice(Math.max(0, i - 5), i + 1)) &&
             (i - 5 <= 0 || !/[A-Za-z_]/.test(sql[i - 6] ?? ''))) break
  }
  return sql.slice(i + 1, last.index)
}

const IDENT = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g

export function resolveMeasureInputs(sql: string, opts: ResolveOptions): MeasureInputs {
  const clean = stripNoise(sql)
  const ctes = extractCtes(clean)
  const staging = new Set(opts.stagingColumns)
  const exclude = new Set(opts.exclude ?? [])
  const measureSet = new Set(opts.measures)
  const out: MeasureInputs = { inputs: {}, deps: {} }
  /** 递归中防环：度量与 CTE 各自一个栈。 */
  const measureStack = new Set<string>()
  const cteStack = new Set<string>()
  const MAX_DEPTH = 6

  const ids = (text: string): string[] => {
    const found: string[] = []
    let m: RegExpExecArray | null
    IDENT.lastIndex = 0
    while ((m = IDENT.exec(text)) !== null) found.push(m[1]!.toLowerCase())
    return found
  }

  /** 把一段表达式解析成 (staging 列集合, 度量依赖集合)。 */
  const scan = (text: string, depth: number): { cols: Set<string>; deps: Set<string> } => {
    const cols = new Set<string>()
    const deps = new Set<string>()
    if (depth > MAX_DEPTH) return { cols, deps }
    // 谓词里的列是过滤条件，不是值来源（2026-11-16 订正：hour 曾被当成度量输入）
    const tokens = ids(valueOnly(text))
    const grain = grainOf(text)
    // 1) 度量引用优先：`sale_amount__gen` / `sale_amount__rollup`
    let sawMeasure = false
    for (const t of tokens) {
      const base = t.replace(/__(gen|rollup)$/, '')
      if (base === t || !measureSet.has(base)) continue
      sawMeasure = true
      if (deps.has(base)) continue
      deps.add(base)
      const sub = resolveMeasure(base, depth + 1)
      sub.cols.forEach((c) => cols.add(c))
    }
    // 2) 没有度量引用时，按 CTE 内联（order_count → order_count_cte → base_sale）
    if (!sawMeasure) {
      for (const t of tokens) {
        if (staging.has(t) && !exclude.has(t) && !grain.has(t)) cols.add(t)
        const body = ctes.get(t)
        if (body === undefined || cteStack.has(t)) continue
        cteStack.add(t)
        const sub = scan(body, depth + 1)
        cteStack.delete(t)
        sub.cols.forEach((c) => cols.add(c))
        sub.deps.forEach((d) => deps.add(d))
      }
    }
    return { cols, deps }
  }

  const resolveMeasure = (name: string, depth: number): { cols: Set<string>; deps: Set<string> } => {
    const empty = { cols: new Set<string>(), deps: new Set<string>() }
    if (measureStack.has(name)) return empty
    measureStack.add(name)
    try {
      const own = ctes.get(`${name}__gen`) ?? ctes.get(`${name}__rollup`)
      const text = own ?? finalExpression(clean, name)
      if (text === null) return empty
      return scan(text, depth)
    } finally {
      measureStack.delete(name)
    }
  }

  for (const measure of opts.measures) {
    const { cols, deps } = resolveMeasure(measure, 0)
    if (cols.size === 0 && deps.size === 0) continue
    out.inputs[measure] = opts.stagingColumns.filter((c) => cols.has(c))
    if (deps.size > 0) out.deps[measure] = [...deps]
  }
  return out
}
