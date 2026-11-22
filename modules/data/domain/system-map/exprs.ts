// exprs.ts — 「这一列的表达式是什么」的列级解析器（2026-11-22，#2683）。
//
// 与 lineage.ts 的分工：lineage 判「直通/聚合/丢弃」；本文件把**每列的 SQL 原文**拿出来，
// 让人看到「营业日 = r['bizday']::date」「销售额 = round(sum(...), 2)」这类加工逻辑。
//
// 三个来源、一套输出（alias → expression 文本）：
//   1. duckle 管线 `code.sql`：`json_extract_string(u.d, '$.item_num') AS item_num`
//      （湖字段 ← 源接口 JSON 路径）
//   2. dbt staging SQL：`r['bizday']::date as bizday`（湖列 → 定型列）
//   3. dbt marts SQL：`round(sum(detail_sum - order_total_money), 2) as swap_offset`
//
// 纯函数、只做顶层 select 列表切分（括号/引号感知），**不当血缘证明**——拿不到就返回空，
// 调用方如实显示「未解析」，不猜。
import { parse as parseYaml } from 'yaml'

/**
 * 解析 `dbt/semantics/l1_metrics.yml` 的 `measures:` 段 → `度量名 → {expr, grain, unit, domain}`。
 *
 * 为什么它是 marts 表达式的**权威来源**：marts 模型是 Jinja 模板（`{{ fct_measures(...) }}`），
 * 静态解析 SQL 只能拿到键列；真正的聚合公式声明在这份语义层里（口径的唯一实现，B11）。
 * 解析失败/缺段 ⇒ {}（调用方退回 SQL 解析结果，不猜）。
 * @param raw l1_metrics.yml 原文
 */
export function parseMeasureExprs(
  raw: string | null | undefined,
): Record<string, { expr: string; grain: string[]; unit: string | null; domain: string | null }> {
  if (typeof raw !== 'string' || raw.trim() === '') return {}
  let doc: unknown
  try { doc = parseYaml(raw) } catch { return {} }
  const root = (typeof doc === 'object' && doc !== null ? doc : {}) as Record<string, unknown>
  const measures = root.measures
  if (typeof measures !== 'object' || measures === null || Array.isArray(measures)) return {}
  const out: Record<string, { expr: string; grain: string[]; unit: string | null; domain: string | null }> = {}
  for (const [name, v] of Object.entries(measures as Record<string, unknown>)) {
    if (typeof v !== 'object' || v === null) continue
    const m = v as Record<string, unknown>
    out[name] = {
      expr: typeof m.expr === 'string' ? m.expr.replace(/\s+/g, ' ').trim() : '',
      grain: Array.isArray(m.grain) ? m.grain.map(String) : [],
      unit: typeof m.unit === 'string' ? m.unit : null,
      domain: typeof m.domain === 'string' ? m.domain : null,
    }
  }
  return out
}

/** 去掉 Jinja 块与 SQL 注释（注释会干扰别名扫描；Jinja 会破坏括号配对）。 */
export function stripSqlNoise(sql: string): string {
  return sql
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\{%[\s\S]*?%\}/g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
}

/**
 * 按**顶层逗号**切分（括号/单引号内的逗号不切）。用于 select 列表与函数参数。
 * @param text 待切分文本
 * @returns 各段（已 trim，丢弃空段）
 */
export function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let inQuote = false
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuote) {
      if (ch === "'") {
        // 连续两个单引号是转义，不结束
        if (text[i + 1] === "'") i += 1
        else inQuote = false
      }
      continue
    }
    if (ch === "'") { inQuote = true; continue }
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    else if (ch === ',' && depth === 0) {
      const seg = text.slice(start, i).trim()
      if (seg !== '') out.push(seg)
      start = i + 1
    }
  }
  const tail = text.slice(start).trim()
  if (tail !== '') out.push(tail)
  return out
}

/**
 * 取 SQL 里**第一个顶层 select … from** 的 select 列表（不含 `select` 关键字）。
 * 找不到返回 null（调用方如实留空）。
 */
export function firstSelectList(sql: string): string | null {
  const code = stripSqlNoise(sql)
  const sel = /\bselect\b/i.exec(code)
  if (sel === null) return null
  // 从 select 之后找第一个顶层 from（括号内的 from 不算）
  let depth = 0
  let inQuote = false
  for (let i = sel.index + sel[0].length; i < code.length; i += 1) {
    const ch = code[i]
    if (inQuote) { if (ch === "'") inQuote = false; continue }
    if (ch === "'") { inQuote = true; continue }
    if (ch === '(' || ch === '[') depth += 1
    else if (ch === ')' || ch === ']') depth -= 1
    else if (depth === 0 && /\bfrom\b/i.test(code.slice(i, i + 5)) && !/[\w.]/.test(code[i - 1] ?? '')) {
      return code.slice(sel.index + sel[0].length, i)
    }
  }
  return null
}

/**
 * 解析「别名 → 表达式」。
 *
 * 只认显式 `… AS <alias>` 的段（大小写不敏感）；普通列（`select a, b`）不产条目——
 * 它们本来就是直通，页面按「无表达式 = 直通」显示。同名多次出现取最后一次（CTE 覆盖）。
 */
export function parseAliasedExprs(sql: string): Record<string, string> {
  const list = firstSelectList(sql)
  if (list === null) return {}
  const out: Record<string, string> = {}
  for (const seg of splitTopLevel(list)) {
    const m = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(seg)
    if (m === null) continue
    const expr = seg.slice(0, m.index).trim()
    if (expr === '') continue
    out[m[1]] = expr.replace(/\s+/g, ' ')
  }
  return out
}

/**
 * 解析 duckle `code.sql`：湖字段 ← 源接口 JSON 路径。
 *
 * 形状（retail 家族实测）：`json_extract_string(u.d, '$.item_num') AS item_num`。
 * 把路径抽成 `$.item_num` 作为「来源」；其余表达式原样保留（拼接/CAST 等）。
 */
export function parseJsonPathSources(sql: string): Record<string, string> {
  const exprs = parseAliasedExprs(sql)
  const out: Record<string, string> = {}
  for (const [alias, expr] of Object.entries(exprs)) {
    const path = /\$(\.[A-Za-z0-9_.]+)/.exec(expr)
    out[alias] = path === null ? expr : `$${path[1]}`
  }
  return out
}
