// mcp.ts — POST /mcp-manage：forms 的管理面 MCP 端点（#724）。
//
// 为什么单开一条而不是把工具塞进既有端点：**让声明面仍然反映「写所需的能力」**——
// 本端点声明 `forms:manage`，外部 agent 持该档位凭据即可起草表单（照 modules/data
// 的 /mcp-manage 先例，见 docs/superpowers/specs/2026-10-07-mcp-write-face-design.md）。
//
// ⚠️ **AI 永不发布**：本端点**不暴露**任何 publish/rollback/retire 工具（§14.1 发布是人的
// 唯一 gate）。agent 能做的只有「起草」与「读」——发布仍在 console/HTTP 面由持 forms:publish 的人做。
//
// 壳的形状照 modules/data/routes/mcp-rpc.ts 抄（§12.13：不跨模块 import，抄形状不抄代码）。
// 协议语义与那边逐条一致：只用 initialize/ping/tools/list/tools/call + 通知；
// stateless（不强制握手顺序，但 initialize 必答——回 -32601 会让真实 MCP 客户端连不上）；
// 通知（无 id）回 202 空体；协议错误走 JSON-RPC 错误信封（HTTP 200），不是 500。
//
// ⚠️ 本壳**不做身份/授权判定**：授权由宿主门卫按 manifest 的 api.internal 施加
// （本模块不写 requireScope）；org 取自身份行，工具内一律按 org 隔离。
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { generateDraft } from './domain/generator'
import { LlmError } from './domain/llm'
import type { ChatModel } from './domain/llm'
import * as store from './storage'

export const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type McpDeps = { pool: Pool; org: string; userId: string; chatModel: ChatModel | null }
type McpToolResult = { text: string; isError: boolean }
type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

const err = (reason: string, extra: Record<string, unknown> = {}): McpToolResult => ({
  text: JSON.stringify({ status: 'error', reason, ...extra }),
  isError: true,
})
const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false })

/** 本端点暴露的工具集。加工具只改这张表 + TOOLS 的分支。 */
export function toolDefs(): ToolDef[] {
  return [
    {
      name: 'list_forms',
      description: '列出本租户已有表单（assetId / 当前发布版本 / 各状态版本数）。起草新表单前先查，避免重名。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'generate_form_draft',
      description:
        '用自然语言描述业务场景，生成表单契约并落为**草稿**（draft）。' +
        '生成结果不会自动发布——发布必须由持发布权限的人在控制台确认。' +
        '若 assetId 与既有表单重名会报错，请换个名字或改用 list_forms 查看。',
      inputSchema: {
        type: 'object',
        properties: { description: { type: 'string', description: '业务场景描述（要采集什么、有哪些字段与规则）' } },
        required: ['description'],
        additionalProperties: false,
      },
    },
  ]
}

const MAX_DESCRIPTION_LEN = 2000

export async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (name === 'list_forms') {
    return ok({ forms: await store.listDefs(deps.pool, deps.org) })
  }
  if (name === 'generate_form_draft') {
    if (deps.chatModel === null) return err('llm_not_configured', { hint: '需配置 FORMS_LLM_* 或 DATA_LLM_*' })
    const description = typeof args['description'] === 'string' ? args['description'].trim() : ''
    if (description.length === 0) return err('description_required')
    if (description.length > MAX_DESCRIPTION_LEN) return err('description_too_long', { limit: MAX_DESCRIPTION_LEN })
    let result: Awaited<ReturnType<typeof generateDraft>>
    try {
      result = await generateDraft({ model: deps.chatModel, description })
    } catch (e) {
      if (e instanceof LlmError) return err('llm_upstream_failed', { detail: e.message })
      throw e
    }
    if (!result.ok) return err('contract_rejected', { code: result.code, detail: result.detail })
    if (await store.assetExists(deps.pool, deps.org, result.assetId)) {
      return err('asset_id_taken', { assetId: result.assetId, hint: '换个名字重试，或用 list_forms 查看已有表单' })
    }
    const version = await store.newDraft(deps.pool, deps.org, result.assetId, result.body, deps.userId)
    return ok({
      assetId: result.assetId,
      version,
      status: 'draft',
      repairUsed: result.repairUsed,
      body: result.body,
      next: '草稿已落地，需由持发布权限的人在控制台发布后才可填报',
    })
  }
  return err('unknown_tool', { name })
}

/** 把 MCP 管理面挂成 `POST /mcp-manage`（挂到模块既有 router 上，与 data 的做法一致）。 */
export function registerFormsMcpManage(
  r: Hono<{ Variables: { identity: Identity } }>,
  deps: { pool: Pool; chatModel: ChatModel | null },
): void {
  r.post('/mcp-manage', async (c) => {
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
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-forms-mcp-manage', version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: toolDefs() })
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await callTool(mcpDeps, name, args)
      return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError })
    }
    return rpcError(-32601, 'method not found')
  })
}
