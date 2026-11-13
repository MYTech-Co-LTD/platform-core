// tools.ts —— 需求台账工具的**静态元数据**（纯：不 import pg / Hono / zod）。
// 与提案面工具（pipelines/tools.ts）分开：这里是治理读面，不是管线提案。
import type { ToolAnnotations } from '../toolbox/registry'

export interface DemandToolMeta {
  name: string; group: 'demand'; title: string; description: string
  inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>
  requiredScope: string | null; mutating: boolean; annotations: ToolAnnotations
}

const MANAGE_SCOPE = 'data:manage'
const anyObject = { type: 'object' }

export const DEMAND_TOOLS: readonly DemandToolMeta[] = [
  {
    name: 'list_demand_signals', group: 'demand', title: '需求台账清单',
    description: '列出从真实用法挖出的需求（alias_gap / new_metric / drill_gap / metric_hunt），按出现次数降序；带 resolved 自动判定（metric_hunt 只能人工否决）。默认不含已否决。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['alias_gap', 'new_metric', 'drill_gap', 'metric_hunt'] },
        includeResolved: { type: 'boolean', description: '缺省 false：不返回已自动消解的条目' },
        includeDismissed: { type: 'boolean', description: '缺省 false：不返回已否决的条目' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '缺省 20' },
      },
      required: [],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: { readOnlyHint: true },
  },
  {
    name: 'dismiss_demand_signal', group: 'demand', title: '否决一条需求',
    description: '把需求标记为「不建」（幂等）。受写总闸 DATA_MCP_ALLOW_MUTATING 门控。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'integer', minimum: 1 },
        reason: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['id', 'reason'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: { readOnlyHint: false },
  },
]
