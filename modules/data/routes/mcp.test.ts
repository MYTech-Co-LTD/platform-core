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
import { upsertL1Metric, upsertMetric } from '../domain/metric-store'
import type { L1MetricDef } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与 metrics/query/keys 各文件互不相同，避免互相擦数据。 */
const ORG = 'org-t8-mcp'
/** 本文件的 L1 夹具 id 前缀（平台桶 `org='platform'` 跨文件共用 ⇒ 清理只按前缀删）。 */
const L1_PREFIX = 't8m:'

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
/** date_range 参数的 schema 映射面（I2 回归锁：type 不透传，落成 {from,to} 对象）。 */
const RANGE_DAILY: MetricDef = {
  id: 'sales_range', title: '区间销售', description: '按日区间汇总的销售明细',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
  groupBy: '',
  params: { bizday: { column: 'bizday', type: 'date_range' } },
}
/**
 * 带下钻绑定的夹具（绑定形状与 drill.test.ts 的 DRILL 同形）：query_detail 的 ok 路径要真走到
 * 下钻 SQL。⚠️ 只能走 **L1 平台行**（upsertL1Metric）：`upsertMetric`（L2 写面）**刻意不写**
 * 下钻三列——L2 声明面没有 compose/dimensions/detail 输入。L1 行带源维度 ⇒ seededApp 以
 * `['lemeng']` 扮演「宿主投影：已接入该源」（query.test.ts 同款）；平台桶跨文件共用 ⇒
 * id 带前缀、afterAll 按前缀清。
 */
const DRILL_NET: L1MetricDef = {
  id: `${L1_PREFIX}drill_net_sales`, title: '净销售额', description: '带明细下钻的销售指标',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, system_book, bizday, sum(net) AS value FROM fct_t GROUP BY system_book, bizday',
  groupBy: 'system_book, bizday',
  params: { bizday: { column: 'bizday', type: 'date_range' } },
  sourceSystem: 'lemeng',
  slaDays: 1, freshnessRelations: [], masks: null,
  drill: {
    expr: '(sale_amount@order - return_amount@line)',
    dims: ['system_book', 'bizday', 'branch_num', 'order_no'],
    relation: 'vw_t',
    filter: "state = 'FINISHED'",
  },
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
    // 平台桶跨文件共用 ⇒ 只删本文件前缀的那些（别 `where org='platform'`，会删掉并行兄弟的夹具）
    await pool.query('delete from data.metrics where org = $1 and id like $2', ['platform', `${L1_PREFIX}%`])
      .catch(() => {})
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  /** 种词表 + 建 app（默认身份 scopes = ['data:query']）。sources=['lemeng'] = DRILL_NET（L1 行）的已接入源。 */
  async function seededApp(ctxExtra: { execute?: SqlExecutor } = {}) {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    await upsertMetric(pool, ORG, FINANCE_MRR, 'fixture')
    await upsertL1Metric(pool, DRILL_NET)
    // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool）
    const ctx = { pool, ...ctxExtra }
    return buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG }, ['lemeng'])
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

  it('tools/list 的 date_range 参数 → 合法对象 schema（{from,to} 必填），绝不透传非法 type:"date_range"（spec 2026-10-15 §2.3）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, RANGE_DAILY, 'fixture')
    const ctx = { pool }
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await rpc(app, { jsonrpc: '2.0', id: 12, method: 'tools/list' })
    expect(res.status).toBe(200)
    const body = await res.json()
    const tool = (body.result.tools as { name: string; inputSchema: {
      properties: Record<string, unknown>
    } }[]).find((t) => t.name === 'sales_range')
    expect(tool).toBeDefined()
    expect(tool!.inputSchema.properties.bizday).toEqual({
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' } },
      required: ['from', 'to'],
      description: '闭区间 YYYY-MM-DD',
    })
    // 回归锁本体：'date_range' 不是合法 JSON-Schema type，出现在 schema 里即坏
    expect(JSON.stringify(tool!.inputSchema)).not.toContain('date_range')
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

  it('tools/call scope 不够的指标（finance_mrr / data:finance）→ denied/metric_not_declared（被裁剪）', async () => {
    const app = await seededApp()
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'finance_mrr', arguments: {} },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    // ★ 计划 5 起 reason 是 `metric_not_declared`（此前 `metric_not_authorized`）：runQuery 先经
    //   `visibleMetrics` 裁剪再 authorize ⇒ 与本文件的 tools/list（finance_mrr 根本不在工具面里）
    //   口径一致。此前两条路径分叉：工具面说「没有这个工具」，直接调却说「存在但没权限」。
    expect(callTextOf(body)).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
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
    // 主体钉死 + 业务参数落位：SQL 只由授权核心拼，MCP 层不改写。
    // ⚠️ Wave 1 起辅助读（新鲜度/维度名）也走 execute 这条缝（warehouseExec = execute）⇒
    //    calls 里会出现 load_log 等辅助 SQL——主计划仍应恰一条（按表名计数）。
    expect(calls.filter((c) => c.includes('mart_sales_daily'))).toHaveLength(1)
    expect(calls[0]).toContain(`WHERE org = '${ORG}'`)
    expect(calls[0]).toContain(`day = '2026-08-15'::date`)
  })

  it('tools/list 含静态下钻工具 query_detail（恒在——工具存在不是存在性探针，required 只有 metricId）', async () => {
    const app = await seededApp()
    const res = await rpc(app, { jsonrpc: '2.0', id: 13, method: 'tools/list' })
    expect(res.status).toBe(200)
    const body = await res.json()
    const tools = body.result.tools as {
      name: string; description: string; inputSchema: { required: string[] }
    }[]
    const detail = tools.find((t) => t.name === 'query_detail')
    expect(detail, 'query_detail 与每指标工具并列出现在 tools/list').toBeDefined()
    expect(detail!.inputSchema.required).toEqual(['metricId'])
    // 条件列缺席 = 未授权（spec 2026-10-22 §2.3/§2.7）：工具文案是四份副本之一，
    // 与 agent-loop / 插件 index.js / SKILL 同口径（少一列 ≠ 没有数据）
    expect(detail!.description).toContain('未授权')
  })

  it('tools/call query_detail → 分发到 runDetailQuery（execute 透传，count 与明细两腿都走假执行器）', async () => {
    // ok 路径会碰仓库缝（维度名解析 / data_as_of）：env 先清（drill.test.ts 同款纪律）
    delete process.env.DATA_WAREHOUSE_URL
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      return /count\(\*\)/.test(sql)
        ? { columns: ['n'], rows: [[15222]] }
        : { columns: ['system_book', 'value'], rows: [['3120', 123.4]] }
    }
    const app = await seededApp({ execute })
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 43, method: 'tools/call',
      params: { name: 'query_detail', arguments: {
        metricId: DRILL_NET.id,
        args: { bizday: { from: '2026-10-19', to: '2026-10-20' } },
        dimensions: ['system_book'], limit: 10,
      } },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.id).toBe(43)
    expect(body.result.isError).toBe(false)
    expect(callTextOf(body)).toMatchObject({
      status: 'ok', subject: ORG, rowCountTotal: 15222, dimensions: ['system_book'],
    })
    // 与 /query/detail 同一 runDetailQuery：下钻 SQL 带请求维度上卷 + value 降序 + limit 透传
    const detailSql = calls.find((s) => !/count\(\*\)/.test(s))
    expect(detailSql).toContain('group by system_book order by value desc limit 10')
    expect(calls.some((s) => /count\(\*\)/.test(s))).toBe(true)
  })

  it('tools/call query_detail 打未声明下钻的指标 → no_detail_binding + isError:true（能力陈述在调用回包）', async () => {
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => { calls.push(sql); return { columns: ['n'], rows: [[1]] } }
    const app = await seededApp({ execute })
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 44, method: 'tools/call',
      params: { name: 'query_detail', arguments: { metricId: 'sales_daily', args: { day_from: '2026-08-15' } } },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    expect(callTextOf(body)).toMatchObject({ status: 'denied', reason: 'no_detail_binding' })
    expect(calls, '能力边界拒绝 ⇒ 从未触达仓库').toEqual([])
  })
})

// ══ 分析师面（spec 2026-10-21：协议 2025-11-25 + registry 驱动 + 信封 + 审计 tool）════════
describePg('POST /mcp 分析师面（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  /** 冒号 id 夹具（sanitize 命名面：tools/list 出 acme__sales__v2，tools/call 可用）。 */
  const ACME_V2: MetricDef = {
    id: 'acme:sales:v2', title: '销售 v2', description: '',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.sales_daily',
    groupBy: '', params: {},
  }

  async function seeded(): Promise<Hono> {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY, 'fixture')
    await upsertMetric(pool, ORG, ACME_V2, 'fixture')
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      return { columns: ['org', 'day'], rows: [[ORG, '2026-08-15']] }
    }
    // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（既有 seededApp 同法）
    const ctx = { pool, execute }
    return buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
  }

  it('initialize 回 2025-11-25', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const body = await res.json()
    expect(body.result.protocolVersion).toBe('2025-11-25')
  })

  it('tools/list：分析师面固定工具在（带 annotations/outputSchema/title）、legacy 指标工具名 sanitized', async () => {
    const app = await seeded()
    const res = await rpc(app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = (await res.json()).result.tools as { name: string; title?: string; annotations?: { readOnlyHint?: boolean }; outputSchema?: unknown }[]
    const names = tools.map((t) => t.name)
    for (const t of ['data_agent_guide', 'data_harness_catalog', 'search_catalog', 'describe_metric', 'query_metric', 'get_freshness']) {
      expect(names).toContain(t)
    }
    expect(names).toContain('sales_daily')          // 无冒号 id 名不变
    expect(names).toContain('acme__sales__v2')      // 冒号 id sanitize
    expect(names).not.toContain('acme:sales:v2')
    const guide = tools.find((t) => t.name === 'data_agent_guide')!
    expect(guide.annotations?.readOnlyHint).toBe(true)
    expect(guide.outputSchema).toBeDefined()
    expect(typeof guide.title).toBe('string')
  })

  it('tools/call data_agent_guide ⇒ structuredContent 在场、isError=false、审计带 tool 且 metric_id 为空串', async () => {
    const app = await seeded()
    const res = await rpc(app, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'data_agent_guide', arguments: {} } })
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    expect(body.result.structuredContent.status).toBe('ok')
    expect(typeof body.result.structuredContent.workflow).toBe('string')
    const audit = await pool.query(
      "select tool, metric_id, row_count from data.query_audit where org = $1 and verdict = 'ok' order by id desc limit 1", [ORG])
    expect(audit.rows[0]).toMatchObject({ tool: 'data_agent_guide', metric_id: '', row_count: null })
  })

  it('tools/call query_metric（经 runQuery 全链）⇒ 信封 structuredContent；主体钉死回声', async () => {
    const app = await seeded()
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'query_metric', arguments: { metricId: 'sales_daily', args: { day_from: '2026-08-15' } } },
    })
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    const env = body.result.structuredContent as Record<string, Record<string, unknown>>
    expect(env.status).toBe('ok')
    expect(env.subject).toMatchObject({ org: ORG })
    expect(env.result).toMatchObject({ rowCount: 1 })
    expect(env.audit).toBeDefined()
  })

  it('tools/call 未声明指标（裸 id，兼容回退路径）⇒ denied/metric_not_declared + 审计留痕', async () => {
    const app = await seeded()
    const res = await rpc(app, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } })
    const body = await res.json()
    expect(body.result.isError).toBe(true)
    // 兼容回退：非工具名的 name 当裸指标 id 走 runQuery ⇒ 拒因与升级前一致（metric_not_declared）
    expect(callTextOf(body as { result: { content: { text: string }[] } })).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
    const audit = await pool.query(
      "select tool, verdict, reason from data.query_audit where org = $1 order by id desc limit 1", [ORG])
    expect(audit.rows[0]).toMatchObject({ tool: 'nope', verdict: 'denied', reason: 'metric_not_declared' })
  })

  it('legacy 工具仍可用：sanitized 名反解回 metricId；structured 透传 runQuery 结果', async () => {
    const app = await seeded()
    const res = await rpc(app, {
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'acme__sales__v2', arguments: {} },
    })
    const body = await res.json()
    expect(body.result.isError).toBe(false)
    expect(callTextOf(body as { result: { content: { text: string }[] } })).toMatchObject({ status: 'ok', subject: ORG })
    expect(body.result.structuredContent.status).toBe('ok')
  })
})
