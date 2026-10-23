// defs.ts —— 提案面的**只读**定义源：仓内管线 / 调度 / 契约（全部同步读文件）。
//
// 为什么读文件而不是走 OpenShip / duckle console HTTP：见计划 D-W3-2（真机实测：
// 容器内无 duckle、无 contracts；consoles 只绑回环且跨 compose 项目不可达）。
//
// 铁律：
//   · **不抛**。读面不能因为一个坏文件整体失败——坏项进 warnings，工具回包里带出去。
//   · **用户输入永不拼进路径**：只按 id 在已枚举的结果里查（path traversal 结构性不可能）。
//   · 管线只看 `<pipelinesRoot>/pipelines/*.json`，**文件名 = 管线 id**（与
//     `deploy/duckle/console/README.md` 的「console 只认自己 workspace 里的 pipelines/」一致）。
//   · 调度文件是**数组**（不是字典），每条带 `pipeline_id`。
//   · 契约里 `_` 开头的文件是基础设施（_schema/_template），必须跳过（contracts/README.md）。
//   · 契约是**两层容器**：`contracts/<域>/<源>.<表>.json` 与 `contracts/customers/<客户>/…`；
//     同 id 多份只告警不裁决（优先级未定案，contracts/customers/README.md）。
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PIPELINE_ID_RE = /^[A-Za-z0-9_.-]+$/

/**
 * 运行 id：引擎形如 `run-manual-<管线>-<epochMs>` / `run-scheduled-…`。
 * **不得含 `/`、不得以 `.` 开头**——来源要把它拼进 `receipts/<runId>.json`，
 * 这条正则就是路径穿越的结构性防线（先用它判，再用 `join`）。
 */
export const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/

/**
 * 仓根，**按本模块文件位置**解析（`modules/data/domain/pipelines/` 上四级）：
 * `modules/data/domain/pipelines/defs.ts` → `modules/data/domain/pipelines` → … → 仓根。
 *
 * 为什么不按 `process.cwd()`：`pnpm --filter @platform/server start`（镜像 CMD）把 cwd
 * 定在 `apps/server`，于是 `join(cwd, 'contracts')` 会落到 `apps/server/contracts`
 * ——镜像里根本没有那个目录（缺省根会静默落空，读面回 unknown）。
 * 镜像内本模块在 `/app/modules/data/domain/pipelines`，上四级即 `/app`。
 *
 * ⚠️ 路径用 `node:path` 取，**不要**写 `new URL(rel, import.meta.url)`：happy-dom 会替换
 * 全局 URL 构造函数，`file:` 解析失效（#718 实测，同 modules/forms/index.ts:17-20）。
 */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

export interface PipelineRoots { pipelinesRoot: string; contractsRoot: string }

/**
 * env 缝（B9：两键必须在根 .env.example 声明）。
 * 缺省根 = {@link REPO_ROOT}（**按模块位置解析，与 cwd 无关**；镜像内即 `/app`）——
 * 故 pnpm 脚本把 cwd 设成 `apps/server` 不影响缺省解析。
 * 第二参数是显式基准目录（测试用），不传则用仓根。
 */
export function rootsOf(
  env: Record<string, string | undefined> = process.env, baseDir: string = REPO_ROOT,
): PipelineRoots {
  return {
    pipelinesRoot: env.DATA_PIPELINES_ROOT?.trim() || join(baseDir, 'deploy/duckle/console'),
    contractsRoot: env.DATA_CONTRACTS_ROOT?.trim() || join(baseDir, 'contracts'),
  }
}

export interface ScheduleEntry {
  source: string; pipelineId: string; enabled: boolean; cron: string | null; timezone: string | null
}

/** 节点类型计数键。`quality` 是引擎真实接受的词汇（`qa.contract` 写 `"type":"quality"`，
 *  `docs/data-platform-handbook.md` 实测引擎照跑），不能漏计——否则 `get_pipeline` 的
 *  `nodes` 明细会静默吞掉判据节点。 */
const COUNT_KEYS = ['source', 'transform', 'sink', 'control', 'quality'] as const
type CountKey = (typeof COUNT_KEYS)[number]

export interface PipelineDef {
  id: string
  name: string
  version: unknown
  doc: Record<string, unknown>
  counts: Record<CountKey, number>
  /** 所有 snk.minio sink 的 key（湖写入面的事实清单；沙箱断言与契约匹配都用它）。 */
  lakeKeys: string[]
}

export interface ContractRef {
  id: string; domain: string; table: string; path: string; columns: number
  doc: Record<string, unknown>
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const readJson = (p: string): Record<string, unknown> | unknown[] | null => {
  try {
    const v: unknown = JSON.parse(readFileSync(p, 'utf8'))
    return isObj(v) || Array.isArray(v) ? (v as Record<string, unknown> | unknown[]) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function loadPipelines(
  roots: PipelineRoots,
): { defs: Map<string, PipelineDef>; warnings: string[]; readable: boolean; incomplete: boolean } {
  const defs = new Map<string, PipelineDef>()
  const warnings: string[] = []
  // 「有东西没读到/没解析成功」的显式信号（≠「目录里没有」）。读不全时清单里的 **缺席**
  // 不等于「不存在」——调用方必须能机器区分，不能靠 warnings 文本反推。
  let incomplete = false
  let dir = ''
  let files: string[]
  try {
    // join 也必须在 guard 内：非字符串 root 会让 join 抛错，破坏「不抛」铁律。
    dir = join(roots.pipelinesRoot, 'pipelines')
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    // readable=false 是给调用方的**显式**信号：目录读不到 ≠ 目录里没有管线。
    // 不要靠 warnings 文本反推（文案会变），也别让调用方自己再 stat 一遍。
    warnings.push(`pipelines 目录不可读：${roots.pipelinesRoot}`)
    return { defs, warnings, readable: false, incomplete: true }
  }
  for (const f of files) {
    const id = f.slice(0, -'.json'.length)
    if (!PIPELINE_ID_RE.test(id)) {
      warnings.push(`跳过非法管线名：${f}`); incomplete = true; continue
    }
    const raw = readJson(join(dir, f))
    if (!isObj(raw)) { warnings.push(`跳过不可解析的管线：${f}`); incomplete = true; continue }
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isObj) : []
    const counts: Record<CountKey, number> = { source: 0, transform: 0, sink: 0, control: 0, quality: 0 }
    const lakeKeys: string[] = []
    for (const n of nodes) {
      const t = str(n.type)
      if ((COUNT_KEYS as readonly string[]).includes(t)) counts[t as CountKey] += 1
      const data = isObj(n.data) ? n.data : {}
      if (t === 'sink' && str(data.componentId) === 'snk.minio') {
        const props = isObj(data.properties) ? data.properties : {}
        if (str(props.key) !== '') lakeKeys.push(str(props.key))
      }
    }
    defs.set(id, {
      id, name: str(raw.name) || id, version: raw.version ?? null, doc: raw, counts, lakeKeys,
    })
  }
  return { defs, warnings, readable: true, incomplete }
}

export function loadSchedules(
  roots: PipelineRoots,
): { byPipeline: Map<string, ScheduleEntry[]>; warnings: string[]; incomplete: boolean } {
  const byPipeline = new Map<string, ScheduleEntry[]>()
  const warnings: string[] = []
  let incomplete = false
  let dir = ''
  let files: string[]
  try {
    // 同 loadPipelines：join 在 guard 内，非字符串 root 也不抛。
    dir = join(roots.pipelinesRoot, 'schedules')
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    // 调度根读不到 ≠ 没有调度。没有这条信号，`source` 过滤会回 ok/count:0，
    // 被读成「这个账套没有任何管线」——最危险的一类假绿。
    warnings.push(`schedules 目录不可读：${roots.pipelinesRoot}`)
    return { byPipeline, warnings, incomplete: true }
  }
  for (const f of files) {
    const source = f.slice(0, -'.json'.length)
    const raw = readJson(join(dir, f))
    // 调度文件是**数组**（每条带 pipeline_id），不是字典——见 deploy/duckle/console/README.md。
    if (!Array.isArray(raw)) { warnings.push(`跳过不可解析的调度：${f}`); incomplete = true; continue }
    for (const e of raw) {
      if (!isObj(e)) { warnings.push(`调度条目不是对象：${f}`); incomplete = true; continue }
      const pid = str(e.pipeline_id)
      if (pid === '') { warnings.push(`调度条目缺 pipeline_id：${f}`); incomplete = true; continue }
      const kind = isObj(e.kind) ? e.kind : {}
      const entry: ScheduleEntry = {
        source, pipelineId: pid, enabled: e.enabled === true,
        cron: str(kind.expr) || null, timezone: str(e.timezone) || null,
      }
      byPipeline.set(pid, [...(byPipeline.get(pid) ?? []), entry])
    }
  }
  return { byPipeline, warnings, incomplete }
}

export function loadContracts(
  roots: PipelineRoots,
): { contracts: ContractRef[]; warnings: string[]; incomplete: boolean; duplicateIds: string[] } {
  const contracts: ContractRef[] = []
  const warnings: string[] = []
  // 「有东西没读到/没解析成功」的显式信号（≠「仓里没有」，也 ≠「同 id 重复」那种读到了但有歧义）。
  // 调用方要判断「基线是否可信」，不要靠 warnings 文本反推（文案会变）。
  let incomplete = false
  let domains: string[]
  try {
    domains = readdirSync(roots.contractsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    warnings.push(`contracts 目录不可读：${roots.contractsRoot}`)
    return { contracts, warnings, incomplete: true, duplicateIds: [] }
  }

  /** 枚举一个目录里的契约（`_` 前缀 = 基础设施，跳过；坏件进 warnings 并标记读不全）。 */
  const collect = (relDir: string): void => {
    let files: string[]
    try { files = readdirSync(join(roots.contractsRoot, relDir)).filter((f) => f.endsWith('.json')).sort()
    } catch { warnings.push(`契约目录不可读：${relDir}`); incomplete = true; return }
    for (const f of files) {
      // `_` 前缀 = 基础设施（_schema/_template），跳过（contracts/README.md 明文）。
      if (f.startsWith('_')) continue
      const stem = f.slice(0, -'.json'.length)
      const raw = readJson(join(roots.contractsRoot, relDir, f))
      if (!isObj(raw)) { warnings.push(`跳过不可解析的契约：${relDir}/${f}`); incomplete = true; continue }
      const table = str(raw.table)
      // domain 缺省时按 `<源>.<表>.json` 的文件名取源。**不能**用目录名兜底：
      // 客户覆盖目录名是**客户**（customers/acme），不是数据域。
      const fallbackDomain = stem.includes('.') ? stem.slice(0, stem.lastIndexOf('.')) : relDir
      const dom = str(raw.domain) || fallbackDomain
      const cols = Array.isArray(raw.columns) ? raw.columns.length : 0
      contracts.push({
        id: table === '' ? stem : `${dom}.${table}`,
        domain: dom, table, path: `contracts/${relDir}/${f}`, columns: cols, doc: raw,
      })
    }
  }

  for (const domain of domains) {
    // `customers/` 是**容器**（下一层才是客户目录），不是数据域——见下方两层枚举与
    // contracts/customers/README.md。把它当域扫只会读到空/README。
    if (domain === 'customers') continue
    collect(domain)
  }

  // 客户级覆盖：`contracts/customers/<客户>/<源>.<表>.json`（README.md 明文的两层形态）。
  // 缺 `customers/` 目录是正常形态（当前仓就是空目录，只有 README）⇒ 不告警；
  // 目录在但读不到 ⇒ 告警并标记读不全（否则客户覆盖会**静默消失**）。
  const customersDir = join(roots.contractsRoot, 'customers')
  if (existsSync(customersDir)) {
    let customers: string[] = []
    try {
      customers = readdirSync(customersDir, { withFileTypes: true })
        .filter((d) => d.isDirectory()).map((d) => d.name).sort()
    } catch {
      warnings.push('契约目录不可读：customers')
      incomplete = true
    }
    for (const customer of customers) collect(`customers/${customer}`)
  }

  // 同 id 多份（common 与 customers/<客户>，或两个客户）：**只告警，不裁决**——
  // contracts/customers/README.md 明写优先级未定案，遇到并存要问 owner，不许猜顺序。
  const byId = new Map<string, ContractRef[]>()
  for (const c of contracts) byId.set(c.id, [...(byId.get(c.id) ?? []), c])
  // 重复 id 也是**机器信号**：`contractFor` 只取第一份 ⇒ `contractId`/`contract` 可能指错。
  // 光有散文 warning，调用方无从判断「这个 contract 字段可不可信」。
  const duplicateIds: string[] = []
  for (const [id, list] of [...byId.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (list.length > 1) {
      duplicateIds.push(id)
      warnings.push(`契约 id 重复：${id}（${list.map((c) => c.path).join('、')}）`
        + '——common 与 customers 的优先级未定案，不要猜，先问 owner')
    }
  }

  return { contracts, warnings, incomplete, duplicateIds }
}

/**
 * 管线 ↔ 契约匹配：契约 id（`<domain>.<table>`）是管线 id 的**最长前缀**者胜。
 * 例：`lemeng.retail_order_line.tick` → `lemeng.retail_order_line`；
 *     `lemeng.retail.tick.l1` → 无命中（`lemeng.retail` 不存在）⇒ null。
 * 这是**命名约定**（仓内既有事实），不是契约格式的一部分——匹配不上不算错。
 */
export function contractFor(pipelineId: string, contracts: readonly ContractRef[]): ContractRef | null {
  let best: ContractRef | null = null
  for (const c of contracts) {
    if (pipelineId === c.id || pipelineId.startsWith(`${c.id}.`)) {
      if (best === null || c.id.length > best.id.length) best = c
    }
  }
  return best
}
