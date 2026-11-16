// mcp.ts — 数据模块的 **MCP 面**（通道 B 的 JSON-RPC 端点；协议壳见 mcp-rpc.ts）。
//
// agent 能力网关（spec 2026-11-16 §5.2/§6）把工具面拆成三个 face：
//   · `/mcp`（full）：**保留给直连客户端**——legacy 每指标工具 + 分析师面 + 静态工具（不变）；
//   · `/mcp-read`（read，data:read）：只读工具（faceScope=data:read 的契约工具）；
//   · `/mcp-curated`（curated，data:query）：13 个分析师工具 + query_detail，**不含 legacy**。
// face 最低权限由宿主按 manifest `api.internal` 门卫施加；本文件只决定「该面有哪些工具」，
// 工具级附加 scope 由 registry.callTool 单点执法（本文件不做第二份判定）。
//
// Wave 1（spec 2026-10-21）起的既有语义不变：
//   · 分析师面 = registry 驱动的固定工具；legacy 过渡面 = 每指标一工具（仅 full）；
//   · 下钻静态工具 query_detail（spec 2026-10-21 §2.4）不随词表物化，恒在；
//   · 授权仍不自建：词表裁剪只调 visibleMetrics、执行只调 runQuery / runDetailQuery / registry.callTool。
import { loadMergedCatalog } from '../domain/metric-store'
import { deptContextIfOwned } from '../domain/metric-visibility'
import { runDetailQuery } from '../domain/drill'
import { runQuery } from '../domain/query-service'
import { analystPool, runWarehouseSql } from '../domain/warehouse'
import {
  callTool, legacyMetricTools, listAnalystTools, visibleAnalystTools,
} from '../domain/toolbox/registry'
import { buildToolboxDeps } from '../domain/toolbox/all'
import '../domain/toolbox/all'
import { contractView, renderInstructions } from '../skill/render'
import { GUIDE_INVARIANTS } from '../domain/toolbox/guide'
import { faceOf, type ContractTool } from '../skill/contract'
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpDeps, McpToolResult, McpToolSet } from './mcp-rpc'

/** 分析师面的仓库执行器：只读池（default_transaction_read_only=on）。测试经 McpDeps.wh 注入替身。 */
const readonlyWh = () => (sql: string) => runWarehouseSql(analystPool(), sql)

/** 端点 face：full = 直连全量；curated = 13 分析师工具 + query_detail；read = 只读工具。 */
export type McpFace = 'full' | 'curated' | 'read'

/** MCP tools/list 条目（协议字段）。outputSchema 缺省即省略（契约没声明就不合成）。 */
interface ListEntry {
  name: string
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  annotations: { readOnlyHint: boolean }
}

/**
 * 契约工具 → tools/list 条目。**非 MCP 规范字段不外泄**
 * （requiredScope / faceScope / mutating / group 只经 `data_harness_catalog` 的声明面输出）——
 * 工具面与声明面分开，前者按协议、后者按治理。
 */
function toListEntry(t: ContractTool): ListEntry {
  const face = faceOf(t, 'mcp')
  return {
    name: face.name, title: t.title, description: face.description,
    inputSchema: face.inputSchema, outputSchema: face.outputSchema, annotations: t.annotations,
  }
}

/**
 * 该 face 的契约工具集合（**faceScope 过滤只在这里**，不外泄到 list 条目）：
 *   · full：全部（含 legacy 另加）；
 *   · curated：13 个分析师工具 + static（query_detail，faceScope=data:query）；
 *   · read：ANALYST_TOOLS 中 faceScope=data:read 的读工具——**只含分析师面**，
 *     因为 callRead 统一走 callAnalyst→callTool（静态工具不在这条链上；未来若有
 *     static read 工具，须在此处与 call 路由同时加分支）。
 */
function contractToolsForFace(face: McpFace): ContractTool[] {
  const all = contractView('mcp')
  if (face === 'full') return all
  if (face === 'read') return all.filter((t) => t.analyst && t.faceScope === 'data:read')
  // curated：analyst 全收（读 + 查），static 只收 query 面（query_detail）。
  return all.filter((t) => t.analyst || t.faceScope === 'data:query')
}

/**
 * face 的 tools/list 条目。按 `visibleAnalystTools` 裁掉附加 scope 不满足的分析师工具
 * （spec §6.2：tools/list 只返回调用方满足 requiredScope 的工具）。
 * 空身份（M3 守卫拒掉）⇒ 空面，不是报错。
 */
function listEntriesForFace(face: McpFace, deps: McpDeps): ListEntry[] {
  if (deps.requester === null) return []
  const visible = new Set(visibleAnalystTools(deps.requester).map((t) => t.name))
  return contractToolsForFace(face)
    .filter((t) => !t.analyst || visible.has(faceOf(t, 'mcp').name))
    .map(toListEntry)
}

/** 静态附加工具（analyst=false 且声明了 mcp 通道）——query_detail 在这里。 */
const STATIC_MCP_TOOLS = contractView('mcp').filter((t) => !t.analyst).map(toListEntry)

/**
 * 装载期守卫：每个静态工具都必须有 call 分支。否则 tools/list 里看得见、call 却会落到
 * legacy / 裸 id 回退——静默错分，比少一个工具更难发现。
 */
const STATIC_TOOL_HANDLERS = new Set(['query_detail'])
for (const t of STATIC_MCP_TOOLS) {
  if (!STATIC_TOOL_HANDLERS.has(t.name)) {
    throw new Error(`/mcp: 静态工具 ${t.name} 没有 call 分支（tools/list 有、call 会落到 legacy）`)
  }
}

/** 静态工具名是否属于该 face（faceScope 与 read/curated 对齐）。 */
function staticToolInFace(name: string, face: McpFace): boolean {
  const tool = contractView('mcp').find((t) => !t.analyst && faceOf(t, 'mcp').name === name)
  if (tool === undefined) return false
  if (face === 'full') return true
  return face === 'read' ? tool.faceScope === 'data:read' : tool.faceScope === 'data:query'
}

/** 未知工具的统一回包（MCP 工具级错误形态；不落到其它 face/legacy 分支）。 */
function unknownTool(name: string): McpToolResult {
  return { text: JSON.stringify({ status: 'denied', reason: 'unknown_tool', name }), isError: true }
}

/** query_detail：与 /query/detail 同一 runDetailQuery——授权核心同链。 */
async function callDetail(deps: McpDeps, args: Record<string, unknown>): Promise<McpToolResult> {
  const out = await runDetailQuery(
    { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
    deps.org, deps.requester,
    typeof args.metricId === 'string' ? args.metricId : '',
    typeof args.args === 'object' && args.args !== null && !Array.isArray(args.args) ? args.args as Record<string, unknown> : {},
    {
      dimensions: Array.isArray(args.dimensions) ? args.dimensions as string[] : undefined,
      orderBy: typeof args.orderBy === 'string' ? args.orderBy : undefined,
      desc: typeof args.desc === 'boolean' ? args.desc : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
      offset: typeof args.offset === 'number' ? args.offset : undefined,
    })
  return { text: JSON.stringify(out), isError: out.status !== 'ok' }
}

/** 分析师面固定工具：registry.callTool 单点分发（mutating 闸 + 工具级 scope + 审计）。 */
async function callAnalyst(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const toolbox = buildToolboxDeps(
    { pool: deps.pool, org: deps.org, requester: deps.requester, adoptedSources: deps.adoptedSources },
    { wh: deps.wh },
  )
  const out = await callTool(toolbox, name, args)
  return {
    text: JSON.stringify(out.payload), isError: out.isError,
    ...(out.isError ? {} : { structured: out.payload }),
  }
}

/** full face 的 call：现有逻辑逐字保留（静态下钻 → 分析师面 → legacy → 裸 id 回退）。 */
async function callFull(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  // ⓪ 静态下钻工具（query_detail）：排在 legacy / 裸 id 回退**之前**——词表里 sanitize 后
  //    恰为 query_detail 的指标名不得冒名顶替静态工具。
  if (name === 'query_detail') return callDetail(deps, args)
  // ① 分析师面固定工具。
  if (listAnalystTools().some((t) => t.name === name)) return callAnalyst(deps, name, args)
  // ② legacy：sanitized 名反解回 metricId（与 list 同一 legacyMetricTools——无第二份映射）。
  if (deps.requester !== null) {
    const catalog = await loadMergedCatalog(deps.pool, deps.org)
    const deptCtx = await deptContextIfOwned(deps.pool, deps.requester.tenantId, deps.requester, catalog)
    const hit = legacyMetricTools(catalog, deps.requester, deps.adoptedSources, deptCtx).find((x) => x.tool.name === name)
    if (hit !== undefined) {
      const out = await runQuery(
        {
          pool: deps.pool, execute: deps.execute, warehouseExec: deps.wh ?? readonlyWh(),
          adoptedSources: deps.adoptedSources, tool: name,
        },
        deps.org, deps.requester, hit.metricId, args,
      )
      return {
        text: JSON.stringify(out), isError: out.status !== 'ok',
        ...(out.status === 'ok' ? { structured: out as unknown as Record<string, unknown> } : {}),
      }
    }
  }
  // ③ 兼容回退（Wave 1 前的存量调用方用的是**裸指标 id**）：sanitized 反解不中 ⇒ 当裸 id 走
  //    runQuery（词表裁剪/主体钉死同链）。未声明指标 ⇒ denied/metric_not_declared。
  if (deps.requester !== null) {
    const out = await runQuery(
      {
        pool: deps.pool, execute: deps.execute, warehouseExec: deps.wh ?? readonlyWh(),
        adoptedSources: deps.adoptedSources, tool: name,
      },
      deps.org, deps.requester, name, args,
    )
    return {
      text: JSON.stringify(out), isError: out.status !== 'ok',
      ...(out.status === 'ok' ? { structured: out as unknown as Record<string, unknown> } : {}),
    }
  }
  return { text: JSON.stringify({ status: 'denied', reason: 'unauthenticated', name }), isError: true }
}

/** curated face 的 call：只允许分析师工具 + query_detail；**不回退 legacy/裸 id**。 */
async function callCurated(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (name === 'query_detail' && staticToolInFace(name, 'curated')) return callDetail(deps, args)
  if (listAnalystTools().some((t) => t.name === name)) return callAnalyst(deps, name, args)
  return unknownTool(name)
}

/** read face 的 call：只允许该面的只读工具；未知（含查询工具）⇒ unknown_tool。 */
async function callRead(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  const allowed = new Set(contractToolsForFace('read').map((t) => faceOf(t, 'mcp').name))
  if (!allowed.has(name)) return unknownTool(name)
  return callAnalyst(deps, name, args)
}

/** 三个 face 共用的协议壳（instructions / 分发结构只有这一份）。 */
function makeToolset(face: McpFace): McpToolSet {
  return {
    serverName: face === 'full' ? 'platform-data-mcp' : `platform-data-mcp-${face}`,

    // 惰性 + fail-soft：读契约/渲染失败时 initialize 不能 500（initialize 失败会让客户端直接连不上）；
    // shared.md 缺失会在模块加载期 fail-fast（GUIDE_INVARIANTS 已 eager 加载）。
    get instructions(): string {
      try {
        return renderInstructions()
      } catch (e) {
        console.warn('[data] mcp initialize.instructions 渲染失败（回退到内置硬约束）:', e instanceof Error ? e.message : e)
        return ['平台数据 MCP：开始数据任务前先调用 data_agent_guide。', ...GUIDE_INVARIANTS].join('\n')
      }
    },

    async list(deps) {
      // full 保留 legacy（含词表裁剪 + 部门可见），read/curated 不碰 legacy。
      if (face !== 'full') return listEntriesForFace(face, deps)
      // M3 守卫拒掉的请求者：词表对其「看不见」——空 tools，不是报错。
      if (deps.requester === null) return []
      const catalog = await loadMergedCatalog(deps.pool, deps.org)
      const deptCtx = await deptContextIfOwned(deps.pool, deps.requester.tenantId, deps.requester, catalog)
      return [
        ...legacyMetricTools(catalog, deps.requester, deps.adoptedSources, deptCtx).map((x) => x.tool),
        ...listEntriesForFace('full', deps),
      ]
    },

    async call(deps, name, args) {
      if (face === 'full') return callFull(deps, name, args)
      if (face === 'curated') return callCurated(deps, name, args)
      return callRead(deps, name, args)
    },
  }
}

export const fullToolset: McpToolSet = makeToolset('full')
export const readOnlyToolset: McpToolSet = makeToolset('read')
export const curatedToolset: McpToolSet = makeToolset('curated')

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp', ctx, fullToolset)
}

export function registerMcpRead(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp-read', ctx, readOnlyToolset)
}

export function registerMcpCurated(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp-curated', ctx, curatedToolset)
}
