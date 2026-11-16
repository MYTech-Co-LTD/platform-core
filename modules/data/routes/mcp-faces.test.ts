// mcp-faces.test.ts — agent 能力网关的三个 data face（spec 2026-11-16 §5.2/§6）。
//
// 本文件只验**工具面选择**（不需要数据库）：
//   · `/mcp-read`（data:read）= 8 个只读工具，无查询工具、无 query_detail、无 legacy；
//   · `/mcp-curated`（data:query）= 13 个分析师工具 + query_detail，无 legacy；
//   · `/mcp`（full）仍注册，且保留给直连客户端（其 list 需要词表 ⇒ 这里只验 initialize）。
// 宿主门卫/网关鉴权不在本壳（buildTestApp 不挂门卫）——这里断言的是模块侧面内工具集合。
// 装配复用 routes/mcp.test.ts 的 buildTestApp/makeIdentity；rpc 多带一个 path 参数。
import { describe, expect, it } from 'vitest'
import type { Hono } from 'hono'
import mod from '../index'
import { buildTestApp, makeIdentity } from '../test-util'

const ORG = 'org-mcp-faces'

/** 一次 JSON-RPC POST（path 可指 /mcp、/mcp-read、/mcp-curated）。 */
async function rpc(app: Hono, path: string, payload: unknown): Promise<Response> {
  return await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

/** tools/list 的工具名（保持服务端顺序）。 */
async function toolNames(app: Hono, path: string): Promise<string[]> {
  const res = await rpc(app, path, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
  expect(res.status).toBe(200)
  const body = await res.json()
  return (body.result.tools as { name: string }[]).map((t) => t.name)
}

/**
 * 审计写库的最小替身：catalog 经 `callTool` 必写一条审计（本文件不连库）。
 * 只回 writeAudit 消费的两列（id / created_at）。
 */
const auditPool = { query: async () => ({ rows: [{ id: 1, created_at: new Date('2026-11-16T00:00:00Z') }] }) }

/** 默认身份 scopes = ['data:query']（与 mcp.test.ts 同款）；需要别的档位时显式传。 */
function makeApp(scopes?: string[]): Hono {
  return buildTestApp(
    mod,
    makeIdentity(scopes === undefined ? { orgId: ORG } : { orgId: ORG, scopes }),
    { pool: null as never },
  )
}

/** 分析师面 13 个工具名 + 静态下钻（与 contract.json 的 mcp 通道一致）。 */
const ANALYST_NAMES = [
  'data_agent_guide', 'data_harness_catalog', 'search_catalog', 'describe_metric',
  'describe_dataset', 'sample_dimension_values', 'preview_query', 'query_metric',
  'explore_query', 'explore_recipe', 'get_freshness', 'get_quality', 'get_lineage',
]
/** 只读 face：faceScope=data:read 的 8 个分析师工具。 */
const READ_NAMES = [
  'data_agent_guide', 'data_harness_catalog', 'search_catalog', 'describe_metric',
  'describe_dataset', 'get_freshness', 'get_quality', 'get_lineage',
]

describe('data agent faces：工具面选择（不需要数据库）', () => {
  it('/mcp-read 只回读工具：8 个 faceScope=data:read；无 query_metric/query_detail/legacy', async () => {
    const names = await toolNames(makeApp(), '/mcp-read')
    expect(names).toEqual(READ_NAMES)
    // 查询/下钻/legacy 一律不在读面（query_detail 是 data:query；legacy 只在 full）。
    expect(names).not.toContain('query_metric')
    expect(names).not.toContain('preview_query')
    expect(names).not.toContain('query_detail')
    expect(names).not.toContain('lemeng__retail__sales')
  })

  it('/mcp-curated 回 13 个分析师工具 + query_detail、无 legacy', async () => {
    const names = await toolNames(makeApp(), '/mcp-curated')
    expect(names).toHaveLength(ANALYST_NAMES.length + 1)
    for (const n of [...ANALYST_NAMES, 'query_detail']) expect(names).toContain(n)
    // legacy 每指标工具（sanitized 名）**不在** curated——这条是 face 分离的核心。
    expect(names).not.toContain('lemeng__retail__sales')
    expect(names).not.toContain('acme__sales__v2')
  })

  it('tools/list 条目不带 faceScope/requiredScope（非 MCP 规范字段不外泄）', async () => {
    const res = await rpc(makeApp(), '/mcp-read', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const body = await res.json()
    for (const tool of body.result.tools as Record<string, unknown>[]) {
      expect(tool.faceScope).toBeUndefined()
      expect(tool.requiredScope).toBeUndefined()
      // 协议字段名仍然齐全（与 full 面同一份 toListEntry 投影）。
      expect(Object.keys(tool).sort()).toEqual(['annotations', 'description', 'inputSchema', 'name', 'outputSchema', 'title'])
    }
  })

  it('read face 调查询工具 ⇒ denied/unknown_tool（本面没有这个工具，不回退 full/legacy）', async () => {
    const app = makeApp()
    for (const name of ['query_metric', 'preview_query', 'query_detail', 'lemeng__retail__sales']) {
      const res = await rpc(app, '/mcp-read', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: {} } })
      const body = await res.json()
      expect(body.result.isError).toBe(true)
      expect(JSON.parse(body.result.content[0].text)).toMatchObject({ status: 'denied', reason: 'unknown_tool', name })
    }
  })

  it('curated face 调 legacy/未知名 ⇒ denied/unknown_tool（无裸 id 回退，不碰数据库）', async () => {
    const app = makeApp()
    for (const name of ['lemeng__retail__sales', 'nope']) {
      const res = await rpc(app, '/mcp-curated', { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name, arguments: {} } })
      const body = await res.json()
      expect(body.result.isError).toBe(true)
      expect(JSON.parse(body.result.content[0].text)).toMatchObject({ status: 'denied', reason: 'unknown_tool', name })
    }
  })

  it('/mcp-read 的 data_harness_catalog：face 透传 ⇒ query 工具 available:false、read 工具 true（curated 全 true）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: auditPool as never })
    const catalogAt = async (path: string) => {
      const res = await rpc(app, path, {
        jsonrpc: '2.0', id: 8, method: 'tools/call',
        params: { name: 'data_harness_catalog', arguments: {} },
      })
      const body = await res.json()
      expect(body.result.isError).toBe(false)
      const payload = JSON.parse(body.result.content[0].text) as {
        tools: { name: string; available: boolean; faceScope: string }[]
      }
      return new Map(payload.tools.map((t) => [t.name, t]))
    }
    // read face：faceScope=data:query 的工具 locked 展示（仍在目录里，但 available:false）
    const read = await catalogAt('/mcp-read')
    expect(read.get('query_metric')?.faceScope).toBe('data:query')
    expect(read.get('query_metric')?.available).toBe(false)
    expect(read.get('preview_query')?.available).toBe(false)
    expect(read.get('search_catalog')?.available).toBe(true)
    expect(read.get('data_agent_guide')?.available).toBe(true)
    // curated face：查询工具可用（面内外同判——锁 mcp.ts 把 face 传进 buildToolboxDeps 的接缝）
    const curated = await catalogAt('/mcp-curated')
    expect(curated.get('query_metric')?.available).toBe(true)
    expect(curated.get('search_catalog')?.available).toBe(true)
  })

  it('三个端点都回 initialize；/mcp full 的 serverName 保持不变（直连客户端不回归）', async () => {
    const app = makeApp()
    const full = await (await rpc(app, '/mcp', { jsonrpc: '2.0', id: 5, method: 'initialize', params: {} })).json()
    expect(full.result.serverInfo.name).toBe('platform-data-mcp')
    const read = await (await rpc(app, '/mcp-read', { jsonrpc: '2.0', id: 6, method: 'initialize', params: {} })).json()
    expect(read.result.serverInfo.name).toBe('platform-data-mcp-read')
    const curated = await (await rpc(app, '/mcp-curated', { jsonrpc: '2.0', id: 7, method: 'initialize', params: {} })).json()
    expect(curated.result.serverInfo.name).toBe('platform-data-mcp-curated')
  })
})
