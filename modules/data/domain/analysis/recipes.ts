// recipes.ts —— W6 Task 3：三配方（纯函数：把业务问题编译成 explore spec + 对结果做算术）。
//
// ★ 配方不新开执行缝：它只产出 `ExploreSpec`，由 `explore_query` 同一条只读通道执行。
//   算法写死在这里，不让模型即兴——「为什么」的答案必须是可复算的同一套算术。
//
// 三个口径（与计划 §Task 3 逐字一致）：
//   · 方差分解：delta_i = vA_i - vB_i，share = delta_i / Σdelta_i（Σ≈0 ⇒ null）
//   · Top-N 贡献：按值降序取 N，share = v_i / Σv
//   · 基线异常：前 baselineWindowDays 天的中位数与 MAD，score = 0.6745*(x-median)/MAD，
//     |score| >= 3.5 记异常；MAD=0 时标 degenerate（不给假分数）
import type { ExploreAgg, ExploreSpec } from './explore'
import { parseL1Select } from '../semantic-compiler'

export const RECIPE_KINDS = ['variance', 'top_contributors', 'baseline'] as const
export type RecipeKind = typeof RECIPE_KINDS[number]

export const BASELINE_DEFAULT_WINDOW_DAYS = 28
export const ANOMALY_SCORE_THRESHOLD = 3.5
const EPS = 1e-9

export type RecipeErrorCode =
  | 'BAD_REQUEST'
  | 'COMPOSITE_EXPRESSION'
  | 'NO_SPEC'

export interface RecipeRequest {
  recipe: RecipeKind
  relation: string
  measure: { agg: ExploreAgg; column: string }
  dimension: string
  /** 对比期（variance 必填）：A = 本期，B = 基期 */
  periodA?: { from: string; to: string }
  periodB?: { from: string; to: string }
  /** top_contributors 的窗口（必填） */
  period?: { from: string; to: string }
  /** baseline 的观测日（必填） */
  asOf?: string
  topN?: number
  baselineWindowDays?: number
}

export interface RecipeRow { dimension: string; value: number }

export interface RecipeOutput {
  recipe: RecipeKind
  /** 口径说明（进证据包；人读） */
  notes: string[]
  rows: Array<Record<string, unknown>>
  /** 总量（variance = Σdelta；top = Σv；baseline = 窗口内样本数），供人核对 */
  total?: number
  skipped?: number
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type RecipeTarget =
  | { ok: true; relation: string; measure: { agg: ExploreAgg; column: string } }
  | { ok: false; code: 'COMPOSITE_EXPRESSION'; detail: string }

// 列名可带**关系限定符**（`sum(fct_retail_sale.net_amount)`）：L1 声明的 expression 逐字
// 就是这种形态。`explore_query` 的基表列要求裸列名 ⇒ 只取最后一段。
const SINGLE_AGG_RE = /^(sum|avg|min|max)\s*\(\s*(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\)$/i
const COUNT_DISTINCT_RE = /^count\s*\(\s*distinct\s+(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\)$/i
const COUNT_RE = /^count\s*\(\s*(?:[a-z_][a-z0-9_]*\.)?([a-z_][a-z0-9_]*)\s*\)$/i

/**
 * 从指标的 `select_sql` 反解「单列聚合」目标。
 *
 * 只认 `sum|avg|min|max(col)` / `count(col)` / `count(distinct col)`——复合表达式（差/比率/
 * case）**明确拒**（`COMPOSITE_EXPRESSION`）并指向 `explore_query`：硬把 `a - b` 塞进单列
 * 聚合会得到一个错的数，比拒掉更糟。
 */
export function recipeTargetOf(selectSql: string): RecipeTarget {
  let relation = ''
  let expression = ''
  try {
    const parsed = parseL1Select(selectSql)
    relation = parsed.relation
    expression = parsed.expression
  } catch {
    return { ok: false, code: 'COMPOSITE_EXPRESSION', detail: 'select_sql 不是可解析的 L1 形态' }
  }
  const expr = expression.trim()
  const cd = COUNT_DISTINCT_RE.exec(expr)
  if (cd !== null) return { ok: true, relation, measure: { agg: 'count_distinct', column: cd[1] } }
  const c = COUNT_RE.exec(expr)
  if (c !== null) return { ok: true, relation, measure: { agg: 'count', column: c[1] } }
  const m = SINGLE_AGG_RE.exec(expr)
  if (m !== null) return { ok: true, relation, measure: { agg: m[1].toLowerCase() as ExploreAgg, column: m[2] } }
  return {
    ok: false,
    code: 'COMPOSITE_EXPRESSION',
    detail: `${expr} 不是单列聚合；复合口径请用 explore_query 自己拆，或改用 query_metric 取该指标的整值`,
  }
}

function dateOnly(s: unknown): string | null {
  return typeof s === 'string' && DATE_RE.test(s) ? s : null
}

/** UTC 日期位移（不动时区：业务日已经是字符串）。 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000
  return new Date(t).toISOString().slice(0, 10)
}

function measureSpec(req: RecipeRequest, from: string, to: string, dimensions: string[] = [req.dimension]): ExploreSpec {
  return {
    relation: req.relation,
    measures: [{ agg: req.measure.agg, column: req.measure.column, as: 'value' }],
    dimensions,
    filters: [{ column: 'bizday', op: 'between', value: [from, to] }],
    orderBy: { key: 'value', desc: true },
    // 维度可能很多（门店/商品）；收集全量再在 JS 里取 Top-N，避免 SQL 先截断再排名。
    limit: 1000,
  }
}

export type RecipeCompiled =
  | { ok: true; specs: ExploreSpec[]; notes: string[] }
  | { ok: false; code: RecipeErrorCode; detail?: string }

/** 编译成 1–2 个 explore spec（不执行）。 */
export function compileRecipe(req: RecipeRequest): RecipeCompiled {
  if (!(RECIPE_KINDS as readonly string[]).includes(req.recipe)) return { ok: false, code: 'BAD_REQUEST', detail: 'recipe' }
  if (typeof req.relation !== 'string' || req.relation === '') return { ok: false, code: 'BAD_REQUEST', detail: 'relation' }
  if (typeof req.dimension !== 'string' || req.dimension === '') return { ok: false, code: 'BAD_REQUEST', detail: 'dimension' }
  if (req.measure === undefined || typeof req.measure.column !== 'string') return { ok: false, code: 'BAD_REQUEST', detail: 'measure' }

  if (req.recipe === 'variance') {
    const a = req.periodA
    const b = req.periodB
    const fromA = dateOnly(a?.from); const toA = dateOnly(a?.to)
    const fromB = dateOnly(b?.from); const toB = dateOnly(b?.to)
    if (fromA === null || toA === null || fromB === null || toB === null) {
      return { ok: false, code: 'BAD_REQUEST', detail: 'periodA/periodB 需要 YYYY-MM-DD' }
    }
    return {
      ok: true,
      specs: [measureSpec(req, fromA, toA), measureSpec(req, fromB, toB)],
      notes: [
        `本期 ${fromA}..${toA}，基期 ${fromB}..${toB}`,
        'delta_i = 本期值 - 基期值；share = delta_i / Σdelta_i（Σdelta 绝对值 < 1e-9 时 share 为 null）',
      ],
    }
  }

  if (req.recipe === 'top_contributors') {
    const from = dateOnly(req.period?.from); const to = dateOnly(req.period?.to)
    if (from === null || to === null) return { ok: false, code: 'BAD_REQUEST', detail: 'period 需要 YYYY-MM-DD' }
    const n = req.topN ?? 10
    if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, code: 'BAD_REQUEST', detail: 'topN ∈ [1,50]' }
    return {
      ok: true,
      specs: [measureSpec(req, from, to)],
      notes: [`窗口 ${from}..${to}`, `按值降序取前 ${n}，share = v_i / Σv`],
    }
  }

  // baseline
  const asOf = dateOnly(req.asOf)
  if (asOf === null) return { ok: false, code: 'BAD_REQUEST', detail: 'asOf 需要 YYYY-MM-DD' }
  const window = req.baselineWindowDays ?? BASELINE_DEFAULT_WINDOW_DAYS
  if (!Number.isInteger(window) || window < 7 || window > 180) return { ok: false, code: 'BAD_REQUEST', detail: 'baselineWindowDays ∈ [7,180]' }
  return {
    ok: true,
    // 基线必须**按天**取，才有分布可算中位数与 MAD（按窗口汇总成一个值 ⇒ MAD 恒 0，配方即废）。
    specs: [
      measureSpec(req, shiftDate(asOf, -window), shiftDate(asOf, -1), [req.dimension, 'bizday']),
      measureSpec(req, asOf, asOf),
    ],
    notes: [
      `基线窗口 ${shiftDate(asOf, -window)}..${shiftDate(asOf, -1)}（${window} 天），观测日 ${asOf}`,
      'score = 0.6745 × (x - 中位数) / MAD；|score| ≥ 3.5 记异常；MAD=0 标 degenerate（不给假分数）',
    ],
  }
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

/** 把 explore 结果行归一到 [维度值, 数值]（列顺序：dimension, value）。 */
export function normalizeRows(result: { columns: string[]; rows: unknown[][] }): RecipeRow[] {
  const di = result.columns.indexOf('dimension')
  const vi = result.columns.indexOf('value')
  const dimIdx = di >= 0 ? di : 0
  const valIdx = vi >= 0 ? vi : 1
  const out: RecipeRow[] = []
  for (const row of result.rows) {
    const value = num(row[valIdx])
    if (value === null) continue
    out.push({ dimension: String(row[dimIdx] ?? ''), value })
  }
  return out
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** 应用配方。`results[i]` 对应 `specs[i]` 的执行结果（顺序不可乱）。 */
export function applyRecipe(req: RecipeRequest, results: Array<{ columns: string[]; rows: unknown[][] }>): RecipeOutput {
  if (req.recipe === 'variance') {
    const a = new Map(normalizeRows(results[0] ?? { columns: [], rows: [] }).map((r) => [r.dimension, r.value]))
    const b = new Map(normalizeRows(results[1] ?? { columns: [], rows: [] }).map((r) => [r.dimension, r.value]))
    const dims = new Set([...a.keys(), ...b.keys()])
    const deltas = [...dims].map((dimension) => {
      const va = a.get(dimension) ?? 0
      const vb = b.get(dimension) ?? 0
      return { dimension, current: va, baseline: vb, delta: va - vb }
    })
    const total = deltas.reduce((s, d) => s + d.delta, 0)
    const rows = deltas
      .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta) || x.dimension.localeCompare(y.dimension))
      .map((d) => ({
        dimension: d.dimension,
        current: d.current,
        baseline: d.baseline,
        delta: d.delta,
        share: Math.abs(total) < EPS ? null : Math.round((d.delta / total) * 1e6) / 1e6,
      }))
    return { recipe: 'variance', notes: [], rows, total: Math.round(total * 1e6) / 1e6, skipped: 0 }
  }

  if (req.recipe === 'top_contributors') {
    const normalized = normalizeRows(results[0] ?? { columns: [], rows: [] })
    const total = normalized.reduce((s, r) => s + r.value, 0)
    const n = req.topN ?? 10
    const rows = [...normalized]
      .sort((x, y) => y.value - x.value || x.dimension.localeCompare(y.dimension))
      .slice(0, n)
      .map((r) => ({
        dimension: r.dimension,
        value: r.value,
        share: Math.abs(total) < EPS ? null : Math.round((r.value / total) * 1e6) / 1e6,
      }))
    return { recipe: 'top_contributors', notes: [], rows, total: Math.round(total * 1e6) / 1e6, skipped: 0 }
  }

  // baseline：spec[0] 是 [维度, 业务日] 两维（才有分布），spec[1] 是观测日单值。
  const baseByDim = new Map<string, number[]>()
  const bRes = results[0] ?? { columns: [], rows: [] }
  const bDi = bRes.columns.indexOf('dimension') >= 0 ? bRes.columns.indexOf('dimension') : 0
  const bVi = bRes.columns.indexOf('value') >= 0 ? bRes.columns.indexOf('value') : 2
  for (const row of bRes.rows) {
    const v = num(row[bVi])
    if (v === null) continue
    const dim = String(row[bDi] ?? '')
    const list = baseByDim.get(dim) ?? []
    list.push(v)
    baseByDim.set(dim, list)
  }
  const currentRows = new Map(normalizeRows(results[1] ?? { columns: [], rows: [] }).map((r) => [r.dimension, r.value]))
  const dims = new Set([...baseByDim.keys(), ...currentRows.keys()])
  let degenerate = 0
  const rows: Array<Record<string, unknown>> = []
  for (const dimension of dims) {
    const baselines = baseByDim.get(dimension) ?? []
    const med = baselines.length > 0 ? median(baselines) : null
    const mad = baselines.length > 0 ? median(baselines.map((v) => Math.abs(v - med!))) : null
    const x = currentRows.get(dimension)
    if (med === null || mad === null || x === undefined) {
      rows.push({ dimension, current: x ?? null, median: med, mad, score: null, anomaly: false, degenerate: false })
      continue
    }
    if (mad === 0) {
      degenerate += 1
      rows.push({ dimension, current: x, median: med, mad, score: null, anomaly: x !== med, degenerate: true })
      continue
    }
    const score = Math.round((0.6745 * (x - med)) / mad * 100) / 100
    rows.push({ dimension, current: x, median: med, mad, score, anomaly: Math.abs(score) >= ANOMALY_SCORE_THRESHOLD, degenerate: false })
  }
  rows.sort((p, q) => {
    const sp = typeof p.score === 'number' ? Math.abs(p.score) : -1
    const sq = typeof q.score === 'number' ? Math.abs(q.score) : -1
    return sq - sp || String(p.dimension).localeCompare(String(q.dimension))
  })
  return { recipe: 'baseline', notes: [], rows, total: dims.size, skipped: degenerate }
}
