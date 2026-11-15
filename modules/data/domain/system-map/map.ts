// map.ts —— 「数据体系地图」的取数、建模与渲染（只读、纯函数、可注入数据单测）。
//
// 事实源三层（页面上的每个数字都必须能指回其中一层，不许「感觉」）：
//   ① 仓内声明：dbt/semantics/l1_metrics.yml（L1 口径原文 / 实体 / 表达式 / grain）
//               + dbt/semantics/dimensions.yml（W4 维度层级）
//               + dbt/semantics/invariants.yml（W4 业务不变量）
//               + contracts/**/*.json（源表契约）+ dbt/models/**/*.sql（ref 图）
//               + dbt/tests/**（对账 singular test 是否落地）
//   ② 运行库：data.metrics（L1 ∪ 本租户 L2 ∪ 私有测度）、data.reports/report_versions、
//             data.query_audit（近 30 天按 metric_id 聚合）、data.demand_signals（未消解）、
//             data.metric_audit（近 90 天口径事故计数）
//   ③ 由 ①② 推导的视图：健康五数、实体分组、数据源上游链、指标回溯链
//
// 铁律：
//   · **不写库、不调外部服务**；读面失败不抛整页——坏文件/坏 YAML 进 warnings，页面照样出。
//   · 所有来自库/文件的文本只经 `textContent` 进 DOM；嵌入的 JSON 把 `<`/`>`/`&` 转成
//     `<` 等转义序列（防 `</script>` 逃逸）。渲染层**不拼 innerHTML**。
//   · 单文件 HTML：内联 CSS + 原生 JS + `<script type="application/json">`，零 CDN / 零新依赖。
//   · 结果在路由层缓存 10 分钟（见 routes/system-map.ts）；本文件每次调用都是全量重算。
//   · **健康五数只由 healthOf 计算**（W5 Task 1 的唯一实现；本文件不写第二把尺）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Pool } from 'pg'
// @ts-expect-error TS7016: scripts/ 不是 workspace 包、没有 .d.ts；映射函数只有这一处事实源
// （与 domain/system-map/health.ts、domain/pipelines/propose-metric.ts 同一处理）。
import { metricToAuditFileName } from '../../../../scripts/check-data-models.mjs'
import { healthOf } from './health'
import { valueMetricsOf, type ValueMetrics } from '../analysis/value-metrics'
import type { HealthSummary } from './health'
import { REPO_ROOT, loadContracts, rootsOf } from '../pipelines/defs'
import type { ContractRef } from '../pipelines/defs'
import { readCurrentSemanticsYaml } from '../pipelines/propose-metric'
import { loadMergedCatalog } from '../metric-store'
import type { MetricRow } from '../metric-store'
import { listReports } from '../report-store'
import { listDemands } from '../demand/store'

// ── 输入形状（全部可注入；测试不碰文件系统与数据库）────────────────────────────

export interface SystemMapEntityDecl {
  label: string
  synonyms: string[]
}

export interface SystemMapSemanticsMetric {
  label: string
  definition: string
  expression: string
  grain: string[]
  entity: string | null
  synonyms: string[]
  unit: string | null
  owner: string | null
  tier: string | null
}

export interface SystemMapSemantics {
  entities: Map<string, SystemMapEntityDecl>
  metrics: Map<string, SystemMapSemanticsMetric>
}

/** 一条指标的事实（运行库行 + 可选的 YAML 声明）。除 id 外都可缺省，便于单测造最小样本。 */
export interface SystemMapMetricFact {
  id: string
  title?: string
  description?: string
  selectSql?: string
  entity?: string | null
  synonyms?: string[]
  source?: 'l1' | 'l2'
  basis?: 'l1_tree' | 'column_agg' | 'declared'
  certified?: 'certified' | 'draft'
  requiredScope?: string | null
  unit?: string | null
  bizDescription?: string | null
  caliberNote?: string | null
}

export interface SystemMapDbtModel {
  name: string
  path?: string
  refs?: string[]
  sources?: Array<{ source: string; table: string }>
  /** SQL 原文（供「湖前缀被哪些模型引用」的静态扫描；管线地图用，别拿它去执行）。 */
  sql?: string
}

export interface SystemMapReportFact {
  id: string
  title: string
  renderer?: string
  publishedVersion?: number | null
  latestVersion?: number | null
  latestVersionTitle?: string | null
}

export interface SystemMapDemandFact {
  id?: number
  kind: string
  target: string
  occurrences: number
  lastSeen?: string
  detail?: unknown
  /** 供健康五数的「未消解需求」判定（`null` = 未消解）。 */
  dismissedAt?: string | null
}

/** W4 维度层级：名称 / 层级级数 / 关系。 */
export interface SystemMapDimension {
  name: string
  label: string
  relation: string
  key: string
  /** 自顶向下；`level` 是层级名、`column` 是列名。 */
  levels: Array<{ level: string; column: string }>
}

/** W4 业务不变量：名称 / status / severity（另带关系与 why 便于人读）。 */
export interface SystemMapInvariant {
  name: string
  relation: string
  severity: string
  status: string
  owner: string | null
  why: string
}

export interface SystemMapInput {
  semanticsYaml?: string | null
  semantics?: SystemMapSemantics
  metrics: SystemMapMetricFact[]
  contracts: ContractRef[]
  models: SystemMapDbtModel[]
  auditFiles: string[]
  reports: SystemMapReportFact[]
  usage: Record<string, number>
  demands: SystemMapDemandFact[]
  /** 近 90 天口径事故计数（`data.metric_audit`）。缺省 0。 */
  incidents?: number
  /** 事故计数是否真的取到了（false ⇒ 页面标注「未接入」，不冒充 0）。缺省 true。 */
  incidentsTracked?: boolean
  dimensionsYaml?: string | null
  dimensions?: SystemMapDimension[]
  invariantsYaml?: string | null
  invariants?: SystemMapInvariant[]
  /** Task 5：marts 表归属登记（`dbt/semantics/table-owners.yml`）。 */
  tableOwnersYaml?: string | null
  /** Task 5：待处置候选（`data.metric_candidates` 的 pending 行）；缺省 = 未接入。 */
  candidateRows?: Array<{ relation?: string; agg?: string; column?: string }>
  /** W6：已验问答裁决计数（`data.verified_questions`）；null = 未接入。 */
  verifiedCounts?: { total: number; decided: number } | null
  /** W6：可辩护答案耗时样本（毫秒）；null/undefined = 未接入（今天没有会话关联，恒为 null）。 */
  answerDurationsMs?: readonly number[] | null
  /** 取数期降级说明（DB 查询失败等）；由 loadSystemMapFacts 收集，合并进页面 warnings。 */
  loadWarnings?: string[]
  generatedAt?: string
}

// ── 输出模型（路由/测试直接消费；HTML 只是它的一个渲染面）──────────────────────

/** 健康五数（`healthOf` 的产出）+ 指标分层明细。字段名与 `HealthSummary` 逐字一致。 */
export interface SystemMapHealth extends HealthSummary {
  l1Metrics: number
  l2Metrics: number
  privateMetrics: number
  incidentsTracked: boolean
}

export interface SystemMapTraceUpstream {
  name: string
  depth: number
  path: string | null
  contracts: string[]
}

export interface SystemMapMetric {
  id: string
  title: string
  label: string
  definition: string
  entity: string | null
  entityLabel: string | null
  synonyms: string[]
  grain: string[]
  expression: string
  selectSql: string
  relations: string[]
  source: 'l1' | 'l2'
  basis: 'l1_tree' | 'column_agg' | 'declared'
  certified: 'certified' | 'draft'
  requiredScope: string | null
  unit: string | null
  bizDescription: string | null
  caliberNote: string | null
  auditFile: string
  auditExists: boolean
  usage30d: number
  trace: {
    metric: string
    entity: string | null
    relation: string | null
    model: string | null
    modelPath: string | null
    upstream: SystemMapTraceUpstream[]
    contracts: string[]
  }
}

export interface SystemMapEntityGroup {
  name: string
  label: string
  synonyms: string[]
  metricIds: string[]
  relations: string[]
}

export interface SystemMapSource {
  name: string
  modelPath: string | null
  metricIds: string[]
  upstream: SystemMapTraceUpstream[]
  contracts: string[]
}

export interface SystemMapOrphan {
  id: string
  title: string
  reasons: string[]
}

/** Task 5：一张 marts 表的归属（owner 为 null = 孤儿表，要人认领）。 */
export interface SystemMapTable {
  name: string
  path: string | null
  owner: string | null
}

/** Task 5：候选池质量（只报告，不处置）。 */
export interface SystemMapCandidateQuality {
  total: number
  junk: number
  junkPct: number
  samples: Array<{ relation: string; agg: string; column: string }>
}

export interface SystemMapModel {
  generatedAt: string
  health: SystemMapHealth
  metrics: SystemMapMetric[]
  entities: SystemMapEntityGroup[]
  sources: SystemMapSource[]
  orphans: SystemMapOrphan[]
  /** marts 表全量（含 owner），`orphanTables` 是其中 owner 为空的子集。 */
  tables: SystemMapTable[]
  orphanTables: SystemMapTable[]
  candidateQuality: SystemMapCandidateQuality
  /** W6 三个价值指标（缺数即 null/未接入）。 */
  valueMetrics: ValueMetrics
  reports: Array<SystemMapReportFact & { latestVersion: number | null; latestVersionTitle: string | null }>
  demands: SystemMapDemandFact[]
  dimensions: SystemMapDimension[]
  invariants: SystemMapInvariant[]
  warnings: string[]
}

// ── YAML / dbt / contracts 的读取与解析（全部不抛）──────────────────────────────

const asText = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}

/** 解析 L1 语义声明。解析失败 ⇒ 空结构 + 由调用方给 warning（未知 ≠ 没有声明）。 */
export function parseSystemMapSemantics(raw: string | null | undefined): SystemMapSemantics {
  const entities = new Map<string, SystemMapEntityDecl>()
  const metrics = new Map<string, SystemMapSemanticsMetric>()
  if (typeof raw !== 'string' || raw.trim() === '') return { entities, metrics }
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch {
    return { entities, metrics }
  }
  const root = asRecord(doc)

  const rawEntities = asRecord(root.entities)
  for (const [name, value] of Object.entries(rawEntities)) {
    const decl = asRecord(value)
    entities.set(name, { label: asText(decl.label) || name, synonyms: asStringArray(decl.synonyms) })
  }

  if (Array.isArray(root.metrics)) {
    for (const item of root.metrics) {
      const m = asRecord(item)
      const name = asText(m.name)
      if (name === '') continue
      metrics.set(name, {
        label: asText(m.label) || name,
        definition: asText(m.definition),
        expression: asText(m.expression),
        grain: asStringArray(m.grain),
        entity: asText(m.entity) || null,
        synonyms: asStringArray(m.synonyms),
        unit: asText(m.unit) || null,
        owner: asText(m.owner) || null,
        tier: asText(m.tier) || null,
      })
    }
  }
  return { entities, metrics }
}

/**
 * 解析 W4 维度层级声明（`dbt/semantics/dimensions.yml`）。
 * 形状：`dimensions: [{ name, label, relation, key, hierarchy: [{ level, column }] }]`。
 * 坏 YAML ⇒ []（调用方给 warning；未知 ≠ 没有声明）。
 */
export function parseDimensionsYaml(raw: string | null | undefined): SystemMapDimension[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch {
    return []
  }
  const root = asRecord(doc)
  if (!Array.isArray(root.dimensions)) return []
  const out: SystemMapDimension[] = []
  for (const item of root.dimensions) {
    const d = asRecord(item)
    const name = asText(d.name)
    if (name === '') continue
    const levels: Array<{ level: string; column: string }> = []
    if (Array.isArray(d.hierarchy)) {
      for (const lv of d.hierarchy) {
        const level = asRecord(lv)
        const levelName = asText(level.level)
        if (levelName === '') continue
        levels.push({ level: levelName, column: asText(level.column) })
      }
    }
    out.push({
      name,
      label: asText(d.label) || name,
      relation: asText(d.relation),
      key: asText(d.key),
      levels,
    })
  }
  return out
}

/**
 * 解析 W4 业务不变量（`dbt/semantics/invariants.yml`）。
 * 只取展示面字段（name/relation/severity/status/owner/why）；`check_sql` 不在页面上复制。
 */
export function parseInvariantsYaml(raw: string | null | undefined): SystemMapInvariant[] {
  if (typeof raw !== 'string' || raw.trim() === '') return []
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch {
    return []
  }
  const root = asRecord(doc)
  if (!Array.isArray(root.invariants)) return []
  const out: SystemMapInvariant[] = []
  for (const item of root.invariants) {
    const inv = asRecord(item)
    const name = asText(inv.name)
    if (name === '') continue
    out.push({
      name,
      relation: asText(inv.relation),
      severity: asText(inv.severity) || 'unknown',
      status: asText(inv.status) || 'unknown',
      owner: asText(inv.owner) || null,
      why: asText(inv.why),
    })
  }
  return out
}

/**
 * 解析 marts 表归属登记（`dbt/semantics/table-owners.yml`）。
 * 形状：`owners: { <表名或模型名>: <负责人> }`。读不到/坏 YAML ⇒ 空表（调用方给 warning）。
 */
export function parseTableOwnersYaml(raw: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof raw !== 'string' || raw.trim() === '') return out
  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch {
    return out
  }
  for (const [name, value] of Object.entries(asRecord(asRecord(doc).owners))) {
    const owner = asText(value).trim()
    if (name.trim() !== '' && owner !== '') out.set(name.trim(), owner)
  }
  return out
}

/** marts 层模型（`dbt/models/**\/marts/*.sql`）——孤儿表统计的取值域。 */
export function martsTablesOf(
  models: readonly SystemMapDbtModel[],
  owners: ReadonlyMap<string, string>,
): SystemMapTable[] {
  return models
    .filter((m) => (m.path ?? '').includes('/marts/'))
    .map((m) => ({
      name: m.name,
      path: m.path ?? null,
      owner: owners.get(m.name) ?? owners.get(m.path ?? '') ?? null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * 候选质量：单列聚合候选里「列名就不像度量」的占比（`*_id` / `*_num` / `*_flag` / `*_status`…
 * 聚合它们通常没业务意义，是 profiler 的噪声）。**只统计，不删除**（删除是人的决定）。
 */
export function candidateQualityOf(
  rows: readonly { relation?: string; agg?: string; column?: string }[],
): SystemMapCandidateQuality {
  const list = Array.isArray(rows) ? rows : []
  const junkRows = list.filter((r) => NON_MEASURE_COLUMN.test(String(r.column ?? '')))
  const samples = junkRows.slice(0, 8).map((r) => ({
    relation: String(r.relation ?? ''),
    agg: String(r.agg ?? ''),
    column: String(r.column ?? ''),
  }))
  const total = list.length
  return {
    total,
    junk: junkRows.length,
    junkPct: total === 0 ? 0 : Math.round((junkRows.length / total) * 1000) / 10,
    samples,
  }
}

/** 非度量列名（不是数值口径维度而是标识/开关）：命中即算噪声候选。 */
const NON_MEASURE_COLUMN = /(?:^|_)(id|num|no|code|flag|status|type|level|seq|sort|order|version|name)$/i

function walkFiles(start: string, predicate: (name: string) => boolean): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile() && predicate(entry.name)) out.push(abs)
    }
  }
  walk(start)
  return out.sort()
}

/** dbt 模型图：模型名 = 文件名去 `.sql`；边 = `{{ ref('x') }}` 与 `{{ source('a','b') }}`。 */
export function loadDbtModels(baseDir: string = REPO_ROOT): SystemMapDbtModel[] {
  const modelsDir = join(baseDir, 'dbt', 'models')
  if (!existsSync(modelsDir)) return []
  const refRe = /\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g
  const sourceRe = /\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g
  const models: SystemMapDbtModel[] = []
  for (const file of walkFiles(modelsDir, (name) => name.endsWith('.sql'))) {
    let sql = ''
    try {
      sql = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const refs: string[] = []
    const sources: Array<{ source: string; table: string }> = []
    for (const m of sql.matchAll(refRe)) if (m[1]) refs.push(m[1])
    for (const m of sql.matchAll(sourceRe)) if (m[1] && m[2]) sources.push({ source: m[1], table: m[2] })
    models.push({
      name: basename(file, '.sql'),
      path: file.slice(baseDir.length).replace(/^[/\\]/, '').replace(/\\/g, '/'),
      refs: [...new Set(refs)],
      sql,
      sources,
    })
  }
  return models
}

/** `dbt/tests/**` 下所有 singular test 的文件名（对账覆盖率按文件名判存在性）。 */
export function loadAuditFiles(baseDir: string = REPO_ROOT): string[] {
  const testsDir = join(baseDir, 'dbt', 'tests')
  if (!existsSync(testsDir)) return []
  return walkFiles(testsDir, (name) => name.endsWith('.sql')).map((p) => basename(p)).sort()
}

/** `dbt/dbt_project.yml` 的 `vars`（只收字符串）：视图里 `{{ var("x_prefix") }}` 的展开值。 */
export function loadDbtVars(baseDir: string = REPO_ROOT): Record<string, string> {
  const raw = readRepoText('dbt/dbt_project.yml', baseDir)
  if (raw === null) return {}
  try {
    const doc = parseYaml(raw) as { vars?: Record<string, unknown> } | null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(doc?.vars ?? {})) {
      if (typeof v === 'string') out[k] = v
    }
    return out
  } catch { return {} }
}

/** 读仓内声明文件；不可读 ⇒ null（未知 ≠ 空文件，由调用方给 warning）。 */
export function readRepoText(relPath: string, baseDir: string = REPO_ROOT): string | null {
  try {
    return readFileSync(join(baseDir, relPath), 'utf8')
  } catch {
    return null
  }
}

// ── select_sql 解析（关系名 / 表达式 / 维度）────────────────────────────────────

const SELECT_SHAPE_RE = /^\s*select\s+([\s\S]+?)\s+from\s+([A-Za-z0-9_."`]+)\s*$/i

export function parseSelectSql(selectSql: string | undefined): {
  expression: string
  dimensions: string[]
  relation: string
} {
  const sql = (selectSql ?? '').trim()
  const m = SELECT_SHAPE_RE.exec(sql)
  if (m !== null) {
    const body = m[1].trim()
    const asValue = /\s+as\s+value\s*(,[\s\S]*)?$/i.exec(body)
    let expression = body
    let dimensions: string[] = []
    if (asValue !== null) {
      expression = body.slice(0, asValue.index).trim()
      dimensions = asValue[1]
        ? asValue[1].slice(1).split(',').map((d) => d.trim()).filter((d) => d !== '')
        : []
    }
    const rawRelation = m[2].replace(/["`]/g, '')
    return { expression, dimensions, relation: rawRelation }
  }

  // 嵌套形态（L2 expr 档编译产物）：`select sum(t.value) as value … from (
  //   select … from <真实关系>) t`。顶层 from 后面是括号，严格形状匹配不到；
  // 退而取**最后一个**裸关系名（内层真实关系），表达式取第一个 `as value` 前的内容。
  // 这是展示面的尽力解析：拿不到就如实留空（孤儿指标会列出），不猜。
  const relationMatches = [...sql.matchAll(/\bfrom\s+([A-Za-z_][A-Za-z0-9_.]*)/gi)]
  const relation = relationMatches.length === 0
    ? ''
    : (relationMatches[relationMatches.length - 1][1] ?? '').replace(/["`]/g, '')
  const exprMatch = /^\s*select\s+([\s\S]+?)\s+as\s+value\b/i.exec(sql)
  return { expression: exprMatch?.[1]?.trim() ?? '', dimensions: [], relation }
}

/** 关系名归一：去掉 schema / 引号，只留末段（模型名不带 schema）。 */
const modelKey = (relation: string): string => {
  const clean = relation.replace(/["`]/g, '').trim()
  const parts = clean.split('.')
  return parts[parts.length - 1] ?? clean
}

/** 模型名 → 契约（staging 命名硬约束：`stg_<domain>_<table>`，见 sources.yml 头注）。 */
function contractsForModel(modelName: string, contracts: ContractRef[]): ContractRef[] {
  return contracts.filter((c) => modelName === `stg_${c.domain}_${c.table}`)
}

function describeContract(c: ContractRef): string {
  return `${c.domain}.${c.table}`
}

/** 从模型名向上游走两层（BFS；循环引用用 seen 兜住）。 */
function upstreamOf(
  start: string,
  models: Map<string, SystemMapDbtModel>,
  contracts: ContractRef[],
  maxDepth = 2,
): SystemMapTraceUpstream[] {
  const out: SystemMapTraceUpstream[] = []
  const seen = new Set<string>([start])
  const queue: Array<{ name: string; depth: number }> = [{ name: start, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    const model = models.get(current.name)
    if (model === undefined) continue
    for (const ref of model.refs ?? []) {
      if (seen.has(ref)) continue
      seen.add(ref)
      const refModel = models.get(ref)
      out.push({
        name: ref,
        depth: current.depth + 1,
        path: refModel?.path ?? null,
        contracts: contractsForModel(ref, contracts).map(describeContract),
      })
      if (current.depth + 1 < maxDepth) queue.push({ name: ref, depth: current.depth + 1 })
    }
  }
  return out
}

// ── 建模型（纯函数）────────────────────────────────────────────────────────────

export function buildSystemMapModel(input: SystemMapInput): SystemMapModel {
  // 取数期的降级（DB 不可读等）与文件解析失败同一张清单：页面照出，坏块显式可见。
  const warnings: string[] = [...(input.loadWarnings ?? [])]
  const semantics = input.semantics ?? parseSystemMapSemantics(input.semanticsYaml ?? null)
  if ((input.semanticsYaml ?? '') === '' && input.semantics === undefined) {
    warnings.push('L1 语义声明（dbt/semantics/l1_metrics.yml）不可读——指标口径原文与实体标签可能缺失')
  }
  const modelMap = new Map(input.models.map((m) => [m.name, m]))
  if (input.models.length === 0) warnings.push('dbt/models 目录不可读或为空——上游模型链为空')
  const contractList = Array.isArray(input.contracts) ? input.contracts : []
  const auditSet = new Set(input.auditFiles.map((f) => basename(f)))
  const usage = input.usage ?? {}
  const demands = Array.isArray(input.demands) ? input.demands : []

  const metrics: SystemMapMetric[] = input.metrics.map((fact) => {
    const decl = semantics.metrics.get(fact.id)
    const select = parseSelectSql(fact.selectSql)
    const relations = select.relation === '' ? [] : [select.relation]
    const title = fact.title?.trim() || decl?.label || fact.id
    const rawEntity = fact.entity ?? decl?.entity ?? null
    const entity = rawEntity === '' ? null : rawEntity
    const entityDecl = entity === null ? undefined : semantics.entities.get(entity)
    const relation = relations[0] ?? null
    const relationModel = relation === null ? undefined : modelMap.get(modelKey(relation))
    const upstream = relationModel === undefined
      ? []
      : upstreamOf(relationModel.name, modelMap, contractList)
    const relationContracts = relationModel === undefined
      ? []
      : contractsForModel(relationModel.name, contractList).map(describeContract)
    const auditFile = metricToAuditFileName(fact.id)
    return {
      id: fact.id,
      title,
      label: decl?.label || title,
      definition: decl?.definition || fact.description || '',
      entity,
      entityLabel: entityDecl?.label ?? entity,
      synonyms: fact.synonyms !== undefined && fact.synonyms.length > 0
        ? fact.synonyms
        : (decl?.synonyms ?? []),
      grain: decl?.grain ?? select.dimensions,
      expression: decl?.expression || select.expression,
      selectSql: fact.selectSql ?? '',
      relations,
      source: fact.source ?? 'l1',
      basis: fact.basis ?? 'l1_tree',
      certified: fact.certified ?? (fact.source === 'l2' ? 'draft' : 'certified'),
      requiredScope: fact.requiredScope ?? null,
      unit: fact.unit ?? decl?.unit ?? null,
      bizDescription: fact.bizDescription ?? null,
      caliberNote: fact.caliberNote ?? null,
      auditFile,
      auditExists: auditSet.has(auditFile),
      usage30d: Number.isFinite(usage[fact.id]) ? Number(usage[fact.id]) : 0,
      trace: {
        metric: fact.id,
        entity,
        relation,
        model: relationModel?.name ?? null,
        modelPath: relationModel?.path ?? null,
        upstream,
        contracts: [...new Set([
          ...relationContracts,
          ...upstream.flatMap((u) => u.contracts),
        ])],
      },
    }
  })

  const l1Metrics = metrics.filter((m) => m.source === 'l1').length
  const privateMetrics = metrics.filter((m) => m.basis === 'column_agg').length
  const l2Metrics = metrics.filter((m) => m.source === 'l2' && m.basis !== 'column_agg').length

  // 健康五数：唯一实现是 healthOf（W5 Task 1）。这里只装配它的输入。
  const healthBase = healthOf({
    metrics: metrics.map((m) => ({ id: m.id, certified: m.certified, entity: m.entity, basis: m.basis })),
    auditTests: input.auditFiles,
    usage,
    demands: demands.map((d) => ({ kind: d.kind, dismissedAt: d.dismissedAt ?? null })),
    incidents: input.incidents ?? 0,
  })
  const health: SystemMapHealth = {
    ...healthBase,
    l1Metrics,
    l2Metrics,
    privateMetrics,
    incidentsTracked: input.incidentsTracked ?? true,
  }

  // 实体分组：先按全部声明实体建组（没有指标的实体也保留，让人看见「声明了但没人用」），
  // 再补上指标里出现但 YAML 未声明的实体名（不吞数据）。
  const entityMap = new Map<string, SystemMapEntityGroup>()
  for (const [name, decl] of semantics.entities) {
    entityMap.set(name, {
      name, label: decl.label, synonyms: decl.synonyms, metricIds: [], relations: [],
    })
  }
  for (const m of metrics) {
    if (m.entity === null || m.entity === '') continue
    let group = entityMap.get(m.entity)
    if (group === undefined) {
      group = { name: m.entity, label: m.entity, synonyms: [], metricIds: [], relations: [] }
      entityMap.set(m.entity, group)
    }
    group.metricIds.push(m.id)
    for (const r of m.relations) if (!group.relations.includes(r)) group.relations.push(r)
  }
  const entities = [...entityMap.values()].sort((a, b) => a.name.localeCompare(b.name))

  // 数据源：所有被指标引用的关系（通常 = marts 模型），带上引用它的指标与两层上游链。
  const sourceMap = new Map<string, SystemMapSource>()
  for (const m of metrics) {
    for (const relation of m.relations) {
      let src = sourceMap.get(relation)
      if (src === undefined) {
        const model = modelMap.get(modelKey(relation))
        const upstream = model === undefined ? [] : upstreamOf(model.name, modelMap, contractList)
        src = {
          name: relation,
          modelPath: model?.path ?? null,
          metricIds: [],
          upstream,
          // 直接模型（staging）本身可能无契约；契约通常在更上游的 staging/源表上，
          // 故把两层链上匹配到的契约合并展示（去重）。
          contracts: [...new Set([
            ...(model === undefined ? [] : contractsForModel(model.name, contractList).map(describeContract)),
            ...upstream.flatMap((u) => u.contracts),
          ])],
        }
        sourceMap.set(relation, src)
      }
      if (!src.metricIds.includes(m.id)) src.metricIds.push(m.id)
    }
  }
  const sources = [...sourceMap.values()].sort((a, b) => a.name.localeCompare(b.name))

  const orphans: SystemMapOrphan[] = []
  for (const m of metrics) {
    const reasons: string[] = []
    if (m.entity === null || m.entity === '') reasons.push('未绑定实体')
    if (m.relations.length === 0) reasons.push('未从 select_sql 解析到源关系')
    else {
      const missing = m.relations.filter((r) => !modelMap.has(modelKey(r)))
      if (missing.length > 0) reasons.push(`源关系不在 dbt 模型图中：${missing.join('、')}`)
    }
    if (reasons.length > 0) orphans.push({ id: m.id, title: m.title, reasons })
  }

  const reports = (input.reports ?? []).map((r) => ({
    ...r,
    latestVersion: r.latestVersion ?? null,
    latestVersionTitle: r.latestVersionTitle ?? null,
  }))

  // W4 声明：只做清单与计数（不改其渲染成图）。读不到 ⇒ 空 + warning。
  const dimensions = input.dimensions ?? parseDimensionsYaml(input.dimensionsYaml ?? null)
  if (input.dimensions === undefined && (input.dimensionsYaml ?? '') === '') {
    warnings.push('维度层级声明（dbt/semantics/dimensions.yml）不可读——总览的维度层级清单为空')
  }
  const invariants = input.invariants ?? parseInvariantsYaml(input.invariantsYaml ?? null)
  if (input.invariants === undefined && (input.invariantsYaml ?? '') === '') {
    warnings.push('业务不变量声明（dbt/semantics/invariants.yml）不可读——总览的不变量清单为空')
  }

  // Task 5：孤儿表（marts 无 owner）+ 候选池质量（只报告，不删除）。
  const tableOwners = parseTableOwnersYaml(input.tableOwnersYaml ?? null)
  if ((input.tableOwnersYaml ?? '') === '') {
    warnings.push('表归属登记（dbt/semantics/table-owners.yml）不可读——marts 表会全部显示为待认领')
  }
  const tables = martsTablesOf(input.models, tableOwners)
  const orphanTables = tables.filter((t) => t.owner === null)
  const candidateQuality = candidateQualityOf(input.candidateRows ?? [])

  // W6 Task 5：三个价值指标（口径在 analysis/value-metrics.ts，唯一实现）。
  const valueMetrics = valueMetricsOf({
    answerDurationsMs: input.answerDurationsMs ?? null,
    decided: input.verifiedCounts?.decided ?? 0,
    verifiedTotal: input.verifiedCounts?.total ?? 0,
    incidents: input.incidentsTracked === false ? null : (input.incidents ?? 0),
  })

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    health,
    metrics,
    entities,
    sources,
    orphans,
    tables,
    orphanTables,
    candidateQuality,
    valueMetrics,
    reports,
    demands,
    dimensions,
    invariants,
    warnings,
  }
}

// ── 取数（生产装配；测试走 buildSystemMapModel 的注入面）────────────────────────

export interface SystemMapLoadDeps {
  pool: Pool
  org: string
  repoRoot?: string
  env?: Record<string, string | undefined>
  now?: Date
}

const metricRowToFact = (row: MetricRow): SystemMapMetricFact => ({
  id: row.id,
  title: row.title,
  description: row.description,
  selectSql: row.selectSql,
  entity: row.entity,
  synonyms: row.synonyms,
  source: row.source,
  basis: row.basis,
  certified: row.certified,
  requiredScope: row.requiredScope ?? null,
  unit: row.unit,
  bizDescription: row.bizDescription,
  caliberNote: row.caliberNote,
})

/**
 * 读取全部事实源。读面失败一律降级（空集 + warnings），不让整页 500：
 * 地图是观测面，某一块坏了应该显示「这块缺失」，而不是整页打不开。
 */
export async function loadSystemMapFacts(deps: SystemMapLoadDeps): Promise<SystemMapInput> {
  const baseDir = deps.repoRoot ?? REPO_ROOT
  const semanticsYaml = readCurrentSemanticsYaml(deps.repoRoot)
  const semantics = parseSystemMapSemantics(semanticsYaml)
  const dimensionsYaml = readRepoText('dbt/semantics/dimensions.yml', baseDir)
  const invariantsYaml = readRepoText('dbt/semantics/invariants.yml', baseDir)
  const tableOwnersYaml = readRepoText('dbt/semantics/table-owners.yml', baseDir)
  const contracts = loadContracts(rootsOf(deps.env ?? process.env, deps.repoRoot)).contracts
  const models = loadDbtModels(baseDir)
  const auditFiles = loadAuditFiles(baseDir)

  // 读面降级一律进 warnings（页面照出，坏块显式可见）——不静默把失败读成「没有数据」。
  const loadWarnings: string[] = []
  const warn = (label: string): void => { loadWarnings.push(`${label} 读取失败——该块按空处理`) }

  // 候选池：只看待处置（pending）的，最多 500 条（这是「质量抽样」，不是全量导出）。
  const candidatesRes = await deps.pool.query(
    `select relation, expr->>'agg' as agg, expr->>'column' as column
       from data.metric_candidates
      where org = $1 and status = 'pending'
      order by id desc
      limit 500`,
    [deps.org],
  ).catch(() => null)

  // W6：可辩护答案时长——按会话算「首条审计 → 首条成功审计」的毫秒差（近 30 天）。
  // 没有 session_id 的行不参与（企微外的通道没有会话概念，不按时间猜）。
  const answerTimeRes = await deps.pool.query(
    `select session_id,
            (extract(epoch from (min(created_at) filter (where verdict = 'ok') - min(created_at))) * 1000)::float8 as ms
       from data.query_audit
      where org = $1 and session_id is not null and created_at >= now() - interval '30 days'
      group by session_id
     having min(created_at) filter (where verdict = 'ok') is not null`,
    [deps.org],
  ).catch(() => null)

  // W6：已验问答裁决计数（接受率的分母/分子）；表缺席 ⇒ null（未接入）。
  const verifiedRes = await deps.pool.query(
    `select count(*)::int as total, count(decided_by)::int as decided
       from data.verified_questions where org = $1`,
    [deps.org],
  ).catch(() => null)

  const [metricRows, reportRows, usageRes, versionRes, demandRows, incidentsRes] = await Promise.all([
    loadMergedCatalog(deps.pool, deps.org)
      .catch(() => { warn('指标词表（data.metrics）'); return [] as MetricRow[] }),
    listReports(deps.pool, deps.org)
      .catch(() => { warn('报表登记（data.reports）'); return [] }),
    deps.pool.query(
      `select metric_id, count(*)::int as uses
         from data.query_audit
        where org = $1 and created_at >= now() - interval '30 days' and verdict = 'ok'
        group by metric_id`,
      [deps.org],
    ).catch(() => {
      warn('近 30 天使用量（data.query_audit）')
      return { rows: [] as Array<{ metric_id: string; uses: number }> }
    }),
    deps.pool.query(
      `select distinct on (report_id) report_id, version, title
         from data.report_versions
        where org = $1
        order by report_id, version desc`,
      [deps.org],
    ).catch(() => {
      warn('报表版本（data.report_versions）')
      return { rows: [] as Array<{ report_id: string; version: number; title: string }> }
    }),
    listDemands(deps.pool, deps.org, { limit: 200 })
      .catch(() => { warn('需求台账（data.demand_signals）'); return [] }),
    // 近 90 天口径事故（data.metric_audit 每次 create/update/delete 一行）。
    // null = 没取到（表缺失/权限/连接失败）⇒ 页面标「未接入」，不冒充 0。
    deps.pool.query(
      `select count(*)::int as n from data.metric_audit
        where org = $1 and created_at >= now() - interval '90 days'`,
      [deps.org],
    ).catch(() => { warn('口径事故计数（data.metric_audit）'); return null }),
  ])

  const usage: Record<string, number> = {}
  for (const row of usageRes.rows) {
    usage[String(row.metric_id)] = Number(row.uses)
  }
  const latestVersion = new Map<string, { version: number; title: string }>()
  for (const row of versionRes.rows) {
    latestVersion.set(String(row.report_id), { version: Number(row.version), title: String(row.title) })
  }

  if (candidatesRes === null) warn('候选池（data.metric_candidates）')

  const incidentsTracked = incidentsRes !== null
  const incidents = incidentsTracked ? Number(incidentsRes.rows[0]?.n ?? 0) : 0

  return {
    semanticsYaml,
    semantics,
    dimensionsYaml,
    invariantsYaml,
    tableOwnersYaml,
    answerDurationsMs: answerTimeRes === null
      ? null
      : (answerTimeRes.rows as Array<{ ms: number }>).map((r) => Number(r.ms)).filter((n) => Number.isFinite(n) && n >= 0),
    verifiedCounts: verifiedRes === null
      ? null
      : { total: Number(verifiedRes.rows[0]?.total ?? 0), decided: Number(verifiedRes.rows[0]?.decided ?? 0) },
    candidateRows: candidatesRes === null
      ? []
      : (candidatesRes.rows as Array<{ relation?: string; agg?: string; column?: string }>),
    metrics: metricRows.map(metricRowToFact),
    contracts,
    models,
    auditFiles,
    reports: reportRows.map((r) => {
      const latest = latestVersion.get(r.id)
      return {
        id: r.id,
        title: r.title,
        renderer: r.renderer,
        publishedVersion: r.publishedVersion,
        latestVersion: latest?.version ?? null,
        latestVersionTitle: latest?.title ?? null,
      }
    }),
    usage,
    demands: demandRows.map((d) => ({
      id: d.id,
      kind: d.kind,
      target: d.target,
      occurrences: d.occurrences,
      lastSeen: d.lastSeen,
      detail: d.detail,
      dismissedAt: d.dismissedAt,
    })),
    incidents,
    incidentsTracked,
    loadWarnings,
    generatedAt: (deps.now ?? new Date()).toISOString(),
  }
}
