// report-root-cause.ts — `ai_text` 的**有界根因分析**（focus=`root_cause`）。
//
// 定位：报表 AI 组件是**一次生成、文本输出**，不是对话。本模块在 `buildFacts` 之后跑
// **有界、确定性的分析循环**（不调 LLM、不做自由工具循环）：
//
//   1. 从报表自身的 KPI / 日趋势挑异常候选；
//   2. 按「业务维度优先级」逐维尝试：门店 → 商品 → 客户 → 日；
//   3. 每个维度算「主因解释度」= |top delta| / Σ|delta|；达到阈值即收口，
//      低于阈值就换下一维（这就是「有界」：最多 2 维 / 4 次探针）；
//   4. 对胜出的维度再取一层明细行（订单级），形成「维度 → 明细」链；
//   5. 输出 findings + 证据数字；narrative.ts 的 LLM 只负责一次成文。
//
// 数据入口只有两个，且都复用既有唯一入口：
//   · `runDetailQuery`（指标声明的 detail 绑定）——复合口径 / 订单级根因的首选；
//   · `compileRecipe` + `executeExplore`（方差 / Top-N）——单列聚合指标的贡献分解。
// 权限/掩码/审计/双钟全部由这两个入口负责；本文件不写 SQL、不写权限判定。
import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { visibleMetrics, type MetricDef, type Requester } from './authz'
import { runDetailQuery } from './drill'
import { loadMergedCatalog, type MetricRow } from './metric-store'
import type { QueryDeps, SqlExecutor } from './query-service'
import { executeExplore } from './analysis/explore-exec'
import { applyRecipe, compileRecipe, recipeTargetOf } from './analysis/recipes'
import type { RecipeKind, RecipeRequest } from './analysis/recipes'
import type { ExploreAgg } from './analysis/explore'
import { formatValue } from './report-format'
import { compareRangeOf } from './report-query'
import type { FactBundle } from './report-facts'
import type { KpiPanel, PeriodSpec, ReportSpec } from './report-spec'
import { dimensionNamesOf } from './semantic-compiler'
import { analystPool, runWarehouseSqlParams } from './warehouse'
import type { ToolboxDeps } from './toolbox/registry'

/** 根因事实里的一行（值已格式化，白名单与展示同一把尺）。 */
export interface RootCauseRow {
  label: string
  value: string
  /** variance 才有：本期 - 基期（格式化后的值）。 */
  delta?: string
  /** Top-N / variance 的贡献占比（如 `-120%`）。 */
  share?: string
}

export interface RootCauseFinding {
  metricId: string
  metricTitle: string
  /** `detail` = 维度下的明细行；`variance` = 两期分解；`top` = 单期贡献；`unavailable` = 无法分解。 */
  kind: 'detail' | 'variance' | 'top' | 'unavailable'
  dimension: string
  rows: RootCauseRow[]
  /** 给人读的附加说明（如双钟、未接入源、指标不可分解）。 */
  note?: string
  detailRowCount?: number
  clockNote?: string
}

export interface RootCauseBundle {
  findings: RootCauseFinding[]
  /** 额外数字白名单（会并入 FactBundle.numbers）。 */
  numbers: string[]
  dataAsOf: string | null
  hash: string
  /** 已尝试的 `metricId:dimension`（有界循环的审计面；上限 6）。 */
  tried: string[]
}

export interface RootCauseDeps {
  pool: Pool
  org: string
  requester: Requester
  adoptedSources: ReadonlySet<string>
  execute?: SqlExecutor
  exploreExec?: ToolboxDeps['exploreExec']
  raceRetryDelayMs?: number
  dimensionLookup?: QueryDeps['dimensionLookup']
  /** 当前报表门店（筛选栏覆盖优先）：探针必须和报表同店，否则会拿别店订单当根因。 */
  branchNum?: string | null
}

/** `buildRootCause` 只依赖事实包里的这几段（避免与 report-facts 形成运行时环）。 */
export type RootCauseFacts = Pick<FactBundle, 'kpis' | 'breakdowns' | 'daily' | 'dataAsOf'>

/** 硬上限：异常候选最多 2 个 × 最多 2 维 = 4 次探针；生产上按天数切窗后通常 1–2 次就收口。 */
export const MAX_PROBES = 4
export const MAX_DIMENSIONS = 2
/** 主因解释度阈值：top |delta| / Σ|delta| ≥ 该值即收口；否则换下一维。 */
export const CONCENTRATION_THRESHOLD = 0.5
const TOP_N = 5
const PREFERRED_DIMS = ['branch_num', 'item_num', 'client_fid', 'bizday'] as const

interface ProbeResult {
  finding: RootCauseFinding
  /** 0..1；越高越像「单一主因」。 */
  concentration: number
  /** 可选下一层：胜出维度值下的订单/明细行。 */
  detail?: RootCauseFinding
}

interface Candidate {
  metricId: string
  metricTitle: string
  kind: 'kpi_delta' | 'lowest_day'
  format: KpiPanel['format']
  compare: { from: string; to: string } | null
  day?: string
}

/** 解析 facts 里的格式化数字（`1,234.56` / `-1200` / `47.36%` / `+2.1pp` / `-`）。 */
export function numOf(s: string | null | undefined): number | null {
  if (s === null || s === undefined || s === '' || s === '-') return null
  const t = s.replaceAll(',', '').replace(/[%pp]+$/i, '').replace(/^\+/, '').trim()
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function fmt(n: number, format: KpiPanel['format']): string {
  return formatValue(n, format).replace(/^¥/, '')
}

function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`
}

/**
 * 该指标可尝试的分解维度，按业务优先级排序：
 * 门店 → 商品 → 客户 → 日，其余 grain 列补位；排除主体列/账套。
 * 有 `drill` 时只认声明闭集；否则用 grain（recipe 的可用列由 executeExplore 再校验）。
 */
export function rankDimensions(metric: MetricDef): string[] {
  const dims = metric.drill?.dims ?? dimensionNamesOf(metric)
  const preferred = PREFERRED_DIMS.filter((d) => dims.includes(d)) as string[]
  const rest = dims.filter((d) => !(PREFERRED_DIMS as readonly string[]).includes(d))
  return [...preferred, ...rest]
    .filter((d) => d !== 'system_book' && d !== 'org')
    .slice(0, MAX_DIMENSIONS)
}

/** 兼容旧调用：优先维度。 */
export function chooseDimension(metric: MetricDef): string | null {
  return rankDimensions(metric)[0] ?? null
}

/**
 * 从报表自身的 KPI/日趋势面板挑「值得解释的异常」——只挑不跑探针。
 * 排序按相对变化；无对比值的 KPI 不参与排序，但仍可作为日趋势候选。
 */
export function pickCandidates(
  spec: ReportSpec, facts: RootCauseFacts, range: { from: string; to: string },
  periodMode: PeriodSpec['mode'] | undefined,
): Candidate[] {
  const out: Candidate[] = []
  const formatByMetric = new Map<string, KpiPanel['format']>()
  for (const p of spec.panels) if (p.chart === 'kpi') formatByMetric.set(p.metricId, p.format)
  for (const p of spec.panels) {
    if (p.chart !== 'kpi') continue
    const k = facts.kpis.find((x) => x.panel === p.title)
    if (k === undefined) continue
    const compare = p.timeScoped === false ? null : compareRangeOf(p, periodMode, range)
    out.push({
      metricId: p.metricId, metricTitle: p.title, kind: 'kpi_delta', format: p.format,
      compare,
      // 明细探针按**最低日单日**切窗：19 天整段直读湖会把一次探针拖到分钟级。
      ...(facts.daily.min === null ? {} : { day: facts.daily.min.day }),
    })
  }
  // 日趋势：最低日；line 本身没有 compare，复用同指标 KPI 的对比段。
  const line = spec.panels.find((p) => p.chart === 'line')
  if (line !== undefined && facts.daily.min !== null) {
    const compareKpi = spec.panels.find((p) => p.chart === 'kpi' && p.metricId === line.metricId)
    const compare = compareKpi !== undefined && compareKpi.chart === 'kpi'
      ? compareRangeOf(compareKpi, periodMode, range)
      : null
    out.push({
      metricId: line.metricId, metricTitle: line.title, kind: 'lowest_day',
      format: formatByMetric.get(line.metricId) ?? 'number', compare, day: facts.daily.min.day,
    })
  }
  const rank = (c: Candidate): number => {
    const k = facts.kpis.find((x) => x.panel === c.metricTitle)
    const cur = numOf(k?.current)
    const prev = numOf(k?.previous)
    if (cur === null || prev === null || prev === 0) return -1
    return Math.abs(cur - prev) / Math.abs(prev)
  }
  return out.sort((a, b) => rank(b) - rank(a)).slice(0, 2)
}

/** 按维度把明细行聚合成 {维度值 → 值}（用于本期/基期对比）。 */
function aggregateDetail(
  out: { columns: string[]; rows: unknown[][] }, dimension: string,
): Map<string, number> {
  const di = out.columns.indexOf(dimension)
  const vi = out.columns.indexOf('value')
  const map = new Map<string, number>()
  if (di < 0 || vi < 0) return map
  for (const row of out.rows) {
    const label = String(row[di] ?? '')
    const n = numOf(String(row[vi] ?? ''))
    if (label === '' || n === null) continue
    map.set(label, (map.get(label) ?? 0) + n)
  }
  return map
}

/** 明细行里取「胜出维度值」的订单/明细行（下一层）。 */
function detailRowsOf(
  out: { columns: string[]; rows: unknown[][] }, dimension: string, topLabel: string,
): RootCauseRow[] {
  const di = out.columns.indexOf(dimension)
  const vi = out.columns.indexOf('value')
  const oi = out.columns.indexOf('order_no')
  if (di < 0 || vi < 0 || oi < 0) return []
  return out.rows
    .filter((r) => String(r[di] ?? '') === topLabel)
    .map((r) => ({ label: String(r[oi] ?? ''), n: numOf(String(r[vi] ?? '')) }))
    .filter((r): r is { label: string; n: number } => r.label !== '' && r.n !== null)
    .sort((a, b) => Math.abs(b.n) - Math.abs(a.n))
    .slice(0, TOP_N)
    .map((r) => ({ label: r.label, value: fmt(r.n, 'number') }))
}

function concentrationOf(rows: RootCauseRow[], key: 'delta' | 'value' | 'share'): number {
  const vals = rows
    .map((r) => numOf(r[key]))
    .filter((n): n is number => n !== null)
    .map(Math.abs)
  const sum = vals.reduce((a, b) => a + b, 0)
  return sum === 0 ? 0 : Math.max(...vals) / sum
}

function topRows(
  cur: Map<string, number>, format: KpiPanel['format'],
): { rows: RootCauseRow[]; concentration: number } {
  const rows = [...cur.entries()]
    .map(([label, value]) => ({ label, value: fmt(value, format) }))
    .sort((a, b) => Math.abs(numOf(b.value) ?? 0) - Math.abs(numOf(a.value) ?? 0))
    .slice(0, TOP_N)
  return { rows, concentration: concentrationOf(rows, 'value') }
}

async function detailProbe(
  deps: RootCauseDeps, metric: MetricRow, dimension: string,
  candidate: Candidate, range: { from: string; to: string },
): Promise<ProbeResult | null> {
  // 只跑**单日**（最低日；没有就取期间末日）：整段直读湖会把一次探针拖到分钟级。
  // 基期对比由 KPI 事实负责；这里的职责是「哪个维度/哪几行造成异常」。
  // 单日窗口下 `bizday` 维度恒一行，是退化维（「最低日就是最低日」）——不作为明细根因。
  if (dimension === 'bizday' && candidate.day !== undefined) return null
  const window = candidate.day === undefined
    ? { from: range.to, to: range.to }
    : { from: candidate.day, to: candidate.day }
  const drillDims = metric.drill?.dims ?? []
  const orderDim = dimension !== 'order_no' && drillDims.includes('order_no') ? 'order_no' : null
  const requested = orderDim === null ? [dimension] : [dimension, orderDim]
  const qd: QueryDeps = {
    pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources,
    raceRetryDelayMs: deps.raceRetryDelayMs, dimensionLookup: deps.dimensionLookup,
  }
  const args: Record<string, unknown> = { bizday: window }
  if (deps.branchNum !== undefined && deps.branchNum !== null && metric.params.branch_num !== undefined) {
    args.branch_num = deps.branchNum
  }
  const cur = await runDetailQuery(
    qd, deps.org, deps.requester, metric.id, args,
    { dimensions: requested, orderBy: 'value', desc: true, limit: 100 },
  )
  if (cur.status !== 'ok') return null
  const curMap = aggregateDetail(cur, dimension)
  if (curMap.size === 0) return null
  const { rows, concentration } = topRows(curMap, candidate.format)
  if (rows.length === 0) return null

  const note = candidate.compare === null
    ? undefined
    : '单日主因（基期对比见 KPI 事实；逐单对比基期需另查）'
  const primary: RootCauseFinding = {
    metricId: metric.id, metricTitle: metric.title,
    kind: 'top', dimension, rows,
    detailRowCount: cur.rowCountTotal,
    ...(cur.clock_note !== undefined ? { clockNote: cur.clock_note } : {}),
    ...(note === undefined ? {} : { note }),
  }
  let detail: RootCauseFinding | undefined
  if (orderDim !== null && rows[0] !== undefined) {
    const orderRows = detailRowsOf(cur, dimension, rows[0].label)
    if (orderRows.length > 0) {
      detail = {
        metricId: metric.id, metricTitle: metric.title, kind: 'detail', dimension: orderDim,
        rows: orderRows, detailRowCount: cur.rowCountTotal,
        note: `${dimension}=${rows[0].label} 的明细行`,
        ...(cur.clock_note !== undefined ? { clockNote: cur.clock_note } : {}),
      }
    }
  }
  return { finding: primary, concentration, ...(detail === undefined ? {} : { detail }) }
}

async function recipeProbe(
  deps: RootCauseDeps, metric: MetricRow,
  target: { relation: string; measure: { agg: ExploreAgg; column: string } },
  dimension: string, candidate: Candidate, range: { from: string; to: string },
): Promise<ProbeResult | null> {
  const recipe: RecipeKind = candidate.compare === null ? 'top_contributors' : 'variance'
  const req: RecipeRequest = {
    recipe,
    relation: target.relation,
    measure: { agg: target.measure.agg, column: target.measure.column },
    dimension,
    ...(candidate.compare === null
      ? { period: { from: range.from, to: range.to } }
      : { periodA: { from: range.from, to: range.to }, periodB: candidate.compare }),
    topN: TOP_N,
  }
  const compiled = compileRecipe(req)
  if (!compiled.ok) return null
  // 与报表同店：报表筛选栏的门店必须带进配方，否则会拿别店贡献当根因。
  if (deps.branchNum !== undefined && deps.branchNum !== null
    && (metric.params.branch_num !== undefined || dimensionNamesOf(metric).includes('branch_num'))) {
    for (const spec of compiled.specs) {
      spec.filters = [...(spec.filters ?? []), { column: 'branch_num', op: 'eq', value: deps.branchNum }]
    }
  }
  const exec = deps.exploreExec ?? ((sql, params) => runWarehouseSqlParams(analystPool(), sql, params))
  const results: Array<{ columns: string[]; rows: unknown[][] }> = []
  for (const spec of compiled.specs) {
    const out = await executeExplore({
      pool: deps.pool, org: deps.org,
      requesterUserId: deps.requester.userId, channel: deps.requester.channel,
      keyId: deps.requester.keyId, exec, audit: true,
    }, spec)
    if (!out.ok) return null
    results.push({ columns: out.columns, rows: out.rows })
  }
  const applied = applyRecipe(req, results)
  const format = candidate.format
  const rows: RootCauseRow[] = applied.rows.slice(0, TOP_N).map((r) => {
    const row = r as Record<string, unknown>
    const value = typeof row.value === 'number' ? fmt(row.value, format)
      : typeof row.current === 'number' ? fmt(row.current, format) : '-'
    const delta = typeof row.delta === 'number' ? fmt(row.delta, format) : undefined
    const share = typeof row.share === 'number' ? `${(row.share * 100).toFixed(2)}%` : undefined
    return {
      label: String(row.dimension ?? ''), value,
      ...(delta === undefined ? {} : { delta }),
      ...(share === undefined ? {} : { share }),
    }
  }).filter((r) => r.label !== '')
  if (rows.length === 0) return null
  const concentration = concentrationOf(rows, recipe === 'variance' ? 'delta' : 'value')
  return {
    finding: {
      metricId: metric.id, metricTitle: metric.title,
      kind: recipe === 'variance' ? 'variance' : 'top', dimension, rows,
      note: compiled.notes.join('；'),
    },
    concentration,
  }
}

async function probeDimension(
  deps: RootCauseDeps, metric: MetricRow, dimension: string,
  candidate: Candidate, range: { from: string; to: string },
): Promise<ProbeResult | null> {
  // 1) 明细下钻（复合口径也能用；只认声明闭集）
  if (metric.drill !== undefined && metric.drill.dims.includes(dimension) && metric.params.bizday !== undefined) {
    const detail = await detailProbe(deps, metric, dimension, candidate, range)
    if (detail !== null) return detail
  }
  // 2) 单列聚合配方（variance / top）
  const target = recipeTargetOf(metric.selectSql)
  if (target.ok) return recipeProbe(deps, metric, target, dimension, candidate, range)
  return null
}

function addLabelNumbers(numbers: Set<string>, label: string): void {
  for (const m of label.match(/\d+/g) ?? []) numbers.add(m)
}

function addFindingNumbers(numbers: Set<string>, f: RootCauseFinding): void {
  for (const r of f.rows) {
    if (r.value !== '-') numbers.add(r.value)
    if (r.delta !== undefined) numbers.add(r.delta)
    if (r.share !== undefined) numbers.add(r.share)
    addLabelNumbers(numbers, r.label)
  }
}

function findingKey(f: RootCauseFinding): string {
  return `${f.metricId}|${f.kind}|${f.dimension}|${f.rows.map((r) => r.label).join(',')}`
}

/**
 * 有界根因分析。返回 null 时 narrative 走「无法分解」文案（不编）。
 *
 * 预算：2 个异常候选 × 最多 2 维 = 4 次探针；每维 Top 5；胜出维度再取一层明细行。
 * 明细探针只读**单日**（最低日），避免整段直读湖把首屏拖到分钟级。
 * 缓存键（factsHash）包含本包，同一事实不重复跑探针。
 */
export async function buildRootCause(
  deps: RootCauseDeps, spec: ReportSpec, range: { from: string; to: string },
  periodMode: PeriodSpec['mode'] | undefined, facts: RootCauseFacts,
): Promise<RootCauseBundle | null> {
  // 与所有消费通道同一把裁剪尺：不可见/未接入源的指标不做探针。
  const catalog = visibleMetrics(
    await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources,
  )
  const numbers = new Set<string>()
  const findings: RootCauseFinding[] = []
  const tried: string[] = []
  let probes = 0

  // 报表自己的拆解面板：已经是「按维度分解」的结果，直接作为 finding（不重复查）。
  for (const b of facts.breakdowns.slice(0, 2)) {
    const rows = b.rows.slice(0, TOP_N)
    const panel = spec.panels.find((p) => p.chart !== 'text' && p.chart !== 'ai_text' && p.title === b.panel)
    const metricId = panel !== undefined && 'metricId' in panel ? panel.metricId : ''
    findings.push({
      metricId, metricTitle: b.panel, kind: 'top', dimension: b.dimension, rows,
      note: '报表面板自带的维度拆解',
    })
  }

  const candidates = pickCandidates(spec, facts, range, periodMode)
  for (const c of candidates) {
    const metric = catalog.find((m) => m.id === c.metricId)
    if (metric === undefined) continue
    const dims = rankDimensions(metric)
    let best: ProbeResult | null = null
    for (const dim of dims) {
      if (probes >= MAX_PROBES) break
      probes += 1
      tried.push(`${metric.id}:${dim}`)
      const r = await probeDimension(deps, metric, dim, c, range)
      if (r === null) continue
      if (best === null || r.concentration > best.concentration) best = r
      // 主因集中度达标 ⇒ 收口；否则继续换下一维（有界循环的核心）
      if (r.concentration >= CONCENTRATION_THRESHOLD) break
    }
    if (best === null) {
      findings.push({
        metricId: metric.id, metricTitle: metric.title, kind: 'unavailable',
        dimension: dims[0] ?? '', rows: [],
        note: `已尝试维度：${dims.join('、') || '无'}；该指标没有可用的下钻/单列聚合分解路径`,
      })
      continue
    }
    findings.push(best.finding)
    if (best.detail !== undefined) findings.push(best.detail)
  }

  // 去重 + 上限：主 finding 优先（breakdown 在前会挤掉探针结果，按 kind 排序）
  const order: Record<RootCauseFinding['kind'], number> = { variance: 0, detail: 1, top: 2, unavailable: 3 }
  const seen = new Set<string>()
  const deduped = findings
    .sort((a, b) => order[a.kind] - order[b.kind])
    .filter((f) => {
      const k = findingKey(f)
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .slice(0, 4)

  if (deduped.length === 0) return null
  for (const f of deduped) addFindingNumbers(numbers, f)
  for (const c of candidates) {
    if (c.day === undefined) continue
    const day = c.day
    numbers.add(day)
    addLabelNumbers(numbers, day)
  }
  const hash = createHash('sha256').update(canonicalJson({ findings: deduped, tried })).digest('hex')
  return {
    findings: deduped,
    numbers: [...numbers],
    dataAsOf: facts.dataAsOf,
    hash,
    tried,
  }
}
