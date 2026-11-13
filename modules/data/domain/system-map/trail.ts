// trail.ts — 指标 → marts → staging → 湖 → 管线 的链路投影（体系地图节点抽屉用）。
//
// 为什么单独一层：本体图回答「谁和谁有关系」，链路回答「这个数**具体**是怎么被造出来的、
// 最近一次造出来是什么时候」。后者要拼三类事实源（dbt 模型图、湖前缀命名约定、管线定义），
// 且每一步都要标「这是声明的还是推断的」——用户拿它排障，不能被推测冒充事实。
//
// 纯函数部分只做结构；运行态（最近 run / 物化钟 / 水位）由路由层注入（有时效，不该进 10 分钟缓存）。
import type { SystemMapModel } from './map'

export type TrailStepKind = 'metric' | 'mart' | 'staging' | 'lake' | 'pipeline'

export interface TrailStep {
  kind: TrailStepKind
  label: string
  detail?: string
  /**
   * declared = 有声明锚（dbt 模型图 / 管线 lakeKeys 命中）；
   * inferred = 只有命名约定（`stg_lemeng_x` ⇒ `lemeng/x`），排障时要当线索而不是结论。
   */
  from: 'declared' | 'inferred'
}

export interface TrailRuntime {
  pipelineId: string | null
  lastRun: { runId: string; at: string; status: string; durationMs?: number; error?: string } | null
  /** 物化钟：load_log 里这些 staging 关系最近一次成功物化的时间（缺库/缺表 ⇒ null）。 */
  materializedAt: string | null
  /** 水位：各关系 max_bizday 的最小值（木桶短板）。 */
  maxBizday: string | null
}

export interface MetricTrail {
  metricId: string
  title: string
  steps: TrailStep[]
  runtime: TrailRuntime
  notes: string[]
}

/** `stg_<domain>_<table>` ⇒ `<domain>/<table>`（与 017 迁移里 freshness_relations 的推导同一条规则）。 */
export function lakeOfStaging(staging: string): string | null {
  const m = /^stg_([a-z0-9]+)_(.+)$/.exec(staging)
  return m === null ? null : `${m[1]}/${m[2]}`
}

/** 管线 sink key ⇒ 湖前缀（取前两段；`${ENV:...}` 段或过短 key 不算）。 */
export function lakePrefixOfKey(key: string): string | null {
  if (key.includes('${')) {
    // 变量在第 1/2 段就无法判断资产；在更后面的段不影响前缀
    const head = key.split('/').slice(0, 2).join('/')
    if (head.includes('${')) return null
  }
  const seg = key.split('/')
  return seg.length >= 2 ? `${seg[0]}/${seg[1]}` : null
}

export interface TrailPipelineRef {
  id: string
  lakeKeys: readonly string[]
}

/**
 * 构建结构链路。返回 null = 这个指标不在模型里（调用方给 404 而不是编一条）。
 * 同一 kind+label 只出现一次（一个指标多条 mart 时保持顺序、去重）。
 */
export function buildMetricTrail(
  model: SystemMapModel,
  metricId: string,
  pipelines: readonly TrailPipelineRef[],
): MetricTrail | null {
  const metric = model.metrics.find((m) => m.id === metricId)
  if (metric === undefined) return null

  const steps: TrailStep[] = [{ kind: 'metric', label: metric.title, detail: metric.id, from: 'declared' }]
  const seen = new Set<string>(['metric:' + metric.title])
  const push = (step: TrailStep): void => {
    const key = `${step.kind}:${step.label}`
    if (seen.has(key)) return
    seen.add(key)
    steps.push(step)
  }

  // 湖前缀 → 写它的管线（声明锚：管线定义里的 snk.minio key）
  const pipelinesOfLake = (lake: string): TrailPipelineRef[] =>
    pipelines.filter((p) => p.lakeKeys.some((k) => lakePrefixOfKey(k) === lake))

  for (const mart of metric.relations) {
    push({ kind: 'mart', label: mart, detail: 'marts 表', from: 'declared' })
    const source = model.sources.find((s) => s.name === mart)
    if (source === undefined) continue
    // staging：dbt 模型图的上游（depth 1），名字以 stg_ 开头
    const stagings = source.upstream.filter((u) => u.depth === 1 && u.name.startsWith('stg_'))
    if (stagings.length === 0) {
      // 没有 staging 上游：可能是直接读湖的 marts（或模型图没读到）——留一条 note 由路由层补充
      continue
    }
    for (const stg of stagings) {
      push({ kind: 'staging', label: stg.name, detail: 'dbt staging 模型', from: 'declared' })
      const lake = lakeOfStaging(stg.name)
      if (lake === null) continue
      const refs = pipelinesOfLake(lake)
      push({
        kind: 'lake',
        label: lake,
        detail: refs.length > 0 ? `${refs.length} 条管线写入` : '没有在仓内管线里找到写入方',
        // 管线定义里命中 = 声明锚；没命中 ⇒ 只有命名约定，标明是推断
        from: refs.length > 0 ? 'declared' : 'inferred',
      })
      for (const p of refs) push({ kind: 'pipeline', label: p.id, detail: 'duckle 管线', from: 'declared' })
    }
  }

  const notes: string[] = []
  if (steps.filter((s) => s.kind === 'staging').length === 0) {
    notes.push('模型图里没有读到这个指标的 staging 上游（可能是直接读湖的 marts，或 dbt 模型图不可读）')
  }
  if (steps.filter((s) => s.kind === 'pipeline').length === 0) {
    notes.push('没有在仓内管线定义里找到写这条链路的管线（湖前缀可能由仓外任务写入）')
  }

  return {
    metricId,
    title: metric.title,
    steps,
    runtime: { pipelineId: null, lastRun: null, materializedAt: null, maxBizday: null },
    notes,
  }
}

/** 链路里涉及的 staging 关系名（路由层拿它查 load_log 水位）。 */
export function stagingRelationsOf(trail: MetricTrail): string[] {
  return trail.steps.filter((s) => s.kind === 'staging').map((s) => s.label)
}

/** 链路里涉及的管线 id（路由层拿它查最近 run）。 */
export function pipelineIdsOf(trail: MetricTrail): string[] {
  return trail.steps.filter((s) => s.kind === 'pipeline').map((s) => s.label)
}
