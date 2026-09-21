// chat.test.ts — POST /chat（通道 A 的 SSE 端点）测试。
// 三个面：① llmFromEnv 的 env 解析与 fail-closed（只测这两个，真 LLM 调用不在单测面）；
// ② 未配 DATA_LLM_* ⇒ 503 LLM_UNCONFIGURED（可解释，不是 500）；
// ③ SSE 形状：text/event-stream + 事件序列里有 activity 与 final。
// 真模型不在单测面：SSE 用例里 fetch 被 stub 成脚本化的 OpenAI 兼容应答。
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'
import { llmFromEnv } from '../domain/llm'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 与本模块其他测试文件互不相同的隔离键。 */
const ORG = 'org-t9-chat'

const LLM_ENV = {
  DATA_LLM_BASE_URL: 'http://llm.test/v1',
  DATA_LLM_API_KEY: 'sk-t9-chat-key',
  DATA_LLM_MODEL: 'test-model',
}
function setLlmEnv(on: boolean): void {
  for (const k of Object.keys(LLM_ENV)) {
    if (on) process.env[k] = LLM_ENV[k as keyof typeof LLM_ENV]
    else delete process.env[k]
  }
}
afterAll(() => setLlmEnv(false))

/** 一次性把三个 env 键都删干净（默认态 = 通道 A 未配置）。 */
function noLlm(): void {
  setLlmEnv(false)
}

describe('llmFromEnv（纯函数，不需要数据库）', () => {
  it('三键全在 → 解析出 LlmConfig，且 trim 生效', () => {
    const cfg = llmFromEnv({
      DATA_LLM_BASE_URL: '  https://llm.example/v1  ',
      DATA_LLM_API_KEY: ' k ',
      DATA_LLM_MODEL: ' m ',
    })
    expect(cfg).toEqual({ baseUrl: 'https://llm.example/v1', apiKey: 'k', model: 'm' })
  })

  it('任一键缺失或空白 ⇒ null（fail-closed：部署没开通道 A 不是故障）', () => {
    expect(llmFromEnv({ DATA_LLM_API_KEY: 'k', DATA_LLM_MODEL: 'm' })).toBeNull()
    expect(llmFromEnv({ DATA_LLM_BASE_URL: 'https://x', DATA_LLM_MODEL: 'm' })).toBeNull()
    expect(llmFromEnv({ DATA_LLM_BASE_URL: 'https://x', DATA_LLM_API_KEY: 'k' })).toBeNull()
    expect(llmFromEnv({ DATA_LLM_BASE_URL: '  ', DATA_LLM_API_KEY: 'k', DATA_LLM_MODEL: 'm' })).toBeNull()
  })
})

describe('POST /chat 的配置门与入参门（不需要数据库）', () => {
  it('未配 DATA_LLM_* → 503 LLM_UNCONFIGURED（可解释，不是 500）', async () => {
    noLlm()
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'q' }),
    })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'LLM_UNCONFIGURED' })
  })

  it('配了 LLM 但 body 非法（question 为空）→ 400 INVALID_BODY', async () => {
    setLlmEnv(true)
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: '' }),
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'INVALID_BODY' })
  })

  it('配了 LLM 但 body 不是 JSON → 400 INVALID_BODY（不是 500）', async () => {
    setLlmEnv(true)
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    })
    expect(res.status).toBe(400)
  })

  it('M3 守卫拒掉请求者（空 orgId）→ 403 UNAUTHENTICATED（fail-closed，不进编排）', async () => {
    setLlmEnv(true)
    const app = buildTestApp(mod, makeIdentity({ orgId: '' }), { pool: null as never })
    const res = await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'q' }),
    })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })
})

describePg('POST /chat 的 SSE 形状（需要 DATABASE_URL；fetch stub 成脚本化 LLM）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const SALES_DAILY: MetricDef = {
    id: 'sales_daily', title: '销售日明细', description: '按日汇总的销售明细',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
    groupBy: '',
    params: { day_from: { column: 'day', type: 'date', required: true } },
  }
  const execute: SqlExecutor = async () => ({ columns: ['day', 'revenue'], rows: [['2026-09-01', 42]] })
  // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool）
  const ctx = { pool, execute }

  /** OpenAI 兼容应答（一次 fetch 一回）。 */
  const wire = (body: unknown) => new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  })
  const toolTurn = { choices: [{ message: { content: '', tool_calls: [{
    id: 'c1', type: 'function',
    function: { name: 'query_metric', arguments: '{"metricId":"sales_daily","args":{"day_from":"2026-09-01"}}' },
  }] } }] }
  const finalTurn = { choices: [{ message: { content: '2026-09-01 的收入是 42。' } }] }

  async function ask(app: Hono): Promise<Response> {
    return await app.request('/chat', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: '上个月各门店销售额' }),
    })
  }

  /** 解析 SSE 正文里的全部 data: 行。 */
  function parseEvents(text: string): Record<string, unknown>[] {
    return text.split('\n\n')
      .filter((block) => block.startsWith('data: '))
      .map((block) => JSON.parse(block.slice(6)))
  }

  it('SSE：content-type 正确、事件序列 = activity + final（带表）、key 只出现在请求头', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    setLlmEnv(true)

    const fetchCalls: { url: string; init: RequestInit }[] = []
    let call = 0
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init: init ?? {} })
      call += 1
      return wire(call === 1 ? toolTurn : finalTurn)
    })

    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await ask(app)

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    // edge/nginx 默认缓冲会攒住 SSE——显式关掉的头必须在
    expect(res.headers.get('x-accel-buffering')).toBe('no')

    const events = parseEvents(await res.text())
    expect(events[0]).toMatchObject({ type: 'activity', tool: 'query_metric' })
    expect(events.at(-1)).toMatchObject({
      type: 'final', text: '2026-09-01 的收入是 42。',
      table: { columns: ['day', 'revenue'], rows: [['2026-09-01', 42]] },
    })
    // 供应商调用：URL 是 <baseUrl>/chat/completions，凭证只出现在 Authorization 头
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls[0]!.url).toBe('http://llm.test/v1/chat/completions')
    const headers = fetchCalls[0]!.init.headers as Record<string, string>
    expect(headers.authorization).toBe(`Bearer ${LLM_ENV.DATA_LLM_API_KEY}`)
    // key 不出现在请求体里（只在头）
    expect(JSON.stringify(fetchCalls[0]!.init.body)).not.toContain(LLM_ENV.DATA_LLM_API_KEY)
  })

  it('SSE 里的失败用事件表达：LLM HTTP 错 ⇒ error 事件（流已开头，不再换状态码）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    setLlmEnv(true)
    vi.stubGlobal('fetch', async () => new Response('upstream boom', { status: 502 }))

    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await ask(app)

    // 状态码仍是 200（流已开头发不出去 5xx），失败走 error 事件，detail 是 LlmError 的自述
    expect(res.status).toBe(200)
    const events = parseEvents(await res.text())
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', reason: 'AGENT_FAILED', detail: 'LLM_HTTP_502' })
  })
})
