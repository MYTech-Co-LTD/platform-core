// mcp-rpc.ts — MCP 端点的**共享协议壳**：JSON-RPC 分层 + initialize/ping/通知 + 工具分发。
//
// 两个端点（读面 `/mcp`、写面 `/mcp-manage`）各提供一个「工具集」，协议细节只有这一份——
// 否则规范升版时只会改到一处，另一处默默落后。
//
// 为什么不用 @modelcontextprotocol/sdk：本端点只用 initialize / ping / tools/list /
// tools/call 四个方法 + 通知，协议面小且稳定；引 SDK 会把重依赖塞进模块
// （modules/* 的依赖面刻意保持窄）。application/json 单发单回是 streamable HTTP 的合法形态。
//
// stateless 的含义：**无会话状态、不强制握手顺序**（先 tools/list 后 initialize 也照答），
// 不是拒答 initialize——真实 MCP 客户端连接必走 initialize，回 -32601 会让本端点对它们不可用。
// 通知（无 id）按 MCP 要求回 202 空体，不产生任何服务端输出。
//
// ⚠️ 本壳**不做身份/授权判定**，也不替工具集决定「未知工具」怎么答：
//   · 授权由宿主门卫按 manifest 的 api.internal 施加（本模块不写 requireScope）；
//   · 词表裁剪 / 保留键拒 / M3 空身份守卫都在各工具集内部（读面走 runQuery 那条链，
//     写面走 domain/metric-write）——壳只负责把 deps 递过去。
import type { Pool } from 'pg'
import { TENANT_SOURCES } from '@platform/sdk'
import type { Requester } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'

/** 与 MCP 规范 2025-06-18 版协议字符串对齐；客户端不匹配时自行协商降级。 */
export const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

/** 工具集每个方法拿到的依赖。**唯一**组装点在壳里（见 registerMcpEndpoint）。 */
export interface McpDeps {
  pool: Pool
  /** 缺省 = 真仓库（runQuery 惰性连）。测试注入假执行器。 */
  execute?: SqlExecutor
  /** 隔离键（text）= 租户的 Casdoor org——与 /query 同一口径，不是数字 id。 */
  org: string
  requester: Requester | null
  /** 宿主投影的「本租户已接入源」。`?? []` 的语义是**刻意的 fail-closed**（见调用点）。 */
  adoptedSources: ReadonlySet<string>
}

/** 工具级结果：拒绝/出错也走 `result` + `isError`（MCP 的工具级错误形态）。 */
export interface McpToolResult {
  text: string
  isError: boolean
}

/** 一个端点暴露的工具集。协议壳只做分发。 */
export interface McpToolSet {
  /** initialize 回给客户端的 `serverInfo.name`——两个端点各自可辨认。 */
  serverName: string
  list(deps: McpDeps): Promise<Record<string, unknown>[]>
  call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult>
}

/**
 * 端点内部的**工具片**：一个端点可以由多片合成（如管理面 = 口径片 + 报表片）。
 * `call` 返回 `null` 表示「这不是我的工具」——由合成方继续问下一片；
 * 任一片认领了但业务上拒绝，则返回 `McpToolResult`（带 `isError`），不再往下问。
 */
export interface McpToolGroup {
  list(deps: McpDeps): Promise<Record<string, unknown>[]>
  call(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<McpToolResult | null>
}

/** 把一个工具集挂成 `POST <path>` 的 MCP 端点。 */
export function registerMcpEndpoint(
  r: ModuleHono, path: string, ctx: RouteCtx, toolset: McpToolSet,
): void {
  r.post(path, async (c) => {
    const msg = (await c.req.json().catch(() => null)) as RpcRequest | null
    // 错误码按 JSON-RPC 2.0 规范拆分：body 不可解析 → -32700 parse error；
    // 可解析但形状非法（缺 jsonrpc 版本 / 缺 method）→ -32600 invalid request。
    // 两类都回 JSON-RPC 错误信封（HTTP 200），不是 500——协议错误不是服务端故障。
    if (msg === null) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }, 200)
    }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }

    // 通知（无 id）：**不回**，202 空体（MCP 明确要求；stateless 下也无从异步补发）
    if (msg.id === undefined) return c.body(null, 202)

    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    // deps 的**唯一**组装点：pool / execute 来自装配期注入的 RouteCtx（不在 Hono context 上）；
    // org 取租户的 Casdoor org（text）；adoptedSources 的 `?? []` = 宿主没投影 ⇒ 空集
    // ⇒ 未接入源的指标一律不可见/不可写（fail-closed，两面的工具集都靠这份事实）。
    const deps: McpDeps = {
      pool: ctx.pool,
      execute: ctx.execute,
      org: c.get('tenant').casdoor_org,
      requester: requesterOf(c),
      adoptedSources: new Set(c.get(TENANT_SOURCES) ?? []),
    }

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: toolset.serverName, version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') return reply({ tools: await toolset.list(deps) })
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      const out = await toolset.call(deps, name, args)
      return reply({ content: [{ type: 'text', text: out.text }], isError: out.isError })
    }
    return rpcError(-32601, 'method not found')
  })
}
