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

/** 沙箱允许的**写入组件**（allowlist）：新增组件默认不可写——安全的一侧是默认拒绝（#1005）。 */
const SANDBOX_WRITE_COMPONENTS = ['snk.minio', 'snk.csv']

/**
 * 沙箱**可执行组件**的族级 allowlist（#1002，口径见 `docs/architecture.md` §2.8）。
 *
 * 为什么不逐条评审那 417 个组件：评审不动（每次引擎升级还会变），也守不住（新组件默认落进哪一侧全看运气）。
 * 族级 allowlist + 显式拒绝是**有意收窄**的 v1 —— 不得在实现里悄悄改回「拒绝已知危险项」的 denylist 形态。
 */
const SANDBOX_COMPONENT_FAMILIES = ['xf', 'src', 'snk', 'qa', 'ctl']

/**
 * allowlist 里仍要单独拒绝的组件，值为拒绝理由（理由进 issue，人看得懂才改得动）。
 *
 * · `code.*`（7 个）：执行任意代码 —— 接上执行面之后，草案作者能跑什么就是沙箱的边界；
 * · `ctl.foreach`：唯一一个「**校验对象 ≠ 执行对象**」的组件 —— 它把活委托给子管线文件，
 *   本函数只看得见父文件，子管线里写什么都拦不住。
 */
const SANDBOX_DENIED_COMPONENTS: Record<string, string> = {
  'ctl.foreach': '把执行委托给子管线文件，子管线不经本层校验',
}

/**
 * 沙箱试跑的**组件策略**：族级 allowlist（`xf` / `src` / `snk` / `qa` / `ctl`），
 * 外加 `code.*` 全拒与 `ctl.foreach` 拒绝；**未知族默认拒绝**。
 *
 * 与 `sandboxViolations`（写入面）是两回事，两者都要过：
 * 写入面管「写到哪」，这里管「拿什么组件去写」——`code.shell` 不进 sink 也能执行任意命令。
 */
export function sandboxComponentViolations(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc) || !Array.isArray(doc.nodes)) {
    return [{ path: 'nodes', message: 'nodes 缺失，无法断言沙箱组件策略' }]
  }
  doc.nodes.forEach((n, i) => {
    if (!isObj(n)) return
    const data = isObj(n.data) ? n.data : {}
    const comp = str(data.componentId)
    const path = `nodes[${i}].data.componentId`
    if (comp === '') {
      out.push({ path, message: 'componentId 为空，无法判定组件策略（判不了即拒）' })
      return
    }
    const denied = SANDBOX_DENIED_COMPONENTS[comp]
    if (denied !== undefined) {
      out.push({ path, message: `沙箱不执行 ${comp}：${denied}` })
      return
    }
    if (comp.startsWith('code.')) {
      out.push({ path, message: `沙箱不执行 ${comp}：执行任意代码（沙箱不得成为执行面）` })
      return
    }
    const family = comp.split('.')[0]
    if (!SANDBOX_COMPONENT_FAMILIES.includes(family)) {
      out.push({
        path,
        message: `沙箱只允许 ${SANDBOX_COMPONENT_FAMILIES.join(' / ')} 族组件，实际：${comp}（未知族默认拒绝）`,
      })
    }
  })
  return out
}

/**
 * POSIX 路径 / 对象键**规范化**。返回 `null` = 这个值判不了 ⇒ 调用方一律当违规。
 *
 * 为什么必须规范化再判：`startsWith('__sandbox/')` 判的是**字面**——`__sandbox/../prod/x`
 * 字面通过、语义却写在正式湖里。接执行面之前这里是一条直接写生产湖的路（#1005）。
 *
 * 规则（判不了就拒，不猜）：
 *   · 反斜杠：Linux 上是普通字符、别处是分隔符 ⇒ 拒（我们的键里不需要它）；
 *   · 百分号编码**只解一层**：解不开、或解完还剩 `%`（多重编码）⇒ 拒——不猜有几层；
 *   · `.` 与空段（`//`、首尾斜杠）折叠，`..` 回退；**回退越过根 ⇒ 拒**；
 *   · 控制字符（含 NUL）⇒ 拒：在 shell / 日志 / 客户端里可能被截断或转义；
 *   · 开头 `/` **保留**（本地落盘规则要求绝对路径，抹掉就等于把相对路径当绝对路径）；
 *   · 大小写**不动**（S3 键区分大小写，`__SANDBOX/` 是另一个前缀，必须判违规而不是被「归一」放行）。
 */
const normalizePosixPath = (raw: string): string | null => {
  if (raw === '' || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return null
  let decoded: string
  try { decoded = decodeURIComponent(raw) } catch { return null }
  if (decoded.includes('%')) return null
  const absolute = decoded.startsWith('/')
  const out: string[] = []
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length === 0) return null
      out.pop()
      continue
    }
    out.push(seg)
  }
  if (out.length === 0) return null
  return `${absolute ? '/' : ''}${out.join('/')}`
}

/** 规范化后的值是否**严格落在** `prefix` 之下（`prefix` 自带尾斜杠；光有目录本身不算一个文件）。 */
const underPrefix = (norm: string, prefix: string): boolean =>
  norm.startsWith(prefix) && norm.length > prefix.length

/**
 * 沙箱试跑的**写入面**断言（spec §7 红线：产物写 __sandbox 前缀，不入正式湖）：
 *   · 写入组件只允许 `snk.minio` / `snk.csv`，其余（含 `snk.webhook` 与**未知**组件）一律违规；
 *   · `snk.minio` 的 `properties.key` 必须落在 `__sandbox/` 之下；
 *   · `snk.csv` 的 `properties.path` 必须落在 `/workspace/logs/sandbox/` 之下；
 *   · 前缀判据一律**按规范化后的路径**判（`..`、`//`、`%2e%2e`、反斜杠都先归一或判不了即拒）；
 *   · 是否「写」按 `componentId`（`snk.*`）或 `type === 'sink'` 判——**不只看 type 标签**：
 *     写不写由组件决定，误标成 `transform` 的 `snk.webhook` 不能整个漏过去（Task 7 ⑤）。
 * 源节点不在这里限制：读生产 API 是试跑的题中之义（只读）。
 */
export function sandboxViolations(doc: unknown): Issue[] {
  const out: Issue[] = []
  if (!isObj(doc) || !Array.isArray(doc.nodes)) {
    return [{ path: 'nodes', message: 'nodes 缺失，无法断言沙箱前缀' }]
  }
  doc.nodes.forEach((n, i) => {
    if (!isObj(n)) return
    const data = isObj(n.data) ? n.data : {}
    const comp = str(data.componentId)
    const isWrite = str(n.type) === 'sink' || comp.startsWith('snk.')
    if (!isWrite) return
    if (!SANDBOX_WRITE_COMPONENTS.includes(comp)) {
      out.push({
        path: `nodes[${i}].data.componentId`,
        message: `沙箱只允许写入 ${SANDBOX_WRITE_COMPONENTS.join(' / ')}，实际：${comp || '(空)'}`
          + (comp === 'snk.webhook' ? '（沙箱试跑不得对外发数据）' : ''),
      })
      return
    }
    const props = isObj(data.properties) ? data.properties : {}
    const [field, prefix, label] = comp === 'snk.minio'
      ? (['key', SANDBOX_LAKE_PREFIX, '湖写入'] as const)
      : (['path', SANDBOX_LOCAL_PREFIX, '本地落盘'] as const)
    const raw = str(props[field])
    const norm = normalizePosixPath(raw)
    if (norm === null || !underPrefix(norm, prefix)) {
      out.push({
        path: `nodes[${i}].data.properties.${field}`,
        message: norm === null
          ? `${label}路径无法规范化（含反斜杠/坏编码/越界回退或为空），判为违规：${raw || '(空)'}`
          : `${label}必须落在 ${prefix} 之下（按规范化后的路径判），实际：${raw} → ${norm}`,
      })
    }
  })
  return out
}
