// agent-mcp.test.ts — 统一 agent MCP 网关（face 选择 / 命名空间 / 转发 / 能力目录 / 错误映射）。
//
// 组装：注入 identity + REQUESTER_* 的测试中间件 + 真 agentMcpRoutes；模块侧用 fetchModule
// 替身按路径回 tools/list / tools/call，并记录每次内部转发的 path/headers/body。
import { afterEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
import { agentMcpRoutes, type AgentFace, type AgentMcpEnv } from './agent-mcp'
import { INTERNAL_IDENTITY_HEADER, verifyInternalIdentity } from '../internal-identity'

type Rpc = { jsonrpc: '2.0'; id?: number | string; method: string; params?: Record<string, unknown> }
type ModuleCall = { path: string; headers: Record<string, string>; body: Rpc }

const faces: AgentFace[] = [
  { moduleId: 'data', mountPath: '/api/modules/data', face: { face: 'read', group: 'agent', precedence: 1, path: '/mcp-read', method: 'POST', scope: 'data:read', audiences: ['mcp'] } },
  { moduleId: 'data', mountPath: '/api/modules/data', face: { face: 'agent', group: 'agent', precedence: 2, path: '/mcp-curated', method: 'POST', scope: 'data:query', audiences: ['mcp'] } },
  // C 通道（wecom）只该看见 notify 的 manage 面；data manage 面钉死 mcp audience。
  { moduleId: 'data', mountPath: '/api/modules/data', face: { face: 'manage', group: 'manage', precedence: 1, path: '/mcp-manage', method: 'POST', scope: 'data:manage', audiences: ['mcp'] } },
  { moduleId: 'notify', mountPath: '/api/modules/notify', face: { face: 'agent-manage', group: 'manage', precedence: 2, path: '/mcp-c-manage', method: 'POST', scope: 'notify:manage', audiences: ['wecom'], profile: 'c-manage' } },
  // 第二个 mcp audience 模块：用于验证 miss 刷新只影响名字前缀所属 module。
  { moduleId: 'forms', mountPath: '/api/modules/forms', face: { face: 'read', group: 'forms', precedence: 1, path: '/mcp', method: 'POST', scope: 'forms:view', audiences: ['mcp'] } },
]

const TOOLS_BY_PATH: Record<string, string[]> = {
  '/mcp-read': ['search_catalog'],
  '/mcp-curated': ['search_catalog', 'query_metric'],
  '/mcp-manage': ['customize_metric'],
  '/mcp-c-manage': ['create_agent_rule'],
  '/mcp': ['list_forms'],
}

const faceByPath = (path: string) => faces.find((f) => path.endsWith(f.face.path))!

const defaultRespond = (call: ModuleCall): Response => {
  const face = faceByPath(call.path)
  if (call.body.method === 'tools/list') {
    const names = TOOLS_BY_PATH[face.face.path] ?? []
    return Response.json({
      jsonrpc: '2.0',
      id: call.body.id,
      result: {
        tools: names.map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object' },
          annotations: { readOnlyHint: true },
        })),
      },
    })
  }
  return Response.json({
    jsonrpc: '2.0',
    id: call.body.id,
    result: { content: [{ type: 'text', text: JSON.stringify({ ok: true, face: face.face.face }) }], isError: false },
  })
}

interface MakeAppOptions {
  channel?: 'pat' | 'wecom'
  keyId?: number
  respond?: (call: ModuleCall) => Response | Promise<Response>
  /** 覆盖 face 投影（保留名 / 自定义模块测试用）。 */
  faces?: AgentFace[]
}

function makeApp(scopes: string[], opts: MakeAppOptions = {}) {
  const app = new Hono<AgentMcpEnv>()
  const calls: ModuleCall[] = []
  const allFaces = opts.faces ?? faces
  const identity: Identity = {
    userId: 'u1',
    orgId: 'acme',
    displayName: 'User One',
    scopes,
    hasScope: (code) => scopes.includes(code),
    roles: ['analyst'],
    accountName: 'alice',
    sessionId: 'sess-1',
  }
  app.use('*', async (c, next) => {
    c.set('identity', identity)
    c.set(REQUESTER_CHANNEL, opts.channel ?? 'pat')
    if (opts.keyId != null) c.set(REQUESTER_KEY_ID, opts.keyId)
    await next()
  })
  app.route('/agent', agentMcpRoutes({
    faces: () => allFaces,
    fetchModule: async (path, init) => {
      const body = JSON.parse(init.body) as Rpc
      const call = { path, headers: init.headers, body }
      calls.push(call)
      return (opts.respond ?? defaultRespond)(call)
    },
  }))
  return { app, calls, identity }
}

const rpc = (app: Hono<AgentMcpEnv>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/agent/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

const listTools = async (app: Hono<AgentMcpEnv>) =>
  (await (await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()) as {
    result: { tools: Array<{ name: string }> }
  }

const callCapabilities = async (app: Hono<AgentMcpEnv>) =>
  (await (await rpc(app, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'agent__capabilities', arguments: {} },
  })).json()) as { result: { content: Array<{ text: string }> } }

const textOf = (body: { result: { content: Array<{ text: string }> } }) =>
  JSON.parse(body.result.content[0].text) as Record<string, unknown>

afterEach(() => {
  delete process.env.AGENT_MCP_ENABLED
})

describe('agent mcp', () => {
  it('只暴露可进 face 的工具；命名 <module>__<tool>；暴露出选中的 query 面', async () => {
    const { app } = makeApp(['data:query'])
    const body = await listTools(app)
    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('agent__capabilities')
    expect(names).toContain('data__search_catalog')
    expect(names).not.toContain('data__customize_metric')
    // 选中的是 group=agent 的最高 precedence 面（mcp-curated），不是 read 面。
    expect(names).toContain('data__query_metric')
  })

  it('缺 manage scope ⇒ manage 面不可见；capabilities lockedFaces 带 scope', async () => {
    const { app } = makeApp(['data:query'])
    const out = textOf(await callCapabilities(app))
    expect(out.lockedFaces).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'manage', scope: 'data:manage' }),
    )
    expect(out.faces).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'agent', scope: 'data:query' }),
    )
  })

  it('tools/call 转发到选中 face；未知名 -32601', async () => {
    const { app } = makeApp(['data:query'])
    const r = await rpc(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })
    expect(((await r.json()) as { result: { content: Array<{ text: string }> } }).result.content[0].text)
      .toContain('agent')

    const bad = await rpc(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'nope__x', arguments: {} },
    })
    expect(((await bad.json()) as { error: { code: number } }).error.code).toBe(-32601)
  })

  it('内部转发带原请求 host（宿主按 host 解析租户）', async () => {
    const { app, calls } = makeApp(['data:query'])
    await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { host: 'acme.example.com' })
    expect(calls).toHaveLength(1)
    expect(calls[0].headers.host).toBe('acme.example.com')
  })

  it('PAT 的 keyId 进入内部签名身份（审计归属）', async () => {
    const { app, calls } = makeApp(['data:query'], { keyId: 7 })
    await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const payload = verifyInternalIdentity(calls[0].headers[INTERNAL_IDENTITY_HEADER])
    expect(payload).toMatchObject({
      org: 'acme',
      userId: 'u1',
      channel: 'pat',
      keyId: 7,
      scopes: ['data:query'],
    })
  })

  it('AGENT_MCP_ENABLED=0 ⇒ 404 且不转发', async () => {
    process.env.AGENT_MCP_ENABLED = '0'
    const { app, calls } = makeApp(['data:query'])
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: string }).error).toBe('NOT_FOUND')
    expect(calls).toHaveLength(0)
  })

  it('C 通道（wecom）只选 wecom audience 的 face；转发带该 face 的 profile', async () => {
    const { app, calls } = makeApp(['data:manage', 'notify:manage'], { channel: 'wecom' })
    const body = await listTools(app)
    const names = body.result.tools.map((t) => t.name)
    expect(names).toContain('notify__create_agent_rule')
    expect(names).not.toContain('data__customize_metric')
    expect(calls.map((c) => c.path)).toEqual(['/api/modules/notify/mcp-c-manage'])
    expect(calls[0].headers['x-agent-profile']).toBe('c-manage')
    expect(verifyInternalIdentity(calls[0].headers[INTERNAL_IDENTITY_HEADER])).toMatchObject({
      channel: 'wecom',
    })
    // audience 排除的面不算 locked：data 的 read/query/manage 全是 mcp audience。
    const caps = textOf(await callCapabilities(app))
    expect((caps.lockedFaces as Array<{ module: string }>).some((f) => f.module === 'data')).toBe(false)
  })

  it('缓存键含 scope：不同 scope 集不共享工具缓存', async () => {
    // 动态 scope：验证同一个网关实例在两个 scope 集之间不串缓存。
    let scopes = ['data:query']
    const calls: ModuleCall[] = []
    const app = new Hono<AgentMcpEnv>()
    app.use('*', async (c, next) => {
      const identity: Identity = {
        userId: 'u1',
        orgId: 'acme',
        displayName: 'User One',
        scopes,
        hasScope: (code) => scopes.includes(code),
      }
      c.set('identity', identity)
      c.set(REQUESTER_CHANNEL, 'pat')
      await next()
    })
    app.route('/agent', agentMcpRoutes({
      faces: () => faces,
      fetchModule: async (path, init) => {
        const body = JSON.parse(init.body) as Rpc
        const call = { path, headers: init.headers, body }
        calls.push(call)
        return defaultRespond(call)
      },
    }))

    await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const afterFirst = calls.length

    // 两个 scope 集都选中同一个 face（group=agent 的 mcp-curated），只有 scope 集不同。
    scopes = ['data:query', 'data:read']
    await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    expect(calls.length).toBeGreaterThan(afterFirst)

    // 同一 scope 集再来一次 ⇒ 命中缓存，不重复转发。
    const afterSecond = calls.length
    await rpc(app, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
    expect(calls.length).toBe(afterSecond)
  })

  it('模块 403 ⇒ 工具级 missing_scope', async () => {
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? defaultRespond(call)
          : new Response(null, { status: 403 }),
    })
    const body = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })).json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      status: 'denied',
      reason: 'missing_scope',
      scope: 'data:query',
    })
  })

  it('模块 5xx ⇒ 工具级 module_unavailable', async () => {
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? defaultRespond(call)
          : new Response(null, { status: 500 }),
    })
    const body = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })).json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      status: 'error',
      reason: 'module_unavailable',
    })
  })

  it('模块 JSON-RPC error ⇒ 原样透传，id 换成调用方 id', async () => {
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? defaultRespond(call)
          : Response.json({
              jsonrpc: '2.0',
              id: 'module-internal-id',
              error: { code: -32000, message: 'boom' },
            }),
    })
    const body = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })).json()) as { id: number; error: { code: number; message: string } }
    expect(body.id).toBe(9)
    expect(body.error).toMatchObject({ code: -32000, message: 'boom' })
  })

  it('同 group 按 precedence 选最高可用面（query + read ⇒ curated，不是 read）', async () => {
    const { app, calls } = makeApp(['data:query', 'data:read'])
    const body = await listTools(app)
    const names = body.result.tools.map((t) => t.name)
    // query_metric 只在 mcp-curated 面；read 面只有 search_catalog。
    expect(names).toContain('data__query_metric')
    expect(calls.map((c) => c.path)).toEqual(['/api/modules/data/mcp-curated'])
  })

  it('模块 face tools/list 5xx ⇒ capabilities 报 available:false 且不贡献工具', async () => {
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? new Response(null, { status: 500 })
          : defaultRespond(call),
    })
    const out = textOf(await callCapabilities(app))
    expect(out.faces).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'agent', available: false }),
    )
    expect((out.tools as Array<{ name: string }>).map((t) => t.name)).not.toContain('data__search_catalog')
  })

  it('tools/call 缓存未命中 ⇒ 强制刷新一次 tools/list 再命中（spec §7.4）', async () => {
    let listCalls = 0
    const { app } = makeApp(['data:query'], {
      respond: (call) => {
        if (call.body.method !== 'tools/list') return defaultRespond(call)
        listCalls += 1
        const names = listCalls === 1 ? ['query_metric'] : ['search_catalog']
        return Response.json({
          jsonrpc: '2.0',
          id: call.body.id,
          result: { tools: names.map((name) => ({ name, description: name, inputSchema: { type: 'object' } })) },
        })
      },
    })
    const body = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })).json()) as { result: { content: Array<{ text: string }> } }
    expect(listCalls).toBe(2)
    expect(body.result.content[0].text).toContain('agent')
  })

  it('initialize / ping / 通知 202', async () => {
    const { app, calls } = makeApp(['data:query'])
    const init = (await (await rpc(app, { jsonrpc: '2.0', id: 20, method: 'initialize' })).json()) as {
      result: { protocolVersion: string; serverInfo: { name: string } }
    }
    expect(init.result.protocolVersion).toBe('2025-11-25')
    expect(init.result.serverInfo.name).toBe('platform-agent-mcp')

    const ping = (await (await rpc(app, { jsonrpc: '2.0', id: 21, method: 'ping' })).json()) as { result: unknown }
    expect(ping.result).toEqual({})

    // 通知（无 id）⇒ 202 空体，且不触发任何模块转发。
    const note = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(note.status).toBe(202)
    expect(await note.text()).toBe('')
    expect(calls).toHaveLength(0)
  })

  it('同一工具超过 60 次/分钟 ⇒ 工具级 rate_limited', async () => {
    const { app } = makeApp(['data:query'])
    let last: { result: { content: Array<{ text: string }>; isError: boolean } } | undefined
    for (let i = 0; i < 61; i += 1) {
      last = (await (await rpc(app, {
        jsonrpc: '2.0',
        id: 100 + i,
        method: 'tools/call',
        params: { name: 'data__search_catalog', arguments: {} },
      })).json()) as typeof last
    }
    expect(last?.result.isError).toBe(true)
    expect(JSON.parse(last!.result.content[0].text)).toMatchObject({
      status: 'error',
      reason: 'rate_limited',
    })
  })

  it('模块 result.structuredContent 原样透传', async () => {
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? defaultRespond(call)
          : Response.json({
              jsonrpc: '2.0',
              id: call.body.id,
              result: {
                content: [{ type: 'text', text: 'ok' }],
                isError: false,
                structuredContent: { rows: 1 },
              },
            }),
    })
    const body = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 30,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })).json()) as { result: { structuredContent?: unknown } }
    expect(body.result.structuredContent).toEqual({ rows: 1 })
  })

  // ---- 安全边界 ----

  it('未认证（无 identity）⇒ 401 UNAUTHENTICATED', async () => {
    const app = new Hono<AgentMcpEnv>()
    app.route('/agent', agentMcpRoutes({
      faces: () => faces,
      fetchModule: async () => {
        throw new Error('should not forward')
      },
    }))
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  it('非法 JSON-RPC 请求 ⇒ -32600', async () => {
    const { app } = makeApp(['data:query'])
    const res = await rpc(app, { jsonrpc: '1.0', id: 1, method: 'tools/list' })
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32600)
  })

  it('客户端传入的 authorization/cookie/x-internal-identity/x-agent-profile 不进转发头', async () => {
    const { app, calls } = makeApp(['data:query'])
    await rpc(app, { jsonrpc: '2.0', id: 40, method: 'tools/list' }, {
      authorization: 'Bearer dkq_forged',
      cookie: 'session=forged',
      'x-internal-identity': 'forged.payload',
      'x-agent-profile': 'evil',
    })
    const h = calls[0].headers
    expect(h.authorization).toBeUndefined()
    expect(h.cookie).toBeUndefined()
    // profile 用该 face 自己的（data agent 面 → full），不是客户端伪造值。
    expect(h['x-agent-profile']).toBe('full')
    // 内部身份是网关现签的合法头，不是客户端传的那串。
    expect(h[INTERNAL_IDENTITY_HEADER]).not.toBe('forged.payload')
    expect(verifyInternalIdentity(h[INTERNAL_IDENTITY_HEADER])).toMatchObject({ userId: 'u1', org: 'acme' })
  })

  // ---- 每 face 失败隔离 ----

  it('模块 tools/list 403 ⇒ face available:false', async () => {
    const { app } = makeApp(['data:query'], { respond: () => new Response(null, { status: 403 }) })
    const out = textOf(await callCapabilities(app))
    expect(out.faces).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'agent', available: false }),
    )
  })

  it('模块 tools/list 非 JSON / 200 带 JSON-RPC error ⇒ available:false（不 500）', async () => {
    const nonJson = makeApp(['data:query'], {
      respond: () => new Response('not-json', { status: 200 }),
    })
    const a = textOf(await callCapabilities(nonJson.app))
    expect(a.faces).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'agent', available: false }),
    )

    const rpcError = makeApp(['data:query'], {
      respond: (call) => Response.json({
        jsonrpc: '2.0',
        id: call.body.id,
        error: { code: -32000, message: 'boom' },
      }),
    })
    const b = textOf(await callCapabilities(rpcError.app))
    expect(b.faces).toContainEqual(
      expect.objectContaining({ module: 'data', face: 'agent', available: false }),
    )
  })

  it('模块 tools/call 非 JSON ⇒ module_unavailable（不把他宿主打成 500）', async () => {
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? defaultRespond(call)
          : new Response('<html>bad gateway</html>', { status: 200 }),
    })
    const res = await rpc(app, {
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'data__search_catalog', arguments: {} },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError: boolean } }
    expect(body.result.isError).toBe(true)
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      status: 'error',
      reason: 'module_unavailable',
    })
  })

  // ---- 刷新放大 / 负缓存窗口 ----

  it('tools/call miss 只刷新名字前缀 module 的 face，且窗口内最多刷一次', async () => {
    let listCalls = 0
    const { app } = makeApp(['data:query', 'forms:view'], {
      respond: (call) => {
        if (call.body.method === 'tools/list') listCalls += 1
        return defaultRespond(call)
      },
    })
    const callUnknown = () =>
      rpc(app, {
        jsonrpc: '2.0',
        id: 50,
        method: 'tools/call',
        params: { name: 'data__nope', arguments: {} },
      })

    expect(((await (await callUnknown()).json()) as { error: { code: number } }).error.code).toBe(-32601)
    // 初取 2 个 face（data + forms）+ 定向刷新 data 1 次 = 3；全量 refresh 会是 2+2=4。
    expect(listCalls).toBe(3)

    // 同一 (userId, name) 在 30s 窗口内不再重列。
    expect(((await (await callUnknown()).json()) as { error: { code: number } }).error.code).toBe(-32601)
    expect(listCalls).toBe(3)
  })

  // ---- 分页 ----

  it('cursor 必须是非负整数字符串：负数/小数/NaN/数字类型 ⇒ -32602', async () => {
    const { app } = makeApp(['data:query'])
    for (const cursor of ['-1', '1.5', 'abc', 1] as unknown[]) {
      const res = await rpc(app, { jsonrpc: '2.0', id: 60, method: 'tools/list', params: { cursor } })
      expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32602)
    }
  })

  it('单个工具超字节上限也至少放一个，避免空页 + 同 cursor 死循环', async () => {
    const giant = { name: 'huge', description: '中'.repeat(6000), inputSchema: { type: 'object' } }
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: { tools: [giant] } })
          : defaultRespond(call),
    })
    const page1 = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 70,
      method: 'tools/list',
    })).json()) as { result: { tools: Array<{ name: string }>; nextCursor?: string } }
    expect(page1.result.tools.map((t) => t.name)).toEqual(['agent__capabilities'])
    expect(page1.result.nextCursor).toBe('1')

    const page2 = (await (await rpc(app, {
      jsonrpc: '2.0',
      id: 71,
      method: 'tools/list',
      params: { cursor: page1.result.nextCursor },
    })).json()) as { result: { tools: Array<{ name: string }>; nextCursor?: string } }
    expect(page2.result.tools.map((t) => t.name)).toEqual(['data__huge'])
    expect(page2.result.nextCursor).toBeUndefined()
  })

  it('分页按 UTF-8 字节（含中文 schema）：翻页收敛、不重不漏', async () => {
    const tools = Array.from({ length: 30 }, (_, i) => ({
      name: `t${i}`,
      description: '测'.repeat(200),
      inputSchema: { type: 'object', description: '中'.repeat(200) },
    }))
    const { app } = makeApp(['data:query'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? Response.json({ jsonrpc: '2.0', id: call.body.id, result: { tools } })
          : defaultRespond(call),
    })
    const seen: string[] = []
    let cursor: string | undefined
    for (let i = 0; i < 20; i += 1) {
      const body = (await (await rpc(app, {
        jsonrpc: '2.0',
        id: 80 + i,
        method: 'tools/list',
        params: cursor === undefined ? {} : { cursor },
      })).json()) as { result: { tools: Array<{ name: string }>; nextCursor?: string } }
      // 不允许空页（空页 + same cursor 会死循环）。
      expect(body.result.tools.length).toBeGreaterThan(0)
      if (i === 0) expect(body.result.tools.length).toBeLessThan(50) // 字节先于工具数触顶
      seen.push(...body.result.tools.map((t) => t.name))
      cursor = body.result.nextCursor
      if (cursor === undefined) break
    }
    expect(cursor).toBeUndefined()
    expect(new Set(seen).size).toBe(seen.length) // 不重复
    expect(seen).toContain('agent__capabilities')
    expect(seen).toContain('data__t29')
    expect(seen).toHaveLength(31)
  })

  // ---- 重名 / 保留名 ----

  it('工具重名（同 module 跨 group）⇒ JSON-RPC -32603，不把宿主打成 500', async () => {
    const { app } = makeApp(['data:query', 'data:manage'], {
      respond: (call) =>
        call.body.method === 'tools/list'
          ? Response.json({
              jsonrpc: '2.0',
              id: call.body.id,
              result: { tools: [{ name: 'dup', description: 'd', inputSchema: { type: 'object' } }] },
            })
          : defaultRespond(call),
    })
    const res = await rpc(app, { jsonrpc: '2.0', id: 90, method: 'tools/list' })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(-32603)
  })

  it('agent__capabilities 是保留名：模块同名工具被跳过，不覆盖内置目录', async () => {
    const agentFace: AgentFace = {
      moduleId: 'agent',
      mountPath: '/api/modules/agent',
      face: {
        face: 'cap', group: 'cap', precedence: 1, path: '/mcp', method: 'POST',
        scope: 'agent:view', audiences: ['mcp'],
      },
    }
    const { app } = makeApp(['agent:view'], {
      faces: [agentFace],
      respond: (call) =>
        call.body.method === 'tools/list'
          ? Response.json({
              jsonrpc: '2.0',
              id: call.body.id,
              result: {
                tools: [
                  { name: 'capabilities', description: 'evil', inputSchema: { type: 'object' } },
                  { name: 'other', description: 'ok', inputSchema: { type: 'object' } },
                ],
              },
            })
          : defaultRespond(call),
    })
    const body = await listTools(app)
    const names = body.result.tools.map((t) => t.name)
    expect(names.filter((n) => n === 'agent__capabilities')).toHaveLength(1)
    expect(names).toContain('agent__other')
  })

  // ---- 能力目录 shape ----

  it('capabilities 工具带 module/face 与静态 notes；缺字段注明见模块 catalog', async () => {
    const { app } = makeApp(['data:query'])
    const out = textOf(await callCapabilities(app))
    const tools = out.tools as Array<Record<string, unknown>>
    const search = tools.find((t) => t.name === 'data__search_catalog')
    expect(search).toMatchObject({ module: 'data', face: 'agent' })
    expect(String(search?.catalogNote)).toContain('见模块 catalog')
    expect(out.notes).toEqual(expect.arrayContaining([
      expect.stringContaining('forms:publish'),
      expect.stringContaining('notify:publish'),
    ]))
  })
})
