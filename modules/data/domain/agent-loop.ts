// domain/agent-loop.ts —— 通道 A 的 LLM 编排。工具**只有三把**，且**都走同一个授权核心**
// （spec §5 约束 1：任何通道不得自建权限判定）。
import type { Pool } from 'pg'
import type { MetricDef, MetricParamFace, Requester } from './authz'
import { paramFaceOf, visibleMetrics } from './authz'
import { runDetailQuery } from './drill'
import { loadMergedCatalog } from './metric-store'
import { runQuery } from './query-service'
import type { SqlExecutor } from './query-service'
import type { ChatMessage, ChatModel, ToolCall, ToolSpec } from './llm'
import { ANALYST_TOOLS, callTool, type ToolboxDeps } from './toolbox/registry'
import { buildToolboxDeps } from './toolbox/all'
import { GUIDE_INVARIANTS } from './toolbox/guide'

export type AgentEvent =
  | { type: 'activity'; tool: string; detail: string }
  | { type: 'final'; text: string; table?: { columns: string[]; rows: unknown[][] } }
  | { type: 'error'; reason: string; detail?: string }

export interface AgentDeps {
  pool: Pool
  org: string
  execute?: SqlExecutor
  /**
   * 本租户**已接入的源**（宿主投影 `TENANT_SOURCES`；计划 5）。**必填**——理由与
   * `QueryDeps.adoptedSources` 同：少了它，`list_metrics` 会把别的源的指标列给 agent、
   * `query_metric` 会放行硬编码的未接入源 id（两条都正是 spec §3⑧ 要堵的）。
   * 由路由（`routes/chat.ts`）读投影后传入；本函数再把它透传给 `runQuery`（同一份事实）。
   */
  adoptedSources: ReadonlySet<string>
}

/** 硬上限。超出即收尾出 `final`，**不是**抛错、更不是继续转。 */
export const MAX_AGENT_TURNS = 6

const SYSTEM_PROMPT = [
  '你是平台数据问数助手。只能用提供的工具回答，不要臆造指标名或数字。',
  '你看到的数据**已经按当前用户权限裁剪过**：看不到的指标就是没权限，直接说明即可。',
  '工具返回 status=denied 时，用其中 reason 向用户解释，不要重试同一个调用。',
  ...GUIDE_INVARIANTS, // 通道中性硬约束：与 guide.ts（B）、SKILL.md（C）同源（Wave 2 决策 D-G1）
].join('\n')

/**
 * 工具面：**三把**。
 * `query_metric` / `query_detail` 的 inputSchema **刻意不暴露 org/subject**（spec §5 约束 2）——
 * 主体不属于客户端可指定面，模型连"能不能填"都不该知道。
 * 参数契约（spec 2026-10-15 §2.5）：type=string/number/date 只做**等值**比较；
 * type=date_range 传 {from,to} 闭区间（from>to 服务端显式报错——T2 防的「恒空集且不报错」
 * 在区间形态上已被结构化修复）。等值参数的「同列两个同传会拼出恒空集且不报错」告诫
 * **只保留给等值参数**（区间单参数无此问题）；合法参数键名以 list_metrics 返回的
 * 该指标 params 为准（list_metrics 与 HTTP 词表共用同一投影，spec §2.4）。
 * 合计规则（spec §8.4）**必须写在描述里**（不是 SKILL 方法论层）：可加指标的响应自动带
 * total 值字段——「直接引用、勿自己加总」这条对 flash 级模型是弱引导兜底，规则下沉到
 * 模型上下文必在的工具文案。
 */
const LEGACY_TOOLS: ToolSpec[] = [
  {
    name: 'list_metrics',
    description: '列出当前用户有权访问的指标（id / 标题 / 说明）。问数前若不确定指标 id，先调它。',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'query_metric',
    description: [
      '按指标 id 查询数据。参数键**只能**取 list_metrics 返回的该指标 params 键名（未列出的键会被拒绝）。',
      'type=date_range 的参数传 {"from":"YYYY-MM-DD","to":"YYYY-MM-DD"} 闭区间（查某天则 from=to）；',
      'type=string/number 的参数只做**等值**匹配，且同列不要同时传（会拼出恒空条件且不报错）。',
      '求和类（可加）指标的回包自动带 total 字段 = 该过滤范围的合计——直接引用该值，不要自己把行加总；',
      '没有 total 字段（比率/去重计数类指标）就不要跨行求和（跨行求和是错数）。',
      '只要总数可传 args.total:true（布尔）——服务端求和恒返回单行合计；未声明 params 的指标只能空参查全量（可能返回大量行）——能用参数就用参数。',
      '答案末尾必须原样单独一行附回包的 freshness_line（服务端拼好的新鲜度说明，不混入正文、不改写不翻译；回包没有该字段 = 该指标未接新鲜度链路，不要自己编一行）。data_as_of（数据截止，已是北京时间 UTC+8，直接引用不要自行换算）可注明「数据截至 X」；没有该字段 = 新鲜度未知，如实说明，不要编；明细 rows 按 bizday 降序，首行即最新分区；当日数据是部分天，须标注。',
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
  {
    name: 'query_detail',
    description: [
      '按指标下钻到明细构成（订单级）。**只对声明了下钻的指标可用**（调用后 status=denied 且 reason=no_detail_binding = 该指标不支持，改用 query_metric，不要重试）。',
      'args.bizday **必传**（{"from":"YYYY-MM-DD","to":"YYYY-MM-DD"}，查单日 from=to）——直读数据湖，范围越大越慢。',
      '回包 rowCountTotal = 该范围的**全量原始行数**（不受 limit/分组影响）——回答「多少行」用它，不要拿 rows 长度或把样本当全量。',
      'dimensions 缺省 = 最细（订单级）；传入必须是 list 后该指标声明维度的子集（变粗上卷）。回包默认按 value 降序。',
      '「哪几行/哪几单贡献最大」用本工具；「合计多少」用 query_metric 的 total。',
      '回包带 drill_as_of（明细查询时刻）与 data_as_of（聚合口径截止）+ clock_note——两个时钟不同，逐行相加可能与聚合值不一致，以 clock_note 为准原样转述。scope_line 有则原样单独一行附在答案末尾。',
      '回包可能**少一列**（条件列）：那是未授权（如 data:cost），**不是没有数据/不是 NULL**——如实说明「该列需授权」。',
    ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        metricId: { type: 'string', description: '指标 id，取自 list_metrics' },
        args: { type: 'object', description: '指标参数；bizday 必传', additionalProperties: true },
        dimensions: { type: 'array', items: { type: 'string' }, description: '分组维度子集；缺省 = 最细（订单级）' },
        orderBy: { type: 'string', description: "排序键，'value'（缺省）或维度名" },
        desc: { type: 'boolean', description: '降序（缺省 true）' },
        limit: { type: 'number', description: '返回行数，默认 50，上限 500' },
        offset: { type: 'number', description: '翻页偏移' },
      },
      required: ['metricId'],
    },
  },
]

/**
 * 通道 A 绑定的 registry 子集（Wave 2 决策 D-A1，ref #985）：三把全只读，实现/文案/schema
 * 全部同源直取 `ANALYST_TOOLS`（零第二份）；执行走 callTool 单点（审计含拒绝/出错）。
 * 刻意不绑 search_catalog（list_metrics 已覆盖）/ describe_dataset / preview_query
 * （A 的 query_metric 无切片形状，绑了只会诱导误用）/ get_quality / get_lineage
 * （无已观测需求）——LLM 面最小化，6 把封顶。
 */
const BOUND_TOOL_NAMES: readonly string[] = ['describe_metric', 'sample_dimension_values', 'get_freshness']
const REGISTRY_TOOLS: ToolSpec[] = ANALYST_TOOLS
  .filter((t) => BOUND_TOOL_NAMES.includes(t.name))
  .map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))

export const TOOLS: ToolSpec[] = [...LEGACY_TOOLS, ...REGISTRY_TOOLS]

export async function* runAgentLoop(
  deps: AgentDeps, requester: Requester, model: ChatModel, question: string,
): AsyncGenerator<AgentEvent> {
  // 词表在本轮对话开始时裁剪一次（同一次对话内权限漂移不做中途刷新——改权限下一次问答生效）
  // ★ 必须是**合并**加载器（L1 ∪ 本 org）：用只回本 org 的那个，平台指标对 agent 就不存在
  //   （它连"看不见"都不会说——`list_metrics` 里直接没有这条 id）。T8 评审 C1。
  // ★ 裁剪带**源维度**（计划 5 §3⑧）：agent 只该看到「本租户已接入源」的指标——否则单源
  //   租户会看到别的源的同名口径，只能停下来问人（spec 实测的那个歧义）。
  const catalog = visibleMetrics(
    await loadMergedCatalog(deps.pool, deps.org), requester, deps.adoptedSources)
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: question },
  ]
  let lastTable: { columns: string[]; rows: unknown[][] } | undefined

  // registry 子集的 ToolboxDeps（requester 每轮固定 ⇒ 循环外构建一次）。
  // wh 缺省 = deps.execute（测试注入）；生产无注入时落到只读池（analystPool）。
  const toolbox = buildToolboxDeps(
    { pool: deps.pool, org: deps.org, requester, adoptedSources: deps.adoptedSources },
    { wh: deps.execute },
  )

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
      const result = await runTool(call, catalog, deps, requester, toolbox)
      if (result.status === 'ok') lastTable = { columns: result.columns, rows: result.rows }
      // 拒绝结果**原样**回给模型：可解释的 reason 才让它能对用户说清「你没权限」。
      // toolbox 分支回 payload 原体（信封/拒绝形态即 impl 的产物），其余分支回整个 result。
      messages.push({
        role: 'tool', toolCallId: call.id,
        content: JSON.stringify(result.status === 'toolbox' ? result.payload : result),
      })
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
  call: ToolCall, catalog: MetricDef[], deps: AgentDeps, requester: Requester, toolbox: ToolboxDeps,
): Promise<{ status: 'ok'; columns: string[]; rows: unknown[][] }
        | { status: 'denied'; metricId: string; reason: string; detail?: string }
        | { status: 'error'; reason: string; detail: string }
        | { status: 'metrics'; metrics: { id: string; title: string; description: string; params: MetricParamFace }[] }
        | { status: 'toolbox'; payload: Record<string, unknown> }> {
  // registry 子集（Wave 2）：走 callTool 单点——未知/未认证/mutating 闸/审计（含拒绝）全继承。
  // payload 的 status 字段保持 impl 原形（ok/denied/not_found/unknown），模型按文案自解释。
  if (BOUND_TOOL_NAMES.includes(call.name)) {
    const out = await callTool(toolbox, call.name, call.arguments)
    return { status: 'toolbox', payload: out.payload }
  }
  if (call.name === 'list_metrics') {
    // 参数面与 HTTP 词表**同一份投影**（paramFaceOf，spec 2026-10-15 §2.4）：query_metric
    // 的描述让模型「参数键只能取 list_metrics 返回的 params 键名」——这里不给 params，
    // 那句话就是空头支票，模型只能臆造键（spec §1 实测的 biz_date 拒因链）。
    return {
      status: 'metrics',
      metrics: catalog.map((m) => ({
        id: m.id, title: m.title, description: m.description, params: paramFaceOf(m.params),
      })),
    }
  }
  // 下钻与聚合同序纪律：先 list_metrics，再 query_detail，最后 query_metric——
  // dispatch 顺序显式落在本文件里，不靠 else-if 链的隐式顺序（改分支先看这里）。
  if (call.name === 'query_detail') {
    const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : ''
    const rawArgs = call.arguments.args
    const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>) : {}
    const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : undefined)
    const dims = Array.isArray(call.arguments.dimensions)
      ? call.arguments.dimensions.filter((d): d is string => typeof d === 'string') : undefined
    return runDetailQuery(
      { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
      deps.org, requester, metricId, args, {
        dimensions: dims,
        orderBy: typeof call.arguments.orderBy === 'string' ? call.arguments.orderBy : undefined,
        desc: typeof call.arguments.desc === 'boolean' ? call.arguments.desc : undefined,
        limit: num(call.arguments.limit),
        offset: num(call.arguments.offset),
      })
  }
  if (call.name !== 'query_metric') {
    return { status: 'error', reason: 'unknown_tool', detail: call.name }
  }
  const metricId = typeof call.arguments.metricId === 'string' ? call.arguments.metricId : ''
  const rawArgs = call.arguments.args
  const args = rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
    ? (rawArgs as Record<string, unknown>) : {}
  // 与 MCP 通道**同一个** runQuery ⇒ 同一个授权核心。这里不做任何权限判断。
  // `adoptedSources` 必须透传：runQuery 自己会再裁一次（同一条 `visibleMetrics`），漏传就
  // 等于这条路径不裁——`catalog-consumers.test.ts` 的面③ 行为断言正是钉这个的。
  return runQuery(
    { pool: deps.pool, execute: deps.execute, adoptedSources: deps.adoptedSources },
    deps.org, requester, metricId, args)
}

/** 活动事件的展示文案。**只放 id 与非敏感参数**——SQL、主体值、凭证都不进事件流。 */
function describeCall(call: ToolCall): string {
  if (call.name === 'list_metrics') return '列出可用指标'
  const str = (v: unknown): string => (typeof v === 'string' && v !== '' ? v : '(未指定)')
  if (call.name === 'describe_metric') return `查指标详情 ${str(call.arguments.id)}`
  if (call.name === 'sample_dimension_values') return `抽样维度值 ${str(call.arguments.metricId)}.${str(call.arguments.dimension)}`
  if (call.name === 'get_freshness') return `查新鲜度 ${str(call.arguments.scope) === '(未指定)' ? '全局' : str(call.arguments.scope)}`
  const metricId = metricIdOf(call)
  if (call.name === 'query_detail') return `下钻明细 ${metricId}`
  return `查询指标 ${metricId}`
}

/** 既有取 id 逻辑抽出：query_metric 与 query_detail 共用（缺失给占位，不抛）。 */
function metricIdOf(call: ToolCall): string {
  return typeof call.arguments.metricId === 'string' ? call.arguments.metricId : '(未指定)'
}
