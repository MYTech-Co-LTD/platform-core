// catalog-consumers.test.ts — **消费面词表四通道一致**（T8 评审 C1 的机器判据）。
//
// ── 为什么必须单开一个文件（这是本文件存在的全部理由）──────────────────────────────
// C1 的缺陷类是「某个消费通道用了只回本 org 的加载器（`loadOrgCatalog`）」——
// 它对**行为**测试是**结构性不可见**的：每条通道各自的测试都用
// `upsertMetric(pool, <本租户 org>, …)` 铺夹具，夹具永远落在租户桶里，
// 于是「平台 L1 行在这条通道上不可达」没有任何用例会红（团队 #50/#51 的同一原型）。
// 本文件把**四条面**放在**同一份夹具**上对比，让「同一 id 在任一通道上解析结果一致」
// 成为一条真断言，而不是一句注释。
//
// 四条面（评审原文的口径）：① `POST /query` ② MCP `tools/list` ③ chat（`POST /chat`）
// ④ `GET /metrics`。前三条改前应当看不到平台 L1 指标（红），第四条改前就看得见——
// 「同一 id 在两条通道上胜负相反」正是 C1 的核心症状。
//
// **来源级守卫**另起一组（不需要数据库）：行为断言只能覆盖「今天这四条面」，
// 来源守卫覆盖「明天新增的第五条」——它钉的是「消费面只有**一个**词表加载器」这件事本身。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from './index'
import { applyMigrations, buildTestApp, makeIdentity } from './test-util'
import { L1_ORG, upsertL1Metric, upsertMetric } from './domain/metric-store'
import type { L1MetricDef } from './domain/metric-store'
import type { MetricDef } from './domain/authz'
import type { SqlExecutor } from './domain/query-service'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text）——与本模块其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-t8-consumers'
/** 本文件的 L1 夹具 id 前缀（平台桶跨文件共用 ⇒ 清理只按前缀删，别 `where org='platform'`）。 */
const L1_PREFIX = 't8c:'

const PLATFORM_ID = `${L1_PREFIX}net_sales`
const CLASH_ID = `${L1_PREFIX}clash`
/** 存在、但本租户**未接入**的源（`shanhai`）的 L1 指标 —— 源维度裁剪的探针（计划 5 Task 5）。 */
const FOREIGN_ID = `${L1_PREFIX}shanhai_margin`

/**
 * 本租户**已接入的源**（宿主投影 `TENANT_SOURCES` 的测试替身）。夹具里的 `lemeng` 是当前
 * 唯一已接入源；`FOREIGN` 那条挂在 `shanhai` 上 ⇒ 它对本租户**处处不可见**（四条面都要如此）。
 */
const ADOPTED = ['lemeng']

/**
 * 平台 L1 指标（夹具经 `upsertL1Metric` 落平台桶 = sync 的产物；管理 API 写不出 l1 行）。
 * `select_sql` 里的 `fct_t8c.platform_amount` 是**它在 SQL 里的指纹**——
 * 断言「这一条真的被查了」时认这个串，而不是认「200」。
 */
const L1_PLATFORM: L1MetricDef = {
  id: PLATFORM_ID, title: '平台净销售额', description: '平台口径净销售额',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select sum(fct_t8c.platform_amount) as value from fct_t8c',
  groupBy: '', params: {},
  // L1 行恒有源（源维度进声明面 = Task 3）——本夹具是「sync 的产物」，故与声明同形。
  sourceSystem: 'lemeng',
}

/** 撞 id 的两个版本：租户**先**建 L2，平台**事后**同 id 物化（写侧闸门只拦「L1 已存在」的时序）。 */
const L1_CLASH: L1MetricDef = {
  id: CLASH_ID, title: '平台版', description: '平台版说明',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select sum(fct_t8c.l1_amount) as value from fct_t8c',
  groupBy: '', params: {},
  sourceSystem: 'lemeng',
}
const L2_CLASH: MetricDef = {
  id: CLASH_ID, title: '租户版', description: '租户版说明',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select sum(fct_t8c.l2_amount) as value from fct_t8c',
  groupBy: '', params: {},
}

/** chat 面要一份 LLM env（SSE 用例 stub fetch，不打真模型）。 */
const LLM_ENV: Record<string, string> = {
  DATA_LLM_BASE_URL: 'http://llm.test/v1',
  DATA_LLM_API_KEY: 'sk-t8c-key',
  DATA_LLM_MODEL: 'test-model',
}

/** 「未接入源」的 L1 夹具（`lemeng` 之外 ⇒ 源维度裁剪应把它从四条面上全部拿掉）。 */
const L1_FOREIGN: L1MetricDef = {
  id: FOREIGN_ID, title: '山海毛利', description: '别的源的平台口径',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select sum(fct_t8c.foreign_amount) as value from fct_t8c',
  groupBy: '', params: {},
  sourceSystem: 'shanhai',
}

const post = (app: Hono, path: string, body: unknown) => app.request(path, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
})

const rpc = (app: Hono, payload: unknown) => post(app, '/mcp', payload)

/** 解析 SSE 正文里的全部 data: 行（与 chat.test.ts 同一口径）。 */
const parseEvents = (text: string): Record<string, unknown>[] =>
  text.split('\n\n').filter((b) => b.startsWith('data: ')).map((b) => JSON.parse(b.slice(6)))

describe('消费面词表的来源守卫（不需要数据库）', () => {
  /**
   * 四条**读词表**的消费面，逐文件钉住它引用的是哪一个加载器。
   * 为什么读源码而不是跑行为：行为断言只能覆盖今天写下的场景；本组断言覆盖
   * 「这个模块的**词表来源**是哪一个」——那正是 C1 里漂掉的东西。
   */
  const CONSUMERS = [
    'domain/query-service.ts', // ① POST /query（通道 C + MCP tools/call）
    'domain/agent-loop.ts', // ③ chat（POST /chat 的编排）
    'routes/mcp.ts', // ② MCP tools/list
    'routes/metrics.ts', // ④ GET /metrics
  ] as const
  /**
   * 读宿主「已接入源」投影的**接线点**：四个路由文件（域层经 deps 收，路由层读投影）。
   * 与 CONSUMERS 是两个不同的集合：CONSUMERS 是「谁裁词表」，WIRING 是「谁把源集合供给裁剪」。
   */
  const WIRING = [
    'routes/metrics.ts', // ④ GET /metrics
    'routes/mcp.ts', // ② MCP tools/list + tools/call
    'routes/query.ts', // ① POST /query 的接线（域层的 runQuery 经 deps 收）
    'routes/chat.ts', // ③ chat 的接线（域层的 runAgentLoop 经 deps 收）
  ] as const
  const sourceOf = (rel: string) => readFileSync(new URL(`./${rel}`, import.meta.url), 'utf8')

  it('四条面的来源都引用**合并**加载器 loadMergedCatalog（= L1 ∪ 本 org 的单一落点）', () => {
    for (const rel of CONSUMERS) {
      expect(sourceOf(rel), `${rel} 没有引用合并词表加载器 ⇒ 它的词表不再是 L1 ∪ 本 org`)
        .toMatch(/\bloadMergedCatalog\b/)
    }
  })

  it('四条面的来源都不引用只回本 org 的 loadOrgCatalog（用了它则平台 L1 在该通道不可达）', () => {
    for (const rel of CONSUMERS) {
      expect(sourceOf(rel), `${rel} 引用了只回本 org 的加载器 ⇒ 平台 L1 指标在这条通道上不可达`)
        .not.toMatch(/\bloadOrgCatalog\b/)
    }
  })

  /**
   * 源维度裁剪（计划 5 Task 5）的来源守卫：裁剪只许经 `visibleMetrics`（授权核心单实现），
   * 且「本租户已接入源」必须真的读到了宿主投影。为什么还要机器判一层：`visibleMetrics` 的
   * 第三参是**必填**（漏传是编译错），但编译器管不住「传了个空集 / 传了个恒全集」——
   * 而这两种错法都不可观测（一个整片消失、一个放行未接入源）。故把两件事分别钉住：
   *   · 谁裁词表（CONSUMERS）——都经唯一裁剪函数；
   *   · 谁供源集合（WIRING）——都在路由层读宿主投影 `TENANT_SOURCES`（域层经 deps 收，
   *     路由层是唯一能读 context 的地方）。
   */
  it('四条面的词表裁剪都经唯一裁剪函数 visibleMetrics（绕开它就不知道源维度）', () => {
    for (const rel of CONSUMERS) {
      expect(sourceOf(rel), `${rel} 没引用唯一裁剪函数 visibleMetrics ⇒ 这条通道不裁（源维度失效）`)
        .toMatch(/\bvisibleMetrics\b/)
    }
  })

  it('四条面的「已接入源」都取自宿主投影 TENANT_SOURCES（漏一处 = 那条路径拿不到源集合）', () => {
    for (const rel of WIRING) {
      expect(sourceOf(rel), `${rel} 没读宿主投影 TENANT_SOURCES ⇒ 这条通道拿不到已接入源`)
        .toMatch(/\bTENANT_SOURCES\b/)
    }
  })
})

describePg('消费面词表四通道一致（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  /** 注入的执行器：只记录 SQL，不碰真仓库（断言面 = 「跑的是哪段口径」）。 */
  let executed: string[] = []
  const execute: SqlExecutor = async (sql) => {
    executed.push(sql)
    return { columns: ['value'], rows: [[1]] }
  }
  const ctx = { pool, execute }
  const app = (org = ORG, sources: string[] = ADOPTED) =>
    buildTestApp(mod, makeIdentity({ orgId: org, scopes: ['data:query', 'data:manage'] }), ctx,
      { id: 1, casdoor_org: org }, sources)

  beforeAll(async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, L1_PLATFORM)
    await upsertL1Metric(pool, L1_CLASH)
    await upsertL1Metric(pool, L1_FOREIGN)
    // 撞 id 的 L2 行直落存储层（等价于「租户先建、平台后物化」那条合法时序；
    // 走管理 API 建不出来——写侧闸门会以 409 ID_RESERVED_BY_L1 拦下）
    await upsertMetric(pool, ORG, L2_CLASH)
  })

  beforeEach(() => { executed = []; for (const k of Object.keys(LLM_ENV)) process.env[k] = LLM_ENV[k]! })
  afterEach(() => {
    vi.unstubAllGlobals()
    for (const k of Object.keys(LLM_ENV)) delete process.env[k]
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    // 平台桶跨文件共用 ⇒ 只删本文件前缀的那些（别 `where org='platform'`，会删掉并行兄弟的夹具）
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${L1_PREFIX}%`])
      .catch(() => {})
    await pool.end().catch(() => {})
  })

  // ── 面①：POST /query ────────────────────────────────────────────────────────
  it('面① POST /query：平台 L1 指标可见且可查（跑的就是 L1 那段口径）', async () => {
    const res = await post(app(), '/query', { metricId: PLATFORM_ID, args: {} })
    expect(res.status, '平台 L1 指标在 /query 上不可达 ⇒ 消费通道的词表没合并').toBe(200)
    expect((await res.json()).status).toBe('ok')
    expect(executed[0]).toContain('fct_t8c.platform_amount')
  })

  it('面① POST /query：撞 id 时 L1 赢（与面④同胜者，不是租户那条 SQL）', async () => {
    const res = await post(app(), '/query', { metricId: CLASH_ID, args: {} })
    expect(res.status).toBe(200)
    expect(executed[0], '同一 id 在 /query 上跑了租户那条 SQL ⇒ 与 GET /metrics 口径分叉').toContain('fct_t8c.l1_amount')
    expect(executed[0]).not.toContain('fct_t8c.l2_amount')
  })

  // ── 面②：MCP tools/list + tools/call ───────────────────────────────────────
  it('面② MCP tools/list：平台 L1 指标出现在工具面里', async () => {
    const res = await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const names = (await res.json()).result.tools.map((t: { name: string }) => t.name)
    expect(names, '平台 L1 指标不在 MCP 工具面里 ⇒ agent 看不见平台指标').toContain(PLATFORM_ID)
  })

  it('面② MCP tools/call：撞 id 时 L1 赢', async () => {
    const res = await rpc(app(), {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: CLASH_ID, arguments: {} },
    })
    const body = await res.json()
    expect(body.result.isError, '撞 id 的 L1 指标在 MCP 上查不通').toBe(false)
    expect(executed[0]).toContain('fct_t8c.l1_amount')
  })

  // ── 面③：chat（POST /chat，SSE）─────────────────────────────────────────────
  /** 一次 fetch 一回的 OpenAI 兼容应答；脚本：第一轮调 query_metric，第二轮收尾。 */
  const wire = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  const toolTurn = (metricId: string) => ({ choices: [{ message: { content: '', tool_calls: [{
    id: 'c1', type: 'function',
    function: { name: 'query_metric', arguments: JSON.stringify({ metricId, args: {} }) },
  }] } }] })
  const finalTurn = { choices: [{ message: { content: '查到了。' } }] }

  async function ask(metricId: string): Promise<Record<string, unknown>[]> {
    let call = 0
    vi.stubGlobal('fetch', async () => { call += 1; return wire(call === 1 ? toolTurn(metricId) : finalTurn) })
    const res = await post(app(), '/chat', { question: '平台净销售额是多少' })
    expect(res.status).toBe(200)
    return parseEvents(await res.text())
  }

  it('面③ chat：平台 L1 指标可被 agent 查到（final 事件带表，不是 isError）', async () => {
    const events = await ask(PLATFORM_ID)
    expect(events[0]).toMatchObject({ type: 'activity', tool: 'query_metric' })
    expect(events.at(-1), 'chat 面查不到平台 L1 指标（词表里没有它）')
      .toMatchObject({ type: 'final', table: { columns: ['value'], rows: [[1]] } })
    expect(executed[0]).toContain('fct_t8c.platform_amount')
  })

  it('面③ chat：撞 id 时 L1 赢', async () => {
    await ask(CLASH_ID)
    expect(executed[0], '同一 id 在 chat 上跑了租户那条 SQL ⇒ 与 GET /metrics 口径分叉')
      .toContain('fct_t8c.l1_amount')
  })

  // ── 面④：GET /metrics（改前就正确的那条面——C1 的症状正是「与它胜负相反」）────
  it('面④ GET /metrics：平台 L1 指标在列表里（改前即绿，是三条红的对照面）', async () => {
    const res = await app().request('/metrics')
    const ids = (await res.json()).metrics.map((m: { id: string }) => m.id)
    expect(ids).toContain(PLATFORM_ID)
  })

  it('面④ GET /metrics：撞 id 时 L1 赢（四条面必须同胜者）', async () => {
    const res = await app().request('/metrics')
    const clash = (await res.json()).metrics.find((m: { id: string }) => m.id === CLASH_ID)
    expect(clash).toMatchObject({ title: '平台版', description: '平台版说明' })
  })

  // ── 源维度裁剪：四条面都不许放行「未接入源」的指标（计划 5 Task 5）────────────────
  // 与上面「同一 id 四条面同胜者」同一精神：**四条面放在同一份夹具上对比**。
  // 未接入源的那条 L1（`sourceSystem: 'shanhai'`，本租户只接了 `lemeng`）报得出 id 也不行——
  // /query 与 chat 的解析路径经裁剪后按「未声明」拒（看不见，不是报错），MCP / GET /metrics
  // 直接不出现。任何一条面放行它，「四消费方都经 visibleMetrics」就出现了绕开点。
  it('面① POST /query：未接入源的 L1 一律拒（metric_not_declared），且从不触达仓库', async () => {
    const res = await post(app(), '/query', { metricId: FOREIGN_ID, args: {} })
    expect(res.status, '未接入源的指标在 /query 上被放行了').toBe(403)
    expect((await res.json()).reason).toBe('metric_not_declared')
    expect(executed, '被拒的请求不该跑任何 SQL').toEqual([])
  })

  it('面② MCP tools/list：未接入源的 L1 不出现在工具面里（agent 连它存不存在都看不到）', async () => {
    const res = await rpc(app(), { jsonrpc: '2.0', id: 91, method: 'tools/list' })
    const names = (await res.json()).result.tools.map((t: { name: string }) => t.name)
    expect(names, '未接入源的指标出现在 MCP 工具面里').not.toContain(FOREIGN_ID)
  })

  it('面③ chat：未接入源的 L1 查不到（工具结果是 denied，末事件不带表）', async () => {
    const events = await ask(FOREIGN_ID)
    const final = events.at(-1) as { type: string; table?: unknown }
    expect(final.type).toBe('final')
    expect(final.table, '未接入源的指标在 chat 上被查出来了').toBeUndefined()
  })

  it('面④ GET /metrics：未接入源的 L1 不在列表里', async () => {
    const res = await app().request('/metrics')
    const ids = (await res.json()).metrics.map((m: { id: string }) => m.id)
    expect(ids, '未接入源的指标出现在 GET /metrics 上').not.toContain(FOREIGN_ID)
  })
})
