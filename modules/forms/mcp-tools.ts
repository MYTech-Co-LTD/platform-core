// mcp-tools.ts — forms MCP 工具元数据（**纯**：无 Hono/pg 运行时依赖）。
// 供 scripts/check-mcp-toolface.mjs 静态检查；实现见 mcp.ts。
//
// 2026-11-16 能力网关 spec §6.5：forms 只有三个工具——
// - `list_forms`：读面（`/mcp`，forms:view），摘要可见性，**不回 draft body**；
// - `search_standard_approvals`：读面（`/mcp`，forms:view），只回已发布企微绑定的
//   {name, deepLink, description}——**不渲染/不预填标准表单字段**（字段在企微，平台不持有）；
// - `generate_form_draft`：管理面（`/mcp-manage`，forms:manage），只落 draft。
// **永远没有** publish / rollback / retire 工具：发布是人的唯一 gate（forms:publish，HTTP-only）。

// 加工具必须同 PR 显式抬（门禁 check-mcp-toolface 按此上限判）。
export const FORMS_MAX_TOOLS = 3

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
    name: 'search_standard_approvals',
    description:
      '搜索本租户已发布的标准审批（企微原生）模板：按名称 / processCode 关键词匹配，' +
      '返回 {name, deepLink, description}。用户选中后把 deepLink 原样给他，让他在企业微信「审批」里提交——' +
      '平台只镜像状态与审批人，**不渲染也不预填任何标准表单字段**（那些字段在企微，平台不持有）。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '名称或 processCode 关键词（空 = 列出前 20 个）' },
      },
      additionalProperties: false,
    },
    mutating: false,
    annotations: { readOnlyHint: true },
    requiredScope: null,
    faceScope: 'forms:view',
  },
  {
    name: 'generate_form_draft',
    description:
      '用自然语言描述业务场景，生成表单契约并落为**草稿**（draft）。' +
      '生成结果不会自动发布——发布必须由持发布权限的人在控制台确认。' +
      '若 assetId 与既有表单重名会报错，请先用 list_forms 查重或换个名字。',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: '业务场景描述（要采集什么、有哪些字段与规则）' },
      },
      required: ['description'],
      additionalProperties: false,
    },
    mutating: true,
    annotations: { readOnlyHint: false },
    requiredScope: 'forms:manage',
    faceScope: 'forms:manage',
  },
]
