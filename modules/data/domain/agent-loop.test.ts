// agent-loop.test.ts — 通道 A 的 LLM 编排测试。
// 真模型不在单测面：ChatModel 一律注入**脚本化的假实现**（brief Step 1 的口径），
// 断言三件事：① 事件流形状（activity/final，到 MAX_AGENT_TURNS 收尾不抛错）；
// ② 送进模型的历史形状（#28 判别式、拒绝 reason 原样回放）；
// ③ 上下文卫生（dkq_ / DATA_LLM_* 的值绝不进 messages——约束 5）。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertMetric } from './metric-store'
import type { MetricDef, Requester } from './authz'
import type { ChatMessage, ChatModel, ChatTurn, ToolSpec } from './llm'
import { MAX_AGENT_TURNS, runAgentLoop } from './agent-loop'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与 metrics/query/keys/mcp 各文件互不相同。 */
const ORG = 'org-t9-agent'

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

/** 会话通道的请求者：只有 data:query（finance_mrr 挂 data:finance ⇒ 未授权）。 */
function sessionRequester(): Requester {
  const scopes = ['data:query']
  return {
    userId: 'u-t9', orgId: ORG, channel: 'session', keyId: null,
    scopes, hasScope: (code) => scopes.includes(code),
  }
}

/**
 * 假 ChatModel：按脚本逐轮回话（脚本用尽还继续问 ⇒ 永远回最后一项——服务「不收敛」用例）。
 * **逐字快照**每轮收到的 messages 与 tools（引用会被 loop 后续 push 改掉，必须拷贝）。
 */
class FakeChatModel implements ChatModel {
  readonly calls: { messages: ChatMessage[]; tools: ToolSpec[] }[] = []
  constructor(private readonly script: ChatTurn[]) {}
  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<ChatTurn> {
    this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) })
    return structuredClone(this.script[Math.min(this.calls.length - 1, this.script.length - 1)])
  }
}

/** 跑完整个 loop 收事件（生成器要消费完才有「末事件」）。 */
async function collect(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

describePg('runAgentLoop（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  async function seed() {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    await upsertMetric(pool, ORG, FINANCE_MRR)
  }

  /** 供 query_metric 用的假执行器：只认 sales_daily 的形状，另记下收到的 SQL 供断言。 */
  function fakeExecute(log: string[] = []) {
    return async (sql: string) => {
      log.push(sql)
      return { columns: ['day', 'revenue'], rows: [['2026-09-01', 42]] }
    }
  }

  it('先 list_metrics 再 query_metric → 事件流 = 两条 activity + 末事件 final（带表）', async () => {
    await seed()
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'list_metrics', arguments: {} }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'query_metric', arguments: { metricId: 'sales_daily', args: { day_from: '2026-09-01' } } }] },
      { content: '2026-09-01 的收入是 42。', toolCalls: [] },
    ])
    const events = await collect(
      runAgentLoop({ pool, org: ORG, execute: fakeExecute() }, sessionRequester(), model, '上个月销售额'),
    )
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({ type: 'activity', tool: 'list_metrics' })
    expect(events[1]).toMatchObject({ type: 'activity', tool: 'query_metric', detail: '查询指标 sales_daily' })
    expect(events[2]).toMatchObject({
      type: 'final', text: '2026-09-01 的收入是 42。',
      table: { columns: ['day', 'revenue'], rows: [['2026-09-01', 42]] },
    })
    expect(model.calls).toHaveLength(3)
  })

  it('#28 判别式：list_metrics 的工具结果带 status:"metrics"，query 的带 status:"ok"（历史形状完整）', async () => {
    await seed()
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'list_metrics', arguments: {} }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'query_metric', arguments: { metricId: 'sales_daily', args: { day_from: '2026-09-01' } } }] },
      { content: '答完了', toolCalls: [] },
    ])
    await collect(runAgentLoop({ pool, org: ORG, execute: fakeExecute() }, sessionRequester(), model, 'q'))
    // 第二轮：应看到 c1 的 tool 消息，content 是带 status:'metrics' 的 JSON
    const round2Tool = model.calls[1]!.messages.find((m) => m.role === 'tool')
    expect(round2Tool?.toolCallId).toBe('c1')
    const listed = JSON.parse(round2Tool!.content) as { status: string; metrics: { id: string }[] }
    expect(listed.status).toBe('metrics')
    expect(listed.metrics.map((m) => m.id)).toContain('sales_daily')
    // 词表裁剪：data:finance 的 finance_mrr 不在给模型的列表里
    expect(listed.metrics.map((m) => m.id)).not.toContain('finance_mrr')
    // 第三轮：应看到 c2 的 tool 消息，status:'ok' 且主体回包是钉死的 org
    const round3Tool = model.calls[2]!.messages.find((m) => m.role === 'tool' && m.toolCallId === 'c2')
    const queried = JSON.parse(round3Tool!.content) as { status: string; subject: string }
    expect(queried.status).toBe('ok')
    expect(queried.subject).toBe(ORG)
    // assistant 轮原样回放（含 toolCalls）——少了它模型对不上工具结果
    const assistant = model.calls[1]!.messages.find((m) => m.role === 'assistant')
    expect(assistant?.toolCalls?.[0]?.id).toBe('c1')
  })

  it('不收敛（每轮都只要求工具）→ 恰好 MAX_AGENT_TURNS 轮后收尾 final，不是抛错也不是死循环', async () => {
    await seed()
    const sqlLog: string[] = []
    // 脚本只给一项且带 toolCalls ⇒ FakeChatModel 永远回同一形状（服务「不收敛」）
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'cx', name: 'query_metric', arguments: { metricId: 'sales_daily', args: { day_from: '2026-09-01' } } }] },
    ])
    const events = await collect(
      runAgentLoop({ pool, org: ORG, execute: fakeExecute(sqlLog) }, sessionRequester(), model, 'q'),
    )
    expect(model.calls).toHaveLength(MAX_AGENT_TURNS)
    expect(events.filter((e) => (e as { type: string }).type === 'activity')).toHaveLength(MAX_AGENT_TURNS)
    const finals = events.filter((e) => (e as { type: string }).type === 'final')
    expect(finals).toHaveLength(1)
    expect((finals[0] as { text: string }).text).toContain('上限')
    // 收尾时把已有结果带上（每轮查询都成功了）
    expect((finals[0] as { table?: unknown }).table).toMatchObject({ columns: ['day', 'revenue'] })
    expect(sqlLog).toHaveLength(MAX_AGENT_TURNS)
  })

  it('模型要未授权指标（finance_mrr）→ 工具结果是可解释 reason（denied），不是 SQL 错误', async () => {
    await seed()
    const sqlLog: string[] = []
    const model = new FakeChatModel([
      { content: '', toolCalls: [{ id: 'c1', name: 'query_metric', arguments: { metricId: 'finance_mrr', args: {} } }] },
      { content: '你没有权限查看该指标。', toolCalls: [] },
    ])
    const events = await collect(
      runAgentLoop({ pool, org: ORG, execute: fakeExecute(sqlLog) }, sessionRequester(), model, 'q'),
    )
    // 拒绝发生在授权核心 ⇒ 根本没到 SQL
    expect(sqlLog).toHaveLength(0)
    const toolMsg = model.calls[1]!.messages.find((m) => m.role === 'tool')
    const denied = JSON.parse(toolMsg!.content) as { status: string; reason: string }
    expect(denied.status).toBe('denied')
    expect(denied.reason).toBe('metric_not_authorized')
    expect(toolMsg!.content).not.toMatch(/SQL|syntax|error/i)
    expect(events.at(-1)).toMatchObject({ type: 'final', text: '你没有权限查看该指标。' })
  })

  it('约束 5：LLM 上下文（送进 complete 的全部 messages）绝不出现 dkq_ 前缀与 DATA_LLM_* 的值', async () => {
    await seed()
    // 埋哨兵值：PAT 前缀字符串 + 假的环境凭证值。loop 根本不该读它们——本用例是守卫。
    const canary = 'sk-t9-llm-canary-DO-NOT-LEAK'
    process.env.DATA_LLM_API_KEY = canary
    try {
      const model = new FakeChatModel([
        { content: '', toolCalls: [{ id: 'c1', name: 'list_metrics', arguments: {} }] },
        { content: '好了', toolCalls: [] },
      ])
      await collect(runAgentLoop({ pool, org: ORG }, sessionRequester(), model, 'q'))
      expect(model.calls.length).toBeGreaterThan(0)
      for (const call of model.calls) {
        const dump = JSON.stringify(call.messages)
        expect(dump).not.toContain('dkq_')
        expect(dump).not.toContain(canary)
      }
    } finally {
      delete process.env.DATA_LLM_API_KEY
    }
  })

  it('T2 取舍原样告知：query_metric 的工具描述写明等值语义与「同列参数不要同时传」', async () => {
    await seed()
    const model = new FakeChatModel([{ content: '直接答了', toolCalls: [] }])
    await collect(runAgentLoop({ pool, org: ORG }, sessionRequester(), model, 'q'))
    const tools = model.calls[0]!.tools
    expect(tools.map((t) => t.name).sort()).toEqual(['list_metrics', 'query_metric'])
    const spec = tools.find((t) => t.name === 'query_metric')!
    expect(spec.description).toContain('等值')
    expect(spec.description).toContain('同列')
    // 主体不在客户端可指定面：inputSchema 的键里没有 org/subject
    expect(JSON.stringify(spec.inputSchema)).not.toMatch(/"org"|subject/)
  })
})
