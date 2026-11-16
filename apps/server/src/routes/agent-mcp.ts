// agent-mcp.ts — 统一 agent MCP 网关：face 选择 + 命名空间 + 转发 + 能力目录。
//
// 设计（2026-11-16 能力网关 spec §7）：网关是**哑聚合器**——只按 audience + scope 选面、
// 把工具名加 `<module>__` 前缀、用内部签名身份转发；**权限执法在模块 face**（模块的
// requireScope / callTool 才是唯一授权点）。网关不自行放行/拒绝任何业务工具。
//
// 安全边界：
//   · 网关不信任客户端传入的任何身份/发现头（`x-internal-identity` / `x-agent-profile`
//     一律不转发）——内部头由本网关用 `issueInternalIdentity` 现签。
//   · 转发必须带**原请求 host**：宿主租户解析按 host，内部 `app.request` 的缺省 host
//     会落到错误租户。
//   · 不记 token / 工具参数：本文件不 console.log 身份头或 args。
import { Hono } from 'hono'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity, McpFaceDecl, RequesterVars } from '@platform/sdk'
import { INTERNAL_IDENTITY_HEADER, issueInternalIdentity } from '../internal-identity'

/** 运行时的 face 投影（loader.mcpFaces() 的结构同形）。 */
export interface AgentFace {
  moduleId: string
  face: McpFaceDecl
  mountPath: string
}

/** 网关路由读的上下文变量：会话身份 + 通道/keyId（PAT 审计）。 */
export type AgentMcpEnv = { Variables: { identity: Identity } & RequesterVars }

/** 模块转发调用（签名与 Hono `app.request` 的 `RequestInit` 兼容）。 */
export interface ModuleFetchInit {
  method: string
  headers: Record<string, string>
  body: string
}

type Rpc = {
  jsonrpc: '2.0'
  id?: number | string
  method: string
  params?: Record<string, unknown>
}

const PROTOCOL_VERSION = '2025-11-25'
const MAX_PAGE_TOOLS = 50
const MAX_PAGE_BYTES = 10_240
const CACHE_TTL_MS = 30_000
const RATE_LIMIT_PER_MIN = 60

type Channel = 'pat' | 'session' | 'wecom'

/** mcp = PAT / 会话；wecom = 渠道身份（C 侧只走 manage 面）。 */
const audienceOf = (channel: string): 'mcp' | 'wecom' => (channel === 'wecom' ? 'wecom' : 'mcp')

/**
 * 对每个 `(module, group)` 选该 audience 内、调用方有 scope 的**最高 precedence** face。
 * 不探测、不试错；audience 只是发现/产品面，安全差异由模块按 `identity.channel` 执法。
 */
function selectFaces(all: AgentFace[], identity: Identity, channel: string): AgentFace[] {
  const audience = audienceOf(channel)
  const chosen = new Map<string, AgentFace>()
  for (const f of all) {
    if (!f.face.audiences.includes(audience)) continue
    if (!identity.hasScope(f.face.scope)) continue
    const key = `${f.moduleId}\0${f.face.group}`
    const prev = chosen.get(key)
    if (!prev || f.face.precedence > prev.face.precedence) chosen.set(key, f)
  }
  return [...chosen.values()]
}

const toolName = (moduleId: string, name: string) => `${moduleId}__${name}`

const BUILTIN_CAPABILITIES = {
  name: 'agent__capabilities',
  description: '返回当前身份可用的能力、lockedFaces 与所需 scope；先调它，再调列表里的工具。',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true },
}

type Tool = { name: string; [k: string]: unknown }

export function agentMcpRoutes(deps: {
  faces: () => AgentFace[]
  fetchModule: (path: string, init: ModuleFetchInit) => Promise<Response>
}): Hono<AgentMcpEnv> {
  const app = new Hono<AgentMcpEnv>()
  // 工具清单缓存：键含 org / scope 集 / audience / module / face / profile（spec §7.3）。
  // TTL 30s，**惰性过期**：只在读取时判断 `at`，没有后台清扫——过期条目留在 map 里直到
  // 同键被再次访问/覆盖。单进程、键数 ≈ 租户×scope×face 组合，内存可控；主动清理留后续。
  const cache = new Map<string, { at: number; tools: Tool[] }>()
  // 每 (userId, tool) 一个固定窗口令牌桶（默认 60 次/分钟）。同样惰性重置：窗口过期在
  // 下一次同键访问时初始化，不扫全表（清理策略留后续，注释固化 TTL 语义）。
  const buckets = new Map<string, { at: number; count: number }>()

  const internalHeaders = (
    identity: Identity,
    channel: Channel,
    keyId: number | null,
    host: string,
  ): Record<string, string> => ({
    'content-type': 'application/json',
    ...(host ? { host } : {}),
    [INTERNAL_IDENTITY_HEADER]: issueInternalIdentity({
      org: identity.orgId,
      userId: identity.userId,
      displayName: identity.displayName,
      channel,
      ...(keyId != null ? { keyId } : {}),
      ...(identity.roles ? { roles: identity.roles } : {}),
      ...(identity.accountName ? { accountName: identity.accountName } : {}),
      ...(identity.sessionId ? { sessionId: identity.sessionId } : {}),
      ...(identity.boundExternalIds ? { boundExternalIds: identity.boundExternalIds } : {}),
      scopes: identity.scopes,
    }),
  })

  const rpc = async (
    face: AgentFace,
    identity: Identity,
    channel: Channel,
    keyId: number | null,
    host: string,
    body: Rpc,
  ): Promise<Response> =>
    deps.fetchModule(`${face.mountPath}${face.face.path}`, {
      method: 'POST',
      headers: {
        ...internalHeaders(identity, channel, keyId, host),
        'x-agent-profile': face.face.profile ?? 'full',
      },
      body: JSON.stringify(body),
    })

  /** 取某 face 的工具清单。`ok:false` = 模块 face 不可用（403/5xx/不可达），不缓存失败结果。 */
  const listFaceTools = async (
    face: AgentFace,
    identity: Identity,
    channel: Channel,
    keyId: number | null,
    host: string,
    refresh = false,
  ): Promise<{ tools: Tool[]; ok: boolean }> => {
    const key = [
      identity.orgId,
      identity.scopes.join(','),
      audienceOf(channel),
      face.moduleId,
      face.face.face,
      face.face.profile ?? 'full',
    ].join('\0')
    if (!refresh) {
      const hit = cache.get(key)
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { tools: hit.tools, ok: true }
    }
    const res = await rpc(face, identity, channel, keyId, host, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    if (!res.ok) return { tools: [], ok: false }
    const body = (await res.json()) as { result?: { tools?: Tool[] } }
    const tools = (body.result?.tools ?? []).map((t) => ({
      ...t,
      name: toolName(face.moduleId, t.name),
    }))
    cache.set(key, { at: Date.now(), tools })
    return { tools, ok: true }
  }

  const allTools = async (
    identity: Identity,
    channel: Channel,
    keyId: number | null,
    host: string,
    opts: { refresh?: boolean } = {},
  ) => {
    const selected = selectFaces(deps.faces(), identity, channel)
    const pairs = await Promise.all(
      selected.map(async (face) => ({
        face,
        ...(await listFaceTools(face, identity, channel, keyId, host, opts.refresh)),
      })),
    )
    const byName = new Map<string, { tool: Tool; face: AgentFace }>()
    for (const { face, tools, ok } of pairs) {
      // 模块 face 不可用 ⇒ 不贡献工具；`faces` 里如实上报 available:false，不影响其他 face。
      if (!ok) continue
      for (const tool of tools) {
        const prev = byName.get(tool.name)
        // 发现期冲突 ⇒ 报错（不静默去重）；命名空间已含模块前缀，正常不会跨模块撞名。
        if (prev && prev.face.moduleId !== face.moduleId) {
          throw new Error(`agent mcp: 工具名冲突 ${tool.name}`)
        }
        if (!prev) byName.set(tool.name, { tool, face })
      }
    }
    return {
      faces: pairs.map(({ face, ok }) => ({ face, available: ok })),
      tools: [...byName.values()],
    }
  }

  const rateOk = (identity: Identity, tool: string): boolean => {
    const key = `${identity.userId}\0${tool}`
    const now = Date.now()
    const b = buckets.get(key)
    if (!b || now - b.at >= 60_000) {
      buckets.set(key, { at: now, count: 1 })
      return true
    }
    if (b.count >= RATE_LIMIT_PER_MIN) return false
    b.count += 1
    return true
  }

  app.post('/mcp', async (c) => {
    if (process.env.AGENT_MCP_ENABLED === '0') return c.json({ error: 'NOT_FOUND' }, 404)

    const identity = c.get('identity')
    if (!identity) return c.json({ error: 'UNAUTHENTICATED' }, 401)

    const channel: Channel = c.get(REQUESTER_CHANNEL) ?? 'session'
    // PAT 的 keyId 只作审计归属透传；其他通道为 null（不写进内部头）。
    const keyId = c.get(REQUESTER_KEY_ID) ?? null
    const host = c.req.header('host') ?? ''

    const msg = (await c.req.json().catch(() => null)) as Rpc | null
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'invalid request' } }, 200)
    }
    // 通知/响应无需回包（MCP 通知 id 缺省）。
    if (msg.id === undefined) return c.body(null, 202)

    const reply = (result: unknown) => c.json({ jsonrpc: '2.0', id: msg.id, result })
    const rpcErr = (code: number, message: string) =>
      c.json({ jsonrpc: '2.0', id: msg.id, error: { code, message } }, 200)

    if (msg.method === 'initialize') {
      return reply({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'platform-agent-mcp', version: '0.1.0' },
        instructions: '工具按 <module>__<tool> 命名；先调 agent__capabilities；发布/启用必须人做。',
      })
    }
    if (msg.method === 'ping') return reply({})

    if (msg.method === 'tools/list') {
      const { tools } = await allTools(identity, channel, keyId, host)
      // allTools 返回的是 `{ tool, face }` 对（tools/call 要靠 face 路由）；这里只取工具本身。
      const all: Tool[] = [BUILTIN_CAPABILITIES, ...tools.map((x) => x.tool)]
      const cursor = typeof msg.params?.cursor === 'string' ? Number(msg.params.cursor) : 0
      const page: Tool[] = []
      let bytes = 0
      for (const t of all.slice(cursor)) {
        // 上限按**字节**算（spec §7.3）：字符串 length 是 UTF-16 码元，中文描述会低估传输量。
        const b = Buffer.byteLength(JSON.stringify(t))
        if (page.length >= MAX_PAGE_TOOLS || bytes + b > MAX_PAGE_BYTES) break
        page.push(t)
        bytes += b
      }
      const next = cursor + page.length < all.length ? String(cursor + page.length) : undefined
      return reply({ tools: page, ...(next ? { nextCursor: next } : {}) })
    }

    if (msg.method === 'tools/call') {
      const name = String(msg.params?.name ?? '')
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>

      if (name === 'agent__capabilities') {
        const { faces, tools } = await allTools(identity, channel, keyId, host)
        const audience = audienceOf(channel)
        // 不可用 face 只报 face + 所需 scope，不报工具名（网关无权替调用方枚举该 face 的工具）。
        const locked = [
          ...new Map(
            deps
              .faces()
              .filter((f) => f.face.audiences.includes(audience) && !identity.hasScope(f.face.scope))
              .map((f) => [
                `${f.moduleId}\0${f.face.face}`,
                { module: f.moduleId, face: f.face.face, scope: f.face.scope },
              ]),
          ).values(),
        ]
        return reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                // selected face 如实上报可用性：模块 tools/list 失败 ⇒ available:false（不贡献工具）。
                faces: faces.map(({ face: f, available }) => ({
                  module: f.moduleId,
                  face: f.face.face,
                  group: f.face.group,
                  audience: audienceOf(channel),
                  scope: f.face.scope,
                  available,
                })),
                tools: tools.map((x) => x.tool),
                lockedFaces: locked,
              }),
            },
          ],
          isError: false,
        })
      }

      const { tools } = await allTools(identity, channel, keyId, host)
      let hit = tools.find((x) => x.tool.name === name)
      if (!hit) {
        // spec §7.4：缓存未命中（scope 变更 / 模块新增工具）⇒ 强制刷新一次 tools/list 再判定；
        // 仍不中才 -32601，不盲目转发未知工具名。
        const refreshed = await allTools(identity, channel, keyId, host, { refresh: true })
        hit = refreshed.tools.find((x) => x.tool.name === name)
      }
      // 只接受 tools/list 投影过的名字；未知名不盲目转发。
      if (!hit) return rpcErr(-32601, 'method not found')
      if (!rateOk(identity, name)) {
        return reply({
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', reason: 'rate_limited' }) }],
          isError: true,
        })
      }

      const original = name.slice(hit.face.moduleId.length + 2)
      const res = await rpc(hit.face, identity, channel, keyId, host, {
        jsonrpc: '2.0',
        id: msg.id,
        method: 'tools/call',
        params: { name: original, arguments: args },
      })

      // 错误映射（spec §7.4）：403 ⇒ missing_scope；5xx/不可达 ⇒ module_unavailable。
      if (res.status === 403) {
        return reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'denied',
                reason: 'missing_scope',
                scope: hit.face.face.scope,
              }),
            },
          ],
          isError: true,
        })
      }
      if (!res.ok) {
        return reply({
          content: [
            {
              type: 'text',
              text: JSON.stringify({ status: 'error', reason: 'module_unavailable' }),
            },
          ],
          isError: true,
        })
      }

      const body = (await res.json()) as { result?: unknown; error?: unknown }
      // 模块 JSON-RPC error 原样透传，id 用调用方 id。
      if (body.error) return c.json({ jsonrpc: '2.0', id: msg.id, error: body.error }, 200)
      return reply(body.result)
    }

    return rpcErr(-32601, 'method not found')
  })

  return app
}
