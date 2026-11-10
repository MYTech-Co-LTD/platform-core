// recipes.ts —— `explore_recipe` 的 MCP 工具实现（W6 Task 3）。
//
// 只做装配：可见指标 → 单列聚合目标 → 编译配方 → 同一只读通道执行 → 算术 → 带证据包返回。
// 审计仍由 `callTool` 单点写（本 impl 只回填 auditMetricId / auditRowCount）。
import { loadMergedCatalog } from '../metric-store'
import { visibleMetrics } from '../authz'
import { executeExplore } from '../analysis/explore-exec'
import { applyRecipe, compileRecipe, recipeTargetOf } from '../analysis/recipes'
import type { RecipeKind, RecipeRequest } from '../analysis/recipes'
import { buildEvidencePack } from '../analysis/evidence'
import type { ToolImpl } from './registry'

const RECIPE_OF = new Set(['variance', 'top_contributors', 'baseline'])

export const exploreRecipeImpl: ToolImpl = async (deps, args) => {
  if (deps.requester === null) {
    return { payload: { status: 'denied', reason: 'unauthenticated' }, isError: true }
  }
  if (deps.exploreExec === undefined) {
    return { payload: { status: 'error', reason: 'warehouse_unconfigured' }, isError: true }
  }
  const recipe = String(args.recipe ?? '')
  if (!RECIPE_OF.has(recipe)) {
    return { payload: { status: 'denied', reason: 'bad_recipe', allowed: [...RECIPE_OF] }, isError: true }
  }
  const metricId = String(args.metricId ?? '')
  const dimension = String(args.dimension ?? '')
  const catalog = await loadMergedCatalog(deps.pool, deps.org)
  const row = visibleMetrics(catalog, deps.requester, deps.adoptedSources).find((m) => m.id === metricId)
  if (row === undefined) {
    return { payload: { status: 'denied', reason: 'metric_not_found', metricId }, isError: true, auditMetricId: metricId }
  }
  const target = recipeTargetOf(row.selectSql)
  if (!target.ok) {
    return {
      payload: { status: 'denied', reason: target.code, detail: target.detail, metricId },
      isError: true, auditMetricId: metricId,
    }
  }

  const req: RecipeRequest = {
    recipe: recipe as RecipeKind,
    relation: target.relation,
    measure: target.measure,
    dimension,
    periodA: args.periodA as RecipeRequest['periodA'],
    periodB: args.periodB as RecipeRequest['periodB'],
    period: args.period as RecipeRequest['period'],
    asOf: typeof args.asOf === 'string' ? args.asOf : undefined,
    topN: typeof args.topN === 'number' ? args.topN : undefined,
    baselineWindowDays: typeof args.baselineWindowDays === 'number' ? args.baselineWindowDays : undefined,
  }

  const compiled = compileRecipe(req)
  if (!compiled.ok) {
    return { payload: { status: 'denied', reason: compiled.code, detail: compiled.detail ?? null }, isError: true, auditMetricId: metricId }
  }

  const results: Array<{ columns: string[]; rows: unknown[][] }> = []
  const evidence: unknown[] = []
  let rowCount = 0
  for (const spec of compiled.specs) {
    const out = await executeExplore(
      {
        pool: deps.pool,
        org: deps.org,
        requesterUserId: deps.requester.userId,
        channel: deps.requester.channel,
        keyId: deps.requester.keyId,
        exec: deps.exploreExec,
        audit: false,
      },
      spec,
    )
    if (!out.ok) {
      return {
        payload: { status: 'error', reason: out.code, detail: out.detail ?? null, metricId },
        isError: true, auditMetricId: metricId, auditRowCount: null,
      }
    }
    results.push({ columns: out.columns, rows: out.rows })
    rowCount += out.rowCount
    evidence.push(buildEvidencePack({
      metricId,
      params: { recipe, dimension, ...(req.asOf !== undefined ? { asOf: req.asOf } : {}) },
      value: out.rowCount,
      sql: out.sql,
      sqlPreview: out.preview,
      // 数据截至用指标自己的水位（拿不到就 null / unknown，不冒充最新）
      dataAsOf: null,
      freshness: { status: 'unknown', slaDays: row.slaDays ?? null },
      caliber: {
        tier: row.certified === 'certified' ? 'certified' : 'draft',
        basis: row.basis ?? 'l1_tree',
        certifiedBy: row.createdBy ?? null,
        version: row.version ?? null,
      },
      reconcile: { auditFile: null, status: 'unknown' },
    }))
  }

  const applied = applyRecipe(req, results)
  return {
    payload: {
      status: 'ok',
      metricId,
      relation: target.relation,
      measure: target.measure,
      recipe,
      dimension,
      notes: compiled.notes,
      result: { rows: applied.rows, total: applied.total ?? null, skipped: applied.skipped ?? 0 },
      evidence,
      // 结果来源（S1）：配方的锚点是指标 + 关系 + 度量 + 执行时刻；口径证据仍在 evidence[]。
      provenance: {
        source: 'recipe',
        metricId,
        relation: target.relation,
        measure: target.measure,
        recipe,
        executedAt: (deps.now ?? (() => new Date()))().toISOString(),
      },
    },
    isError: false,
    auditMetricId: metricId,
    auditRowCount: rowCount,
  }
}
