// system-map.ts — 「数据体系地图」的取数、建模与渲染（只读、纯函数、可注入数据单测）。
//
// 事实源三层（页面上的每个数字都必须能指回其中一层，不许「感觉」）：
//   ① 仓内声明：dbt/semantics/l1_metrics.yml（L1 口径原文 / 实体 / 表达式 / grain）
//               + contracts/**/*.json（源表契约）+ dbt/models/**/*.sql（ref 图）
//               + dbt/tests/**（对账 singular test 是否落地）
//   ② 运行库：data.metrics（L1 ∪ 本租户 L2 ∪ 私有测度）、data.reports/report_versions、
//             data.query_audit（近 30 天按 metric_id 聚合）、data.demand_signals（未消解）
//   ③ 由 ①② 推导的视图：健康卡片、实体分组、数据源上游链、指标回溯链
//
// 铁律：
//   · **不写库、不调外部服务**；读面失败不抛整页——坏文件/坏 YAML 进 warnings，页面照样出。
//   · 所有来自库/文件的文本只经 `textContent` 进 DOM；嵌入的 JSON 把 `<`/`>`/`&` 转成
//     `<` 等转义序列（防 `</script>` 逃逸）。渲染层**不拼 innerHTML**。
//   · 单文件 HTML：内联 CSS + 原生 JS + `<script type="application/json">`，零 CDN / 零新依赖。
//   · 结果在路由层缓存 10 分钟（见 routes/system-map.ts）；本文件每次调用都是全量重算。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { basename, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Pool } from 'pg'
// @ts-expect-error TS7016: scripts/ 不是 workspace 包、没有 .d.ts；映射函数只有这一处事实源
// （与 domain/pipelines/propose-metric.ts 同一处理，切勿在模块里再写一份 `:`→`__` 规则）。
import { metricToAuditFileName } from '../../../scripts/check-data-models.mjs'
import { REPO_ROOT, loadContracts, rootsOf } from './pipelines/defs'
import type { ContractRef } from './pipelines/defs'
import { readCurrentSemanticsYaml } from './pipelines/propose-metric'
import { loadMergedCatalog } from './metric-store'
import type { MetricRow } from './metric-store'
import { listReports } from './report-store'
import { listDemands } from './demand/store'

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
  generatedAt?: string
}

// ── 输出模型（路由/测试直接消费；HTML 只是它的一个渲染面）──────────────────────

export interface SystemMapHealth {
  totalMetrics: number
  l1Metrics: number
  l2Metrics: number
  privateMetrics: number
  entityBound: number
  entityCoveragePct: number
  auditCovered: number
  auditCoveragePct: number
  zeroUsageMetrics: number
  unresolvedDemands: number
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

export interface SystemMapModel {
  generatedAt: string
  health: SystemMapHealth
  metrics: SystemMapMetric[]
  entities: SystemMapEntityGroup[]
  sources: SystemMapSource[]
  orphans: SystemMapOrphan[]
  reports: Array<SystemMapReportFact & { latestVersion: number | null; latestVersionTitle: string | null }>
  demands: SystemMapDemandFact[]
  warnings: string[]
}

// ── YAML / dbt / contracts 的读取与解析（全部不抛）──────────────────────────────

const asText = (v: unknown): string => (typeof v === 'string' ? v : '')
const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

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
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { entities, metrics }
  const root = doc as Record<string, unknown>

  if (typeof root.entities === 'object' && root.entities !== null && !Array.isArray(root.entities)) {
    for (const [name, value] of Object.entries(root.entities as Record<string, unknown>)) {
      const decl = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      entities.set(name, { label: asText(decl.label) || name, synonyms: asStringArray(decl.synonyms) })
    }
  }

  if (Array.isArray(root.metrics)) {
    for (const item of root.metrics) {
      if (typeof item !== 'object' || item === null) continue
      const m = item as Record<string, unknown>
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
  const warnings: string[] = []
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
  const entityBound = metrics.filter((m) => m.entity !== null && m.entity !== '').length
  const auditCovered = metrics.filter((m) => m.auditExists).length
  const zeroUsageMetrics = metrics.filter((m) => m.usage30d === 0).length
  const pct = (n: number): number => (total === 0 ? 0 : Math.round((n / total) * 100))

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

  return {
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    health: {
      totalMetrics: total,
      l1Metrics,
      l2Metrics,
      privateMetrics,
      entityBound,
      entityCoveragePct: pct(entityBound),
      auditCovered,
      auditCoveragePct: pct(auditCovered),
      zeroUsageMetrics,
      unresolvedDemands: demands.length,
    },
    metrics,
    entities,
    sources,
    orphans,
    reports,
    demands,
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
  const contracts = loadContracts(rootsOf(deps.env ?? process.env, deps.repoRoot)).contracts
  const models = loadDbtModels(baseDir)
  const auditFiles = loadAuditFiles(baseDir)

  const [metricRows, reportRows, usageRes, versionRes, demandRows] = await Promise.all([
    loadMergedCatalog(deps.pool, deps.org).catch(() => [] as MetricRow[]),
    listReports(deps.pool, deps.org).catch(() => []),
    deps.pool.query(
      `select metric_id, count(*)::int as uses
         from data.query_audit
        where org = $1 and created_at >= now() - interval '30 days' and verdict = 'ok'
        group by metric_id`,
      [deps.org],
    ).catch(() => ({ rows: [] as Array<{ metric_id: string; uses: number }> })),
    deps.pool.query(
      `select distinct on (report_id) report_id, version, title
         from data.report_versions
        where org = $1
        order by report_id, version desc`,
      [deps.org],
    ).catch(() => ({ rows: [] as Array<{ report_id: string; version: number; title: string }> })),
    listDemands(deps.pool, deps.org, { limit: 200 }).catch(() => []),
  ])

  const usage: Record<string, number> = {}
  for (const row of usageRes.rows) {
    usage[String(row.metric_id)] = Number(row.uses)
  }
  const latestVersion = new Map<string, { version: number; title: string }>()
  for (const row of versionRes.rows) {
    latestVersion.set(String(row.report_id), { version: Number(row.version), title: String(row.title) })
  }

  return {
    semanticsYaml,
    semantics,
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
    })),
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
  function linkButton(parent, text, onClick) {
    var b = add(parent, 'button', 'link-button', text);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function table(parent, headers, rows) {
    var t = add(parent, 'table', 'grid');
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

  // ── 总览 ──────────────────────────────────────────────────────────────────
  var gen = document.getElementById('generated-at');
  if (gen && data.generatedAt) {
    try {
      gen.textContent = new Date(data.generatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) + '（北京时间）';
    } catch (e) { /* 保留服务端 ISO 原文 */ }
  }

  var health = data.health || {};
  var cards = document.getElementById('health');
  clear(cards);
  [
    { k: '指标总数', v: health.totalMetrics, s: 'L1 ' + health.l1Metrics + ' · 自建 L2 ' + health.l2Metrics + ' · 私有测度 ' + health.privateMetrics },
    { k: '实体绑定覆盖率', v: health.entityCoveragePct + '%', s: health.entityBound + ' / ' + health.totalMetrics + ' 条指标已绑定实体' },
    { k: '对账测试覆盖率', v: health.auditCoveragePct + '%', s: health.auditCovered + ' / ' + health.totalMetrics + ' 条指标有独立复算文件' },
    { k: '近 30 天零使用指标', v: health.zeroUsageMetrics, s: '按 data.query_audit 成功查询聚合' },
    { k: '未消解需求', v: health.unresolvedDemands, s: 'data.demand_signals（未 dismissed）' }
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

  // 指标 × 实体清单（矩阵的紧凑形态：每行一个指标，实体列可排序/可点）
  var matrix = document.getElementById('matrix');
  clear(matrix);
  add(matrix, 'h3', null, '指标 × 实体清单');
  table(matrix,
    ['指标', '实体', '来源', '认证', '近 30 天', '对账'],
    (data.metrics || []).map(function (m) {
      var name = h('div', 'metric-cell');
      linkButton(name, m.title, function () { selectMetric(m.id); });
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
      linkButton(li, o.title, function () { selectMetric(o.id); });
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
  }

  // ── 指标搜索 / 详情 ───────────────────────────────────────────────────────
  var metricList = document.getElementById('metric-list');
  var search = document.getElementById('metric-search');
  var detail = document.getElementById('metric-detail');

  function metricText(m) {
    return [m.id, m.title, m.label, m.definition, m.entityLabel].concat(m.synonyms || []).join(' ').toLowerCase();
  }
  function renderMetricList() {
    var q = (search.value || '').trim().toLowerCase();
    clear(metricList);
    var list = (data.metrics || []).filter(function (m) { return q === '' || metricText(m).indexOf(q) >= 0; });
    if (!list.length) { add(metricList, 'p', 'empty', '没有匹配的指标。'); return; }
    list.forEach(function (m) {
      var item = h('button', 'metric-item');
      item.type = 'button';
      var top = add(item, 'div', 'metric-item-top');
      add(top, 'strong', null, m.title);
      add(top, 'span', 'muted', m.id);
      var tags = add(item, 'div', 'tags');
      tags.appendChild(badge(m.entityLabel || '未绑定实体', m.entityLabel ? 'ok' : 'warn'));
      tags.appendChild(badge(m.basis === 'column_agg' ? '私有测度' : (m.source === 'l1' ? 'L1' : 'L2'), 'info'));
      tags.appendChild(badge(m.certified === 'certified' ? '已认证' : '草稿', m.certified === 'certified' ? 'ok' : 'warn'));
      tags.appendChild(badge('近 30 天 ' + m.usage30d, 'info'));
      item.addEventListener('click', function () { selectMetric(m.id); });
      metricList.appendChild(item);
    });
  }
  search.addEventListener('input', renderMetricList);

  function renderTrace(root, m) {
    var box = add(root, 'div', 'trace-box');
    add(box, 'h4', null, '回溯链：指标 → 实体 → 关系 → 上游模型 → 契约');
    var ol = add(box, 'ol', 'trace');
    var li = add(ol, 'li');
    add(li, 'span', 'trace-step', '指标');
    add(li, 'strong', null, m.title + '（' + m.id + '）');
    li = add(ol, 'li');
    add(li, 'span', 'trace-step', '实体');
    add(li, 'span', null, m.entityLabel || '未绑定实体（孤儿）');
    li = add(ol, 'li');
    add(li, 'span', 'trace-step', '源关系');
    add(li, 'code', null, m.trace.relation || '未解析到');
    if (m.trace.model) {
      add(li, 'span', 'muted', ' · 模型 ' + m.trace.model + (m.trace.modelPath ? ('（' + m.trace.modelPath + '）') : ''));
    }
    (m.trace.upstream || []).forEach(function (u) {
      li = add(ol, 'li');
      add(li, 'span', 'trace-step', '上游模型 L' + u.depth);
      add(li, 'code', null, u.name);
      if (u.path) add(li, 'span', 'muted', ' · ' + u.path);
      if ((u.contracts || []).length) add(li, 'span', 'contract', '契约：' + u.contracts.join('、'));
    });
    li = add(ol, 'li');
    add(li, 'span', 'trace-step', '契约');
    add(li, 'span', null, (m.trace.contracts || []).length ? m.trace.contracts.join('、') : '上游未匹配到契约（可能是非源表模型）');
  }

  function selectMetric(id) {
    var m = (data.metrics || []).find(function (x) { return x.id === id; });
    if (!m) return;
    clear(detail);
    var head = add(detail, 'div', 'detail-head');
    add(head, 'h3', null, m.title);
    add(head, 'div', 'muted', m.id);
    var tags = add(head, 'div', 'tags');
    tags.appendChild(badge(m.entityLabel || '未绑定实体', m.entityLabel ? 'ok' : 'warn'));
    tags.appendChild(badge(m.basis === 'column_agg' ? '私有测度' : (m.source === 'l1' ? 'L1 平台声明' : 'L2 自建'), 'info'));
    tags.appendChild(badge(m.certified === 'certified' ? '已认证' : '草稿', m.certified === 'certified' ? 'ok' : 'warn'));

    var def = add(detail, 'div', 'definition', m.definition || '（未声明口径原文）');
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
    renderTrace(detail, m);
    detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── 实体 ──────────────────────────────────────────────────────────────────
  var entityList = document.getElementById('entity-list');
  clear(entityList);
  if (!(data.entities || []).length) add(entityList, 'p', 'empty', '没有声明实体。');
  (data.entities || []).forEach(function (g) {
    var d = add(entityList, 'details', 'group');
    var s = add(d, 'summary');
    add(s, 'strong', null, g.label);
    add(s, 'span', 'muted', ' · ' + g.name + ' · ' + g.metricIds.length + ' 个指标');
    if ((g.synonyms || []).length) add(s, 'span', 'muted', ' · 别称：' + g.synonyms.join('、'));
    var body = add(d, 'div', 'group-body');
    if (!g.metricIds.length) add(body, 'p', 'empty', '声明了实体，但还没有指标挂上来。');
    else {
      var ul = add(body, 'ul', 'plain-list');
      g.metricIds.forEach(function (id) {
        var m = (data.metrics || []).find(function (x) { return x.id === id; });
        var li = add(ul, 'li');
        linkButton(li, m ? m.title : id, function () { selectMetric(id); });
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
    var s = add(d, 'summary');
    add(s, 'code', null, src.name);
    add(s, 'span', 'muted', ' · ' + src.metricIds.length + ' 个指标引用');
    if (src.modelPath) add(s, 'span', 'muted', ' · ' + src.modelPath);
    var body = add(d, 'div', 'group-body');
    add(body, 'div', 'subhead', '被这些指标引用');
    var ul = add(body, 'ul', 'plain-list');
    src.metricIds.forEach(function (id) {
      var m = (data.metrics || []).find(function (x) { return x.id === id; });
      var li = add(ul, 'li');
      linkButton(li, m ? m.title : id, function () { selectMetric(id); });
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
    table(demandList,
      ['类型', '目标', '出现次数', '最近出现', '细节'],
      data.demands.map(function (d) {
        var detailText = '';
        try { detailText = d.detail && Object.keys(d.detail).length ? JSON.stringify(d.detail) : ''; } catch (e) { detailText = ''; }
        return [kindLabel[d.kind] || d.kind, d.target, String(d.occurrences), d.lastSeen || '—', detailText];
      })
    );
  }

  renderMetricList();
  if ((data.metrics || []).length) selectMetric(data.metrics[0].id);
})();
`

export function renderSystemMapHtml(model: SystemMapModel): string {
  const json = escapeJsonForScript(model)
  const generated = escapeHtml(model.generatedAt)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>数据体系地图</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --text: #1f2328; --muted: #6b7280;
    --line: #e5e7eb; --accent: #2563eb; --ok: #047857; --warn: #b45309;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  header.top { background: var(--panel); border-bottom: 1px solid var(--line); padding: 22px 28px 14px; }
  header.top h1 { margin: 0 0 4px; font-size: 22px; }
  header.top .sub { margin: 0; color: var(--muted); }
  nav { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 14px; }
  nav a { color: var(--accent); text-decoration: none; font-size: 13px; }
  main { max-width: 1240px; margin: 0 auto; padding: 20px 28px 60px; }
  section { margin: 0 0 30px; }
  section h2 { font-size: 18px; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
  h3 { font-size: 15px; margin: 18px 0 8px; }
  h4 { font-size: 14px; margin: 14px 0 6px; }
  .muted { color: var(--muted); font-size: 12px; }
  .empty { color: var(--muted); font-style: italic; margin: 6px 0; }
  .warning { background: #fff7ed; border: 1px solid #fed7aa; color: #9a3412; border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .card-value { font-size: 26px; font-weight: 700; line-height: 1.2; }
  .card-label { font-weight: 600; margin-top: 4px; }
  .card-sub { color: var(--muted); font-size: 12px; margin-top: 4px; }
  .grid { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
  .grid th, .grid td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
  .grid th { background: #f3f4f6; font-size: 12px; color: var(--muted); font-weight: 600; }
  .grid tr:last-child td { border-bottom: 0; }
  .metric-cell { display: flex; flex-direction: column; }
  .link-button { background: none; border: 0; padding: 0; color: var(--accent); cursor: pointer; font: inherit; text-align: left; }
  .link-button:hover { text-decoration: underline; }
  .badge { display: inline-block; border-radius: 999px; padding: 1px 8px; font-size: 11px; background: #f3f4f6; color: #374151; margin: 0 4px 4px 0; }
  .badge.ok { background: #ecfdf5; color: var(--ok); }
  .badge.warn { background: #fffbeb; color: var(--warn); }
  .badge.info { background: #eff6ff; color: #1d4ed8; }
  .tags { margin-top: 6px; }
  .plain-list { margin: 4px 0; padding-left: 20px; }
  .plain-list li { margin: 2px 0; }
  input[type=search] { width: 100%; max-width: 480px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; font: inherit; margin-bottom: 10px; }
  .metric-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; }
  .metric-item { text-align: left; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; cursor: pointer; font: inherit; }
  .metric-item:hover { border-color: #93c5fd; }
  .metric-item-top { display: flex; flex-direction: column; }
  .metric-detail { margin-top: 16px; }
  .detail-head { background: var(--panel); border: 1px solid var(--line); border-radius: 10px 10px 0 0; padding: 14px; }
  .detail-head h3 { margin: 0; }
  .definition { background: #fbfbfc; border: 1px solid var(--line); border-top: 0; padding: 12px 14px; white-space: pre-wrap; }
  .fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 0; border: 1px solid var(--line); border-top: 0; background: var(--panel); }
  .field { padding: 8px 12px; border-bottom: 1px solid var(--line); }
  .field-label { font-size: 12px; color: var(--muted); }
  .field-value { word-break: break-word; }
  .trace-box { border: 1px solid var(--line); border-top: 0; background: var(--panel); border-radius: 0 0 10px 10px; padding: 10px 14px 14px; }
  .trace { margin: 6px 0 0; padding-left: 20px; }
  .trace li { margin: 4px 0; }
  .trace-step { display: inline-block; min-width: 88px; color: var(--muted); font-size: 12px; }
  code { background: #f3f4f6; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
  .contract { margin-left: 6px; color: var(--ok); font-size: 12px; }
  .group { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; margin: 8px 0; }
  .group summary { cursor: pointer; padding: 10px 12px; }
  .group-body { border-top: 1px solid var(--line); padding: 10px 12px; }
  .subhead { font-weight: 600; margin: 10px 0 4px; font-size: 13px; }
  @media (max-width: 640px) { main { padding: 14px; } header.top { padding: 16px; } }
</style>
</head>
<body>
<header class="top">
  <h1>数据体系地图</h1>
  <p class="sub">从指标回溯到实体、源表与口径 · 生成时间 <span id="generated-at">${generated}</span></p>
  <nav>
    <a href="#overview">总览</a>
    <a href="#metrics">指标</a>
    <a href="#entities">实体</a>
    <a href="#sources">数据源</a>
    <a href="#demands">需求台账</a>
  </nav>
</header>
<main>
  <section id="overview">
    <h2>总览</h2>
    <div id="health" class="cards"></div>
    <div id="warnings"></div>
    <div id="orphans"></div>
    <div id="reports"></div>
    <div id="matrix"></div>
  </section>
  <section id="metrics">
    <h2>指标</h2>
    <input id="metric-search" type="search" placeholder="搜索指标 id / 名称 / 同义词 / 口径原文">
    <div id="metric-list" class="metric-list"></div>
    <div id="metric-detail" class="metric-detail"></div>
  </section>
  <section id="entities">
    <h2>实体</h2>
    <div id="entity-list"></div>
  </section>
  <section id="sources">
    <h2>数据源</h2>
    <div id="source-list"></div>
  </section>
  <section id="demands">
    <h2>需求台账</h2>
    <div id="demand-list"></div>
  </section>
</main>
<script type="application/json" id="system-map-data">${json}</script>
<script>${CLIENT_JS}</script>
</body>
</html>`
}
