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
    description: '列出从真实用法挖出的「想要但词表没有」的需求（alias_gap 别名缺口 / new_metric 真缺指标 / drill_gap 下钻缺口 / metric_hunt 口径寻路），按出现次数降序。每条带 resolved 自动判定：词表已补齐的条目标 resolved=true（metric_hunt 永不自动消解，只能人工否决）。默认不含已否决条目。',
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
    description: '把一条需求标记为「不建」（写 dismissed_at/by/reason），此后默认不再出现在清单里。重复否决幂等（回原否决信息）。受写总闸 DATA_MCP_ALLOW_MUTATING 门控。',
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
