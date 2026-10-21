// mcp.ts — POST /mcp：通道 B（PAT）的**读面** MCP 端点（问数 + 分析师面）。协议壳见 mcp-rpc.ts。
//
// Wave 1（spec 2026-10-21）起本面 = **registry 驱动**的两组工具：
//   · legacy 过渡面：每指标一工具（sanitized 名；与 query_metric 并存，未决 #1 观察后下线）；
//   · 分析师面：toolbox 的 11 个固定工具（guide/catalog/discovery/query/health）。
// 授权仍不自建：词表裁剪只调 visibleMetrics、执行只调 runQuery / registry.callTool
// （保留键拒 / 未授权拒全部出自那条链——本文件不做第二份判定）。
import { loadMergedCatalog } from '../domain/metric-store'
import { runQuery } from '../domain/query-service'
import { analystPool, runWarehouseSql } from '../domain/warehouse'
import { defaultDbtManifest } from '../domain/toolbox/health'
import { callTool, legacyMetricTools, listAnalystTools, mutatingAllowed } from '../domain/toolbox/registry'
import type { ToolboxDeps } from '../domain/toolbox/registry'
import '../domain/toolbox/all'
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpDeps, McpToolResult, McpToolSet } from './mcp-rpc'

/** 分析师面的仓库执行器：只读池（default_transaction_read_only=on）。测试经 McpDeps.wh 注入替身。 */
const readonlyWh = () => (sql: string) => runWarehouseSql(analystPool(), sql)

/**
 * 分析师面工具 → tools/list 条目。**非 MCP 规范字段不外泄**（requiredScope/mutating/group 只经
 * `data_harness_catalog` 的声明面输出）——工具面与声明面分开，前者按协议、后者按治理。
 */
function analystListEntries(): Record<string, unknown>[] {
  return listAnalystTools().map((t) => ({
    name: t.name, title: t.title, description: t.description,
    inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations,
  }))
}

const readToolset: McpToolSet = {
  serverName: 'platform-data-mcp',

  async list(deps) {
    // M3 守卫拒掉的请求者：词表对其「看不见」——空 tools（两类工具都空），不是报错。
    // 守卫必须在加载词表**之前**（实测：放在后面 = 空身份先炸在加载词表上，500 而非空词表）。
    if (deps.requester === null) return []
    // 合并加载器（L1 ∪ 本 org）+ 源维度裁剪——与 /query、chat、GET /metrics 同一落点（T8 评审 C1）。
    const catalog = await loadMergedCatalog(deps.pool, deps.org)
    return [
      ...legacyMetricTools(catalog, deps.requester, deps.adoptedSources).map((x) => x.tool),
      ...analystListEntries(),
    ]
  },

  async call(deps, name, args): Promise<McpToolResult> {
    // ① 分析师面固定工具：registry.callTool 单点分发（mutating 闸 + 审计含拒绝/出错）。
    if (listAnalystTools().some((t) => t.name === name)) {
      const toolbox: ToolboxDeps = {
        pool: deps.pool, org: deps.org, requester: deps.requester, adoptedSources: deps.adoptedSources,
        wh: deps.wh ?? readonlyWh(),
        dbtManifest: defaultDbtManifest(),
        allowMutating: mutatingAllowed(process.env),
      }
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
      const hit = legacyMetricTools(catalog, deps.requester, deps.adoptedSources).find((x) => x.tool.name === name)
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
