// mcp.ts — POST /mcp-manage：notify 的管理面 MCP 端点（issue #889）。
//
// 为什么单开一条：**让声明面仍反映「写所需的能力」**——本端点声明 `notify:manage`，
// 外部 agent 持该档位凭据即可建/看通知规则（照 modules/forms 的 /mcp-manage 先例）。
//
// ⚠️ **AI 永不碰文案模板**（§2.6 门禁分层）：规则行 = 高频 × 小（发错人可一键停用，可逆）⇒ AI 直写；
// 文案模板 = 低频 × 大（外发不可撤回）⇒ Novu 生产 401 架构强制「Dev 建 + 人审 + sync」。
// 故本端点**不暴露**任何建模板/改文案工具，只引既有 templateId。
//
// 壳形状照 modules/forms/mcp.ts 抄（§12.13：不跨模块 import，抄形状不抄代码）。
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity } from '@platform/sdk'
import { validateRule, type Channel, type RecipientKind } from './domain/rules'
import * as store from './storage'

export const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type McpDeps = { pool: Pool; org: string; userId: string }
type McpToolResult = { text: string; isError: boolean }
type ToolDef = { name: string; description: string; inputSchema: Record<string, unknown> }

const err = (reason: string, extra: Record<string, unknown> = {}): McpToolResult => ({
  text: JSON.stringify({ status: 'error', reason, ...extra }),
  isError: true,
})
const ok = (payload: unknown): McpToolResult => ({ text: JSON.stringify(payload), isError: false })

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

export function toolDefs(): ToolDef[] {
  return [
    {
      name: 'list_rules',
      description: '列出本租户已有的通知规则（事件 / 挂载点 / 模板 / 收件人 / 启停 / origin）。建规则前先查。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'propose_rule',
      description:
        '创建一条通知规则（绑定层：事件 × 收件人 × 模板 × 通道）。**即时生效**——规则行可逆，发错人可一键停用。' +
        'templateId 必须引用既有 Novu 模板；本工具**不创建/修改文案模板**（文案走人审）。',
      inputSchema: {
        type: 'object',
        properties: {
          eventType: { type: 'string', description: '如 case.awaiting_approval / form.due_reminder' },
          mount: { type: 'string', description: "挂载点：case_type_id / form_def_id / '*'" },
          templateId: { type: 'string', description: '既有 Novu workflow identifier' },
          recipient: { type: 'string', enum: ['assignee', 'submitter', 'user_list', 'field'] },
          recipientArg: { type: 'string', description: 'user_list / field 的参数' },
          channels: { type: 'array', items: { type: 'string', enum: ['wechat_work', 'in_app'] } },
        },
        required: ['eventType', 'mount', 'templateId', 'recipient'],
        additionalProperties: false,
      },
    },
  ]
}

export async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult> {
  if (name === 'list_rules') {
    return ok({ rules: await store.listRules(deps.pool, deps.org) })
  }
  if (name === 'propose_rule') {
    const eventType = str(args['eventType'])
    const mount = str(args['mount'])
    const templateId = str(args['templateId'])
    const recipient = str(args['recipient']) as RecipientKind
    if (!eventType || !mount || !templateId || !recipient) return err('missing_required')
    const recipientArg = str(args['recipientArg']) || null
    const bad = validateRule({ eventType, mount, recipient, recipientArg })
    if (bad) return err(bad.code)

    const id = `rule:${randomUUID()}`
    await store.upsertRule(
      deps.pool,
      deps.org,
      {
        id,
        org: deps.org,
        enabled: true,
        eventType,
        mount,
        templateId,
        recipient,
        recipientArg,
        channels: (Array.isArray(args['channels']) ? args['channels'] : ['wechat_work', 'in_app']) as Channel[],
        cooldownMinutes: null,
        origin: 'manual',
        createdAt: new Date().toISOString(),
      },
      deps.userId,
    )
    return ok({ id, next: '规则即时生效；可在控制台规则管理区查看与启停' })
  }
  return err('unknown_tool', { name })
}

/** 把 MCP 管理面挂成 `POST /mcp-manage`（挂到模块既有 router 上）。 */
export function registerNotifyMcpManage(
  r: Hono<{ Variables: { identity: Identity } }>,
  deps: { pool: Pool },
): void {
  r.post('/mcp-manage', async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | null
    if (msg === null) return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200)
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }
    if (msg.id === undefined) return c.body(null, 202) // 通知：不回

    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    const identity = c.get('identity') as Identity
    const mcpDeps: McpDeps = { pool: deps.pool, org: identity.orgId, userId: identity.userId }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-notify-mcp-manage', version: '0.1.0' },
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
