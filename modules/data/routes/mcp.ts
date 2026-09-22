// mcp.ts — POST /mcp：通道 B（PAT）的 MCP 端点，手写 stateless JSON-RPC over POST。
//
// 为什么不用 @modelcontextprotocol/sdk：本端点只用 initialize / ping / tools/list /
// tools/call 四个方法 + 通知，协议面小且稳定；引 SDK 会把重依赖塞进模块
// （modules/* 的依赖面刻意保持窄）。application/json 单发单回是 streamable HTTP 的合法形态。
//
// stateless 的含义：**无会话状态、不强制握手顺序**（先 tools/list 后 initialize 也照答），
// 不是拒答 initialize——真实 MCP 客户端连接必走 initialize，回 -32601 会让本端点对它们不可用。
// 通知（无 id）按 MCP 要求回 202 空体，不产生任何服务端输出。
//
// 授权不自建：词表裁剪只调 visibleMetrics、执行只调 runQuery（保留键拒 / 未声明拒 /
// 未授权拒全部出自那条链——本文件不做第二份判定，约束 1）。
import type { MetricDef } from '../domain/authz'
import { visibleMetrics } from '../domain/authz'
import { loadMergedCatalog } from '../domain/metric-store'
import { runQuery } from '../domain/query-service'
import type { ModuleHono, RouteCtx } from './context'
import { requesterOf } from './context'

/** 与 MCP 规范 2025-06-18 版协议字符串对齐；客户端不匹配时自行协商降级。 */
const PROTOCOL_VERSION = '2025-06-18'

type RpcRequest = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }

/**
 * 指标 → MCP tool。inputSchema 的 properties 只含声明的业务参数——
 * 主体（org 等）不属于客户端可指定面，出现在 arguments 里会被 runQuery 按保留键拒。
 */
function toTool(m: MetricDef) {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [name, p] of Object.entries(m.params)) {
    // JSON Schema 没有 date 类型：date 参数声明为 string（运行时校验在授权核心的 DATE_RE）
    properties[name] = { type: p.type === 'date' ? 'string' : p.type, description: '' }
    if (p.required) required.push(name)
  }
  return { name: m.id, description: m.description || m.title, inputSchema: { type: 'object', properties, required } }
}

export function registerMcp(r: ModuleHono, ctx: RouteCtx): void {
  r.post('/mcp', async (c) => {
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

    // 隔离键 org（text）= 租户的 Casdoor org——与 /query 同一口径，不是数字 id
    const org = c.get('tenant').casdoor_org

    const requester = requesterOf(c)
    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcError = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-data-mcp', version: '0.1.0' },
      })
    }
    if (msg.method === 'ping') return reply({})
    if (msg.method === 'tools/list') {
      // M3 守卫拒掉的请求者（requesterOf → null）：词表对其「看不见」——空 tools，不是报错。
      // 守卫必须在加载词表**之前**（实测：放在后面 = 空身份先炸在加载词表上，500 而非空词表）。
      if (requester === null) return reply({ tools: [] })
      // 合并加载器（L1 ∪ 本 org）——与 /query、chat、GET /metrics 同一落点，
      // 否则平台指标不出现在 agent 的工具面里（T8 评审 C1）。
      return reply({ tools: visibleMetrics(await loadMergedCatalog(ctx.pool, org), requester).map(toTool) })
    }
    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>
      // execute 必须透传：缺省会让 runQuery 去建真仓库连接，测试里就变成「断言被网络错误顶掉」
      const out = await runQuery(
        { pool: ctx.pool, execute: ctx.execute }, org, requester, name, args,
      )
      // 拒绝/出错也走 result + isError（MCP 的工具级错误形态），JSON-RPC error 只留给协议层
      return reply({
        content: [{ type: 'text', text: JSON.stringify(out) }],
        isError: out.status !== 'ok',
      })
    }
    return rpcError(-32601, 'method not found')
  })
}
