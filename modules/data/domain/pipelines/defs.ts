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
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const PIPELINE_ID_RE = /^[A-Za-z0-9_.-]+$/

export interface PipelineRoots { pipelinesRoot: string; contractsRoot: string }

/** env 缝（B9：两键必须在根 .env.example 声明）。缺省值对「仓根 cwd」与「镜像 /app」都正确。 */
export function rootsOf(
  env: Record<string, string | undefined> = process.env, cwd: string = process.cwd(),
): PipelineRoots {
  return {
    pipelinesRoot: env.DATA_PIPELINES_ROOT?.trim() || join(cwd, 'deploy/duckle/console'),
    contractsRoot: env.DATA_CONTRACTS_ROOT?.trim() || join(cwd, 'contracts'),
  }
}

export interface ScheduleEntry {
  source: string; pipelineId: string; enabled: boolean; cron: string | null; timezone: string | null
}

export interface PipelineDef {
  id: string
  name: string
  version: unknown
  doc: Record<string, unknown>
  counts: { source: number; transform: number; sink: number; control: number }
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
): { defs: Map<string, PipelineDef>; warnings: string[]; readable: boolean } {
  const defs = new Map<string, PipelineDef>()
  const warnings: string[] = []
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
    return { defs, warnings, readable: false }
  }
  for (const f of files) {
    const id = f.slice(0, -'.json'.length)
    if (!PIPELINE_ID_RE.test(id)) { warnings.push(`跳过非法管线名：${f}`); continue }
    const raw = readJson(join(dir, f))
    if (!isObj(raw)) { warnings.push(`跳过不可解析的管线：${f}`); continue }
    const nodes = Array.isArray(raw.nodes) ? raw.nodes.filter(isObj) : []
    const counts = { source: 0, transform: 0, sink: 0, control: 0 }
    const lakeKeys: string[] = []
    for (const n of nodes) {
      const t = str(n.type)
      if (t === 'source' || t === 'transform' || t === 'sink' || t === 'control') counts[t] += 1
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
  return { defs, warnings, readable: true }
}

export function loadSchedules(
  roots: PipelineRoots,
): { byPipeline: Map<string, ScheduleEntry[]>; warnings: string[] } {
  const byPipeline = new Map<string, ScheduleEntry[]>()
  const warnings: string[] = []
  let dir = ''
  let files: string[]
  try {
    // 同 loadPipelines：join 在 guard 内，非字符串 root 也不抛。
    dir = join(roots.pipelinesRoot, 'schedules')
    files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  } catch {
    warnings.push(`schedules 目录不可读：${roots.pipelinesRoot}`)
    return { byPipeline, warnings }
  }
  for (const f of files) {
    const source = f.slice(0, -'.json'.length)
    const raw = readJson(join(dir, f))
    // 调度文件是**数组**（每条带 pipeline_id），不是字典——见 deploy/duckle/console/README.md。
    if (!Array.isArray(raw)) { warnings.push(`跳过不可解析的调度：${f}`); continue }
    for (const e of raw) {
      if (!isObj(e)) continue
      const pid = str(e.pipeline_id)
      if (pid === '') { warnings.push(`调度条目缺 pipeline_id：${f}`); continue }
      const kind = isObj(e.kind) ? e.kind : {}
      const entry: ScheduleEntry = {
        source, pipelineId: pid, enabled: e.enabled === true,
        cron: str(kind.expr) || null, timezone: str(e.timezone) || null,
      }
      byPipeline.set(pid, [...(byPipeline.get(pid) ?? []), entry])
    }
  }
  return { byPipeline, warnings }
}

export function loadContracts(
  roots: PipelineRoots,
): { contracts: ContractRef[]; warnings: string[] } {
  const contracts: ContractRef[] = []
  const warnings: string[] = []
  let domains: string[]
  try {
    domains = readdirSync(roots.contractsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name).sort()
  } catch {
    warnings.push(`contracts 目录不可读：${roots.contractsRoot}`)
    return { contracts, warnings }
  }
  for (const domain of domains) {
    let files: string[]
    try { files = readdirSync(join(roots.contractsRoot, domain)).filter((f) => f.endsWith('.json')).sort()
    } catch { warnings.push(`契约目录不可读：${domain}`); continue }
    for (const f of files) {
      // `_` 前缀 = 基础设施（_schema/_template），跳过（contracts/README.md 明文）。
      if (f.startsWith('_')) continue
      const raw = readJson(join(roots.contractsRoot, domain, f))
      if (!isObj(raw)) { warnings.push(`跳过不可解析的契约：${domain}/${f}`); continue }
      const table = str(raw.table)
      const dom = str(raw.domain) || domain
      const cols = Array.isArray(raw.columns) ? raw.columns.length : 0
      contracts.push({
        id: table === '' ? f.slice(0, -'.json'.length) : `${dom}.${table}`,
        domain: dom, table, path: `contracts/${domain}/${f}`, columns: cols, doc: raw,
      })
    }
  }
  return { contracts, warnings }
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
