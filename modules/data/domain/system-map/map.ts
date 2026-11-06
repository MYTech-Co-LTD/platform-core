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
  basis?: 'l1_tree' | 'column_agg'
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
  basis: 'l1_tree' | 'column_agg'
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

  const total = metrics.length
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

// ── 渲染（单文件 HTML）─────────────────────────────────────────────────────────

/** JSON 内嵌到 `<script>` 的转义：`<`/`>`/`&` 与 U+2028/2029 全部转成 `\uXXXX`。 */
export function escapeJsonForScript(value: unknown): string {
  return (JSON.stringify(value) ?? 'null')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** HTML 文本转义（静态壳里若内联任何外部文本时使用；页面动态内容走 textContent）。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

// ── 客户端脚本（原生 JS；零依赖；全部文本经 textContent）─────────────────────────
//
// 路由约定（W5 Task 3）：
//   #/overview · #/metrics · #/metrics/<id> · #/entities · #/sources · #/demands
// 刷新/分享后落在同一视图；未知 hash 回落总览。
// 手机（<768px）：底部固定标签栏 + 卡片列表 + 吸顶搜索 + 全屏详情 + 五步竖排步骤条；
// 桌面（≥1024px）：左侧栏 + 主区 + 实体—指标 SVG 图（≤80 节点才画）。
const CLIENT_JS = `
(function () {
  var node = document.getElementById('system-map-data');
  if (!node) return;
  var data;
  try { data = JSON.parse(node.textContent || '{}'); } catch (e) { return; }

  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function add(parent, tag, cls, text) {
    var e = h(tag, cls, text); parent.appendChild(e); return e;
  }
  function badge(text, tone) { return h('span', 'badge ' + (tone || ''), text); }
  function field(parent, label, value) {
    if (value === null || value === undefined || value === '') return;
    var row = add(parent, 'div', 'field');
    add(row, 'div', 'field-label', label);
    add(row, 'div', 'field-value', typeof value === 'string' ? value : String(value));
    return row;
  }
  // 口径正文里带轻量 Markdown（双星号加粗、反引号代码，来自 YAML 声明原文）。
  // 只把这两类标记换成 strong/code 元素，其余仍然逐段走 textContent——不拼 HTML，XSS 面不变。
  function richText(parent, tag, cls, text) {
    var host = add(parent, tag, cls);
    var src = String(text === undefined || text === null ? '' : text);
    var re = /\\*\\*([^*]+)\\*\\*|\\x60([^\\x60]+)\\x60/g;
    var last = 0, m;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) add(host, 'span', null, src.slice(last, m.index));
      var node = document.createElement(m[1] ? 'strong' : 'code');
      node.textContent = m[1] || m[2];
      host.appendChild(node);
      last = re.lastIndex;
    }
    if (last < src.length) add(host, 'span', null, src.slice(last));
    return host;
  }
  function linkButton(parent, text, onClick) {
    var b = add(parent, 'button', 'link-button tap', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function table(parent, headers, rows) {
    // 桌面表格；手机走同数据的卡片清单（.mobile-only），避免小屏横向表格。
    var wrap = add(parent, 'div', 'table-wrap desktop-only');
    var t = add(wrap, 'table', 'grid');
    var thead = add(t, 'thead');
    var tr = add(thead, 'tr');
    headers.forEach(function (x) { add(tr, 'th', null, x); });
    var tbody = add(t, 'tbody');
    rows.forEach(function (cells) {
      var r = add(tbody, 'tr');
      cells.forEach(function (cell) {
        var td = add(r, 'td');
        if (cell && typeof cell === 'object' && cell.node) td.appendChild(cell.node);
        else td.textContent = cell === undefined || cell === null ? '—' : String(cell);
      });
    });
    return t;
  }
  function metricById(id) {
    return (data.metrics || []).find(function (x) { return x.id === id; });
  }
  function metricCard(parent, m) {
    var item = h('button', 'metric-item tap');
    item.type = 'button';
    var top = add(item, 'div', 'metric-item-top');
    add(top, 'strong', null, m.title);
    add(top, 'span', 'muted', m.id);
    var tags = add(item, 'div', 'tags');
    tags.appendChild(badge(m.entityLabel || '未绑定实体', m.entityLabel ? 'ok' : 'warn'));
    tags.appendChild(badge(m.basis === 'column_agg' ? '私有测度' : (m.source === 'l1' ? 'L1' : 'L2'), 'info'));
    tags.appendChild(badge(m.certified === 'certified' ? '已认证' : '草稿', m.certified === 'certified' ? 'ok' : 'warn'));
    tags.appendChild(badge('近 30 天 ' + m.usage30d, 'info'));
    item.addEventListener('click', function () { openMetric(m.id, false); });
    parent.appendChild(item);
    return item;
  }

  // ── 头部生成时间 ─────────────────────────────────────────────────────────
  var gen = document.getElementById('generated-at');
  if (gen && data.generatedAt) {
    try {
      gen.textContent = new Date(data.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）';
    } catch (e) { /* 保留服务端 ISO 原文 */ }
  }

  // ── 总览：健康五数 ───────────────────────────────────────────────────────
  var health = data.health || {};
  var cards = document.getElementById('health');
  clear(cards);
  [
    { k: '指标总数', v: health.metricTotal,
      s: 'L1 ' + health.l1Metrics + ' · 自建 L2 ' + health.l2Metrics + ' · 私有测度 ' + health.privateMetrics },
    { k: '实体绑定率', v: health.entityBoundPct + '%',
      s: health.entityBound + ' / ' + health.metricTotal + ' 条指标已绑定实体' },
    { k: '对账覆盖率', v: health.auditCoveredPct + '%',
      s: health.auditCovered + ' / ' + health.metricTotal + ' 条指标有独立复算文件' },
    { k: '近 30 天零使用指标', v: health.zeroUse, s: '按 data.query_audit 成功查询聚合' },
    { k: '未消解需求', v: health.openDemands, s: 'data.demand_signals（未 dismissed）' },
    { k: '口径事故数（近 90 天）', v: health.incidents,
      s: health.incidentsTracked === false
        ? '未接入（data.metric_audit 不可读，不冒充 0）'
        : 'data.metric_audit 变更/删除审计行数' }
  ].forEach(function (c) {
    var card = h('div', 'card');
    add(card, 'div', 'card-value', c.v);
    add(card, 'div', 'card-label', c.k);
    add(card, 'div', 'card-sub', c.s);
    cards.appendChild(card);
  });

  var warnings = document.getElementById('warnings');
  clear(warnings);
  (data.warnings || []).forEach(function (w) { add(warnings, 'div', 'warning', w); });

  // ── 总览：W4 声明（维度层级 / 业务不变量，只做清单与计数）───────────────────
  var dimBox = document.getElementById('dimensions');
  clear(dimBox);
  add(dimBox, 'h3', null, '维度层级（' + (data.dimensions || []).length + ' 个）');
  if (!(data.dimensions || []).length) {
    add(dimBox, 'p', 'empty', '未读到维度层级声明（dbt/semantics/dimensions.yml）。');
  } else {
    var dimList = add(dimBox, 'ul', 'plain-list');
    data.dimensions.forEach(function (d) {
      var li = add(dimList, 'li', 'decl-item');
      add(li, 'strong', null, d.label);
      add(li, 'span', 'muted', ' · ' + d.name + ' · 关系 ' + (d.relation || '—') + ' · ' + d.levels.length + ' 级');
      if (d.levels.length) {
        add(li, 'div', 'decl-detail', d.levels.map(function (l) { return l.level + '(' + l.column + ')'; }).join(' → '));
      }
    });
  }

  var invBox = document.getElementById('invariants');
  clear(invBox);
  var invariants = data.invariants || [];
  add(invBox, 'h3', null, '业务不变量（' + invariants.length + ' 条）');
  if (!invariants.length) {
    add(invBox, 'p', 'empty', '未读到业务不变量声明（dbt/semantics/invariants.yml）。');
  } else {
    var byStatus = {};
    var bySeverity = {};
    invariants.forEach(function (x) {
      byStatus[x.status] = (byStatus[x.status] || 0) + 1;
      bySeverity[x.severity] = (bySeverity[x.severity] || 0) + 1;
    });
    var statusText = Object.keys(byStatus).sort().map(function (k) { return k + ' ' + byStatus[k]; }).join(' / ');
    var sevText = Object.keys(bySeverity).sort().map(function (k) { return k + ' ' + bySeverity[k]; }).join(' / ');
    add(invBox, 'p', 'muted', '按状态：' + statusText + '；按严重度：' + sevText);
    var invList = add(invBox, 'ul', 'plain-list');
    invariants.forEach(function (x) {
      var li = add(invList, 'li', 'decl-item');
      add(li, 'strong', null, x.name);
      var tags = add(li, 'div', 'tags');
      tags.appendChild(badge(x.status, x.status === 'verified' ? 'ok' : 'warn'));
      tags.appendChild(badge('严重度 ' + x.severity, x.severity === 'error' ? 'warn' : 'info'));
      add(li, 'span', 'muted', ' · 关系 ' + (x.relation || '—') + (x.owner ? ' · owner ' + x.owner : ''));
      if (x.why) add(li, 'div', 'decl-detail', x.why);
    });
  }

  // ── 总览：孤儿表（marts 无 owner）——「新表不许静默进入体系」的可见面 ─────────
  var tableBox = document.getElementById('tables');
  clear(tableBox);
  var tables = data.tables || [];
  var orphanTables = data.orphanTables || [];
  add(tableBox, 'h3', null, '孤儿表（待认领 ' + orphanTables.length + ' / ' + tables.length + ' 张 marts 表）');
  if (!tables.length) {
    add(tableBox, 'p', 'empty', '未读到 dbt marts 模型（dbt/models/**/marts）。');
  } else if (!orphanTables.length) {
    add(tableBox, 'p', 'muted', '全部已登记归属（事实源 dbt/semantics/table-owners.yml）。');
  } else {
    add(tableBox, 'p', 'muted', '登记表 dbt/semantics/table-owners.yml；未登记的模型会一直出现在这里。');
    var tList = add(tableBox, 'ul', 'plain-list');
    orphanTables.forEach(function (t) {
      var li = add(tList, 'li', 'decl-item');
      add(li, 'strong', null, t.name);
      add(li, 'span', 'muted', ' · 待认领' + (t.path ? ' · ' + t.path : ''));
    });
  }

  // ── 总览：候选池质量（只报告，不删除——删除是人的决定）───────────────────────
  var candBox = document.getElementById('candidates');
  clear(candBox);
  var cq = data.candidateQuality || { total: 0, junk: 0, junkPct: 0, samples: [] };
  add(candBox, 'h3', null, '候选池质量（待处置 ' + cq.total + ' 条）');
  if (!cq.total) {
    add(candBox, 'p', 'muted', '没有待处置候选（data.metric_candidates.status = pending）。');
  } else {
    add(candBox, 'p', 'muted',
      '其中 ' + cq.junk + ' 条落在标识/开关类列（' + cq.junkPct + '%）——聚合 *_id / *_flag / *_status 通常没有业务含义，属 profiler 噪声。');
    if ((cq.samples || []).length) {
      var sList = add(candBox, 'ul', 'plain-list');
      cq.samples.forEach(function (s) {
        add(sList, 'li', 'decl-item', s.relation + ' · ' + s.agg + '(' + s.column + ')');
      });
    }
    add(candBox, 'p', 'muted', '这里只统计、不处置：拒绝/升格候选仍由人决定（POST /private-measures/candidates/<id>/status）。');
  }

  // ── 总览：三个价值指标（W6 Task 5；缺数显示「未接入」，不画 0）───────────────
  var vmBox = document.getElementById('value-metrics');
  if (vmBox) {
    clear(vmBox);
    var vm = data.valueMetrics || {};
    add(vmBox, 'h3', null, '分析面价值指标');
    var vmNote = add(vmBox, 'p', 'muted', '口径：可辩护答案时长（会话首问→首次带证据包查询成功的中位耗时）/ 接受率（已裁决已验问答占比）/ 口径事故数（近 90 天）。');
    var vmCards = add(vmBox, 'div', 'cards');
    function vmCard(value, label, sub) {
      var card = h('div', 'card');
      add(card, 'div', 'card-value', value);
      add(card, 'div', 'card-label', label);
      add(card, 'div', 'card-sub', sub);
      vmCards.appendChild(card);
    }
    if (vm.answerTimeState === 'ok') vmCard(vm.defensibleAnswerSeconds + ' 秒', '可辩护答案时长（中位）', vm.answerTimeSamples + ' 个会话样本');
    else if (vm.answerTimeState === 'insufficient') vmCard('样本不足', '可辩护答案时长', vm.answerTimeSamples + ' / 20 个样本');
    else vmCard('未接入', '可辩护答案时长', '缺会话关联（query_audit 无 session_id），接上后启用');
    vmCard(vm.acceptancePct === null ? '未接入' : vm.acceptancePct + '%', '接受率', (vm.decided || 0) + ' / ' + (vm.verifiedTotal || 0) + ' 条已验问答已裁决');
    vmCard(vm.incidents === null ? '未接入' : vm.incidents, '口径事故数（近 90 天）', 'data.metric_audit');
    void vmNote;
  }

  // ── 总览：实体—指标 SVG 二部图（桌面；≤80 节点；手机 CSS 隐藏）──────────────
  var graph = document.getElementById('graph');
  clear(graph);
  (function renderGraph() {
    var entities = data.entities || [];
    var metrics = data.metrics || [];
    add(graph, 'h3', null, '实体 × 指标图（' + entities.length + ' 个实体 · ' + metrics.length + ' 条指标）');
    if (entities.length + metrics.length > 80) {
      add(graph, 'p', 'empty', '节点超过 80 个，图谱已关闭（改用下方清单/实体页）。');
      return;
    }
    if (!entities.length && !metrics.length) {
      add(graph, 'p', 'empty', '没有可画的实体或指标。');
      return;
    }
    var SVG_NS = 'http://www.w3.org/2000/svg';
    function svgEl(tag, attrs, text) {
      var e = document.createElementNS(SVG_NS, tag);
      if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
      if (text !== undefined && text !== null) e.textContent = String(text);
      return e;
    }
    var rowH = 26;
    var height = Math.max(entities.length, metrics.length) * rowH + 30;
    var width = 900;
    var svg = svgEl('svg', { viewBox: '0 0 ' + width + ' ' + height, class: 'graph-svg', role: 'img' });
    var entityY = {};
    entities.forEach(function (g, i) {
      var y = 24 + i * rowH;
      entityY[g.name] = y;
      svg.appendChild(svgEl('circle', { cx: 12, cy: y, r: 5, fill: '#2563eb' }));
      svg.appendChild(svgEl('text', { x: 24, y: y + 4, 'font-size': 12, fill: '#1f2328' }, g.label));
    });
    metrics.forEach(function (m, i) {
      var y = 24 + i * rowH;
      var ex = m.entity ? entityY[m.entity] : undefined;
      if (ex !== undefined) {
        svg.appendChild(svgEl('line', {
          x1: 210, y1: ex, x2: 560, y2: y, stroke: '#d1d5db', 'stroke-width': 1,
        }));
      }
      svg.appendChild(svgEl('rect', { x: 560, y: y - 9, width: 10, height: 10, rx: 2, fill: m.entity ? '#047857' : '#b45309' }));
      svg.appendChild(svgEl('text', { x: 578, y: y + 4, 'font-size': 12, fill: '#1f2328' }, m.title));
    });
    graph.appendChild(svg);
  })();

  // ── 总览：指标 × 实体清单（桌面表格 + 手机卡片）─────────────────────────────
  var matrix = document.getElementById('matrix');
  clear(matrix);
  add(matrix, 'h3', null, '指标 × 实体清单');
  table(matrix,
    ['指标', '实体', '来源', '认证', '近 30 天', '对账'],
    (data.metrics || []).map(function (m) {
      var name = h('div', 'metric-cell');
      linkButton(name, m.title, function () { openMetric(m.id, false); });
      add(name, 'div', 'muted', m.id);
      return [
        { node: name },
        m.entityLabel || '未绑定',
        m.basis === 'column_agg' ? '私有测度' : (m.source === 'l1' ? 'L1 平台' : 'L2 自建'),
        m.certified === 'certified' ? '已认证' : '草稿',
        String(m.usage30d),
        m.auditExists ? '有' : '无'
      ];
    })
  );
  var matrixCards = add(matrix, 'div', 'metric-cards mobile-only');
  (data.metrics || []).forEach(function (m) { metricCard(matrixCards, m); });

  // 孤儿指标
  var orphanBox = document.getElementById('orphans');
  clear(orphanBox);
  add(orphanBox, 'h3', null, '孤儿指标（未接入体系）');
  if (!(data.orphans || []).length) {
    add(orphanBox, 'p', 'empty', '没有孤儿指标：每条指标都能回溯到实体与源关系。');
  } else {
    var ol = add(orphanBox, 'ul', 'plain-list');
    data.orphans.forEach(function (o) {
      var li = add(ol, 'li');
      linkButton(li, o.title, function () { openMetric(o.id, false); });
      add(li, 'span', 'muted', ' · ' + o.reasons.join('；'));
    });
  }

  // 报表资产（事实源里的 data.reports / report_versions）
  var reportBox = document.getElementById('reports');
  clear(reportBox);
  add(reportBox, 'h3', null, '报表资产');
  if (!(data.reports || []).length) {
    add(reportBox, 'p', 'empty', '本租户暂无登记报表。');
  } else {
    table(reportBox,
      ['报表', '最新定义版本', '发布版本'],
      data.reports.map(function (r) {
        return [r.title, r.latestVersionTitle || (r.latestVersion ? ('v' + r.latestVersion) : '—'), r.publishedVersion ? ('v' + r.publishedVersion) : '未发布'];
      })
    );
    var reportCards = add(reportBox, 'div', 'metric-cards mobile-only');
    data.reports.forEach(function (r) {
      var card = add(reportCards, 'div', 'metric-item');
      add(card, 'strong', null, r.title);
      add(card, 'div', 'muted',
        (r.latestVersionTitle || (r.latestVersion ? 'v' + r.latestVersion : '—')) + ' · '
        + (r.publishedVersion ? '已发布 v' + r.publishedVersion : '未发布'));
    });
  }

  // ── 指标视图：吸顶搜索 + 卡片列表 + 全屏详情 ──────────────────────────────
  var metricList = document.getElementById('metric-list');
  var search = document.getElementById('metric-search');
  var detail = document.getElementById('metric-detail');

  function metricText(m) {
    return [m.id, m.title, m.label, m.definition, m.entityLabel].concat(m.synonyms || []).join(' ').toLowerCase();
  }
  function renderMetricList() {
    var q = (search.value || '').trim().toLowerCase();
    clear(metricList);
    var list = (data.metrics || []).filter(function (m) {
      return q === '' || metricText(m).indexOf(q) >= 0;
    });
    if (!list.length) { add(metricList, 'p', 'empty', '没有匹配的指标。'); return; }
    list.forEach(function (m) { metricCard(metricList, m); });
  }
  if (search) search.addEventListener('input', renderMetricList);

  // ── 回溯：五步竖排步骤条（指标 → 实体 → 关系 → 上游模型 → 契约）────────────
  // 手机端不画连线/图，只给可读的五步；每步带 data-step 供测试与样式定位。
  function renderSteps(root, m) {
    var box = add(root, 'div', 'trace-box');
    add(box, 'h4', null, '回溯链：指标 → 实体 → 关系 → 上游模型 → 契约');
    var ol = add(box, 'ol', 'trace-steps');
    function step(kind, title, fill) {
      var li = add(ol, 'li', 'step');
      li.setAttribute('data-step', kind);
      add(li, 'span', 'step-index', String(ol.children.length));
      var body = add(li, 'div', 'step-body');
      add(body, 'div', 'step-title', title);
      fill(body);
      return li;
    }
    step('metric', '指标', function (body) {
      add(body, 'strong', null, m.title + '（' + m.id + '）');
    });
    step('entity', '实体', function (body) {
      add(body, 'span', null, m.entityLabel || '未绑定实体（孤儿）');
    });
    step('relation', '关系', function (body) {
      add(body, 'code', null, m.trace.relation || '未解析到');
      if (m.trace.model) {
        add(body, 'span', 'muted', ' · 模型 ' + m.trace.model + (m.trace.modelPath ? ('（' + m.trace.modelPath + '）') : ''));
      }
    });
    step('model', '上游模型', function (body) {
      if (!(m.trace.upstream || []).length) {
        add(body, 'span', 'empty', '该关系在 dbt 模型图中没有上游引用。');
        return;
      }
      var ul = add(body, 'ul', 'plain-list');
      m.trace.upstream.forEach(function (u) {
        var li = add(ul, 'li');
        add(li, 'span', 'badge info', 'L' + u.depth);
        add(li, 'code', null, u.name);
        if (u.path) add(li, 'span', 'muted', ' · ' + u.path);
        if ((u.contracts || []).length) add(li, 'span', 'contract', '契约：' + u.contracts.join('、'));
      });
    });
    step('contract', '契约', function (body) {
      add(body, 'span', null, (m.trace.contracts || []).length
        ? m.trace.contracts.join('、')
        : '上游未匹配到契约（可能是非源表模型）');
    });
    return box;
  }

  function renderDetail(m) {
    clear(detail);
    var back = add(detail, 'button', 'back-button tap', '← 返回');
    back.type = 'button';
    back.setAttribute('data-back', 'auto');
    back.addEventListener('click', goBack);

    var head = add(detail, 'div', 'detail-head');
    add(head, 'h3', null, m.title);
    add(head, 'div', 'muted', m.id);
    var tags = add(head, 'div', 'tags');
    tags.appendChild(badge(m.entityLabel || '未绑定实体', m.entityLabel ? 'ok' : 'warn'));
    tags.appendChild(badge(m.basis === 'column_agg' ? '私有测度' : (m.source === 'l1' ? 'L1 平台声明' : 'L2 自建'), 'info'));
    tags.appendChild(badge(m.certified === 'certified' ? '已认证' : '草稿', m.certified === 'certified' ? 'ok' : 'warn'));

    richText(detail, 'div', 'definition', m.definition || '（未声明口径原文）');
    var grid = add(detail, 'div', 'fields');
    field(grid, '业务名称', m.label);
    field(grid, '同义词', (m.synonyms || []).join('、'));
    field(grid, '实体', m.entityLabel ? (m.entityLabel + '（' + m.entity + '）') : '未绑定');
    field(grid, '粒度', (m.grain || []).join('、'));
    field(grid, '表达式', m.expression);
    field(grid, '源关系', (m.relations || []).join('、'));
    field(grid, 'select_sql', m.selectSql);
    field(grid, '对账测试文件', m.auditFile + (m.auditExists ? '（存在）' : '（缺失）'));
    field(grid, '近 30 天使用次数', String(m.usage30d));
    field(grid, '页门 scope', m.requiredScope || '无（拿到模块即可见）');
    field(grid, '单位', m.unit);
    field(grid, '业务描述', m.bizDescription);
    field(grid, '口径说明', m.caliberNote);
    renderSteps(detail, m);
  }

  /** 打开指标详情。fromHash=true ⇒ 由 hash 路由驱动，不再改 hash（防回环）。 */
  function openMetric(id, fromHash) {
    var m = metricById(id);
    if (!m) return false;
    renderDetail(m);
    document.body.classList.add('detail-open');
    if (!fromHash) {
      var target = '#/metrics/' + encodeURIComponent(id);
      if (window.location.hash !== target) window.location.hash = target;
    }
    return true;
  }

  function closeDetail(moveHash) {
    document.body.classList.remove('detail-open');
    clear(detail);
    if (moveHash) window.location.hash = '#/metrics';
  }

  /**
   * 返回：从外部（同源 referrer）进入详情时优先 history.back() 回来源（报表页）；
   * 否则回指标列表。不同源 / 无 referrer ⇒ 绝不 history.back()（会把人带出站点）。
   */
  function goBack() {
    var ref = '';
    try { ref = document.referrer || ''; } catch (e) { ref = ''; }
    var sameOrigin = false;
    try {
      sameOrigin = ref !== '' && new URL(ref).origin === window.location.origin;
    } catch (e) { sameOrigin = false; }
    if (sameOrigin && window.history.length > 1) { window.history.back(); return; }
    window.location.hash = '#/metrics';
  }

  // ── 实体 ──────────────────────────────────────────────────────────────────
  var entityList = document.getElementById('entity-list');
  clear(entityList);
  if (!(data.entities || []).length) add(entityList, 'p', 'empty', '没有声明实体。');
  (data.entities || []).forEach(function (g) {
    var d = add(entityList, 'details', 'group');
    var s = add(d, 'summary', 'tap');
    add(s, 'strong', null, g.label);
    add(s, 'span', 'muted', ' · ' + g.name + ' · ' + g.metricIds.length + ' 个指标');
    if ((g.synonyms || []).length) add(s, 'span', 'muted', ' · 别称：' + g.synonyms.join('、'));
    var body = add(d, 'div', 'group-body');
    if (!g.metricIds.length) add(body, 'p', 'empty', '声明了实体，但还没有指标挂上来。');
    else {
      var ul = add(body, 'ul', 'plain-list');
      g.metricIds.forEach(function (id) {
        var m = metricById(id);
        var li = add(ul, 'li');
        linkButton(li, m ? m.title : id, function () { openMetric(id, false); });
        if (m && (m.relations || []).length) add(li, 'span', 'muted', ' · ' + m.relations.join('、'));
      });
    }
    if ((g.relations || []).length) add(body, 'p', 'muted', '落在关系：' + g.relations.join('、'));
  });

  // ── 数据源（关系 → 指标 → 上游链）──────────────────────────────────────────
  var sourceList = document.getElementById('source-list');
  clear(sourceList);
  if (!(data.sources || []).length) add(sourceList, 'p', 'empty', '没有解析到数据源关系。');
  (data.sources || []).forEach(function (src) {
    var d = add(sourceList, 'details', 'group');
    var s = add(d, 'summary', 'tap');
    add(s, 'code', null, src.name);
    add(s, 'span', 'muted', ' · ' + src.metricIds.length + ' 个指标引用');
    if (src.modelPath) add(s, 'span', 'muted', ' · ' + src.modelPath);
    var body = add(d, 'div', 'group-body');
    add(body, 'div', 'subhead', '被这些指标引用');
    var ul = add(body, 'ul', 'plain-list');
    src.metricIds.forEach(function (id) {
      var m = metricById(id);
      var li = add(ul, 'li');
      linkButton(li, m ? m.title : id, function () { openMetric(id, false); });
    });
    add(body, 'div', 'subhead', '上游模型链（两层）');
    if (!(src.upstream || []).length) add(body, 'p', 'empty', '该关系在 dbt 模型图中没有上游引用。');
    else {
      var chain = add(body, 'ul', 'plain-list');
      src.upstream.forEach(function (u) {
        var li = add(chain, 'li');
        add(li, 'span', 'badge info', 'L' + u.depth);
        add(li, 'code', null, u.name);
        if (u.path) add(li, 'span', 'muted', ' · ' + u.path);
      });
    }
    add(body, 'div', 'subhead', '契约');
    add(body, 'p', (src.contracts || []).length ? null : 'empty',
      (src.contracts || []).length ? src.contracts.join('、') : '未匹配到契约。');
  });

  // ── 需求台账 ──────────────────────────────────────────────────────────────
  var demandList = document.getElementById('demand-list');
  clear(demandList);
  if (!(data.demands || []).length) add(demandList, 'p', 'empty', '没有未消解的需求。');
  else {
    var kindLabel = {
      alias_gap: '说法缺口', new_metric: '新指标', drill_gap: '下钻缺口', metric_hunt: '找不到指标'
    };
    function detailText(d) {
      try { return d.detail && Object.keys(d.detail).length ? JSON.stringify(d.detail) : ''; } catch (e) { return ''; }
    }
    table(demandList,
      ['类型', '目标', '出现次数', '最近出现', '细节'],
      data.demands.map(function (d) {
        return [kindLabel[d.kind] || d.kind, d.target, String(d.occurrences), d.lastSeen || '—', detailText(d)];
      })
    );
    var demandCards = add(demandList, 'div', 'metric-cards mobile-only');
    data.demands.forEach(function (d) {
      var card = add(demandCards, 'div', 'metric-item');
      add(card, 'strong', null, (kindLabel[d.kind] || d.kind) + '：' + d.target);
      add(card, 'div', 'muted', '出现 ' + d.occurrences + ' 次 · 最近 ' + (d.lastSeen || '—'));
      var dt = detailText(d);
      if (dt) add(card, 'div', 'muted', dt);
    });
  }

  // ── hash 路由（深链 / 刷新 / 返回）──────────────────────────────────────────
  var VIEWS = ['overview', 'metrics', 'entities', 'sources', 'demands'];
  function parseHash() {
    var raw = (window.location.hash || '').replace(/^#\\/?/, '');
    var parts = raw.split('/');
    var view = parts[0] || 'overview';
    if (VIEWS.indexOf(view) < 0) view = 'overview';
    var metricId = null;
    if (view === 'metrics' && parts.length > 1 && parts[1] !== '') {
      try { metricId = decodeURIComponent(parts[1]); } catch (e) { metricId = parts[1]; }
    }
    return { view: view, metricId: metricId };
  }

  function markNav(view) {
    var links = document.querySelectorAll('[data-nav]');
    for (var i = 0; i < links.length; i += 1) {
      var el = links[i];
      if (el.getAttribute('data-nav') === view) el.classList.add('active');
      else el.classList.remove('active');
    }
  }

  function applyRoute() {
    var r = parseHash();
    VIEWS.forEach(function (v) {
      var el = document.getElementById('view-' + v);
      if (el) el.hidden = (v !== r.view);
    });
    markNav(r.view);
    if (r.view === 'metrics' && r.metricId) {
      if (!openMetric(r.metricId, true)) closeDetail(false);
    } else {
      closeDetail(false);
    }
    try { window.scrollTo(0, 0); } catch (e) { /* happy-dom 等环境可能未实现 */ }
  }

  window.addEventListener('hashchange', applyRoute);

  renderMetricList();
  applyRoute();
})();
`

// ── 静态壳（CSS 断点 + 桌面侧栏 / 手机底部标签栏）──────────────────────────────

const STYLE = `
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #1f2328; --muted: #6b7280;
    --line: #e5e7eb; --accent: #2563eb; --ok: #047857; --warn: #b45309;
  }
  * { box-sizing: border-box; }
  html, body { max-width: 100%; overflow-x: hidden; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  [hidden] { display: none !important; }
  header.top { background: var(--panel); border-bottom: 1px solid var(--line); padding: 22px 28px 14px; }
  header.top h1 { margin: 0 0 4px; font-size: 22px; }
  header.top .sub { margin: 0; color: var(--muted); }
  .layout { display: flex; gap: 24px; max-width: 1240px; margin: 0 auto; padding: 20px 28px 60px; }
  main { flex: 1 1 auto; min-width: 0; }
  nav.tabs { flex: 0 0 180px; align-self: flex-start; position: sticky; top: 16px; display: flex; flex-direction: column; gap: 4px; }
  nav.tabs a { display: block; padding: 10px 12px; border-radius: 8px; color: var(--text); text-decoration: none; min-height: 44px; }
  nav.tabs a.active { background: #eef2ff; color: var(--accent); font-weight: 600; }
  nav.mobile-tabbar { display: none; }
  section { margin: 0 0 30px; }
  section h2 { font-size: 18px; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 18px 0 8px; }
  h4 { font-size: 14px; margin: 14px 0 6px; }
  .muted { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); font-style: italic; margin: 6px 0; }
  .warning { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; min-width: 0; }
  .card-value { font-size: 26px; font-weight: 700; line-height: 1.2; }
  .card-label { font-weight: 600; margin-top: 4px; }
  .card-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .two-col { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; margin-top: 14px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px; min-width: 0; }
  .panel h3 { margin-top: 0; }
  .graph-panel { margin-top: 14px; }
  .graph-svg { width: 100%; height: auto; display: block; }
  .table-wrap { max-width: 100%; overflow-x: auto; }
  .grid { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .grid th, .grid td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .grid th { background: #f3f4f6; font-size: 12px; color: var(--muted); font-weight: 600; }
  .grid tr:last-child td { border-bottom: 0; }
  .metric-cell { display: flex; flex-direction: column; min-width: 0; }
  .link-button { background: none; border: 0; padding: 4px 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; }
  .link-button:hover { text-decoration: underline; }
  /* 手机点击目标 ≥44×44（Task 3 硬约束） */
  .tap { min-height: 44px; min-width: 44px; }
  .badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; background: #f3f4f6; color: #374151; margin: 0 4px 4px 0; }
  .badge.ok { background: #ecfdf5; color: var(--ok); }
  .badge.warn { background: #fffbeb; color: var(--warn); }
  .badge.info { background: #eff6ff; color: #1d4ed8; }
  .tags { margin-top: 6px; }
  .plain-list { margin: 4px 0; padding-left: 20px; }
  .plain-list li { margin: 2px 0; min-width: 0; }
  .decl-item { min-width: 0; word-break: break-word; }
  .decl-detail { color: var(--muted); font-size: 12px; word-break: break-word; }
  .search-bar { position: sticky; top: 0; z-index: 20; background: var(--bg); padding: 6px 0 8px; }
  input[type=search] { width: 100%; max-width: 480px; min-height: 44px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit; margin-bottom: 4px; }
  .metric-list, .metric-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .metric-item { text-align: left; width: 100%; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; font: inherit; min-width: 0; }
  .metric-item:hover { border-color: #93c5fd; }
  .metric-item-top { display: flex; flex-direction: column; min-width: 0; }
  .metric-item-top strong, .metric-item strong { word-break: break-word; }
  .metric-detail { margin-top: 16px; min-width: 0; }
  .back-button { display: none; border: 1px solid var(--line); background: var(--panel); border-radius: 8px; color: var(--accent); font: inherit; padding: 6px 12px; margin-bottom: 8px; cursor: pointer; }
  .detail-head { background: var(--panel); border: 1px solid var(--line); border-radius: 10px 10px 0 0; padding: 14px; min-width: 0; }
  .detail-head h3 { margin: 0; }
  .definition { background: #fbfbfc; border: 1px solid var(--line); border-top: 0; padding: 12px 14px; white-space: pre-wrap; word-break: break-word; }
  .definition strong { color: var(--fg); font-weight: 650; }
  .definition code { background: #eef0f3; border-radius: 4px; padding: 0 4px; font-size: 12px; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0; border: 1px solid var(--line); border-top: 0; background: var(--panel); }
  .field { padding: 8px 12px; border-bottom: 1px solid var(--line); min-width: 0; }
  .field-label { font-size: 12px; color: var(--muted); }
  .field-value { word-break: break-word; overflow-wrap: anywhere; }
  .trace-box { border: 1px solid var(--line); border-top: 0; background: var(--panel); border-radius: 0 0 10px 10px; padding: 10px 14px 14px; min-width: 0; }
  /* 五步竖排步骤条（手机不画图/连线） */
  .trace-steps { list-style: none; margin: 8px 0 0; padding: 0; }
  .trace-steps .step { position: relative; display: flex; gap: 10px; padding: 8px 0 12px; border-left: 2px solid var(--line); margin-left: 12px; min-width: 0; }
  .trace-steps .step:last-child { border-left-color: transparent; }
  .step-index { flex: 0 0 24px; width: 24px; height: 24px; margin-left: -13px; border-radius: 50%; background: var(--accent); color: #fff; font-size: 12px; line-height: 24px; text-align: center; }
  .step-body { min-width: 0; word-break: break-word; }
  .step-title { font-size: 12px; color: var(--muted); margin-bottom: 2px; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
  .contract { margin-left: 6px; color: var(--ok); font-size: 12px; }
  .group { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; min-width: 0; }
  .group summary { cursor: pointer; padding: 10px 12px; }
  .group-body { border-top: 1px solid var(--line); padding: 10px 12px; min-width: 0; }
  .subhead { font-weight: 600; margin: 10px 0 4px; font-size: 13px; }
  .mobile-only { display: none; }

  /* 平板 768–1023：顶部横向标签 + 主区；图缩到 60% 宽 */
  @media (min-width: 768px) and (max-width: 1023px) {
    .layout { flex-direction: column; gap: 12px; padding: 14px 20px 50px; }
    nav.tabs { flex-direction: row; flex-wrap: wrap; position: static; width: 100%; align-self: auto; }
    nav.tabs a { padding: 8px 14px; }
    .graph-svg { width: 60%; }
  }

  /* 手机 <768：底部固定标签栏 + 卡片列表 + 吸顶搜索 + 全屏详情 + 无 SVG */
  @media (max-width: 767px) {
    header.top { padding: 14px 14px 10px; }
    header.top h1 { font-size: 19px; }
    /* 375px：副标题不折两行、不在时间中间断行——缩字号 + 隐藏时间戳，保留「生成时间」 */
    header.top .sub { font-size: 12px; }
    header.top .sub .ts { display: none; }
    .layout { display: block; padding: 10px 12px 0; }
    body { padding-bottom: calc(64px + env(safe-area-inset-bottom, 0px)); }
    nav.tabs { display: none; }
    nav.mobile-tabbar {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 100;
      display: flex; width: 100%; box-sizing: border-box; background: #fff;
      border-top: 1px solid #ececec;
      /* padding:0（横向无内边距）+ 仅底部安全区——4 项才能严格均分，375px 不裁第 4 项 */
      padding: 0; padding-bottom: env(safe-area-inset-bottom, 0px);
    }
    nav.mobile-tabbar a {
      flex: 1 1 0; min-width: 0; min-height: 56px; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 2px;
      font-size: 11px; color: #8c8c8c; text-decoration: none;
      white-space: nowrap;
    }
    nav.mobile-tabbar a.active { color: var(--accent); font-weight: 600; }
    nav.mobile-tabbar .tab-icon { font-size: 18px; line-height: 1; }
    .desktop-only { display: none !important; }
    .mobile-only { display: grid; }
    .two-col { grid-template-columns: 1fr; }
    /* 375px：健康卡单列（两列会把「近 30 天零使用指标」等标签挤成省略号） */
    .cards { grid-template-columns: 1fr; gap: 8px; }
    .card { padding: 10px; }
    .card-value { font-size: 21px; }
    .metric-list, .metric-cards { grid-template-columns: 1fr; }
    .metric-item { padding: 12px 14px; }
    .graph-panel { display: none !important; }
    .search-bar { top: 0; margin: 0 -12px; padding: 8px 12px; border-bottom: 1px solid var(--line); }
    input[type=search] { max-width: none; }
    .fields { grid-template-columns: 1fr; }
    /* 详情全屏推入：隐藏列表，详情铺满视口 */
    body.detail-open #view-metrics .search-bar,
    body.detail-open #metric-list { display: none; }
    body.detail-open .back-button { display: inline-block; }
    body.detail-open #metric-detail {
      position: fixed; inset: 0; z-index: 50; margin: 0; padding: 10px 12px;
      padding-top: calc(10px + env(safe-area-inset-top, 0px));
      padding-bottom: calc(72px + env(safe-area-inset-bottom, 0px));
      background: var(--bg); overflow-y: auto; overflow-x: hidden;
    }
    .detail-head { border-radius: 10px; }
    .definition, .fields, .trace-box { border-radius: 8px; border-top: 1px solid var(--line); margin-bottom: 8px; }
  }
`

export function renderSystemMapHtml(model: SystemMapModel): string {
  const json = escapeJsonForScript(model)
  const generated = escapeHtml(model.generatedAt)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>数据体系地图</title>
<style>
${STYLE}
</style>
</head>
<body>
<header class="top">
  <h1>数据体系地图</h1>
  <p class="sub">从指标回溯到实体、源表与口径 · 生成时间 <span class="ts" id="generated-at">${generated}</span></p>
</header>
<div class="layout">
  <nav class="tabs" aria-label="体系地图视图">
    <a href="#/overview" data-nav="overview">总览</a>
    <a href="#/metrics" data-nav="metrics">指标</a>
    <a href="#/entities" data-nav="entities">实体</a>
    <a href="#/sources" data-nav="sources">数据源</a>
    <a href="#/demands" data-nav="demands">需求台账</a>
  </nav>
  <main>
    <section id="view-overview" class="view">
      <h2>总览</h2>
      <div id="health" class="cards"></div>
      <div id="warnings"></div>
      <div class="two-col">
        <div id="dimensions" class="panel"></div>
        <div id="invariants" class="panel"></div>
      </div>
      <div class="two-col">
        <div id="tables" class="panel"></div>
        <div id="candidates" class="panel"></div>
      </div>
      <div id="value-metrics" class="panel"></div>
      <div id="graph" class="graph-panel panel"></div>
      <div id="matrix"></div>
      <div id="orphans"></div>
      <div id="reports"></div>
    </section>
    <section id="view-metrics" class="view">
      <h2>指标</h2>
      <div class="search-bar">
        <input id="metric-search" type="search" placeholder="搜索指标 id / 名称 / 同义词 / 口径原文">
      </div>
      <div id="metric-list" class="metric-list"></div>
      <div id="metric-detail" class="metric-detail"></div>
    </section>
    <section id="view-entities" class="view">
      <h2>实体</h2>
      <div id="entity-list"></div>
    </section>
    <section id="view-sources" class="view">
      <h2>数据源</h2>
      <div id="source-list"></div>
    </section>
    <section id="view-demands" class="view">
      <h2>需求台账</h2>
      <div id="demand-list"></div>
    </section>
  </main>
</div>
<nav class="mobile-tabbar" aria-label="体系地图导航">
  <a href="#/overview" data-nav="overview"><span class="tab-icon" aria-hidden="true">◱</span><span>总览</span></a>
  <a href="#/metrics" data-nav="metrics"><span class="tab-icon" aria-hidden="true">◎</span><span>指标</span></a>
  <a href="#/entities" data-nav="entities"><span class="tab-icon" aria-hidden="true">▦</span><span>实体</span></a>
  <a href="#/demands" data-nav="demands"><span class="tab-icon" aria-hidden="true">✎</span><span>需求</span></a>
</nav>
<script type="application/json" id="system-map-data">${json}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`
}
