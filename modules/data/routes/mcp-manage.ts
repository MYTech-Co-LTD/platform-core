// mcp-manage.ts — POST /mcp-manage：管理面 MCP 端点。**只做合成 + 注册**：
// 把各工具片（口径片 mcp-metric-tools / 报表片 mcp-report-tools）拼成一个 McpToolSet，
// 交给共享协议壳 mcp-rpc.ts。工具判定本身都在各片里，本文件不含业务逻辑。
import type { ModuleHono, RouteCtx } from './context'
import { registerMcpEndpoint } from './mcp-rpc'
import type { McpDeps, McpToolGroup, McpToolResult, McpToolSet } from './mcp-rpc'
import { metricTools } from './mcp-metric-tools'
import { reportTools } from './mcp-report-tools'

/** 管理面的工具片。加新片只改这一行（协议壳与门档都不动）。 */
const GROUPS: readonly McpToolGroup[] = [metricTools, reportTools]

const manageToolset: McpToolSet = {
  serverName: 'platform-data-mcp-manage',

  async list(deps: McpDeps) {
    return (await Promise.all(GROUPS.map((g) => g.list(deps)))).flat()
  },

  async call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    for (const g of GROUPS) {
      const out = await g.call(deps, name, args)
      if (out !== null) return out
    }
    // 没有任何片认领 ⇒ 工具级错误（与既有口径一致：工具级错误走 result + isError）
    return { text: JSON.stringify({ status: 'error', reason: 'unknown_tool', name }), isError: true }
  },
}

export function registerMcpManage(r: ModuleHono, ctx: RouteCtx): void {
  registerMcpEndpoint(r, '/mcp-manage', ctx, manageToolset)
}
