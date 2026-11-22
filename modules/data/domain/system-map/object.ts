// object.ts — 「对象详情」的纯函数组装（2026-11-22，#2691）。
//
// 对标 dbt Explorer / DataHub 的对象详情页：**以选中对象为中心**，
// 给出它自己的字段、上下游 2 跳血缘、最近运行态——而不是再画一张全图。
//
// 输入全部来自调用方（路由层查库/读盘后传入），本文件不触达 IO，可单测。

export type ObjectKind = 'lake' | 'staging' | 'mart' | 'recon' | 'metric' | 'pipeline'

export interface SimpleRef { kind: ObjectKind; name: string; displayName?: string; summary?: string }

export interface ObjectColumn {
  name: string
  type: string | null
  /** 该列的表达式（staging 的 cast / marts 的聚合公式）；拿不到就是 null（不猜） */
  expr: string | null
  description: string
}

export interface ObjectDetail {
  kind: ObjectKind
  name: string
  /** 人话名称（有就显示：指标 title / 模型描述首句）；缺省 = 只有英文名 */
  displayName: string | null
  /** 一句人话说明（截断） */
  summary: string | null
  domain: string | null
  columns: ObjectColumn[]
  /** 直接上游 / 下游（1 跳）；`hops2` 是 2 跳以内（去重，不含自己与 1 跳） */
  upstream: SimpleRef[]
  downstream: SimpleRef[]
  upstream2: SimpleRef[]
  downstream2: SimpleRef[]
  notes: string[]
}

export interface ObjectInput {
  kind: ObjectKind
  name: string
  domain: string | null
  columns: ObjectColumn[]
  /** 全图的节点与边（与 /system-map/flow 同源）：用来算中心化血缘 */
  nodes: Array<{ id: string; kind: string; label: string }>
  edges: Array<{ source: string; target: string }>
  notes?: string[]
  /** 人话名称/说明的解析器（由路由层给：指标 title / 模型描述 / 契约描述） */
  describe?: (kind: ObjectKind, name: string) => { displayName: string | null; summary: string | null }
  /** 本对象自己的人话名称与说明（缺省时用 describe） */
  about?: { displayName: string | null; summary: string | null }
}

/** 节点 id 约定：`<前缀>:<label>`（与 flow 图一致）。 */
const idOf = (kind: string, label: string): string => {
  const prefix = kind === 'source' ? 'src'
    : kind === 'pipeline' ? 'pipe'
      : kind === 'lake' ? 'lake'
        : kind === 'staging' ? 'stg'
          : kind === 'metric' ? 'met'
            : kind === 'consumer' ? 'use'
              : kind === 'audit' ? 'audit'
                : 'mart'
  return `${prefix}:${label}`
}

/** flow 节点的 kind → 详情页的 kind（mart/recon 都归 mart 系列）。 */
function detailKindOf(flowKind: string): ObjectKind | null {
  switch (flowKind) {
    case 'lake': return 'lake'
    case 'staging': return 'staging'
    case 'mart': return 'mart'
    case 'recon': return 'recon'
    case 'metric': return 'metric'
    case 'pipeline': return 'pipeline'
    default: return null
  }
}

/**
 * 以对象为中心取 1–2 跳血缘。
 *
 * 口径：按 `edges` 的方向（source → target 即上游 → 下游）。
 * 2 跳**排除** 1 跳与自身；同一对象可能既是 1 跳又是 2 跳（菱形）——只在 1 跳保留。
 */
export function buildObjectDetail(input: ObjectInput): ObjectDetail {
  const notes = [...(input.notes ?? [])]
  const selfId = idOf(input.kind, input.name)
  const byId = new Map(input.nodes.map((n) => [n.id, n]))

  const refOf = (id: string): SimpleRef | null => {
    const n = byId.get(id)
    if (n === undefined) return null
    const kind = detailKindOf(n.kind)
    if (kind === null) return null
    const d = input.describe?.(kind, n.label)
    return {
      kind,
      name: n.label,
      ...(d?.displayName === undefined || d.displayName === null ? {} : { displayName: d.displayName }),
      ...(d?.summary === undefined || d.summary === null ? {} : { summary: d.summary }),
    }
  }

  const up1 = input.edges.filter((e) => e.target === selfId).map((e) => e.source)
  const down1 = input.edges.filter((e) => e.source === selfId).map((e) => e.target)
  const up2 = [...new Set(up1.flatMap((id) => input.edges.filter((e) => e.target === id).map((e) => e.source)))]
  const down2 = [...new Set(down1.flatMap((id) => input.edges.filter((e) => e.source === id).map((e) => e.target)))]

  const oneHop = new Set([...up1, ...down1, selfId])
  const pick = (ids: string[]) => [...new Set(ids)]
    .filter((id) => !oneHop.has(id))
    .map(refOf)
    .filter((x): x is SimpleRef => x !== null)

  const upstream = up1.map(refOf).filter((x): x is SimpleRef => x !== null)
  const downstream = down1.map(refOf).filter((x): x is SimpleRef => x !== null)
  if (upstream.length === 0 && downstream.length === 0) {
    notes.push('没有识别到上下游（该对象可能不在流程图里，或事实源未声明）')
  }

  const about = input.about ?? input.describe?.(input.kind, input.name) ?? { displayName: null, summary: null }
  return {
    kind: input.kind,
    name: input.name,
    displayName: about.displayName,
    summary: about.summary,
    domain: input.domain,
    columns: input.columns,
    upstream,
    downstream,
    upstream2: pick(up2),
    downstream2: pick(down2),
    notes,
  }
}

/** 列表页的行：对象 + 上下游计数（列表页只用计数，不拉详情）。 */
export interface ObjectRow {
  kind: ObjectKind
  name: string
  domain: string | null
  upstreamCount: number
  downstreamCount: number
}

export function listObjects(input: Omit<ObjectInput, 'columns' | 'kind' | 'name' | 'domain'> & {
  /** 每个对象所属域（lake 前缀第二段）；缺省 null */
  domainOf?: (kind: ObjectKind, name: string) => string | null
}): ObjectRow[] {
  const rows: ObjectRow[] = []
  for (const n of input.nodes) {
    const kind = detailKindOf(n.kind)
    if (kind === null) continue
    const upstreamCount = input.edges.filter((e) => e.target === n.id).length
    const downstreamCount = input.edges.filter((e) => e.source === n.id).length
    rows.push({
      kind,
      name: n.label,
      domain: input.domainOf?.(kind, n.label) ?? null,
      upstreamCount,
      downstreamCount,
    })
  }
  const order: ObjectKind[] = ['pipeline', 'lake', 'staging', 'mart', 'recon', 'metric']
  return rows.sort((a, b) => (order.indexOf(a.kind) - order.indexOf(b.kind)) || a.name.localeCompare(b.name))
}
