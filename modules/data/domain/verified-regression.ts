// verified-regression.ts — W1 Task 3：已验问答的**回归核心**（结构 + 相对容差）。
//
// 三件事：
//   1. `summarize(ok)`：把一次查询结果压成基线（列集 / 行数 / 每列数值摘要 + null 计数）；
//   2. `compare(baseline, current, tolerance)`：纯函数比较，五条规则见下方注释（**不许放宽**）；
//   3. `runRegression(deps, org, opts)`：按回归集逐条重放 `runQuery` 并记录结果。
//
// 口径边界（B11）：本文件**不新增业务口径**——只重放已声明指标、比结构与数值稳定性。
// 不做逐字 digest：结果集里的文本/时间值可以合法漂移，基线只钉「口径会不会被改动」。
//
// 租户隔离：回归集由 `listVerified(pool, org)` 读、`recordCheck(pool, org, …)` 写，全部带 org；
// 重放的 `runQuery` 也以同一个 org 作用域（词表 = 平台 L1 ∪ 本 org L2）。
import type { Pool } from 'pg'
import type { Requester, SlicingSpec } from './authz'
import { runQuery, type QueryDeps, type QueryOk, type QueryOutcome, type SqlExecutor } from './query-service'
import {
  listVerified,
  recordCheck,
  type Baseline,
  type CheckResult,
  type ColumnSummary,
} from './verified-questions'

// ── 1. 结果 → 基线 ─────────────────────────────────────────────────────────────

/** pg 的 numeric/bigint 经 node-pg 回**字符串**（避免精度丢失的默认行为）⇒ 必须按数值认。 */
const NUMERIC_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

/**
 * 值 → 有限数；不是数（含 `NaN` / `Infinity` / 空串 / 文字 / Date / 对象）⇒ null。
 *
 * 为什么字符串也认：`sum()`/`numeric` 列在 node-pg 里恒是字符串，不认它等于所有金额列
 * 都退化成「非数值列」（只比 null 计数）——那是**静默放宽**，比误判更危险。
 * 已知代价：纯数字的**文字**列（如门店号 `'3120'`）会被当成数值列比较三聚合。方向上
 * **更严**（不会漏掉漂移），且 QueryOk 只有列名没有类型，无从更精确地区分。
 */
function finiteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    if (t === '' || !NUMERIC_RE.test(t)) return null
    const n = Number(t)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * 一次成功查询 → 基线。
 *
 * 列分类规则：**所有非 null 值都是有限数** ⇒ 数值列（记 sum/min/max）；否则非数值列
 * （三值记 0、`numeric:false`，比较时只比 null 计数）。全 null / 0 行也按非数值列——
 * 没有值就没有依据说它是数，不猜。
 */
export function summarize(ok: QueryOk): Baseline {
  const rowCount = ok.rows.length
  const summary: Record<string, ColumnSummary> = {}
  ok.columns.forEach((column, i) => {
    let nulls = 0
    const nums: number[] = []
    let numeric = true
    for (const row of ok.rows) {
      const v = row[i]
      if (v === null || v === undefined) {
        nulls += 1
        continue
      }
      const n = finiteNumber(v)
      if (n === null) numeric = false
      else nums.push(n)
    }
    // 没有非 null 值 ⇒ 无从判数值性（全 null / 空结果），按非数值列。
    if (nums.length === 0) numeric = false
    summary[column] = numeric
      ? { sum: nums.reduce((a, b) => a + b, 0), min: Math.min(...nums), max: Math.max(...nums), nulls }
      : { sum: 0, min: 0, max: 0, nulls, numeric: false }
  })
  return { columns: [...ok.columns], rowCount, summary }
}

// ── 2. 基线 vs 当前（五条规则，逐条实现） ───────────────────────────────────────

export interface CompareResult {
  ok: boolean
  /** 人/日志可读的差异行；`ok` 时恒为空数组。 */
  diffs: string[]
}

/** 列名列表的形状化输出（diff 文案用；空数组也显式可见）。 */
const listOf = (cols: readonly string[]): string => `[${cols.join(', ')}]`
/** 数值展示（String 天然区分 NaN/Infinity；判红是为了给人查，不是给报表看）。 */
const numOf = (n: number): string => String(n)

/** 单值容差判定：`|cur - base| <= max(abs(base) * tol, 1e-9)`（计划 Task 3 规则 3 逐字）。 */
function withinTolerance(base: number, cur: number, tolerance: number): boolean {
  if (!Number.isFinite(base) || !Number.isFinite(cur) || !Number.isFinite(tolerance)) return false
  return Math.abs(cur - base) <= Math.max(Math.abs(base) * tolerance, 1e-9)
}

/** 数值性判据：只有显式 `numeric: false` 才按非数值列（缺席 = 兼容 Task 1 的旧基线）。 */
const isNumeric = (entry: ColumnSummary | undefined): boolean => entry?.numeric !== false

/**
 * 比较基线（规则与计划 Task 3 逐条对应，**不许放宽**）：
 *   1. `columns` **集合与顺序**任一不同 ⇒ fail；
 *   2. `rowCount` 不同 ⇒ fail；
 *   3. 每个数值列的 sum/min/max：`|cur-base| <= max(|base|*tol, 1e-9)`，否则 fail；
 *   4. 非数值列只比 null 计数；
 *   5. 非 ok 的重放结果不经过本函数——由 `runRegression` 直接判 fail（见下）。
 *
 * 补充的 fail-closed 判定（都不是放宽）：
 *   · 数值列也**同时**比 null 计数（null 数变化是结构信号，规则 3 没禁止多比）；
 *   · summary 缺列 / 数值性翻转 / 非有限数值 / 非法容差 ⇒ fail，不给缺省值兜底。
 */
export function compare(baseline: Baseline, current: Baseline, tolerance: number): CompareResult {
  const diffs: string[] = []

  if (!Number.isFinite(tolerance) || tolerance < 0) {
    diffs.push(`tolerance: 非法容差 ${numOf(tolerance)}（必须是非负有限数）`)
  }

  // 规则 1：集合**与顺序**都比（join 后逐字比即可同时覆盖两者）。
  if (listOf(baseline.columns) !== listOf(current.columns)) {
    diffs.push(`columns: 基线 ${listOf(baseline.columns)} ≠ 当前 ${listOf(current.columns)}`)
  }

  // 规则 2：行数。
  if (baseline.rowCount !== current.rowCount) {
    diffs.push(`rowCount: 基线 ${baseline.rowCount} ≠ 当前 ${current.rowCount}`)
  }

  // summary 里出现列集之外的键 = 基线与列集自相矛盾，结构 fail。
  const extraKeys = (b: Baseline): string[] =>
    Object.keys(b.summary).filter((k) => !b.columns.includes(k))
  for (const key of extraKeys(baseline)) diffs.push(`summary: 基线多出未声明列 '${key}'`)
  for (const key of extraKeys(current)) diffs.push(`summary: 当前多出未声明列 '${key}'`)

  // 规则 3/4：逐列比（以基线列集为准；列集不一致时仍逐列给出可读差异）。
  for (const column of baseline.columns) {
    const b = baseline.summary[column]
    const c = current.summary[column]
    if (b === undefined || c === undefined) {
      diffs.push(`summary: 列 '${column}' ${b === undefined ? '基线' : '当前'}缺摘要`)
      continue
    }
    if (isNumeric(b) !== isNumeric(c)) {
      diffs.push(`column '${column}': 数值性变化（基线 ${isNumeric(b) ? '数值' : '非数值'}，当前 ${isNumeric(c) ? '数值' : '非数值'}）`)
      continue
    }
    if (b.nulls !== c.nulls) {
      diffs.push(`column '${column}': nulls 基线 ${b.nulls} ≠ 当前 ${c.nulls}`)
    }
    if (!isNumeric(b)) continue // 规则 4：非数值列到此为止

    for (const field of ['sum', 'min', 'max'] as const) {
      const base = b[field]
      const cur = c[field]
      if (!Number.isFinite(base) || !Number.isFinite(cur)) {
        // 非有限值不参与「容差内」判定——静默放过会让 NaN 基线永远绿。
        diffs.push(`column '${column}': ${field} 非有限值（基线 ${numOf(base)}，当前 ${numOf(cur)}）`)
        continue
      }
      if (!withinTolerance(base, cur, tolerance)) {
        diffs.push(
          `column '${column}': ${field} 基线 ${numOf(base)} → 当前 ${numOf(cur)}`
          + ` 超出容差 ${numOf(tolerance)}（允许 ±${numOf(Math.max(Math.abs(base) * tolerance, 1e-9))}）`,
        )
      }
    }
  }

  return { ok: diffs.length === 0, diffs }
}

// ── 3. 回归集重放 ──────────────────────────────────────────────────────────────

/**
 * 平台回归特权身份（**不是租户会话**）。
 *
 * 为什么能这样：回归是平台侧对「已验问答」的稳定性巡检——回归集本身已按 org 隔离
 * （`listVerified(pool, org)`），词表也按 org 加载（平台 L1 ∪ 本 org L2），所以这里不给
 * 它任何跨租户能力；`hasScope: () => true` 只用于让重放不受「某个租户用户恰好缺某个
 * scope」影响——**回归测的是口径稳定性，不是权限**。不可复用到用户通道。
 */
function regressionRequester(org: string): Requester {
  return {
    userId: '(regression)',
    orgId: org,
    channel: 'pat',
    keyId: null,
    scopes: [],
    hasScope: () => true,
  }
}

export interface RegressionDeps {
  /** 平台池：读回归集 + 重放的词表/审计（`runQuery` 需要）。 */
  pool: Pool
  /**
   * 本租户已接入的源（`QueryDeps.adoptedSources` **必填**）。
   *
   * 装配在**平台侧**：`scripts/tenant-sources.ts` 的 `loadAdoptedSources(pool, org)`。
   * 为什么不放在本文件：B1（三同纪律）禁止 `modules/<id>/` 引用 `platform.*` 的物理表
   * （`scripts/lint-architecture.test.ts` 的 B1 反例就是 `select id from platform.tenant`），
   * 而 `platform.tenant` / `platform.tenant_source` 是宿主表。回归 CLI 是平台侧工具，
   * 没有请求上下文可拿宿主投影（`TENANT_SOURCES`），故由平台侧脚本自己解析后注入。
   */
  adoptedSources: ReadonlySet<string>

  /** 主计划执行器（缺省 = 真仓库，惰性连接）。测试注入假执行器。 */
  execute?: SqlExecutor
  /** 湖 ETag 竞态退避毫秒（缺省 1000；测试注入 0 免等待）。 */
  raceRetryDelayMs?: number
  /**
   * 重放注入（测试用）。缺省 = `query-service` 的真 `runQuery`。
   * 形状与 `runQuery` 一致 ⇒ 替身与真实现走同一条编排，不在测试里另写一遍循环。
   */
  replay?: typeof runQuery
}

export interface RunRegressionOptions {
  /** 只跑这些 id（CLI `--ids`）。 */
  ids?: readonly number[]
  /** 最多跑前 N 条（CLI `--limit`）。 */
  limit?: number
}

export interface RegressionResult {
  id: number
  metricId: string
  question: string
  /** pass/fail/error —— 与 `data.verified_questions.last_check_result` 同域。 */
  result: CheckResult
  /** 判红/出错的原因；pass 恒为空数组。 */
  diffs: string[]
}

/**
 * 跑本 org 的回归集，逐条重放并把结果写回 `last_checked_at` / `last_check_result`。
 *
 * 规则 5：重放**非 ok**（denied/error）⇒ `fail`，把 `reason` 记进 diffs。
 * 重放**抛异常**（不是 `QueryOutcome` 的出错，例如池断开）⇒ `error`——两者要可辨：
 * 「指标口径变了」和「根本没跑成」在运维上是两件事。
 *
 * 返回顺序 = 回归集顺序（`listVerified` 的 created_at desc），`ids`/`limit` 在重放前裁剪。
 */
export async function runRegression(
  deps: RegressionDeps,
  org: string,
  opts: RunRegressionOptions = {},
): Promise<RegressionResult[]> {
  let questions = await listVerified(deps.pool, org)
  if (opts.ids !== undefined) {
    const wanted = new Set(opts.ids.map(Number))
    questions = questions.filter((q) => wanted.has(q.id))
  }
  if (opts.limit !== undefined) {
    questions = questions.slice(0, Math.max(0, Math.trunc(opts.limit)))
  }

  const queryDeps: QueryDeps = {
    pool: deps.pool,
    adoptedSources: deps.adoptedSources,
    ...(deps.execute !== undefined ? { execute: deps.execute } : {}),
    ...(deps.raceRetryDelayMs !== undefined ? { raceRetryDelayMs: deps.raceRetryDelayMs } : {}),
  }
  const replay = deps.replay ?? runQuery

  const results: RegressionResult[] = []
  for (const q of questions) {
    let result: CheckResult
    let diffs: string[]
    try {
      const outcome = await replay(
        queryDeps, org, regressionRequester(org), q.metricId, q.params, q.slicing as SlicingSpec,
      )
      if (outcome.status !== 'ok') {
        result = 'fail'
        diffs = [`重放未成功: ${outcome.status}/${outcome.reason}${outcome.detail !== undefined ? `（${outcome.detail}）` : ''}`]
      } else {
        const cmp = compare(q.baseline, summarize(outcome), q.tolerance)
        result = cmp.ok ? 'pass' : 'fail'
        diffs = cmp.diffs
      }
    } catch (err) {
      result = 'error'
      diffs = [`重放异常: ${err instanceof Error ? err.message : String(err)}`]
    }
    // 结果如实落库（Task 1 的 recordCheck 是本层唯一写入口；stale 判定不在这里发明）。
    await recordCheck(deps.pool, org, q.id, result)
    results.push({ id: q.id, metricId: q.metricId, question: q.question, result, diffs })
  }
  return results
}

