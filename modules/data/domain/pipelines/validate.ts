// validate.ts —— 提案面的**纯**校验器（不读盘、不联网、不抛）。
// 空数组 = 通过。issue 的 path 定位到 JSON 路径，便于人照着改。
//
// ⚠️ 这里校验的是**结构**，不是业务口径：列类型对不对、口径算得对不对，
//    只能靠 dbt tests / 对账（本层不越权宣称「草案正确」）。
import type { Issue } from './validate-types'

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

// `quality` 是引擎的**真实词汇**：`qa.contract` 判据写 `"type":"quality"`，引擎照跑
// （`docs/data-platform-handbook.md` 实测；仓内语料里已有管线这么写）。
// 校验器比引擎严 = 把合法草案判红，`propose_*` / `run_pipeline_sandbox` 会拒真草案。
const NODE_TYPES = ['source', 'transform', 'sink', 'control', 'quality']
/** 驱动型节点：`ctl.foreach` 把活派给子管线，产物在子管线里落湖，自身**没有** sink。 */
const DRIVER_COMPONENT = 'ctl.foreach'
const DOMAIN_RE = /^[a-z][a-z0-9_]*$/
const SANDBOX_LAKE_PREFIX = '__sandbox/'
const SANDBOX_LOCAL_PREFIX = '/workspace/logs/sandbox/'
export const CONTRACT_VERSION = 2

export function validatePipelineDraft(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc)) return [{ path: '', message: '草案必须是对象' }]
  if (str(doc.name) === '') out.push({ path: 'name', message: 'name 必填（非空字符串）' })
  const nodes = Array.isArray(doc.nodes) ? doc.nodes : null
  if (nodes === null || nodes.length === 0) {
    out.push({ path: 'nodes', message: 'nodes 必须是非空数组' })
    return out
  }
  const ids = new Set<string>()
  let sources = 0
  let sinks = 0
  let driver = false
  nodes.forEach((n, i) => {
    if (!isObj(n)) { out.push({ path: `nodes[${i}]`, message: '节点必须是对象' }); return }
    const id = str(n.id)
    if (id === '') out.push({ path: `nodes[${i}].id`, message: 'id 必填' })
    else if (ids.has(id)) out.push({ path: `nodes[${i}].id`, message: `id 重复：${id}` })
    else ids.add(id)
    const t = str(n.type)
    if (!NODE_TYPES.includes(t)) out.push({ path: `nodes[${i}].type`, message: `type 必须是 ${NODE_TYPES.join('/')} 之一` })
    if (t === 'source') sources += 1
    if (t === 'sink') sinks += 1
    const data = isObj(n.data) ? n.data : null
    if (data === null) out.push({ path: `nodes[${i}].data`, message: 'data 必填' })
    else {
      const comp = str(data.componentId)
      if (comp === '') out.push({ path: `nodes[${i}].data.componentId`, message: 'componentId 必填' })
      // 驱动型 = **transform 节点挂 ctl.foreach**。只认 componentId 会把这个豁免送给任何类型——
      // 例如 source 节点误挂 ctl.foreach 时，薄管线的 sink 要求就被静默免掉了（Tail 终审 R3）。
      if (t === 'transform' && comp === DRIVER_COMPONENT) driver = true
    }
  })
  if (sources === 0) out.push({ path: 'nodes', message: '至少需要一个 source 节点' })
  // 薄管线必须以 sink 收尾（否则判据求值不了，实测见 deploy/duckle/console/README.md），
  // 但这条**只对薄管线**成立：`ctl.foreach` 驱动把活派给子管线，自身没有 sink 是正常形态
  // （仓内 `lemeng.recon.preagg.backfill.json` 即此）。source 要求仍然无条件。
  if (sinks === 0 && !driver) {
    out.push({ path: 'nodes', message: `至少需要一个 sink 节点（薄管线必须以 sink 收尾；${DRIVER_COMPONENT} 驱动的编排管线除外）` })
  }
  const edges = Array.isArray(doc.edges) ? doc.edges : null
  if (edges === null) out.push({ path: 'edges', message: 'edges 必须是数组（可为空）' })
  else edges.forEach((e, i) => {
    if (!isObj(e)) { out.push({ path: `edges[${i}]`, message: '边必须是对象' }); return }
    for (const end of ['source', 'target'] as const) {
      const v = str(e[end])
      if (v === '') out.push({ path: `edges[${i}].${end}`, message: `${end} 必填` })
      else if (!ids.has(v)) out.push({ path: `edges[${i}].${end}`, message: `${end} 指向不存在的节点：${v}` })
    }
  })
  return out
}

export function validateContractDraft(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc)) return [{ path: '', message: '草案必须是对象' }]
  if (doc.contractVersion !== CONTRACT_VERSION) {
    out.push({ path: 'contractVersion', message: `必须是 ${CONTRACT_VERSION}` })
  }
  for (const k of ['domain', 'table'] as const) {
    if (!DOMAIN_RE.test(str(doc[k]))) out.push({ path: k, message: '必须是 [a-z][a-z0-9_]*' })
  }
  if (str(doc.owner) === '') out.push({ path: 'owner', message: 'owner 必填' })
  const layout = isObj(doc.layout) ? doc.layout : null
  if (layout === null) out.push({ path: 'layout', message: 'layout 必填' })
  else {
    if (str(layout.prefix) === '') out.push({ path: 'layout.prefix', message: 'prefix 必填' })
    if (layout.partitionStyle !== 'hive') out.push({ path: 'layout.partitionStyle', message: '只支持 hive 分区' })
    if (!Array.isArray(layout.partitionBy) || layout.partitionBy.length === 0) {
      out.push({ path: 'layout.partitionBy', message: 'partitionBy 必须是非空数组' })
    }
    if (layout.fileName !== 'all.parquet') out.push({ path: 'layout.fileName', message: '必须是 all.parquet' })
  }
  if (!isObj(doc.batch)) out.push({ path: 'batch', message: 'batch 必填' })
  const cols = Array.isArray(doc.columns) ? doc.columns : null
  if (cols === null || cols.length === 0) out.push({ path: 'columns', message: 'columns 必须是非空数组' })
  else cols.forEach((c, i) => {
    if (!isObj(c)) { out.push({ path: `columns[${i}]`, message: '列必须是对象' }); return }
    if (str(c.name) === '') out.push({ path: `columns[${i}].name`, message: 'name 必填' })
    if (str(c.type) === '') out.push({ path: `columns[${i}].type`, message: 'type 必填' })
  })
  return out
}

/**
 * 沙箱试跑的**写入面**断言（spec §7 红线：产物写 __sandbox 前缀，不入正式湖）：
 *   · 每个 snk.minio 的 properties.key 必须 `__sandbox/` 开头；
 *   · 每个 snk.csv 的 properties.path 必须 `/workspace/logs/sandbox/` 开头；
 *   · 出现 snk.webhook ⇒ 违规（沙箱试跑不得对外发数据）。
 * 源节点不在这里限制：读生产 API 是试跑的题中之义（只读）。
 */
export function sandboxViolations(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc) || !Array.isArray(doc.nodes)) {
    return [{ path: 'nodes', message: 'nodes 缺失，无法断言沙箱前缀' }]
  }
  doc.nodes.forEach((n, i) => {
    if (!isObj(n) || str(n.type) !== 'sink') return
    const data = isObj(n.data) ? n.data : {}
    const comp = str(data.componentId)
    const props = isObj(data.properties) ? data.properties : {}
    if (comp === 'snk.minio') {
      const key = str(props.key)
      if (!key.startsWith(SANDBOX_LAKE_PREFIX)) {
        out.push({ path: `nodes[${i}].data.properties.key`, message: `湖写入必须以 ${SANDBOX_LAKE_PREFIX} 开头，实际：${key || '(空)'}` })
      }
    } else if (comp === 'snk.csv') {
      const path = str(props.path)
      if (!path.startsWith(SANDBOX_LOCAL_PREFIX)) {
        out.push({ path: `nodes[${i}].data.properties.path`, message: `本地落盘必须在 ${SANDBOX_LOCAL_PREFIX} 下，实际：${path || '(空)'}` })
      }
    } else if (comp === 'snk.webhook') {
      out.push({ path: `nodes[${i}].data.componentId`, message: '沙箱试跑不得含 webhook 出口（会对外发数据）' })
    }
  })
  return out
}
