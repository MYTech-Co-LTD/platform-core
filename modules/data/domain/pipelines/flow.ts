// flow.ts — 「这条管线是怎么跑完的」：把 duckle 的节点图翻成人话步骤。
//
// 给谁看：业务人员要知道采集全流程（取数 → 展开账套 → 加工 → 校验 → 落湖），
// 而不是读 `src.rest` / `qa.contract` 这种组件名。
//
// 输入：管线定义（nodes/edges）+ 一次运行的逐节点收据（receipt.nodes）。
// 输出：按**拓扑序**排好的步骤，每步带人话类型、原始 label、可读参数摘要、以及该次的
// 行数/耗时/状态。纯函数：不读盘、不查库。
//
// 纪律：
//   · 参数摘要**只挑能读懂的字段**，且把 `${ENV:XXX}` 换成域名占位——绝不外泄环境值。
//   · 收据里没有的节点照常列出（缺数据 ≠ 没这个节点），只是没有运行数字。

export interface FlowNodeStat {
  rows?: number
  durationMs?: number
}

export interface FlowStep {
  /** 节点 id（联运行收据用） */
  id: string
  /** 步骤序号（1 起） */
  step: number
  /** 原始组件 id，如 src.rest（放 tooltip） */
  component: string
  /** 人话类型：取数（接口）/ 加工（SQL）/ 校验（契约）… */
  kind: string
  /** 定义里的中文 label（业务可直接读） */
  label: string
  /** 一句可读参数摘要（没有就省略） */
  detail?: string
  /** 该次运行里这个节点的数字 */
  stat?: FlowNodeStat
  /** 相同类型的连续节点被合并时，这里是节点数（1 或缺省 = 单个节点）。 */
  count?: number
}

export interface PipelineFlow {
  pipelineId: string
  name: string
  steps: FlowStep[]
  /** 收据里没有对应节点的步骤数（>0 ⇒ 提示「定义与收据不完全对应」） */
  unmatched: number
}

interface RawNode {
  id?: unknown
  type?: unknown
  data?: { componentId?: unknown; label?: unknown; properties?: unknown }
}
interface RawEdge { source?: unknown; target?: unknown }

/** 组件 → 人话类型。未登记的组件原样显示组件名（不编一个听起来合理的类别）。 */
const KIND: Record<string, string> = {
  'src.rest': '取数（接口）',
  'src.postgres': '取数（数据库）',
  'src.minio': '取数（对象存储）',
  'src.parquet': '取数（文件）',
  'src.csv': '取数（文件）',
  'code.sql': '加工（SQL）',
  'ctl.foreach': '逐账套展开',
  'ctl.merge': '合并多路',
  'ctl.anchor': '窗口锚定',
  'ctl.die': '守卫（不满足即中断）',
  'xf.unionall': '合并多路',
  'xf.tumble': '翻窗聚合',
  'qa.contract': '校验（契约）',
  'qa.profile': '校验（数据画像）',
  'snk.minio': '落湖（对象存储）',
  'snk.parquet': '写文件',
  'snk.csv': '写文件',
  'snk.postgres': '写入数据库',
  'snk.webhook': '回调',
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const obj = (v: unknown): Record<string, unknown> =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {})

/** 占位符不外露：`${ENV:FORMS_API_BASE}` / `${BIZDAY}` 一律落成 `…`（环境值/运行期变量都不是读者要看的）。 */
function plainPlaceholders(text: string): string {
  return text.replace(/\$\{ENV:[^}]+\}/g, '…').replace(/\$\{[^}]+\}/g, '…')
}

/** `${ENV:FORMS_API_BASE}/api/x` → `…/api/x`：只留路径，不暴露环境变量值。 */
function readableUrl(raw: string): string {
  if (raw === '') return ''
  const noEnv = raw.replace(/\$\{ENV:[^}]+\}/g, '')
  try {
    const u = new URL(noEnv.startsWith('http') ? noEnv : `http://x${noEnv.startsWith('/') ? '' : '/'}${noEnv}`)
    return `${u.pathname}${u.search}`
  } catch {
    return noEnv
  }
}

/** 每个组件挑一句「能读懂」的参数说明；挑不出来就省略（不编）。 */
function detailOf(component: string, props: Record<string, unknown>): string | undefined {
  const parts: string[] = []
  if (component.startsWith('src.')) {
    const method = str(props.method).toUpperCase()
    const path = readableUrl(str(props.url))
    if (method !== '') parts.push(method)
    if (path !== '') parts.push(path)
    const page = str(props.paginationType)
    if (page !== '' && page !== 'none') parts.push(`分页 ${page}`)
    const inc = str(props.incrementalField)
    if (inc !== '') parts.push(`增量列 ${inc}`)
  } else if (component === 'snk.minio' || component === 'snk.parquet' || component === 'snk.csv') {
    const path = str(props.key) || str(props.path) || str(props.prefix)
    if (path !== '') parts.push(path)
    const fmt = str(props.format)
    if (fmt !== '') parts.push(fmt)
  } else if (component === 'snk.postgres') {
    const table = str(props.table)
    if (table !== '') parts.push(table)
  } else if (component === 'qa.contract') {
    parts.push(str(props.assertion) || '列集 / 类型')
  } else if (component === 'ctl.foreach') {
    const items = props.items
    if (Array.isArray(items)) parts.push(`${items.length} 项`)
    else if (typeof items === 'object' && items !== null) parts.push(`${Object.keys(items).length} 项`)
  } else if (component === 'code.sql') {
    const sql = str(props.sql)
    if (sql !== '') parts.push(`${sql.split('\n').length} 行 SQL`)
  }
  return parts.length === 0 ? undefined : plainPlaceholders(parts.join(' · '))
}

/** 拓扑排序（Kahn）；有环就按定义顺序把剩下的补在后面（不在展示层报错）。 */
function topoOrder(ids: string[], edges: Array<{ from: string; to: string }>): string[] {
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
    out.get(e.from)!.push(e.to)
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of out.get(id) ?? []) {
      const d = (indeg.get(next) ?? 1) - 1
      indeg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return order
}

/**
 * 把管线定义 + 一次运行的节点收据翻成步骤。
 * @param stats 运行收据里按节点 id 索引的数字（缺省 = 没有运行数据）
 */
export function buildPipelineFlow(
  pipelineId: string,
  doc: Record<string, unknown>,
  stats: ReadonlyMap<string, FlowNodeStat> = new Map(),
): PipelineFlow {
  const nodes = (Array.isArray(doc.nodes) ? doc.nodes : []) as RawNode[]
  const edges = (Array.isArray(doc.edges) ? doc.edges : []) as RawEdge[]
  const ids = nodes.map((n) => str(n.id)).filter((id) => id !== '')
  const linked = edges
    .map((e) => ({ from: str(e.source), to: str(e.target) }))
    .filter((e) => e.from !== '' && e.to !== '')

  const byId = new Map(nodes.map((n) => [str(n.id), n]))
  let unmatched = 0
  const steps: FlowStep[] = topoOrder(ids, linked).map((id, i) => {
    const n = byId.get(id)!
    const data = obj(n.data)
    const component = str(data.componentId) || str(n.type) || 'unknown'
    const stat = stats.get(id)
    if (stat === undefined) unmatched += 1
    const detail = detailOf(component, obj(data.properties))
    return {
      id,
      step: i + 1,
      component,
      kind: KIND[component] ?? component,
      // 有的定义没写 label，只有裸节点 id（w0 / g3 / p1）——那不是给人读的，宁可不显示
      label: (() => {
        const raw = str(data.label)
        return /^[a-z]\d+$/i.test(raw) ? '' : raw
      })(),
      ...(detail === undefined ? {} : { detail }),
      ...(stat === undefined ? {} : { stat }),
    }
  })

  // 合并连续的同型节点：按「页」扇出的管线有 96 个 `src.rest`（page 1…96），
  // 业务人员要的是「取数 × 96 页」而不是 96 行。判据是 component + detail 都相同
  // （不同接口/不同落点的节点不会被并掉）。
  const merged: FlowStep[] = []
  for (const s of steps) {
    const prev = merged[merged.length - 1]
    if (prev !== undefined && prev.component === s.component && prev.detail === s.detail) {
      prev.count = (prev.count ?? 1) + 1
      if (prev.stat !== undefined || s.stat !== undefined) {
        prev.stat = {
          ...(prev.stat?.rows === undefined && s.stat?.rows === undefined
            ? {}
            : { rows: (prev.stat?.rows ?? 0) + (s.stat?.rows ?? 0) }),
          ...(prev.stat?.durationMs === undefined && s.stat?.durationMs === undefined
            ? {}
            : { durationMs: (prev.stat?.durationMs ?? 0) + (s.stat?.durationMs ?? 0) }),
        }
      }
      continue
    }
    merged.push({ ...s })
  }
  merged.forEach((s, i) => { s.step = i + 1 })

  return {
    pipelineId,
    name: str(doc.name) || pipelineId,
    steps: merged,
    unmatched,
  }
}
