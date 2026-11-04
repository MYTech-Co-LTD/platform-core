// candidate-generator.ts — W2 Task 5：画像 → 规则筛 → 候选池。
//
// 数据流（**两池分离，不跨池事务**）：
//   仓库池（`DATA_WAREHOUSE_URL`，**只读**）：`data.metric_profiles` 最新画像 + `information_schema.columns` 实际列类型
//        ↓ 规则筛（本文件，确定性；LLM **不参与算式**）
//   平台池（`DATABASE_URL`，**只写**）：`data.metric_candidates`（幂等 upsert，见 metric-candidates.ts）
//
// ── 规则（spec 2026-11-04 §3②）──────────────────────────────────────────────────
//   · 排除 全空列（null_percentage = 100）/ 无样本（count = 0）/ 基数 = 1；
//   · 非数值列只有在**可枚举**（低基数）时才产 count / count_distinct；其余（自由文本 / 高基数 id）跳过；
//   · 排除已被 L1 覆盖的「列 × 聚合」（从 L1 `select_sql` 的表达式反解，与运行期同一份解析器）；
//   · 每关系上限 20（`maxPerRelation` 只可下调；硬上限 20）。
//
// ── 维度候选（spec §3② 末条）────────────────────────────────────────────────────
//   dims = **该关系在 L1 已声明的 grain**（`group_by` 拆解）∩ 实际列 ∩ 非掩码 ∩ 低基数 ∩ 非全空。
//   为什么要「已声明」：自造维度会绕开 L1 的 grain 语义（GROUP BY 一个未声明列 = 另一套口径）。
//
// ── LLM 的边界 ───────────────────────────────────────────────────────────────────
//   `opts.rationaleFor` 是**文案缝**：它只拿得到已生成的 draft，返回值只替换 rationale；
//   算式 / 证据 / 置信度**不经过它**（「LLM 不参与算式」）。本任务不接模型（缺省 = 确定性文案）。
//
// ── 失败语义 ─────────────────────────────────────────────────────────────────────
//   画像读不到（表不存在 / 仓库没配 / 连接失败）⇒ 判别式结果 `PROFILE_UNAVAILABLE` /
//   `DATA_WAREHOUSE_UNCONFIGURED`，**不造数据、不写候选**（反例见 Task 4 的空输入闸教训）。
import type { Pool } from 'pg'
import type { MetricRow } from './metric-store'
import { loadPlatformCatalog } from './metric-store'
import { NUMERIC_DATA_TYPES, loadRelationColumns, maskedTargets, whitelistedRelations } from './private-measure'
import type { RelationColumn } from './private-measure'
import { dimensionNamesOf, parseL1Select } from './semantic-compiler'
import type { ColumnAggFunc } from './semantic-compiler'
import { listCandidates, expireCandidates, reviveExpiredCandidates, upsertCandidate } from './metric-candidates'
import type { Candidate } from './metric-candidates'
import { warehouseConfigured, warehousePool } from './warehouse'

/** 每关系上限（spec：「每关系上限 20 条」——可下调，`HARD_MAX` 不许上调）。 */
export const DEFAULT_MAX_PER_RELATION = 20
export const HARD_MAX_PER_RELATION = 20
/** 非数值列的「可枚举」上限（经验阈值，**待真实分布标定**；不是拍板值）。 */
export const DEFAULT_ENUM_MAX_DISTINCT = 100
/** 维度候选的基数上限 + 基数/样本比例上限（经验阈值，**待真实分布标定**）。 */
export const DEFAULT_DIM_MAX_DISTINCT = 500
const DIM_MAX_RATIO = 0.2

/** profiler 的一行最新画像（`data.metric_profiles` 的读侧归一形状）。 */
export interface ProfileRow {
  /** 画像关系（可带 schema；profiler 侧实测是 `staging.fct_*`）。 */
  relation: string
  column: string
  /** qa.profile 的原始逐列统计（count / null_percentage / approx_unique / column_type…）。 */
  stats: Record<string, unknown>
  /** 画像时刻（ISO；用于 evidence，不参与筛选）。 */
  profiledAt: string
}

export interface CandidateGeneratorDeps {
  /** 平台库：读 L1 词表 + 写候选池。 */
  pool: Pool
  /** 仓库库（只读）：画像 + 实际列类型；缺省 = `warehousePool()`（生产是**另一张库**）。 */
  warehouse?: Pool
  /** L1 词表加载器；缺省 = `loadPlatformCatalog(pool)`。 */
  loadCatalog?: (pool: Pool) => Promise<MetricRow[]>
  /** 最新画像加载器；缺省 = `loadLatestProfiles(warehouse, org)`。 */
  loadProfiles?: (pool: Pool, org: string) => Promise<ProfileRow[]>
  /** 实际列加载器；缺省 = `loadRelationColumns(warehouse, relation)`（与三闸同一份）。 */
  loadColumns?: (pool: Pool, relation: string) => Promise<RelationColumn[]>
  /**
   * 「两个关系名是否指向**同一物理关系**」；缺省 = `samePhysicalRelation`（`to_regclass` 比 OID）。
   * 归一画像关系时用：一侧裸名、一侧带 schema 时**不能**只看最后一段（两个 schema 可能同名表）。
   */
  sameRelation?: (pool: Pool, a: string, b: string) => Promise<boolean>
}

export interface GenerateOptions {
  /** 只处理这些关系（画像名或 L1 名，按最后一段匹配）。缺省 = 全部白名单关系。 */
  relations?: readonly string[]
  /** 每关系上限（1–20；超出按 20 收口）。 */
  maxPerRelation?: number
  /** 非数值列可枚举的基数上限（缺省 100）。 */
  enumMaxDistinct?: number
  /** 维度候选的基数上限（缺省 500）。 */
  dimMaxDistinct?: number
  /**
   * **纯文案**钩子（LLM 的落点，本任务未接模型）：只能替换 rationale。
   * 返回 `undefined` / 非字符串 ⇒ 用确定性文案。
   */
  rationaleFor?: (draft: Readonly<CandidateDraft>) => string | undefined | Promise<string | undefined>
}

/** 规则筛的跳过原因（**可机检**；读报告按 key 断言，不解析文案）。 */
export type GenerateSkipReason =
  | 'no-stats'                 // 画像缺 count / approx_unique（判不了）
  | 'no-data'                  // count = 0（空样本）
  | 'all-null'                 // null_percentage = 100
  | 'single-value'             // 基数 ≤ 1（常量列）
  | 'not-enumerable'           // 非数值且高基数（自由文本 / id）
  | 'column-type-unavailable'  // information_schema 看不到该列（契约列与实际列漂移）
  | 'covered-by-l1'            // 该「列 × 聚合」已被某条 L1 覆盖

export interface GenerateReport {
  org: string
  /** 读到的最新画像行数。 */
  profiles: number
  /** 参与生成的关系数（白名单内）。 */
  relations: number
  /** 被跳过的关系数（不在 L1 白名单 / 列清单不可见）。 */
  skippedRelations: number
  /** 新写入的候选数。 */
  added: number
  /** 幂等命中（只刷新证据）的候选数。 */
  refreshed: number
  /** 被规则筛掉的「列 × 聚合」数。 */
  skipped: number
  /** 被每关系上限截掉的候选数（**本次运行**丢掉的；池级结果看 `pendingAfter`）。 */
  capped: number
  maxPerRelation: number
  /** 本次被退役（置 `expired`）的陈旧自动候选数（池级上限的退役动作）。 */
  expired: number
  /** 本次被复活（`expired` → `pending`）的自动候选数（画像重新支持它）。 */
  revived: number
  /**
   * 本次处理的关系在处理完之后，`origin='profile' and status='pending'` 的候选总数
   * （**池级**口径：恒 ≤ `relations × maxPerRelation`）。`capped` 只反映本次截断，
   * 后者才能证明「多次生成不会把池撑爆」。
   */
  pendingAfter: number
  /** 逐规则计数（恒含全部 key，值为 0 也给出——消费方不必判 key 是否存在）。 */
  skippedBy: Record<GenerateSkipReason, number>
}

export type CandidateGenerationResult =
  | { ok: true; report: GenerateReport }
  | {
      ok: false
      code: 'DATA_WAREHOUSE_UNCONFIGURED' | 'PROFILE_UNAVAILABLE' | 'CATALOG_UNAVAILABLE' | 'CANDIDATE_STORE_UNAVAILABLE'
      detail?: string
    }

/** 一条待写入候选的**算式/证据核心**（`rationaleFor` 拿不到它的写权）。 */
export interface DraftCore {
  /** L1 白名单里的关系（已归一；adopt 时直接过三闸①）。 */
  relation: string
  expr: { agg: ColumnAggFunc; column: string; dims: string[] }
  evidence: Record<string, unknown>
  confidence: number
}

/** 完整草稿 = 核心 + 文案（文案可由 `rationaleFor` 覆盖）。 */
export interface CandidateDraft extends DraftCore {
  rationale: string
}

/** 画像表的默认读法：每 (relation, column) 取 `profiled_at` 最新的一份。 */
const LATEST_PROFILES_SQL = `select distinct on (relation, "column") relation, "column", stats, profiled_at
   from data.metric_profiles
  where org = $1
  order by relation, "column", profiled_at desc`

/** 关系名最后一段（白名单与画像可能一边带 schema、一边不带）。 */
function lastSegment(relation: string): string {
  const parts = relation.split('.')
  return parts[parts.length - 1] ?? relation
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function toIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString()
  const d = new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** 读最新画像（**仓库库**；SQL 恒带 org）。行形状收窄，坏 stats 归一成 {}。 */
export async function loadLatestProfiles(pool: Pool, org: string): Promise<ProfileRow[]> {
  const r = await pool.query(LATEST_PROFILES_SQL, [org])
  return r.rows.map((row) => ({
    relation: String((row as { relation?: unknown }).relation ?? ''),
    column: String((row as { column?: unknown }).column ?? ''),
    stats: isRecord((row as { stats?: unknown }).stats) ? (row as { stats: Record<string, unknown> }).stats : {},
    profiledAt: toIso((row as { profiled_at?: unknown }).profiled_at),
  }))
}

/**
 * 两个关系名是否指向**同一物理关系**（`to_regclass` 比 OID）。
 *
 * 为什么不用字符串比较：裸名按会话 `search_path` 解析，`fct_sales` 与 `staging.fct_sales`
 * 可能指向同一张表，也可能指向**两张不同的表**（不同 schema 同名）。只比最后一段的归一
 * 在后者上会静默把画像 A 的列说成表 B 的列 ⇒ adopt 时按 B 的列校验，产出一条语义错误的私有测度。
 *
 * 任一侧解析不到（表不存在 / 名字非法）⇒ false（fail-closed：宁可不归一）。
 */
export async function samePhysicalRelation(pool: Pool, a: string, b: string): Promise<boolean> {
  const r = await pool.query(
    'select to_regclass($1::text)::oid as a, to_regclass($2::text)::oid as b',
    [a, b],
  )
  const row = (r.rows[0] ?? {}) as { a?: unknown; b?: unknown }
  return row.a != null && row.b != null && String(row.a) === String(row.b)
}

/**
 * L1 已覆盖的「关系（最后一段）| 聚合 | 列」集合。
 *
 * 解析对象是 L1 的 `select_sql`（运行期同一份形状契约 ⇒ 先过 `parseL1Select` 拿关系）。
 * 表达式里只认**单列聚合**：`sum(rel.col)` / `count(distinct rel.col)`；
 * `sum(case … end)` 这类复合表达式不产「列 × 聚合」（它本来就不是候选档能表达的东西）。
 * 坏 select_sql 的行跳过不抛（方向是「少排除」= 多产候选，不会漏掉不该产的口径）。
 */
export function coveredColumnAggs(catalog: readonly MetricRow[]): Set<string> {
  const out = new Set<string>()
  for (const row of catalog) {
    if (row.source !== 'l1' || row.basis !== 'l1_tree') continue
    let relation: string
    try {
      relation = lastSegment(parseL1Select(row.selectSql).relation)
    } catch {
      continue
    }
    // 列可带任意层限定（`col` / `rel.col` / `schema.rel.col`）；`count(distinct …)` 归一成 count_distinct
    const re = /\b(sum|avg|min|max|count|count_distinct)\s*\(\s*(distinct\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)\s*\)/gi
    let m: RegExpExecArray | null
    while ((m = re.exec(row.selectSql)) !== null) {
      const agg = (m[2] !== undefined || m[1]!.toLowerCase() === 'count_distinct')
        ? 'count_distinct'
        : m[1]!.toLowerCase()
      out.add(`${relation}|${agg}|${m[3]}`)
    }
  }
  return out
}

/** 关系（最后一段）→ 已声明维度（L1 grain，按词表顺序去重）。 */
function declaredDimsByRelation(catalog: readonly MetricRow[]): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const row of catalog) {
    if (row.source !== 'l1' || row.basis !== 'l1_tree') continue
    let relation: string
    try {
      relation = lastSegment(parseL1Select(row.selectSql).relation)
    } catch {
      continue
    }
    const dims = out.get(relation) ?? []
    for (const d of dimensionNamesOf(row)) if (!dims.includes(d)) dims.push(d)
    out.set(relation, dims)
  }
  return out
}

/**
 * 画像关系到白名单关系的归一（**必须证明是同一物理关系**，不能只看名字）：
 *   ① 逐字命中（L1 声明与画像都带 schema / 都不带）⇒ 直接归一；
 *   ② 否则在「最后一段同名」的候选里逐个用 `to_regclass` OID 比对（裸名 vs 限定名 / 两份限定名）；
 *      **恰好一个**物理命中才算归一；
 *   ③ 0 个（不是同一张表）或多个（同名跨 schema、OID 解析不到）⇒ null（跳过并计入
 *      `skippedRelations`，不猜）。
 *
 * 反例（评审 Important 2）：白名单 `pm_route.fct_sales`、画像 `staging.fct_sales` 是**两张表**，
 * 只比最后一段会把后者的列当成前者的列 ⇒ adopt 过闸后静默产出语义错误的私有测度。
 *
 * 解析器抛错（仓不可达/名字非法）按「不命中」处理：fail-closed，该关系不进候选。
 */
async function canonicalRelation(
  profileRelation: string,
  whitelist: ReadonlySet<string>,
  sameRelation: (a: string, b: string) => Promise<boolean>,
): Promise<string | null> {
  if (whitelist.has(profileRelation)) return profileRelation
  const base = lastSegment(profileRelation)
  const candidates = [...whitelist].filter((r) => lastSegment(r) === base).sort()
  if (candidates.length === 0) return null
  const matches: string[] = []
  for (const candidate of candidates) {
    let same = false
    try {
      same = await sameRelation(candidate, profileRelation)
    } catch {
      same = false
    }
    if (same) matches.push(candidate)
  }
  return matches.length === 1 ? matches[0]! : null
}

interface ParsedStats {
  count: number
  nullPercentage: number
  approxUnique: number
  columnType: string
}

function parseStats(stats: Record<string, unknown>): ParsedStats | null {
  const count = num(stats.count)
  const approxUnique = num(stats.approx_unique)
  if (count === null || approxUnique === null) return null
  return {
    count,
    nullPercentage: num(stats.null_percentage) ?? 0,
    approxUnique,
    columnType: typeof stats.column_type === 'string' ? stats.column_type : '',
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 置信度（0–1，确定性）：非空率 + 样本量两项，**不看 min/max**（Task 4 已钉：画像 min/max 是
 * 堆序前 N 行的短窗口，不可做业务结论）。它只用于候选池排序/上限截断，不是统计保证。
 */
function confidenceOf(count: number, nullPercentage: number): number {
  const nonNull = 1 - Math.min(100, Math.max(0, nullPercentage)) / 100
  const size = Math.min(1, count / 5000)
  return round2(Math.min(0.95, 0.45 + 0.35 * nonNull + 0.15 * size))
}

function defaultRationale(draft: DraftCore): string {
  const ev = draft.evidence as { count: number; nullPercentage: number; approxUnique: number; dataType: string }
  const nonNull = (100 - Math.min(100, Math.max(0, ev.nullPercentage))).toFixed(1)
  const parts = [
    `${draft.expr.agg}(${draft.expr.column})`,
    `${ev.dataType} 列`,
    `非空 ${nonNull}%`,
    `样本 ${ev.count} 行 / 约 ${ev.approxUnique} 个不同值`,
  ]
  if (draft.expr.dims.length > 0) parts.push(`可按 ${draft.expr.dims.join('、')} 分组`)
  return parts.join('；')
}

/** 维度候选筛选（见文件头「维度候选」）。 */
function pickDims(
  declared: readonly string[],
  measureColumn: string,
  columns: ReadonlyMap<string, RelationColumn>,
  profiles: ReadonlyMap<string, ParsedStats>,
  masked: ReadonlySet<string>,
  dimMaxDistinct: number,
): string[] {
  const out: string[] = []
  for (const dim of declared) {
    if (dim === measureColumn) continue           // 同一列不能既是 measure 又是 dim（闸③ DIM_IS_MEASURE）
    if (!columns.has(dim)) continue               // 未声明在外 = 不猜
    if (masked.has(dim)) continue                 // 掩码列不能做 GROUP BY（spec §4.2-3）
    const st = profiles.get(dim)
    if (st === undefined) continue                // 没画像就判不了基数 ⇒ 不用（fail-closed）
    if (st.count <= 0 || st.nullPercentage >= 100) continue
    if (st.approxUnique < 2 || st.approxUnique > dimMaxDistinct) continue
    if (st.approxUnique / st.count > DIM_MAX_RATIO) continue
    out.push(dim)
  }
  return out
}

function candidateKey(relation: string, expr: { agg: string; column: string; dims: readonly string[] }): string {
  return `${relation}|${expr.agg}|${expr.column}|${expr.dims.join(',')}`
}

/**
 * 生成候选（幂等；只写平台库，仓库库只读）。
 *
 * 顺序纪律：先读 L1 词表（白名单/覆盖/维度三份派生物）→ 再读画像 → 再逐关系筛。
 * 白名单为空的部署（L1 还没物化）不会写任何候选，也不会报错（relations = 0）。
 */
export async function generateCandidates(
  deps: CandidateGeneratorDeps, org: string, opts: GenerateOptions = {},
): Promise<CandidateGenerationResult> {
  // ① 仓库池：缺省惰性单例；没配 env ⇒ 显式失败（不是「0 条候选」的假绿）
  let warehouse = deps.warehouse
  if (warehouse === undefined) {
    if (!warehouseConfigured()) {
      return {
        ok: false, code: 'DATA_WAREHOUSE_UNCONFIGURED',
        detail: '未配置 DATA_WAREHOUSE_URL：画像在仓库库（data.metric_profiles），平台库读不到',
      }
    }
    warehouse = warehousePool()
  }
  // 收窄成 const：下面的闭包（sameRelationOf）要用它，`let` 的收窄不进闭包
  const warehouseDb: Pool = warehouse

  const maxPerRelation = Math.max(1, Math.min(
    HARD_MAX_PER_RELATION,
    opts.maxPerRelation ?? DEFAULT_MAX_PER_RELATION,
  ))
  const enumMaxDistinct = opts.enumMaxDistinct ?? DEFAULT_ENUM_MAX_DISTINCT
  const dimMaxDistinct = opts.dimMaxDistinct ?? DEFAULT_DIM_MAX_DISTINCT

  // ② 平台池：L1 词表（白名单 / 覆盖 / 维度声明的唯一来源）
  let catalog: MetricRow[]
  try {
    catalog = await (deps.loadCatalog ?? loadPlatformCatalog)(deps.pool)
  } catch (e) {
    return { ok: false, code: 'CATALOG_UNAVAILABLE', detail: `读 L1 词表失败：${messageOf(e)}` }
  }
  const whitelist = whitelistedRelations(catalog)
  const covered = coveredColumnAggs(catalog)
  const declaredDims = declaredDimsByRelation(catalog)
  const masked = maskedTargets(catalog)

  // ③ 仓库池：最新画像
  let profiles: ProfileRow[]
  try {
    profiles = await (deps.loadProfiles ?? loadLatestProfiles)(warehouseDb, org)
  } catch (e) {
    return {
      ok: false, code: 'PROFILE_UNAVAILABLE',
      detail: `读 data.metric_profiles 失败（profiler 未投递 / 仓库不可达 / 表不存在）：${messageOf(e)}`,
    }
  }

  // ④ 平台池：现有候选键（**只用于报告里的新增/刷新区分**；写入本身靠 upsert 的幂等键）
  let existing: Candidate[]
  try {
    existing = await listCandidates(deps.pool, org)
  } catch (e) {
    return { ok: false, code: 'CANDIDATE_STORE_UNAVAILABLE', detail: `读候选池失败：${messageOf(e)}` }
  }
  const existingKeys = new Set(existing.map((c) => candidateKey(c.relation, c.expr)))
  const existingByKey = new Map(existing.map((c) => [candidateKey(c.relation, c.expr), c]))
  // 关系归一的物理比对器：缺省走仓库池的 to_regclass（测试注入 fake，见 deps.sameRelation）
  const sameRelationOf = (a: string, b: string): Promise<boolean> => (
    deps.sameRelation !== undefined
      ? deps.sameRelation(warehouseDb, a, b)
      : samePhysicalRelation(warehouseDb, a, b)
  )

  const skippedBy: Record<GenerateSkipReason, number> = {
    'no-stats': 0,
    'no-data': 0,
    'all-null': 0,
    'single-value': 0,
    'not-enumerable': 0,
    'column-type-unavailable': 0,
    'covered-by-l1': 0,
  }
  const skip = (reason: GenerateSkipReason): void => { skippedBy[reason] += 1 }

  const relationFilter = opts.relations === undefined
    ? null
    : new Set(opts.relations.map(lastSegment))

  const byRelation = new Map<string, ProfileRow[]>()
  for (const row of profiles) {
    if (row.relation === '' || row.column === '') continue
    const list = byRelation.get(row.relation) ?? []
    list.push(row)
    byRelation.set(row.relation, list)
  }

  const report: GenerateReport = {
    org,
    profiles: profiles.length,
    relations: 0,
    skippedRelations: 0,
    added: 0,
    refreshed: 0,
    skipped: 0,
    capped: 0,
    maxPerRelation,
    expired: 0,
    revived: 0,
    pendingAfter: 0,
    skippedBy,
  }

  for (const profileRelation of [...byRelation.keys()].sort()) {
    if (relationFilter !== null && !relationFilter.has(lastSegment(profileRelation))) continue
    const canonical = await canonicalRelation(profileRelation, whitelist, sameRelationOf)
    if (canonical === null) { report.skippedRelations += 1; continue }

    let columns: RelationColumn[]
    try {
      columns = await (deps.loadColumns ?? loadRelationColumns)(warehouseDb, profileRelation)
    } catch {
      // 关系名不合法 / 仓不可达：该关系不可判 ⇒ 跳过（不猜列类型）
      report.skippedRelations += 1
      continue
    }
    if (columns.length === 0) { report.skippedRelations += 1; continue }
    const columnByName = new Map(columns.map((c) => [c.name, c]))

    const rows = byRelation.get(profileRelation)!
    const profileByName = new Map<string, ParsedStats>()
    for (const row of rows) {
      const parsed = parseStats(row.stats)
      if (parsed !== null) profileByName.set(row.column, parsed)
    }
    const dimsDeclared = declaredDims.get(lastSegment(canonical)) ?? []
    const coveredRelation = lastSegment(canonical)

    const drafts: DraftCore[] = []
    for (const row of [...rows].sort((a, b) => a.column.localeCompare(b.column))) {
      const st = parseStats(row.stats)
      if (st === null) { skip('no-stats'); continue }
      if (st.count <= 0) { skip('no-data'); continue }
      if (st.nullPercentage >= 100) { skip('all-null'); continue }
      if (st.approxUnique <= 1) { skip('single-value'); continue }

      const col = columnByName.get(row.column)
      if (col === undefined) { skip('column-type-unavailable'); continue }
      const dataType = col.dataType.toLowerCase()
      const numeric = NUMERIC_DATA_TYPES.has(dataType)
      const ratio = st.approxUnique / st.count
      const enumerable = !numeric && st.approxUnique <= enumMaxDistinct && ratio <= DIM_MAX_RATIO
      if (!numeric && !enumerable) { skip('not-enumerable'); continue }

      const aggs: readonly ColumnAggFunc[] = numeric
        ? ['sum', 'avg']
        : ['count', 'count_distinct']
      const dims = pickDims(dimsDeclared, row.column, columnByName, profileByName, masked, dimMaxDistinct)

      for (const agg of aggs) {
        if (covered.has(`${coveredRelation}|${agg}|${row.column}`)) { skip('covered-by-l1'); continue }
        const evidence: Record<string, unknown> = {
          source: 'profile',
          profileRelation,
          dataType,
          columnType: st.columnType === '' ? null : st.columnType,
          count: st.count,
          nullPercentage: st.nullPercentage,
          approxUnique: st.approxUnique,
          profiledAt: row.profiledAt,
        }
        drafts.push({
          relation: canonical,
          expr: { agg, column: row.column, dims: [...dims] },
          evidence,
          confidence: confidenceOf(st.count, st.nullPercentage),
        })
      }
    }

    report.relations += 1

    // 上限：先按置信度降序（同分按列名/聚合名稳定），再截断
    drafts.sort((a, b) => (
      b.confidence - a.confidence
      || a.expr.column.localeCompare(b.expr.column)
      || a.expr.agg.localeCompare(b.expr.agg)
    ))
    if (drafts.length > maxPerRelation) {
      report.capped += drafts.length - maxPerRelation
      drafts.length = maxPerRelation
    }

    // ★ 池级上限（评审 Important 1）：纯 upsert 没有删除/失效 ⇒ 旧 pending 永不退场，
    //   「每关系 ≤20」只在单次调用内成立。这里把**本次没有产出**的自动 pending 候选置
    //   `expired`（过期语义：最新画像/规则不再支持它），保证处理完的关系里
    //   `origin='profile' and status='pending'` 恒 ≤ maxPerRelation。
    //   只动 pending + profile：人工拒绝/采用（rejected/created/promoted）与 demand 来源不碰。
    const finalKeys = new Set(drafts.map((d) => candidateKey(d.relation, d.expr)))
    const staleIds = existing
      .filter((c) => c.relation === canonical && c.status === 'pending' && c.origin === 'profile'
        && !finalKeys.has(candidateKey(c.relation, c.expr)))
      .map((c) => c.id)
    if (staleIds.length > 0) {
      try {
        report.expired += await expireCandidates(deps.pool, org, staleIds)
      } catch (e) {
        return { ok: false, code: 'CANDIDATE_STORE_UNAVAILABLE', detail: `退役陈旧候选失败：${messageOf(e)}` }
      }
    }
    // 复活：上一轮被自动退役、本轮画像重新支持的候选置回 pending（upsert 不碰状态，必须显式）。
    const reviveIds = existing
      .filter((c) => c.relation === canonical && c.status === 'expired' && c.origin === 'profile'
        && finalKeys.has(candidateKey(c.relation, c.expr)))
      .map((c) => c.id)
    if (reviveIds.length > 0) {
      try {
        report.revived += await reviveExpiredCandidates(deps.pool, org, reviveIds)
      } catch (e) {
        return { ok: false, code: 'CANDIDATE_STORE_UNAVAILABLE', detail: `复活过期候选失败：${messageOf(e)}` }
      }
    }
    for (const key of finalKeys) {
      const prev = existingByKey.get(key)
      // 新插入 ⇒ pending 且 origin=profile；既有 profile 行：pending 计入池，expired 本轮会被
      // 复活（见上）也计入；既有 demand 行 upsert 不翻 origin ⇒ 不占 profile 的每关系预算。
      if (
        prev === undefined
        || (prev.origin === 'profile' && (prev.status === 'pending' || prev.status === 'expired'))
      ) {
        report.pendingAfter += 1
      }
    }

    for (const draft of drafts) {
      let finalRationale = defaultRationale(draft)
      if (opts.rationaleFor !== undefined) {
        // 文案缝：只吃 draft、只回 rationale —— 算式/证据不经过它（LLM 不参与算式）
        const override = await opts.rationaleFor({ ...draft, rationale: finalRationale })
        if (typeof override === 'string' && override.trim() !== '') finalRationale = override
      }
      try {
        await upsertCandidate(deps.pool, org, {
          relation: draft.relation,
          expr: draft.expr,
          evidence: draft.evidence,
          rationale: finalRationale,
          confidence: draft.confidence,
          origin: 'profile',
        })
      } catch (e) {
        return {
          ok: false, code: 'CANDIDATE_STORE_UNAVAILABLE',
          detail: `写候选失败（已写入部分保留，重复生成幂等）：${messageOf(e)}`,
        }
      }
      if (existingKeys.has(candidateKey(draft.relation, draft.expr))) report.refreshed += 1
      else report.added += 1
    }
  }

  report.skipped = Object.values(skippedBy).reduce((a, b) => a + b, 0)
  return { ok: true, report }
}
