// tools.ts —— T1 提案面 8 个工具的**静态元数据**（spec 2026-10-21 §7）。
//
// ★ 本文件是**纯**的：不得 import pg / Hono / zod / warehouse。CI 门
//   （scripts/check-mcp-toolface.mjs）与路由片共用本清单——两处各写一份必漂。
//
// 落点是 POST /mcp-manage（scope data:manage），不是 /mcp：提案面天然属于管理面，
// 且分析师面的工具预算（≤14，现用 11）与 tools/list ≤10KB 预算**不动**。
import type { ToolAnnotations } from '../toolbox/registry'

export const PIPELINE_FACE_MAX_TOOLS = 8
export const MANAGE_SCOPE = 'data:manage'

export interface PipelineToolMeta {
  name: string
  group: 'pipeline'
  title: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  requiredScope: string | null
  mutating: boolean
  annotations: ToolAnnotations
}

const readOnly: ToolAnnotations = { readOnlyHint: true }
const writeable: ToolAnnotations = { readOnlyHint: false }
const anyObject = { type: 'object' }

export const PIPELINE_TOOLS: readonly PipelineToolMeta[] = [
  {
    name: 'list_pipelines', group: 'pipeline', title: '采集管线清单',
    description: '列出仓内已登记的采集管线（deploy/duckle/console/pipelines）与各自的调度条目。做采集提案前先调它，确认现有管线的 id 与粒度。',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '关键词（id/name 子串，大小写不敏感）' },
        source: { type: 'string', description: '调度来源（账套或源系统：3120 / 64188 / forms）' },
      },
      required: [],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_pipeline', group: 'pipeline', title: '采集管线详情',
    description: '按 id 取单条管线的完整定义（节点/边）、调度条目、关联的数据契约与静态校验结论。管线 JSON 的原始内容在 definition 字段里。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '管线 id（如 lemeng.retail.tick.l1；取自 list_pipelines）' } },
      required: ['id'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'list_pipeline_runs', group: 'pipeline', title: '管线运行记录清单',
    description: '列管线近期运行记录。数据源未接通时**显式返回 unknown**（未知 ≠ 没有失败）——不要把它当成「没跑过」。',
    inputSchema: {
      type: 'object',
      properties: {
        pipelineId: { type: 'string', description: '缺省 = 全部管线' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: '缺省 20' },
      },
      required: [],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'get_pipeline_run', group: 'pipeline', title: '管线运行详情',
    description: '按 runId 取单次运行记录。数据源未接通时**显式返回 unknown**。',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', minLength: 1 } },
      required: ['runId'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: false, annotations: readOnly,
  },
  {
    name: 'run_pipeline_sandbox', group: 'pipeline', title: '沙箱试跑（校验 + 执行）',
    description: '对一份管线草案先做三道校验——结构、组件策略（只允许 xf/src/snk/qa/ctl 族；code.* 与 ctl.foreach 一律拒）、沙箱写入面（湖写入的 key 必须以 __sandbox/ 开头、本地落盘必须在 /workspace/logs/sandbox/ 下、不得含 webhook 出口）；通过后在沙箱 console 里**真跑一次**（同步等待到跑完）。默认档不带任何生产凭据（源端只能是公开/无鉴权端点）。结果 status：ok / failed（管线跑了但失败，看 error）/ refused + reason=engine_parse_error（引擎不认这份草案，一个节点都没跑，看 error 原话）/ unknown + reason=sandbox_run_timeout（到了等待上限、**不知道**终态；引擎侧仍在跑，用 runId 继续追）/ unknown + reason=sandbox_unreachable（执行面不可达）/ not_executed（本部署没接执行面）。',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: { type: 'object', description: 'duckle 管线 JSON：{name,nodes,edges}' },
        note: { type: 'string', description: '可选：这次试跑想验证什么（入审计，便于复盘）' },
      },
      required: ['pipeline'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
  {
    name: 'propose_pipeline_change', group: 'pipeline', title: '提案：管线变更',
    description: '把一份管线草案连同（可选）契约草案，渲染成**三件套提案**：仓内相对路径 + 完整文件内容 + 还差哪些件 + 静态校验结论。只产出、不落盘、不开 PR——应用由人/后续流程决定。',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline: { type: 'object', description: 'duckle 管线 JSON' },
        contract: { type: 'object', description: '可选：配套数据契约 JSON（缺省时下游清单里会点名「契约未提供」）' },
        title: { type: 'string', description: '提案标题（≤120 字）' },
        rationale: { type: 'string', description: '为什么改（入审计与提案摘要）' },
      },
      required: ['pipeline', 'title', 'rationale'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
  {
    name: 'propose_contract_change', group: 'pipeline', title: '提案：契约变更',
    description: '把一份数据契约草案渲染成提案：仓内相对路径 + 完整文件内容 + 受影响的下游清单（管线/模型/语义）+ 静态校验结论。只产出、不落盘、不开 PR。',
    inputSchema: {
      type: 'object',
      properties: {
        contract: { type: 'object', description: '数据契约 JSON（contractVersion=2）' },
        title: { type: 'string', description: '提案标题（≤120 字）' },
        rationale: { type: 'string', description: '为什么改' },
      },
      required: ['contract', 'title', 'rationale'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
  {
    name: 'apply_pipeline_proposal', group: 'pipeline', title: '提案应用：落盘并开 draft PR',
    description: '把 propose_* 的回包原样回传，经 GitHub API 落到提案分支并开 **draft PR**（每文件一个 commit；body 带 downstream 清单与 validation 结论）。三道前置：目标文件与基线不同 ⇒ 拒绝并回当前内容摘要（不自动合并）；piece 路径必须在 contracts/ 或 deploy/duckle/console/pipelines/ 下且为 .json；内容重校验不过 ⇒ 拒绝。本服务未配 DATA_MCP_GITHUB_TOKEN 时回 not_executed（不生效）；写总闸关闭时整个工具不可用。',
    inputSchema: {
      type: 'object',
      properties: { proposal: { type: 'object', description: 'propose_pipeline_change / propose_contract_change 的完整回包（原样回传，不要改写）' } },
      required: ['proposal'],
    },
    outputSchema: anyObject, requiredScope: MANAGE_SCOPE, mutating: true, annotations: writeable,
  },
]

export function pipelineToolNames(): string[] {
  return PIPELINE_TOOLS.map((t) => t.name)
}

export function pipelineToolMeta(name: string): PipelineToolMeta | undefined {
  return PIPELINE_TOOLS.find((t) => t.name === name)
}
