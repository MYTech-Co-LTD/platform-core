// provenance.ts — 查询面共用的「结果来源」类型与构造器（纯函数，零 IO）。
//
// 四个查询面各自的锚点不同（明细业务键 / explore 关系 / recipe 度量），但共享同一组
// 约定：relation 是**逻辑关系名**（不含物理路径或凭据）；auditId 有才带、没有就缺席
// （不伪造）；时刻由调用方注入时钟，便于测试复算。
//
// 这里只收敛类型与可选字段的构造，**不改任何回包字段名**。

export interface ProvenanceBase {
  /** 逻辑关系名（`vw_*` / 指标模型）。 */
  relation: string
  /** 审计行 id（`data.query_audit.id`）；没有写审计时缺席。 */
  auditId?: number
}

/** 明细下钻的来源（`query_detail.provenance`）。 */
export interface DetailProvenance extends ProvenanceBase {
  /** 原子粒度业务键（= 指标声明的 dimensions）。 */
  keyColumns: string[]
  /** 本次实际分组维度（keyColumns 的子集）。 */
  groupedBy: string[]
  /** 同一 where 的全量行数（与回包 rowCountTotal 同源）。 */
  rowCountTotal: number
  /** 明细查询执行时刻。 */
  drillAsOf: string
  /** 聚合物化钟；缺席 = 未知。 */
  dataAsOf?: string
  /** 明细面恒有审计行。 */
  auditId: number
}

/** 即席 explore 的来源（`explore_query.provenance`）。 */
export interface ExploreProvenance extends ProvenanceBase {
  source: 'explore'
  executedAt: string
}

/** 配方的来源（`explore_recipe.provenance`）。 */
export interface RecipeProvenance extends ProvenanceBase {
  source: 'recipe'
  metricId: string
  measure: { agg: string; column: string }
  recipe: string
  executedAt: string
}

/** ISO 时刻；调用方注入时钟以便测试。 */
export function isoNow(now?: () => Date): string {
  return (now ?? (() => new Date()))().toISOString()
}

/** 审计 id 只在有值时出现——null / undefined 都缺席，不写 0 冒充。 */
function auditField(auditId: number | null | undefined): { auditId?: number } {
  return auditId === null || auditId === undefined ? {} : { auditId }
}

export function detailProvenance(input: {
  relation: string
  keyColumns: string[]
  groupedBy: string[]
  rowCountTotal: number
  drillAsOf: string
  dataAsOf?: string
  auditId: number
}): DetailProvenance {
  return {
    relation: input.relation,
    keyColumns: input.keyColumns,
    groupedBy: input.groupedBy,
    rowCountTotal: input.rowCountTotal,
    drillAsOf: input.drillAsOf,
    ...(input.dataAsOf !== undefined ? { dataAsOf: input.dataAsOf } : {}),
    auditId: input.auditId,
  }
}

export function exploreProvenance(input: {
  relation: string
  executedAt: string
  auditId?: number | null
}): ExploreProvenance {
  return {
    source: 'explore',
    relation: input.relation,
    executedAt: input.executedAt,
    ...auditField(input.auditId),
  }
}

export function recipeProvenance(input: {
  metricId: string
  relation: string
  measure: { agg: string; column: string }
  recipe: string
  executedAt: string
}): RecipeProvenance {
  return {
    source: 'recipe',
    metricId: input.metricId,
    relation: input.relation,
    measure: input.measure,
    recipe: input.recipe,
    executedAt: input.executedAt,
  }
}

/** 指标聚合查询的来源（`query_metric.provenance`）。 */
export interface MetricProvenance extends ProvenanceBase {
  source: 'metric'
  metricId: string
  executedAt: string
}

export function metricProvenance(input: {
  metricId: string
  relation: string
  executedAt: string
  auditId?: number | null
}): MetricProvenance {
  return {
    source: 'metric',
    metricId: input.metricId,
    relation: input.relation,
    executedAt: input.executedAt,
    ...auditField(input.auditId),
  }
}
