// flow.ts — 「全流程」节点图的组装（2026-11-22，#2687）。
//
// 目标：一张从左到右的流程图，把**整条链路**画出来——
//   源接口 → 采集管线 → 湖资产 → staging → marts → 指标 → 消费面
//
// 为什么不逐条展开（121 条管线 / 57 个指标直接铺开会糊成一团）：
//   **默认按组聚合、点节点看成员**（抽屉由前端做）。组节点上标数量，
//   既保住「全部流程都在图上」，又不牺牲可读性。
//
// 坐标由本文件算（固定 7 层 x、层内等高均分）——ECharts 用 `layout:'none'` 直接吃，
// 布局稳定、可复现、可单测（不依赖力导向的随机性）。

export type FlowKind = 'source' | 'pipeline' | 'lake' | 'staging' | 'mart' | 'metric' | 'consumer'

export interface FlowNode {
  id: string
  kind: FlowKind
  label: string
  /** 组节点：成员数量（前端显示 ×N） */
  count?: number
  /** 组成员清单（点开抽屉用；上限 200，避免超大列表） */
  members?: string[]
  /** 运行态（仅管线/湖/表有）：ok / failed / running / unknown / idle */
  status?: string
  x: number
  y: number
}

export interface FlowEdge { source: string; target: string }

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
  layers: Array<{ kind: FlowKind; label: string; x: number; count: number }>
  notes: string[]
}

export interface FlowInput {
  /** 契约：id = `<domain>.<table>`，prefix = 湖前缀 */
  contracts: Array<{ id: string; domain: string; table: string; prefix: string | null }>
  /** 管线：id + 它写入的湖 key（`domain/table/...`） */
  pipelines: Array<{ id: string; lakeKeys: string[] }>
  /** staging 模型名与其上游（dbt refs） */
  staging: Array<{ name: string; lakePrefix: string | null }>
  /** marts：名称 + 它引用的 staging / marts */
  marts: Array<{ name: string; refs: string[] }>
  /** 指标：id/标题/实体/用到的关系 */
  metrics: Array<{ id: string; title: string; entity: string | null; relations: string[] }>
}

/** 7 层，x 固定（像素）。高度由层内最大节点数决定。 */
export const FLOW_LAYERS: Array<{ kind: FlowKind; label: string; x: number }> = [
  { kind: 'source', label: '源接口', x: 0 },
  { kind: 'pipeline', label: '采集管线', x: 220 },
  { kind: 'lake', label: '湖资产', x: 440 },
  { kind: 'staging', label: 'staging', x: 660 },
  { kind: 'mart', label: 'marts', x: 880 },
  { kind: 'metric', label: '指标', x: 1100 },
  { kind: 'consumer', label: '消费面', x: 1320 },
]

const LAYER_GAP = 34
const MAX_MEMBERS = 200

/** 湖前缀：`domain/table`（契约 layout.prefix 或 staging 命名推断）。 */
function prefixOfKey(key: string): string | null {
  const seg = key.split('/')
  if (seg.length < 2) return null
  if (seg[0].includes('${') || seg[1].includes('${')) return null
  return `${seg[0]}/${seg[1]}`
}

export function buildFlowGraph(input: FlowInput): FlowGraph {
  const notes: string[] = []
  const byKind = new Map<FlowKind, FlowNode[]>()

  const push = (kind: FlowKind, node: Omit<FlowNode, 'x' | 'y'>) => {
    const list = byKind.get(kind) ?? []
    // 同 id 去重（多来源聚到同一组时不重复画）
    if (!list.some((n) => n.id === node.id)) list.push({ ...node, x: 0, y: 0 })
    byKind.set(kind, list)
  }

  // ── L0 源接口：每个契约一个节点（按 domain.table 命名）────────────────────
  for (const c of input.contracts) {
    push('source', { id: `src:${c.id}`, kind: 'source', label: c.id })
  }

  // ── L1 采集管线：按湖前缀聚合（121 条 → 十余组；点开看成员）──────────────
  const pipeGroups = new Map<string, string[]>()
  for (const p of input.pipelines) {
    const prefixes = [...new Set(p.lakeKeys.map(prefixOfKey).filter((x): x is string => x !== null))]
    if (prefixes.length === 0) {
      notes.push(`管线 ${p.id} 没有可识别的湖前缀——未上图`)
      continue
    }
    for (const pre of prefixes) {
      const list = pipeGroups.get(pre) ?? []
      list.push(p.id)
      pipeGroups.set(pre, list)
    }
  }
  for (const [pre, ids] of pipeGroups) {
    push('pipeline', {
      id: `pipe:${pre}`, kind: 'pipeline', label: pre.split('/')[1] ?? pre,
      count: ids.length, members: ids.slice(0, MAX_MEMBERS).sort(),
    })
  }

  // ── L2 湖资产：契约前缀 ∪ 管线前缀 ∪ staging 推断前缀 ──────────────────────
  const lakePrefixes = new Set<string>()
  for (const c of input.contracts) if (c.prefix !== null) lakePrefixes.add(c.prefix)
  for (const pre of pipeGroups.keys()) lakePrefixes.add(pre)
  for (const s of input.staging) if (s.lakePrefix !== null) lakePrefixes.add(s.lakePrefix)
  for (const pre of lakePrefixes) {
    push('lake', { id: `lake:${pre}`, kind: 'lake', label: pre })
  }

  // ── L3 staging / L4 marts ────────────────────────────────────────────────
  for (const s of input.staging) push('staging', { id: `stg:${s.name}`, kind: 'staging', label: s.name })
  for (const m of input.marts) push('mart', { id: `mart:${m.name}`, kind: 'mart', label: m.name })

  // ── L5 指标：按实体聚合（无实体归「未绑定实体」）───────────────────────────
  const metricGroups = new Map<string, Array<{ id: string; title: string }>>()
  for (const m of input.metrics) {
    const key = m.entity ?? '(未绑定实体)'
    const list = metricGroups.get(key) ?? []
    list.push({ id: m.id, title: m.title })
    metricGroups.set(key, list)
  }
  for (const [entity, list] of metricGroups) {
    push('metric', {
      id: `met:${entity}`, kind: 'metric', label: entity,
      count: list.length, members: list.slice(0, MAX_MEMBERS).map((x) => `${x.id}｜${x.title}`),
    })
  }

  // ── L6 消费面（固定四个：报表 / 钻取 / 问数 / 对账）────────────────────────
  for (const [id, label] of [
    ['report', '固定报表'], ['drill', '钻取明细'], ['ask', '企微问数'], ['recon', '对账台账'],
  ] as const) {
    push('consumer', { id: `use:${id}`, kind: 'consumer', label })
  }

  // ── 边 ───────────────────────────────────────────────────────────────────
  const edges: FlowEdge[] = []
  const seen = new Set<string>()
  const link = (s: string, t: string) => {
    const k = `${s}->${t}`
    if (seen.has(k)) return
    seen.add(k)
    edges.push({ source: s, target: t })
  }

  // 源 → 管线（按湖前缀对上）
  const contractPrefix = new Map(input.contracts.map((c) => [c.id, c.prefix]))
  for (const [pre, ids] of pipeGroups) {
    for (const [cid, cprefix] of contractPrefix) {
      if (cprefix === pre) link(`src:${cid}`, `pipe:${pre}`)
    }
    // 管线 → 湖
    link(`pipe:${pre}`, `lake:${pre}`)
  }
  // 湖 → staging（staging 的湖前缀）
  for (const s of input.staging) {
    if (s.lakePrefix !== null) link(`lake:${s.lakePrefix}`, `stg:${s.name}`)
  }
  // staging → marts（dbt refs）
  for (const m of input.marts) {
    for (const r of m.refs) {
      if (r.startsWith('stg_')) link(`stg:${r}`, `mart:${m.name}`)
      else if (r.startsWith('fct_') || r.startsWith('dim_') || r.startsWith('recon_')) link(`mart:${r}`, `mart:${m.name}`)
    }
  }
  // marts → 指标组（指标声明的关系 ∩ marts）
  const martNames = new Set(input.marts.map((m) => m.name))
  for (const m of input.metrics) {
    const entity = m.entity ?? '(未绑定实体)'
    for (const rel of m.relations) {
      if (martNames.has(rel)) link(`mart:${rel}`, `met:${entity}`)
    }
  }
  // 指标组 → 消费面（四个都连；前端可聚焦单节点看邻域）
  for (const entity of metricGroups.keys()) {
    for (const c of ['report', 'drill', 'ask', 'recon']) link(`met:${entity}`, `use:${c}`)
  }

  // ── 坐标：固定层 x，层内按节点数均分 ───────────────────────────────────────
  const layerCounts = FLOW_LAYERS.map((l) => (byKind.get(l.kind) ?? []).length)
  const maxCount = Math.max(1, ...layerCounts)
  const heightPer = 30
  const nodes: FlowNode[] = []
  for (const layer of FLOW_LAYERS) {
    const list = byKind.get(layer.kind) ?? []
    const span = (list.length - 1) * (heightPer + LAYER_GAP)
    const top = (maxCount - 1) * (heightPer + LAYER_GAP) / 2 - span / 2
    list.forEach((n, i) => {
      nodes.push({ ...n, x: layer.x, y: top + i * (heightPer + LAYER_GAP) })
    })
  }

  if (edges.length === 0) notes.push('没有识别出任何连线——契约/管线的湖前缀可能对不上（未知 ≠ 没有）')

  return {
    nodes,
    edges,
    layers: FLOW_LAYERS.map((l, i) => ({ ...l, count: layerCounts[i] })),
    notes,
  }
}
