// mcp.ts — POST /mcp：通道 B（PAT）的**读面** MCP 端点（问数）。协议壳见 mcp-rpc.ts。
//
// 本文件只剩「读面工具集」：每个指标一个查询工具（工具名 = 指标 id）。写面（本租户口径的定义）
// 在 `mcp-manage.ts`，走另一个端点与另一个 scope——两份工具集共用一个协议壳。
//
// 授权不自建：词表裁剪只调 visibleMetrics、执行只调 runQuery（保留键拒 / 未声明拒 /
// 未授权拒全部出自那条链——本文件不做第二份判定）。
import type { MetricDef } from '../domain/authz'
import { visibleMetrics } from '../domain/authz'
import { loadMergedCatalog } from '../domain/metric-store'
import { runQuery } from '../domain/query-service'
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpToolSet } from './mcp-rpc'

/**
 * 指标 → MCP tool。inputSchema 的 properties 只含声明的业务参数——
 * 主体（org 等）不属于客户端可指定面，出现在 arguments 里会被 runQuery 按保留键拒。
 */
function toTool(m: MetricDef) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(m.params)) {
    // JSON Schema 没有 date 类型：date 参数声明为 string（运行时校验在授权核心的 DATE_RE）
    properties[name] = { type: p.type === 'date' ? 'string' : p.type, description: '' }
    if (p.required) required.push(name)
  }
  return { name: m.id, description: m.description || m.title, inputSchema: { type: 'object', properties, required } }
}

const readToolset: McpToolSet = {
  serverName: 'platform-data-mcp',

  async list(deps) {
    // M3 守卫拒掉的请求者（requesterOf → null）：词表对其「看不见」——空 tools，不是报错。
    // 守卫必须在加载词表**之前**（实测：放在后面 = 空身份先炸在加载词表上，500 而非空词表）。
    if (deps.requester === null) return []
    // 合并加载器（L1 ∪ 本 org）——与 /query、chat、GET /metrics 同一落点，
    // 否则平台指标不出现在 agent 的工具面里（T8 评审 C1）。
    // 裁剪带源维度（计划 5 §3⑧）：未接入源的指标不出现在工具面 ⇒ agent 连它存不存在都看不到。
    return visibleMetrics(
      await loadMergedCatalog(deps.pool, deps.org), deps.requester, deps.adoptedSources,
    ).map(toTool)
  },

  async call(deps, name, args) {
    // `execute` 必须透传：缺省会让 runQuery 去建真仓库连接，测试里就变成「断言被网络错误顶掉」。
    // `adoptedSources` 同理必须透传：runQuery 的解析路径也裁源（与 tools/list 同一份事实）。
    const out = await runQuery(
      { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
      deps.org, deps.requester, name, args,
    )
    // 拒绝/出错也走 result + isError（MCP 的工具级错误形态），JSON-RPC error 只留给协议层
    return { text: JSON.stringify(out), isError: out.status !== 'ok' }
  },
}

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp', ctx, readToolset)
}
