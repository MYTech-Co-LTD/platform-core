// pipeline-map.ts — 管线视角的全局图（资产 → staging → marts），纯函数。
//
// 与 trail.ts 的分工：trail 回答「一个指标怎么来的」；本文件回答「整个域里，哪些资产被管线写、
// 哪些 staging 接了、哪些 marts 在吃它、哪条链断了」。
//
// 三层固定结构（不做自由力导向：用户在问的是「逻辑关系」，分层 DAG 比毛球可读）：
//   资产（湖前缀）── staging（命名约定）── marts（dbt ref 反查）
// 管线不单独占一层：它是资产的属性（`pipelines[]`），点开资产再看，避免 119 个节点挤成一列。
import { lakePrefixOfKey } from './trail'

export interface PipelineMapPipeline {
  id: string
  account: string | null
  cron: string | null
  enabled: boolean
  /**
   * 是否登记了调度（enabled=false 有两种：登记了但停用 / 根本没登记）。
   * 没登记的（backfill、一次性、已被替代的旧管线）**不该算进「当前健康」**——
   * 否则一张图会长期挂着几年前的失败记录（2026-11-14 实测：7 条「最近失败」全是未调度管线）。
   */
  scheduled: boolean
}

export interface PipelineMapAsset {
  lake: string
  /** `stg_<domain>_<table>`；不存在 ≠ 断点（见 views）。 */
  staging: string | null
  /**
   * 直接读这个湖前缀的**视图/模型**（`vw_*` 等，drill 路径）。
   * 有些资产本来就只给视图用、不该有 staging（例：`lemeng/retail_order_line_month`）；
   * 有视图消费就不算断点——否则地图会长期挂着一条假断点。
   */
  views: string[]
  /** 有 staging 时才有的 marts；没有 staging ⇒ 空（marts 通过 staging 间接消费）。 */
  marts: string[]
  pipelines: PipelineMapPipeline[]
}

/**
 * KPI 一律由服务端给数：前端**不许**用 assets 自己再算一遍。
 * 2026-11-14 一天内踩了两次同类问题（「最近失败」「断点」），都是 domain 改了口径、
 * 页面还在按旧规则数——同一个指标两套实现，迟早分叉。
 */
export interface PipelineMapSummary {
  /** 有管线写入的湖资产数 */
  assets: number
  /** 其中有 staging 对接的资产数 */
  withStaging: number
  /** 断点：无 staging 且无视图消费 */
  broken: number
  /** 未登记调度的管线条数（历史 / 一次性） */
  unscheduled: number
}

export interface PipelineMapModel {
  summary: PipelineMapSummary
  assets: PipelineMapAsset[]
  /** 有 staging 但没有任何管线写对应资产的资产名（断点用） */
  orphanStaging: string[]
  warnings: string[]
}

export interface PipelineMapInput {
  pipelines: ReadonlyArray<{ id: string; lakeKeys: readonly string[] }>
  /**
   * staging → 湖前缀（来自契约 `layout.prefix`）。**优先于命名约定**：
   * `lemeng/dim_branch` 对应的 staging 叫 `stg_lemeng_branch`，命名约定在 dim_* 上会判成断点。
   */
  contractLakes?: ReadonlyMap<string, string>
  /** pipelineId → 调度条目（来源 = 账套文件名）。 */
  schedules: ReadonlyMap<string, ReadonlyArray<{ source: string; cron: string | null; enabled: boolean }>>
  /** dbt staging 模型名（`stg_...`）。 */
  staging: readonly string[]
  /** dbt marts 模型名 + 它 ref 的上游名。 */
  marts: ReadonlyArray<{ name: string; refs: readonly string[] }>
  /** 湖前缀 → 直接引用它的 dbt 模型名（由 `lakeConsumers` 从 SQL 里扫出来）。 */
  consumers?: ReadonlyMap<string, readonly string[]>
}

/** pipeline id 的尾段是账套（数字）时用它，否则 null（仓内共享管线）。 */
export function accountOf(pipelineId: string): string | null {
  const last = pipelineId.split('.').pop() ?? ''
  return /^\d+$/.test(last) ? last : null
}

export function buildPipelineMap(input: PipelineMapInput): PipelineMapModel {
  const stagingSet = new Set(input.staging)
  const martsByStaging = new Map<string, string[]>()
  for (const m of input.marts) {
    for (const r of m.refs) {
      if (!stagingSet.has(r)) continue
      const list = martsByStaging.get(r)
      if (list === undefined) martsByStaging.set(r, [m.name])
      else if (!list.includes(m.name)) list.push(m.name)
    }
  }

  // 资产键 = 管线 key 的前两段（湖前缀）。同一资产可能被多条管线写（L0 / backfill / 多账套）。
  const byLake = new Map<string, PipelineMapPipeline[]>()
  for (const p of input.pipelines) {
    const lakes = new Set(p.lakeKeys.map(lakePrefixOfKey).filter((x): x is string => x !== null))
    for (const lake of lakes) {
      const sched = input.schedules.get(p.id) ?? []
      const list = byLake.get(lake)
      const entry: PipelineMapPipeline = {
        id: p.id,
        account: accountOf(p.id),
        cron: sched[0]?.cron ?? null,
        enabled: sched.length === 0 ? false : sched.some((s) => s.enabled),
        scheduled: sched.length > 0,
      }
      if (list === undefined) byLake.set(lake, [entry])
      else list.push(entry)
    }
  }

  // 契约给的 lake ⇄ staging 对照（反向：lake → staging）
  const stagingOfLake = new Map<string, string>()
  for (const [stg, lake] of input.contractLakes ?? []) {
    if (!stagingSet.has(stg)) continue
    stagingOfLake.set(lake, stg)
  }

  const assets: PipelineMapAsset[] = []
  for (const lake of [...byLake.keys()].sort((a, b) => a.localeCompare(b))) {
    const [domain, table] = lake.split('/')
    const conventional = `stg_${domain}_${table}`
    const stagingName = stagingOfLake.get(lake) ?? conventional
    const staging = stagingSet.has(stagingName) ? stagingName : null
    // 视图消费：排除 staging 自己（staging 也读这条湖，但它不是「没有 staging」的替代品）
    const consumers = input.consumers?.get(lake) ?? []
    const views = consumers.filter((m) => m !== staging).sort((a, b) => a.localeCompare(b))
    assets.push({
      lake,
      staging,
      views,
      marts: staging === null ? [] : (martsByStaging.get(staging) ?? []).slice().sort((a, b) => a.localeCompare(b)),
      pipelines: (byLake.get(lake) ?? []).sort((a, b) => a.id.localeCompare(b.id)),
    })
  }

  // 反向断点：有 staging 模型，但没有任何管线写到它对应的湖前缀
  const lakesWithPipelines = new Set(assets.map((a) => a.lake))
  const stagedLakes = new Set(assets.map((a) => a.staging).filter((x): x is string => x !== null))
  const orphanStaging = input.staging
    .filter((s) => s.startsWith('stg_') && !stagedLakes.has(s) && !lakesWithPipelines.has(lakeOf(s)))
    .sort((a, b) => a.localeCompare(b))

  const warnings: string[] = []
  // 断点 = 既没有 staging、也没有视图在消费（只是视图在用的资产不算断点）
  const noStaging = assets.filter((a) => a.staging === null && a.views.length === 0)
  if (noStaging.length > 0) {
    warnings.push(`${noStaging.length} 个湖资产没有 staging 也没有视图消费（链路断点）`)
  }
  if (orphanStaging.length > 0) {
    warnings.push(`${orphanStaging.length} 个 staging 模型没有仓内管线写它的湖前缀`)
  }

  const allPipelines = assets.flatMap((a) => a.pipelines)
  const summary: PipelineMapSummary = {
    assets: assets.length,
    withStaging: assets.filter((a) => a.staging !== null).length,
    broken: assets.filter((a) => a.staging === null && a.views.length === 0).length,
    unscheduled: allPipelines.filter((p) => !p.scheduled).length,
  }

  return { summary, assets, orphanStaging, warnings }
}

/** 与 trail.ts 同一条命名规则的反向（staging ⇒ 湖前缀）。这里避免循环依赖就地写一行。 */
function lakeOf(staging: string): string {
  const m = /^stg_([a-z0-9]+)_(.+)$/.exec(staging)
  return m === null ? '' : `${m[1]}/${m[2]}`
}

/**
 * 从 dbt 模型 SQL 里扫出「哪个模型直接引用了哪条湖前缀」。
 *
 * 为什么用前缀字典而不是正则自由匹配：前缀是有限集合（契约 layout.prefix ∪ 管线 lakeKeys），
 * 匹配不到集合内的就一定是噪音（例如测试夹具、注释里的示例路径）。
 * `{{ var("..._prefix") }}` 先按 dbt_project.yml 的 vars 展开——视图里两种写法都有。
 */
export function lakeConsumers(
  models: ReadonlyArray<{ name: string; sql?: string }>,
  prefixes: Iterable<string>,
  vars: Readonly<Record<string, string>> = {},
): Map<string, string[]> {
  const dict = [...new Set(prefixes)].filter((p) => p.includes('/'))
  const out = new Map<string, string[]>()
  const varRe = /\{\{\s*var\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g
  for (const m of models) {
    if (m.sql === undefined || m.sql === '') continue
    const sql = m.sql.replace(varRe, (_all, key: string) => vars[key] ?? '')
    for (const prefix of dict) {
      // 前缀后必须跟 `/`，避免 `lemeng/item` 命中 `lemeng/item_price/...`
      if (!sql.includes(`${prefix}/`)) continue
      const list = out.get(prefix)
      if (list === undefined) out.set(prefix, [m.name])
      else if (!list.includes(m.name)) list.push(m.name)
    }
  }
  return out
}
