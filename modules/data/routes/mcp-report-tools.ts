// mcp-report-tools.ts — 管理面 MCP 端点的**报表片**（报表制作工具面）。
// 占位空片：Task 3（#496 实施计划）填实三工具（list_reports / propose_report / revise_report_spec）。
import type { McpDeps, McpToolGroup } from './mcp-rpc'

export const reportTools: McpToolGroup = {
  async list(_deps: McpDeps) { return [] },
  async call(_deps: McpDeps, _name: string, _args: Record<string, unknown>) { return null },
}
