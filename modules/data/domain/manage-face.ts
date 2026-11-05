// manage-face.ts —— manage 面（/mcp-manage）的工具总清单与预算。
import type { ToolAnnotations } from './toolbox/registry'
import { PIPELINE_TOOLS } from './pipelines/tools'
import { DEMAND_TOOLS } from './demand/tools'

export interface ManageToolMeta {
  name: string; group: string; title: string; description: string
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>
  requiredScope: string | null; mutating: boolean; annotations: ToolAnnotations
}

/** 9（提案面）+ 2（需求台账）= 11。超了 tools/list 的 10KB 预算会先炸门禁。 */
export const MANAGE_FACE_MAX_TOOLS = 11

export const MANAGE_TOOLS: readonly ManageToolMeta[] = [...PIPELINE_TOOLS, ...DEMAND_TOOLS]

export function manageToolMeta(name: string): ManageToolMeta | undefined {
  return MANAGE_TOOLS.find((t) => t.name === name)
}
