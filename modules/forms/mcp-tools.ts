// mcp-tools.ts — forms MCP 工具元数据（**纯**：无 Hono/pg 运行时依赖）。
// 供 scripts/check-mcp-toolface.mjs 静态检查；实现见 mcp.ts。
//
// 2026-11-16 能力网关 spec §6.5：forms 只有两个工具——
// - `list_forms`：读面（`/mcp`，forms:view），摘要可见性，**不回 draft body**；
// - `generate_form_draft`：管理面（`/mcp-manage`，forms:manage），只落 draft。
// **永远没有** publish / rollback / retire 工具：发布是人的唯一 gate（forms:publish，HTTP-only）。

// 加工具必须同 PR 显式抬（门禁 check-mcp-toolface 按此上限判）。
export const FORMS_MAX_TOOLS = 2

export type FormsToolMeta = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  mutating: boolean
  annotations: { readOnlyHint: boolean }
  requiredScope: string | null
  /** 该工具所属 face 的最低权限（网关投影用：read=forms:view；manage=forms:manage）。 */
  faceScope: 'forms:view' | 'forms:manage'
}

export const FORMS_TOOLS: FormsToolMeta[] = [
  {
    name: 'list_forms',
    description: '列出本租户可查看的表单（摘要，不含 draft body）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    mutating: false,
    annotations: { readOnlyHint: true },
    requiredScope: null,
    faceScope: 'forms:view',
  },
  {
    name: 'generate_form_draft',
    description: '用自然语言生成表单契约并落为草稿；不会发布，需持 forms:publish 的人在控制台发布。',
    inputSchema: {
      type: 'object',
      properties: { description: { type: 'string' } },
      required: ['description'],
      additionalProperties: false,
    },
    mutating: true,
    annotations: { readOnlyHint: false },
    requiredScope: 'forms:manage',
    faceScope: 'forms:manage',
  },
]
