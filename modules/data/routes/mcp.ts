// mcp.ts — POST /mcp：通道 B（PAT）的**读面** MCP 端点（问数 + 分析师面）。协议壳见 mcp-rpc.ts。
//
// Wave 1（spec 2026-10-21）起本面 = **registry 驱动**的工具集，三组：
//   · legacy 过渡面：每指标一工具（sanitized 名；与 query_metric 并存，未决 #1 观察后下线）；
//   · 分析师面：toolbox 的 11 个固定工具（guide/catalog/discovery/query/health）；
//   · 下钻静态工具：query_detail（spec 2026-10-21 §2.4）——不随词表物化，恒在；工具的存在
//     不是存在性探针，该指标支不支持下钻是能力陈述，只出现在调用回包里。
// 写面（本租户口径的定义）在 `mcp-manage.ts`，走另一个端点与另一个
// scope——两份工具集共用一个协议壳。
// 授权仍不自建：词表裁剪只调 visibleMetrics、执行只调 runQuery / runDetailQuery / registry.callTool
// （保留键拒 / 未声明拒 / 未授权拒全部出自那条链——本文件不做第二份判定）。
import { loadMergedCatalog } from '../domain/metric-store'
import { deptContextIfOwned } from '../domain/metric-visibility'
import { runDetailQuery } from '../domain/drill'
import { runQuery } from '../domain/query-service'
import { analystPool, runWarehouseSql } from '../domain/warehouse'
import { callTool, legacyMetricTools, listAnalystTools } from '../domain/toolbox/registry'
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
 * 契约工具 → tools/list 条目（分析师面与静态工具共用一份 shape）。
 * **非 MCP 规范字段不外泄**（requiredScope/mutating/group 只经 `data_harness_catalog` 的
 * 声明面输出）——工具面与声明面分开，前者按协议、后者按治理。
 */
function toListEntry(t: ContractTool): ListEntry {
  const face = faceOf(t, 'mcp')
  return {
    name: face.name, title: t.title, description: face.description,
    inputSchema: face.inputSchema, outputSchema: face.outputSchema, annotations: t.annotations,
  }
}

/** 分析师面工具 → tools/list 条目。 */
function analystListEntries(): ListEntry[] {
  return contractView('mcp').filter((t) => t.analyst).map(toListEntry)
}

// 下钻工具（spec 2026-10-21 §2.4）：与 /query/detail 同一 runDetailQuery——授权核心同链。
// **静态**（不随指标物化）：tools/list 恒在——工具的存在不是存在性探针，该指标支不支持
// 下钻是**能力陈述**，只出现在调用回包里（denied/no_detail_binding，isError=true）。
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

const readToolset: McpToolSet = {
  serverName: 'platform-data-mcp',

  // 惰性 + fail-soft：读契约/渲染失败时 initialize 不能 500（initialize 失败会让客户端直接连不上）；
  // shared.md 缺失会在模块加载期 fail-fast（GUIDE_INVARIANTS 已 eager 加载）。
  // 只放指针 + 五条硬约束，完整工作流走 data_agent_guide（按需拉取）。
  get instructions(): string {
    try {
      return renderInstructions()
    } catch (e) {
      console.warn('[data] mcp initialize.instructions 渲染失败（回退到内置硬约束）:', e instanceof Error ? e.message : e)
      return ['平台数据 MCP：开始数据任务前先调用 data_agent_guide。', ...GUIDE_INVARIANTS].join('\n')
    }
  },

  async list(deps) {
    // M3 守卫拒掉的请求者：词表对其「看不见」——空 tools（两类工具都空），不是报错。
    // 守卫必须在加载词表**之前**（实测：放在后面 = 空身份先炸在加载词表上，500 而非空词表）。
    if (deps.requester === null) return []
    // 合并加载器（L1 ∪ 本 org）+ 源维度裁剪——与 /query、chat、GET /metrics 同一落点（T8 评审 C1）。
    const catalog = await loadMergedCatalog(deps.pool, deps.org)
    // 部门可见（P2 Task 4 接线）：tools/list 与 tools/call 用同一份 ctx（同一函数同一裁剪尺）。
    const deptCtx = await deptContextIfOwned(deps.pool, deps.requester.tenantId, deps.requester, catalog)
    return [
      ...legacyMetricTools(catalog, deps.requester, deps.adoptedSources, deptCtx).map((x) => x.tool),
      ...analystListEntries(),
      ...STATIC_MCP_TOOLS,
    ]
  },

  async call(deps, name, args): Promise<McpToolResult> {
    // ⓪ 静态下钻工具（query_detail）：与 /query/detail 同一 runDetailQuery——授权核心同链
    //    （词表裁剪/拒绝链/主体钉死/参数校验全在 drill.ts 复用 authz，本层不自建判定）。
    //    排在 legacy / 裸 id 回退**之前**：词表里 sanitize 后恰为 query_detail 的指标名
    //    不得冒名顶替静态工具。拒绝/出错也走 result + isError（MCP 工具级错误形态）。
    // 契约改了 query_detail 的名字，这里必须一起改；测试 render.test.ts 已钉住 mcp 视图。
    if (name === 'query_detail') {
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
    // ① 分析师面固定工具：registry.callTool 单点分发（mutating 闸 + 审计含拒绝/出错）。
    //    装配走 buildToolboxDeps（all.ts 唯一装配点，Wave 2 决策 D-M1）。
    if (listAnalystTools().some((t) => t.name === name)) {
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
    // ② legacy：sanitized 名反解回 metricId（与 list 同一 legacyMetricTools——无第二份映射）。
    //    `execute`/`wh` 透传：缺省会让 runQuery 去建真仓库连接；`adoptedSources` 同理必须透传
    //    （runQuery 的解析路径也裁源，与 tools/list 同一份事实）。
    if (deps.requester !== null) {
      const catalog = await loadMergedCatalog(deps.pool, deps.org)
      // 部门可见（P2 Task 4 接线）：与 list() 同一份 ctx——list 不列、call 也不解析（no-probe）。
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
    // ③ 兼容回退（Wave 1 前的存量调用方用的是**裸指标 id**——含冒号、非 2025-11-25 合法工具名）：
    //    sanitized 反解不中 ⇒ 把 name 当裸指标 id 走 runQuery（词表裁剪/主体钉死同链）。
    //    未声明指标 ⇒ denied/metric_not_declared——与升级前逐字节同形，零回归。
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
  },
}

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp', ctx, readToolset)
}
