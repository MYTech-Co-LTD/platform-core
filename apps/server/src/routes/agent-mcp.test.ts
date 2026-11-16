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
]

const TOOLS_BY_PATH: Record<string, string[]> = {
  '/mcp-read': ['search_catalog'],
  '/mcp-curated': ['search_catalog', 'query_metric'],
  '/mcp-manage': ['customize_metric'],
  '/mcp-c-manage': ['create_agent_rule'],
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
}

function makeApp(scopes: string[], opts: MakeAppOptions = {}) {
  const app = new Hono<AgentMcpEnv>()
  const calls: ModuleCall[] = []
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
    faces: () => faces,
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
})
