// mcp.ts — forms 的 MCP 面（#724 → 2026-11-16 能力网关 Task 8）。
//
// 两个 face（spec §5.2/§6.5），共用同一协议壳：
// - `POST /mcp`（read，`forms:view`）：`list_forms`（摘要，不回 draft body）+
//   `search_standard_approvals`（OA P2 Task 7：只回已发布企微绑定的 name/deepLink/description，
//   不渲染/不预填标准表单字段）；
// - `POST /mcp-manage`（manage，`forms:manage`）：以上两个 + `generate_form_draft`。
//
// 为什么分成两个端点而不是把工具塞进一个面：**让声明面仍然反映「写所需的能力」**——
// 读面只要 forms:view，写/起草面额外要 forms:manage（照 modules/data 的 /mcp-manage 先例，
// 见 docs/superpowers/specs/2026-10-07-mcp-write-face-design.md）。
//
// ⚠️ **AI 永不发布**：两个面都**不暴露**任何 publish/rollback/retire 工具（§14.1 发布是人的
// 唯一 gate）。agent 能做的只有「起草」与「读」——发布仍在 console/HTTP 面由持 forms:publish 的人做。
//
// 壳的形状照 modules/data/routes/mcp-rpc.ts / modules/notify/mcp.ts（§12.13：不跨模块 import，
// 抄形状不抄代码）。协议语义与那边逐条一致：只用 initialize/ping/tools/list/tools/call + 通知；
// stateless（不强制握手顺序，但 initialize 必答——回 -32601 会让真实 MCP 客户端连不上）；
// 通知（无 id）回 202 空体；协议错误走 JSON-RPC 错误信封（HTTP 200），不是 500。
//
// 授权分两层（spec §6.1/§6.2）：
// 1. face 门：宿主按 manifest `api.internal` 施加（模块不写 requireScope）；
// 2. 工具级 scope：`requiredScope` 在 `callTool` 里按 `deps.hasScope` 再判一次——直连也绕不过。
// 每次 tools/call 落 `forms.mcp_audit` 一行；**审计失败不改变业务结果**（吞掉 + console.warn）。
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { generateDraft } from './domain/generator'
import { LlmError } from './domain/llm'
import type { ChatModel } from './domain/llm'
import { FORMS_TOOLS } from './mcp-tools'
import type { FormsToolMeta } from './mcp-tools'
import * as store from './storage'

export const PROTOCOL_VERSION = '2025-06-18'

/** MCP face：read = `/mcp`（forms:view）；manage = `/mcp-manage`（forms:manage）。 */
export type McpFace = 'read' | 'manage'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type McpDeps = {
  pool: Pool
  org: string
  userId: string
  chatModel: ChatModel | null
  /** 调用者能力判定（identity.hasScope）——工具级 scope 执法的唯一依据。 */
  hasScope: (code: string) => boolean
}
type McpToolResult = { text: string; isError: boolean }
// annotations.readOnlyHint 是 tools/list 的协议字段（MCP 工具注解），也是能力网关
// 紧凑索引判定 mutating 的**唯一来源**（2026-11-16 能力网关 spec §7.5/§8）：
// forms 的 tools/list 若不投影它，网关只能猜，草稿工具的提示就会失真。
type ToolDef = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  annotations: { readOnlyHint: boolean }
}

const err = (reason: string, extra: Record<string, unknown> = {}): McpToolResult => ({
  text: JSON.stringify({ status: 'error', reason, ...extra }),
  isError: true,
})
const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false })

/** 该 face 能看见哪些工具：read 只看 forms:view 档且**非 mutating** 的工具；manage 全见
 *  （spec §6.1：face 门是最低权限；§5.2：读面绝不暴露写工具，即使将来有读档写工具也挡住）。 */
const faceVisible: Record<McpFace, (t: FormsToolMeta) => boolean> = {
  read: (t) => t.faceScope === 'forms:view' && !t.mutating,
  manage: () => true,
}

/** 本 face 暴露的工具集（加工具只改 mcp-tools.ts 的清单 + runTool 的分支）。 */
export function toolDefs(face: McpFace): ToolDef[] {
  return FORMS_TOOLS.filter(faceVisible[face]).map(({ name, description, inputSchema, mutating }) => ({
    name,
    description,
    inputSchema,
    annotations: { readOnlyHint: !mutating },
  }))
}

const MAX_DESCRIPTION_LEN = 2000
/** 选模板的搜索词上限（有界写入纪律的读侧对应：不让一次调用带进来一条巨型模式串）。 */
const MAX_SEARCH_QUERY_LEN = 100
/** 工具面一次最多回多少条绑定（agent 选模板只需候选，不需要全量目录）。 */
const SEARCH_BINDINGS_LIMIT = 20

/** 工具执行结果 + 审计要记的资产定位（成功或「重名」等已知资产时带）。 */
interface ToolRun {
  result: McpToolResult
  assetId?: string
  version?: number
}

/** 已知的「拒绝」原因（写审计时归 outcome=denied；其余 err 归 error）。 */
const DENIED_REASONS = new Set(['unknown_tool', 'missing_scope', 'read_only_tool_not_allowed'])

function reasonOf(r: McpToolResult): string | null {
  if (!r.isError) return null
  try {
    const v = JSON.parse(r.text) as { reason?: unknown }
    return typeof v.reason === 'string' ? v.reason : null
  } catch {
    return null
  }
}

/** 审计失败绝不影响业务结果：吞掉 + 告警（spec §6.5）。args 摘要随行落库（同 data.query_audit 口径）。 */
async function auditSafe(
  deps: McpDeps,
  tool: string,
  args: Record<string, unknown>,
  outcome: store.McpAuditOutcome,
  reason: string | null,
  assetId?: string,
  version?: number,
): Promise<void> {
  try {
    await store.writeMcpAudit(deps.pool, deps.org, deps.userId, tool, outcome, reason, args, assetId, version)
  } catch (e) {
    console.warn('[forms] mcp audit write failed (business result unaffected):', (e as Error).message)
  }
}

/** 工具级结果 → 审计 outcome：成功 ok；授权/投影拒绝 denied；业务/上游失败 error。 */
function auditOutcomeOf(result: McpToolResult, reason: string | null): store.McpAuditOutcome {
  if (!result.isError) return 'ok'
  return reason !== null && DENIED_REASONS.has(reason) ? 'denied' : 'error'
}

async function runTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolRun> {
  if (name === 'list_forms') {
    return { result: ok({ forms: await store.listDefs(deps.pool, deps.org) }) }
  }
  if (name === 'search_standard_approvals') {
    const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
    if (query.length > MAX_SEARCH_QUERY_LEN) {
      return { result: err('query_too_long', { limit: MAX_SEARCH_QUERY_LEN }) }
    }
    const rows = await store.searchPublishedWecomBindings(deps.pool, deps.org, query, SEARCH_BINDINGS_LIMIT)
    // 三个字段是**全部**输出：标准表单字段不在这里（平台不持有），也就无从渲染或预填。
    return {
      result: ok({
        approvals: rows.map((r) => ({
          name: r.name,
          deepLink: r.deepLink,
          description: `企微原生审批模板 ${r.processCode}：在企业微信「审批」中提交；平台只镜像状态与审批人，不代填表单字段。`,
        })),
      }),
    }
  }
  if (name === 'generate_form_draft') {
    if (deps.chatModel === null) {
      return { result: err('llm_not_configured', { hint: '需配置 FORMS_LLM_* 或 DATA_LLM_*' }) }
    }
    const description = typeof args['description'] === 'string' ? args['description'].trim() : ''
    if (description.length === 0) return { result: err('description_required') }
    if (description.length > MAX_DESCRIPTION_LEN) {
      return { result: err('description_too_long', { limit: MAX_DESCRIPTION_LEN }) }
    }
    let result: Awaited<ReturnType<typeof generateDraft>>
    try {
      result = await generateDraft({ model: deps.chatModel, description })
    } catch (e) {
      if (e instanceof LlmError) return { result: err('llm_upstream_failed', { detail: e.message }) }
      throw e
    }
    if (!result.ok) return { result: err('contract_rejected', { code: result.code, detail: result.detail }) }
    if (await store.assetExists(deps.pool, deps.org, result.assetId)) {
      return {
        result: err('asset_id_taken', { assetId: result.assetId, hint: '换个名字重试，或用 list_forms 查看已有表单' }),
        assetId: result.assetId,
      }
    }
    const version = await store.newDraft(deps.pool, deps.org, result.assetId, result.body, deps.userId)
    return {
      result: ok({
        assetId: result.assetId,
        version,
        status: 'draft',
        repairUsed: result.repairUsed,
        body: result.body,
        next: '草稿已落地，需由持发布权限的人在控制台发布后才可填报',
      }),
      assetId: result.assetId,
      version,
    }
  }
  return { result: err('unknown_tool', { name }) }
}

export async function callTool(
  deps: McpDeps,
  face: McpFace,
  name: string,
  args: Record<string, unknown>,
): Promise<McpToolResult> {
  let run: ToolRun
  try {
    const meta = FORMS_TOOLS.find((t) => t.name === name)
    if (meta === undefined) {
      run = { result: err('unknown_tool', { name }) }
    } else if (!faceVisible[face](meta)) {
      // 读面不接受写工具（spec §5.2）——工具级错误，与 MCP 的 isError 形态一致。
      run = { result: err('read_only_tool_not_allowed', { tool: name }) }
    } else if (meta.requiredScope !== null && !deps.hasScope(meta.requiredScope)) {
      // 工具级 scope 执法（spec §6.2）：tools/list 已投影，直连调用也必须拦。
      run = { result: err('missing_scope', { scope: meta.requiredScope }) }
    } else {
      run = await runTool(deps, name, args)
    }
  } catch (e) {
    // 执行期抛错（DB 断链 / LLM 非 LlmError 等）：**也要留痕**，且不让协议层变成 500。
    // 返回工具级错误（MCP isError 形态）；审计失败仍被 auditSafe 吞掉，不影响本返回。
    const detail = e instanceof Error ? e.message : String(e)
    await auditSafe(deps, name, args, 'error', 'tool_exception')
    return err('tool_exception', { detail })
  }
  const reason = reasonOf(run.result)
  await auditSafe(deps, name, args, auditOutcomeOf(run.result, reason), reason, run.assetId, run.version)
  return run.result
}

/**
 * 把某个 MCP face 挂到 `path`（挂到模块既有 router 上，与 data/notify 的做法一致）。
 * 协议壳只组装一次；read/manage 的差别只在 face 与 serverInfo 名。
 */
function registerFormsMcp(
  r: Hono<{ Variables: { identity: Identity } }>,
  path: string,
  face: McpFace,
  deps: { pool: Pool; chatModel: ChatModel | null },
): void {
  r.post(path, async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | null
    if (msg === null) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200)
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }
    if (msg.id === undefined) return c.body(null, 202) // 通知：不回

    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    const identity = c.get('identity') as Identity
    const mcpDeps: McpDeps = {
      pool: deps.pool,
      org: identity.orgId,
      userId: identity.userId,
      chatModel: deps.chatModel,
      hasScope: (code) => identity.hasScope(code),
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: `platform-forms-mcp-${face}`, version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: toolDefs(face) })
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await callTool(mcpDeps, face, name, args)
      return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError })
    }
    return rpcError(-32601, 'method not found')
  })
}

/** 读面：`POST /mcp`（forms:view）。 */
export function registerFormsMcpRead(
  r: Hono<{ Variables: { identity: Identity } }>,
  deps: { pool: Pool; chatModel: ChatModel | null },
): void {
  registerFormsMcp(r, '/mcp', 'read', deps)
}

/** 管理面：`POST /mcp-manage`（forms:manage）。 */
export function registerFormsMcpManage(
  r: Hono<{ Variables: { identity: Identity } }>,
  deps: { pool: Pool; chatModel: ChatModel | null },
): void {
  registerFormsMcp(r, '/mcp-manage', 'manage', deps)
}
