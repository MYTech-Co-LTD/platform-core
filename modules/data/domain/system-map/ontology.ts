// ontology.ts — 把 `SystemMapModel` 投影成「本体图」（entities + relations 形状）。
//
// 为什么要这一层：体系地图原来的五个页签是「一排清单」，读者要自己在脑子里把
// 实体 / 指标 / 源表 / 维度拼起来。本体图把**关系**变成一等公民：节点带类型，边带类型，
// 点开节点看 observations（口径 / 来源 / 对账 / 使用量）。
//
// 形状参考 MCP 的 knowledge graph（entities + relations）：
//   { nodes: [{ id, type, label, observations }], edges: [{ from, to, type }] }
//
// 两条硬纪律：
//   1. **不留悬空边**——两端节点都会先建好，边只在这两端都存在时产出（前端布局不会出现孤立线头）。
//   2. **纯函数**——不读盘、不查库，输入 `SystemMapModel`，输出可 JSON 化的对象（单测直接喂构造数据）。
import type { SystemMapModel } from './map'

export type OntologyNodeType = 'entity' | 'metric' | 'source' | 'dimension'

export type OntologyEdgeType = 'belongs_to' | 'derives_from' | 'upstream_of' | 'has_dimension'

export interface OntologyNode {
  id: string
  type: OntologyNodeType
  label: string
  /** 给人读的短句，一条一句（口径 / 来源 / 使用量…），前端逐条列出。 */
  observations: string[]
}

export interface OntologyEdge {
  from: string
  to: string
  type: OntologyEdgeType
}

export interface SystemMapOntology {
  nodes: OntologyNode[]
  edges: OntologyEdge[]
}

/** 节点 id 前缀：同名不同类（如实体「门店」与源表「门店」）不会撞车。 */
const nodeId = (type: OntologyNodeType, key: string): string => `${type}:${key}`

export function buildSystemMapOntology(model: SystemMapModel): SystemMapOntology {
  const nodes: OntologyNode[] = []
  const edges: OntologyEdge[] = []
  const seenNodes = new Set<string>()
  const seenEdges = new Set<string>()

  const addNode = (node: OntologyNode): void => {
    if (seenNodes.has(node.id)) return
    seenNodes.add(node.id)
    nodes.push(node)
  }
  const addEdge = (from: string, to: string, type: OntologyEdgeType): void => {
    if (!seenNodes.has(from) || !seenNodes.has(to)) return
    const key = `${from}|${type}|${to}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    edges.push({ from, to, type })
  }

  // ── 节点：四类先全部建好（边只连接已存在的节点）────────────────────────────
  for (const e of model.entities) {
    addNode({
      id: nodeId('entity', e.name),
      type: 'entity',
      label: e.label,
      observations: [
        `${e.metricIds.length} 个指标挂在这个对象上`,
        ...(e.synonyms.length > 0 ? [`别名：${e.synonyms.join('、')}`] : []),
        ...(e.relations.length > 0 ? [`涉及源关系：${e.relations.join('、')}`] : []),
      ],
    })
  }

  for (const m of model.metrics) {
    addNode({
      id: nodeId('metric', m.id),
      type: 'metric',
      label: m.title,
      observations: [
        `口径：${m.definition || m.expression || '未声明'}`,
        `来源：${m.source === 'l1' ? '平台口径' : '本租户派生'}${m.certified === 'draft' ? '（草稿）' : ''}`,
        ...(m.unit !== null && m.unit !== '' ? [`单位：${m.unit}`] : []),
        `近 30 天使用 ${m.usage30d} 次`,
        m.auditExists ? '有独立复算文件（对账覆盖）' : '缺复算文件（对账未覆盖）',
        ...(m.requiredScope !== null ? [`需要权限：${m.requiredScope}`] : []),
      ],
    })
  }

  for (const s of model.sources) {
    addNode({
      id: nodeId('source', s.name),
      type: 'source',
      label: s.name,
      observations: [
        `${s.metricIds.length} 个指标由它算出`,
        ...(s.upstream.length > 0 ? [`上游：${s.upstream.map((u) => u.name).join('、')}`] : []),
        ...(s.contracts.length > 0 ? [`契约：${s.contracts.length} 条`] : []),
      ],
    })
  }

  for (const d of model.dimensions) {
    addNode({
      id: nodeId('dimension', d.name),
      type: 'dimension',
      label: d.label,
      observations: [
        `层级：${d.levels.map((l) => `${l.level}(${l.column})`).join(' → ')}`,
        `基于关系：${d.relation}`,
      ],
    })
  }

  // ── 边：全部有向、全部两端已存在 ────────────────────────────────────────────
  for (const m of model.metrics) {
    const metricNode = nodeId('metric', m.id)
    if (m.entity !== null && m.entity !== '') addEdge(metricNode, nodeId('entity', m.entity), 'belongs_to')
    for (const rel of m.relations) {
      // sources 是由 metrics.relations 反推出来的 ⇒ 这里的命中是常态；不命中说明源解析失败，
      // 该指标已经进了 orphans（不在这里造一条指向空气的边）。
      addEdge(metricNode, nodeId('source', rel), 'derives_from')
    }
  }

  const sourceNames = new Set(model.sources.map((s) => s.name))
  for (const s of model.sources) {
    for (const u of s.upstream) {
      if (sourceNames.has(u.name)) addEdge(nodeId('source', s.name), nodeId('source', u.name), 'upstream_of')
    }
  }

  for (const e of model.entities) {
    for (const d of model.dimensions) {
      if (e.relations.includes(d.relation)) addEdge(nodeId('entity', e.name), nodeId('dimension', d.name), 'has_dimension')
    }
  }

  return { nodes, edges }
}
