// mcp.test.ts — POST /mcp 的 MCP 端点测试（通道 B 的协议面）。
// 模块壳（buildTestApp）不挂宿主门卫与 PAT 中间件——鉴权链归 T10 的端到端；
// 这里验三层：① stateless JSON-RPC 协议面（id 回显 / 通知 202 / 错误码族不是 500）；
// ② 方法面（initialize / ping / tools/list / tools/call，未知方法 -32601——派发单「只有
// tools/list 与 tools/call」两条经裁决作废，以 brief 四方法为准）；
// ③ 与授权核心的对接：词表裁剪只走 visibleMetrics、保留键拒走 runQuery（MCP 层不自建判定）、
// execute 经 RouteCtx 透传（T6 建链，这里只消费）。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与 metrics/query/keys 各文件互不相同，避免互相擦数据。 */
const ORG = 'org-t8-mcp'

// 词表形状照 domain/authz.ts 的 MetricDef（主体列 org，与 ORG 同值 ⇒ 主体钉死可断言）。
// sales_daily 无 requiredScope（拿到 data:query 即可见）；finance_mrr 挂 data:finance ⇒ 裁掉。
const SALES_DAILY: MetricDef = {
  id: 'sales_daily', title: '销售日明细', description: '按日汇总的销售明细',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
  groupBy: '',
  params: { day_from: { column: 'day', type: 'date', required: true } },
}
const FINANCE_MRR: MetricDef = {
  id: 'finance_mrr', title: '财务月度经常性收入', description: '',
  requiredScope: 'data:finance', subjectColumn: 'org',
  selectSql: 'SELECT org, mrr FROM marts.mart_finance_mrr',
  groupBy: '', params: {},
}

/** 一次 JSON-RPC POST。raw 直接给字符串可测「不可解析 body」。 */
async function rpc(app: Hono, payload: unknown): Promise<Response> {
  // await 收敛 Hono 的 `Response | Promise<Response>` 联合返回（app.request 的重载面）
  return await app.request('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}

/** tools/call 的业务载荷：content[0].text 是 runQuery 的 JSON 串——协议外壳与业务结局的接缝。 */
function callTextOf(body: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>
}

describe('POST /mcp 的协议面（不需要数据库）', () => {
  it('initialize → protocolVersion 是字符串、capabilities.tools 存在；id 原样回显', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 'init-echo', method: 'initialize', params: {} })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.id).toBe('init-echo')
    expect(typeof body.result.protocolVersion).toBe('string')
    expect(body.result.capabilities.tools).toBeDefined()
    expect(body.result.serverInfo).toBeDefined()
  })

  it('ping → 空 result（数字 id 同样原样回显）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 9, method: 'ping' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(9)
    expect(body.result).toEqual({})
  })

  it('通知（无 id）→ 202 且 body 为空（MCP 明确要求不回）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
  })

  it('未知方法 → JSON-RPC error -32601（不是 500）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 7, method: 'resources/list' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(7)
    expect(body.error.code).toBe(-32601)
    expect(body.result).toBeUndefined()
  })

  it('body 不可解析 → -32700 parse error（JSON-RPC 错误响应，不是 500）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, '{')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.jsonrpc).toBe('2.0')
    expect(body.error.code).toBe(-32700)
  })

  it('可解析但缺 jsonrpc 版本 → -32600 invalid request', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { id: 3, method: 'ping' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error.code).toBe(-32600)
  })

  it('可解析但缺 method → -32600 invalid request', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 4, params: {} })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.error.code).toBe(-32600)
  })

  it('tools/list 且 M3 守卫拒掉请求者（空 orgId）→ 空 tools，不碰词表（词表对其看不见，不是报错）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: '' }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 11, method: 'tools/list' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result).toEqual({ tools: [] })
  })
})

describePg('POST /mcp 的方法面（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  /** 种词表 + 建 app（默认身份 scopes = ['data:query']）。 */
  async function seededApp(ctxExtra: { execute?: SqlExecutor } = {}) {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    await upsertMetric(pool, ORG, FINANCE_MRR)
    // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool）
    const ctx = { pool, ...ctxExtra }
    return buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
  }

  it('tools/list → 词表内（sales_daily）在、data:finance（finance_mrr）不在——裁剪只走 visibleMetrics', async () => {
    const app = await seededApp()
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = (body.result.tools as { name: string }[]).map((t) => t.name)
    expect(names).toContain('sales_daily')
    expect(names).not.toContain('finance_mrr')
  })

  it('tools/list 的 inputSchema.properties 只含业务参数——org/subject 不在客户端可指定面', async () => {
    const app = await seededApp()
    const res = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/list' })
    const body = await res.json()
    const tool = (body.result.tools as { name: string; inputSchema: {
      type: string; properties: Record<string, unknown>; required: string[]
    } }[]).find((t) => t.name === 'sales_daily')
    expect(tool).toBeDefined()
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(['day_from'])
    expect(tool!.inputSchema.properties.org).toBeUndefined()
    expect(tool!.inputSchema.properties.subject).toBeUndefined()
    expect(tool!.inputSchema.required).toEqual(['day_from'])
  })

  it('tools/call 未声明指标 → denied/metric_not_declared + isError:true', async () => {
    const app = await seededApp()
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(callTextOf(body)).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
  })

  it('tools/call 未授权指标（finance_mrr / data:finance）→ denied/metric_not_authorized', async () => {
    const app = await seededApp()
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'finance_mrr', arguments: {} },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(callTextOf(body)).toMatchObject({ status: 'denied', reason: 'metric_not_authorized' })
  })

  it('tools/call 在 arguments 里传 org → denied/subject_pinned_by_platform（拒因出自 runQuery，MCP 层不自建判定）', async () => {
    const app = await seededApp()
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'sales_daily', arguments: { org: 'someone-else' } },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(callTextOf(body)).toMatchObject({ status: 'denied', reason: 'subject_pinned_by_platform' })
  })

  it('tools/call 正常 → ok/subject/rows；execute 经 RouteCtx 透传（不碰真仓库）且主体钉死', async () => {
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      return { columns: ['org', 'day'], rows: [[ORG, '2026-08-15']] }
    }
    const app = await seededApp({ execute })
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'sales_daily', arguments: { day_from: '2026-08-15' } },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(42)
    expect(body.result.isError).toBe(false)
    expect(callTextOf(body)).toMatchObject({
      status: 'ok', subject: ORG, rows: [[ORG, '2026-08-15']],
    })
    // 主体钉死 + 业务参数落位：SQL 只由授权核心拼，MCP 层不改写
    expect(calls.length).toBe(1)
    expect(calls[0]).toContain(`WHERE org = '${ORG}'`)
    expect(calls[0]).toContain(`day = '2026-08-15'::date`)
  })
})
