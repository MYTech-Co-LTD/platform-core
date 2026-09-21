// domain/agent-loop.ts —— 通道 A 的 LLM 编排。工具**只有两个**，且**都走同一个授权核心**
// （spec §5 约束 1：任何通道不得自建权限判定）。
import type { Pool } from 'pg'
import type { MetricDef, Requester } from './authz'
import { visibleMetrics } from './authz'
import { loadCatalog } from './metric-store'
import { runQuery } from './query-service'
import type { SqlExecutor } from './query-service'
import type { ChatMessage, ChatModel, ToolCall, ToolSpec } from './llm'

export type AgentEvent =
  | { type: 'activity'; tool: string; detail: string }
  | { type: 'final'; text: string; table?: { columns: string[]; rows: unknown[][] } }
  | { type: 'error'; reason: string; detail?: string }

export interface AgentDeps { pool: Pool; org: string; execute?: SqlExecutor }

/** 硬上限。超出即收尾出 `final`，**不是**抛错、更不是继续转。 */
export const MAX_AGENT_TURNS = 6

const SYSTEM_PROMPT = [
  '你是平台数据问数助手。只能用提供的工具回答，不要臆造指标名或数字。',
  '你看到的数据**已经按当前用户权限裁剪过**：看不到的指标就是没权限，直接说明即可。',
  '**不要向用户索要或猜测组织/主体（org/subject）**——主体由平台按登录身份钉死，不由请求参数指定。',
  '工具返回 status=denied 时，用其中 reason 向用户解释，不要重试同一个调用。',
].join('\n')

/**
 * 工具面：**两个**。
 * `query_metric` 的 inputSchema **刻意不暴露 org/subject**（spec §5 约束 2）——
 * 主体不属于客户端可指定面，模型连"能不能填"都不该知道。
 * 描述里的等值语义是 T2 记录在案的取舍**原样告知**（硬口径②）：参数只支持等值比较，
 * 同列两个等值参数同传会拼出恒空集且不报错——必须写清，别让模型自己组合出恒空条件。
 */
const TOOLS: ToolSpec[] = [
  {
    name: 'list_metrics',
    description: '列出当前用户有权访问的指标（id / 标题 / 说明）。问数前若不确定指标 id，先调它。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'query_metric',
    description: [
      '按指标 id 查询数据。参数只能来自该指标声明的维度。',
      '参数只做**等值**匹配（不支持区间、大小于、模糊）：需要区间就得让用户改问某一天。',
      '**同列的参数不要同时传**（如 day_from 与 day_to 都对应 day 列时）：',
      '同时传会拼出恒为空的条件——返回空结果且不报错，你会误以为当天没有数据。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: '指标 id，取自 list_metrics' },
        args: {
          type: 'object',
          description: '指标参数（等值过滤）。键必须是指标声明的参数名。',
          additionalProperties: true,
        },
      },
      required: ['metricId'],
    },
  },
]

export async function* runAgentLoop(
  deps: AgentDeps, requester: Requester, model: ChatModel, question: string,
): AsyncGenerator<AgentEvent> {
  // 词表在本轮对话开始时裁剪一次（同一次对话内权限漂移不做中途刷新——改权限下一次问答生效）
  const catalog = visibleMetrics(await loadCatalog(deps.pool, deps.org), requester)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ]
  let lastTable: { columns: string[]; rows: unknown[][] } | undefined

  for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
    const reply = await model.complete(messages, TOOLS)
    // 原样回放 assistant 轮（含 tool_calls）——不回放则下一轮模型对不上工具结果
    messages.push({ role: 'assistant', content: reply.content, toolCalls: reply.toolCalls })

    if (reply.toolCalls.length === 0) {
      yield { type: 'final', text: reply.content, table: lastTable }
      return
    }

    for (const call of reply.toolCalls) {
      yield { type: 'activity', tool: call.name, detail: describeCall(call) }
      const result = await runTool(call, catalog, deps, requester)
      if (result.status === 'ok') lastTable = { columns: result.columns, rows: result.rows }
      // 拒绝结果**原样**回给模型：可解释的 reason 才让它能对用户说清「你没权限」
      messages.push({ role: 'tool', toolCallId: call.id, content: JSON.stringify(result) })
    }
  }

  // 到上限：把已有的表连同说明一起收尾（**不是**抛错）
  yield {
    type: 'final',
    text: '（本轮工具调用已达上限，先把目前查到的结果给你。）',
    table: lastTable,
  }
}

// ⚠️ 联合的**每一支都必须带 `status` 判别式**：调用方靠 `result.status === 'ok'` 收窄
// （见上面 agent loop 里那行）。少给一支加 `status`，`result.status` 就是 TS2339，
// 而 `pnpm --filter data typecheck` 是本任务的验收门禁之一——所以 `list_metrics` 那支
// 也必须写成 `{ status: 'metrics'; metrics: … }`，不能只回 `{ metrics: … }`。
async function runTool(
  call: ToolCall, catalog: MetricDef[], deps: AgentDeps, requester: Requester,
): Promise<{ status: 'ok'; columns: string[]; rows: unknown[][] }
        | { status: 'denied'; metricId: string; reason: string; detail?: string }
        | { status: 'error'; reason: string; detail: string }
        | { status: 'metrics'; metrics: { id: string; title: string; description: string }[] }> {
  if (call.name === 'list_metrics') {
    return { status: 'metrics', metrics: catalog.map((m) => ({ id: m.id, title: m.title, description: m.description })) }
  }
  if (call.name !== 'query_metric') {
    return { status: 'error', reason: 'unknown_tool', detail: call.name }
  }
  const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : ''
  const rawArgs = call.arguments.args
  const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>) : {}
  // 与 MCP 通道**同一个** runQuery ⇒ 同一个授权核心。这里不做任何权限判断。
  return runQuery({ pool: deps.pool, execute: deps.execute }, deps.org, requester, metricId, args)
}

/** 活动事件的展示文案。**只放 id 与非敏感参数**——SQL、主体值、凭证都不进事件流。 */
function describeCall(call: ToolCall): string {
  if (call.name === 'list_metrics') return '列出可用指标'
  const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : '(未指定)'
  return `查询指标 ${metricId}`
}
