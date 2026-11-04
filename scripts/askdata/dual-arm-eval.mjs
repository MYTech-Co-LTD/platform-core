// dual-arm-eval.mjs — W2 双臂对照：有/无「私有测度档」时的首答即中率与探索动作次数。
//
// ## 为什么需要它
//
// W2 的 Loan B（私有测度档）假设：词表里多一条列级聚合，问数 agent 就少绕路。判据沿用
// `.claude/skills/askdata-tuning/SKILL.md`：
//   · 首答即中率 = 第一次 query_data 就成功（无错误回包、无同参重放）的轮次占比；
//   · 探索动作次数 = 首次数据面工具调用之前出现 read/tool_search/tool_describe/exec 的次数，目标 0–1。
//
// ## 两个臂怎么来（本脚本只做**可复现**的那部分）
//
// A 臂 = **真实轨迹**（`askdata_trace` / `askdata_conv` 导出）。历史运行时词表里没有私有测度，
//        所以 A 臂的数字是**实测**，不是模拟。
// B 臂 = 词表 + 注入的私有测度卡（`--inject`）。⚠️ 没有 W2 部署 + 模型通道，谁也不能凭空算出
//        「同一个问题在 B 词表下模型会怎么走」。因此本脚本**不编 B 臂的模型行为**，只算两件确定的事：
//          ① `--b-mode reachability`（默认）：**可达性**——注入的测度是否让该问题的金标指标
//             从「词表里没有」变成「词表里有」。这是 B 臂的**上界**（available ⇒ 有机会首答即中），
//             不是首答即中率本身。
//          ② `--b-mode model`：**未实现**。留了显式报错 `B_ARM_MODEL_NOT_IMPLEMENTED`，
//             避免有人把 reachability 数字当成模型实测。
//        报告里必须写清 B 臂到底跑了哪一种；`matched=0` 时就是「本批样本无可测 B 臂」。
//
// ## 输入形状
//
// `--trace`：JSONL，每行 = 一条 `scripts/askdata/export-transcript.py` 归一化后的事件（OO 的
// askdata_trace / askdata_conv 就是这个形状）：
//   { seq, ts, session_id?, role?, kind, tool_name?, tool_args?, tool_result?, is_error?, text? }
// 轮次切分：`kind === 'user'` 起一轮；其后到下一轮之前的 tool_call / tool_result 归属该轮。
//
// `--inject`：私有测度卡（数组，或 `{ "measures": [...] }`）：
//   { "id": "private:retail:return_amount", "label": "零售退货金额",
//     "synonyms": ["退货金额"], "relation": "fct_retail_sale",
//     "expr": { "agg": "sum", "column": "return_amount" } }
//
// `--catalog`：A 臂词表的指标 id（数组，或 `{ "metrics": [{"id": "..."}] }`）。reachability 需要它；
//              没给则只做 A 臂。
// `--contract`：可选 `{ "<问题原文>": "<金标 metricId>" }`；缺省从轨迹里最后一个 query_data
//              的 `metricId` 推断金标（推断不出来就跳过该轮）。
//
// 用法：
//   node scripts/askdata/dual-arm-eval.mjs --trace /tmp/askdata_trace.jsonl \
//     [--inject measures.json] [--catalog catalog-a.json] [--contract gold.json] [--json] [--max-examples 10]
//
// 退出码：0 = 正常输出（含 matched=0）；1 = 输入/结构错误；2 = 用法错误。
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 探索动作：askdata-tuning 判据里的「绕路」动作。 */
export const EXPLORE_TOOLS = new Set(['read', 'tool_search', 'tool_describe', 'exec'])

/** 数据面工具：一旦出现，就说明模型开始取数/看词表了。 */
export const DATA_TOOLS = new Set([
  'query_data',
  'query_detail',
  'list_metrics',
  'describe_metric',
  'search_catalog',
  'get_freshness',
])

/**
 * @typedef {object} TraceRow
 * @property {number=} seq
 * @property {number=} ts
 * @property {string=} session_id
 * @property {string|null=} role
 * @property {string|null=} kind
 * @property {string|null=} tool_name
 * @property {string|null=} tool_args
 * @property {string|null=} tool_result
 * @property {boolean=} is_error
 * @property {string|null=} text
 */

/**
 * @typedef {object} ToolCall
 * @property {string} name
 * @property {string|null} args
 * @property {number|null} seq
 */

/**
 * @typedef {object} ToolResult
 * @property {string} name
 * @property {boolean} err
 * @property {string} text
 * @property {number|null} seq
 */

/**
 * @typedef {object} Turn
 * @property {string} sessionId 会话隔离键（缺 session_id 的旧导出统一落空串）
 * @property {string} question
 * @property {number|null} ts
 * @property {boolean} systemic 系统注入/心跳轮（不是真实用户问题）
 * @property {ToolCall[]} calls
 * @property {ToolResult[]} results
 */

/**
 * @typedef {object} Summary
 * @property {number} turns
 * @property {number} businessTurns
 * @property {number} systemicTurns
 * @property {number} dataTurns
 * @property {number} queryDataTurns
 * @property {{hit: number, total: number, rate: number|null}} firstAnswerHit
 * @property {{hit: number, total: number, rate: number|null}} zeroExplorationAndHit
 * @property {{mean: number|null, median: number|null, p90: number|null, max: number|null, turnsWithAny: number, distribution: Record<string, number>}} exploration
 * @property {Record<string, number>} hitReasons
 */

/**
 * @typedef {object} ReachabilityRow
 * @property {string} question
 * @property {string} matchedMeasure
 * @property {string|null} goldMetric
 * @property {boolean} aHasGold
 * @property {boolean} bHasGold
 * @property {boolean} delta
 */

/**
 * @typedef {object} ReachabilityResult
 * @property {string} mode
 * @property {boolean} observedModelBehaviour
 * @property {string} note
 * @property {number} matched
 * @property {number} delta
 * @property {boolean} meaningless 没有 --contract 时为 true：历史轨迹里不可能出现 W2 私有测度 id，delta 不是有效增量
 * @property {string|null} meaninglessReason
 * @property {ReachabilityRow[]} rows
 */

/**
 * @typedef {object} TurnScore
 * @property {string} question
 * @property {boolean} systemic
 * @property {number} explorationActions
 * @property {string|null} firstTool
 * @property {boolean} dataToolUsed
 * @property {boolean|null} firstAnswerHit null = 该轮没有 query_data（不计入分母）
 * @property {string} hitReason
 * @property {number} queryDataCalls
 */

/**
 * 把 JSONL 文本解析成事件行（跳过空行；坏行点名行号）。
 * @param {string} text
 * @returns {TraceRow[]}
 */
export function parseTrace(text) {
  /** @type {TraceRow[]} */
  const rows = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    if (line.length === 0) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      throw new Error(`trace 第 ${i + 1} 行不是合法 JSON`)
    }
  }
  // 不在这里全局排序：seq 是全局单调的，但**多会话会交错**（A 会话的 tool_call 夹在 B 会话
  // 两个 user 事件之间）。切轮必须按 session 分组、组内按 seq 排——见 segmentTurns。
  return rows
}

/**
 * 系统注入轮（gateway restart / heartbeat）不是业务问题，不能进分母。
 * @param {string} text
 * @returns {boolean}
 */
function isSystemicQuestion(text) {
  const q = text.trim()
  return q.startsWith('[System]') || q.startsWith('[OpenClaw heartbeat') || q.length === 0
}

/**
 * 轮次切分：**按 session 隔离**，每个会话内一个 user 事件起一轮。
 *
 * ⚠️ 为什么不能只按全局 seq 切：多会话并发时事件交错（A 的 tool_result 可能排在 B 的 user 之后），
 * 全局切轮会把 B 的工具调用记到 A 的当前轮，首答即中/探索次数都会被污染。先分会话、组内定序。
 * @param {TraceRow[]} rows
 * @returns {Turn[]}
 */
export function segmentTurns(rows) {
  /** @type {Map<string, TraceRow[]>} */
  const bySession = new Map()
  for (const r of rows) {
    const sid = typeof r.session_id === 'string' && r.session_id.length > 0 ? r.session_id : ''
    let group = bySession.get(sid)
    if (group === undefined) {
      group = []
      bySession.set(sid, group)
    }
    group.push(r)
  }

  /** @type {Turn[]} */
  const turns = []
  for (const [sessionId, group] of bySession) {
    // 组内定序：有 seq 用 seq；没有 seq 就保持该会话在文件里的相对顺序（不跨会话借序）。
    if (group.length > 1 && group.every((r) => typeof r.seq === 'number')) {
      group.sort((a, b) => /** @type {number} */ (a.seq) - /** @type {number} */ (b.seq))
    }
    /** @type {Turn|null} */
    let cur = null
    for (const r of group) {
      const kind = r.kind ?? null
      if (kind === 'user' || (r.role === 'user' && typeof r.text === 'string')) {
        const question = (r.text ?? '').trim()
        cur = {
          sessionId,
          question,
          ts: typeof r.ts === 'number' ? r.ts : null,
          systemic: isSystemicQuestion(question),
          calls: [],
          results: [],
        }
        turns.push(cur)
        continue
      }
      if (cur === null) continue
      if (kind === 'tool_call' && typeof r.tool_name === 'string') {
        cur.calls.push({
          name: r.tool_name,
          args: typeof r.tool_args === 'string' ? r.tool_args : null,
          seq: typeof r.seq === 'number' ? r.seq : null,
        })
      } else if (kind === 'tool_result' && typeof r.tool_name === 'string') {
        cur.results.push({
          name: r.tool_name,
          err: r.is_error === true,
          text: typeof r.tool_result === 'string' ? r.tool_result : '',
          seq: typeof r.seq === 'number' ? r.seq : null,
        })
      }
    }
  }
  return turns
}

/**
 * 从 tool_args 里取 metricId（query_data 的调用形状）。
 * @param {string|null} args
 * @returns {string|null}
 */
export function metricIdOf(args) {
  if (typeof args !== 'string' || args.length === 0) return null
  try {
    const j = JSON.parse(args)
    return typeof j?.metricId === 'string' ? j.metricId : null
  } catch {
    return null
  }
}

/**
 * 给一轮打分。
 * @param {Turn} turn
 * @returns {TurnScore}
 */
export function scoreTurn(turn) {
  // 探索动作的界 = **首次 query_data**（askdata-tuning 的「拿数」点）。list_metrics / query_detail
  // 只是辅助面：`list_metrics → exec → query_data` 里的 exec 仍要算绕路（评审订正）。
  let explorationActions = 0
  /** @type {string|null} */
  let firstDataTool = null
  for (const c of turn.calls) {
    if (EXPLORE_TOOLS.has(c.name)) {
      explorationActions += 1
      continue
    }
    if (firstDataTool === null && DATA_TOOLS.has(c.name)) firstDataTool = c.name
    if (c.name === 'query_data') break
  }

  const qdCalls = turn.calls.filter((c) => c.name === 'query_data')
  /** @type {boolean|null} */
  let hit = null
  let hitReason = 'no_query_data'
  if (qdCalls.length > 0) {
    // 按出现顺序把 query_data 的结果配对（导出里 tool_call_id 可能为空，不能用它）。
    const qdResults = turn.results.filter((r) => r.name === 'query_data')
    const firstResult = qdResults.length > 0 ? qdResults[0] : null
    const identicalRetry = qdCalls.some((c, i) => i > 0 && c.args === qdCalls[0].args)
    if (firstResult === null) {
      hit = false
      hitReason = 'no_result'
    } else if (firstResult.err) {
      hit = false
      hitReason = `first_error:${firstErrorCode(firstResult.text)}`
    } else if (identicalRetry) {
      hit = false
      hitReason = 'identical_retry'
    } else {
      hit = true
      hitReason = 'ok'
    }
  }

  return {
    question: turn.question,
    systemic: turn.systemic,
    explorationActions,
    firstTool: turn.calls.length > 0 ? turn.calls[0].name : null,
    dataToolUsed: firstDataTool !== null,
    firstAnswerHit: hit,
    hitReason,
    queryDataCalls: qdCalls.length,
  }
}

/**
 * 错误回包里优先取 `code`，没有就取前 40 字。
 * @param {string} text
 * @returns {string}
 */
function firstErrorCode(text) {
  try {
    const j = JSON.parse(text)
    if (typeof j?.code === 'string' && j.code.length > 0) return j.code
    if (typeof j?.error === 'string') return j.error.slice(0, 40)
  } catch {
    // 不是 JSON：走下面的截断
  }
  return text.slice(0, 40)
}

/**
 * 分位数（线性插值；空数组返回 null）。
 * @param {number[]} xs 已排序
 * @param {number} p 0–1
 * @returns {number|null}
 */
function quantile(xs, p) {
  if (xs.length === 0) return null
  const idx = (xs.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return xs[lo]
  return xs[lo] + (xs[hi] - xs[lo]) * (idx - lo)
}

/**
 * 汇总 A 臂。
 * @param {TurnScore[]} scores
 * @returns {Summary}
 */
export function summarize(scores) {
  const business = scores.filter((s) => !s.systemic)
  const dataTurns = business.filter((s) => s.dataToolUsed)
  const qd = business.filter((s) => s.firstAnswerHit !== null)
  const hits = qd.filter((s) => s.firstAnswerHit === true).length
  const zeroAndHit = qd.filter((s) => s.explorationActions === 0 && s.firstAnswerHit === true).length
  const ex = business.map((s) => s.explorationActions).sort((a, b) => a - b)
  /** @type {Record<string, number>} */
  const dist = {}
  for (const n of ex) dist[String(n)] = (dist[String(n)] ?? 0) + 1
  /** @type {Record<string, number>} */
  const reasons = {}
  for (const s of qd) reasons[s.hitReason] = (reasons[s.hitReason] ?? 0) + 1

  const sum = ex.reduce((a, b) => a + b, 0)
  return {
    turns: scores.length,
    businessTurns: business.length,
    systemicTurns: scores.length - business.length,
    dataTurns: dataTurns.length,
    queryDataTurns: qd.length,
    firstAnswerHit: { hit: hits, total: qd.length, rate: qd.length > 0 ? hits / qd.length : null },
    // 三条件（零探索 + 首答即中）的联合率：单看 68.5% 会被误读成「零绕路且一次中」。
    zeroExplorationAndHit: {
      hit: zeroAndHit,
      total: qd.length,
      rate: qd.length > 0 ? zeroAndHit / qd.length : null,
    },
    exploration: {
      mean: ex.length > 0 ? sum / ex.length : null,
      median: quantile(ex, 0.5),
      p90: quantile(ex, 0.9),
      max: ex.length > 0 ? ex[ex.length - 1] : null,
      turnsWithAny: ex.filter((n) => n > 0).length,
      distribution: dist,
    },
    hitReasons: reasons,
  }
}

/**
 * @typedef {object} Measure
 * @property {string} id
 * @property {string} label
 * @property {string[]} synonyms
 * @property {string} relation
 * @property {{agg?: string, column?: string}=} expr
 */

/**
 * 校验/规范化注入的私有测度卡。
 * @param {unknown} raw
 * @returns {Measure[]}
 */
export function normalizeMeasures(raw) {
  /** @type {unknown[]} */
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).measures)
      ? /** @type {any} */ (raw).measures
      : []
  /** @type {Measure[]} */
  const out = []
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const o = /** @type {any} */ (item)
    if (typeof o.id !== 'string' || typeof o.label !== 'string') continue
    out.push({
      id: o.id,
      label: o.label,
      synonyms: Array.isArray(o.synonyms) ? o.synonyms.filter((/** @type {unknown} */ s) => typeof s === 'string') : [],
      relation: typeof o.relation === 'string' ? o.relation : '',
      expr: o.expr !== null && typeof o.expr === 'object' ? o.expr : undefined,
    })
  }
  return out
}

/**
 * 规范化 A 臂词表（scalar id 数组）。
 * @param {unknown} raw
 * @returns {Set<string>}
 */
export function normalizeCatalog(raw) {
  /** @type {unknown[]} */
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).metrics)
      ? /** @type {any} */ (raw).metrics
      : []
  const out = new Set()
  for (const item of list) {
    if (typeof item === 'string') out.add(item)
    else if (item !== null && typeof item === 'object' && typeof (/** @type {any} */ (item).id) === 'string') {
      out.add(/** @type {any} */ (item).id)
    }
  }
  return out
}

/**
 * 从 `dbt/semantics/l1_metrics.yml` 原文抽指标 id（只认 `  - name: '...'`，与 check-profile-relations 同形）。
 * 这样 catalog-a 不必手工导出成 /tmp JSON —— 仓内文件即事实源。
 * @param {string} text
 * @returns {Set<string>}
 */
export function catalogFromL1Yaml(text) {
  const out = new Set()
  for (const m of text.matchAll(/^ {2}- name: '([^']+)'/gm)) out.add(m[1])
  return out
}

/**
 * 问题里按 label/synonyms/column 找最长命中（长度 >= 2，避免单字噪声）。
 * @param {string} question
 * @param {Measure} m
 * @returns {number} 命中词长度；0 = 不命中
 */
function measureMatchLength(question, m) {
  const terms = [m.label, ...m.synonyms]
  if (m.expr && typeof m.expr.column === 'string') terms.push(m.expr.column)
  let best = 0
  for (const t of terms) {
    if (typeof t !== 'string' || t.length < 2) continue
    if (question.includes(t) && t.length > best) best = t.length
  }
  return best
}

/**
 * B 臂可达性（确定性，不模拟模型）：注入的测度是否把某轮的金标指标从 A 词表缺失变成可用。
 * @param {Turn[]} turns
 * @param {Measure[]} measures
 * @param {Set<string>} catalogA
 * @param {Record<string, string>} contract
 * @param {boolean=} contractProvided CLI 是否显式给了 `--contract`（缺省按 contract 非空推断）
 * @returns {ReachabilityResult}
 */
export function reachability(turns, measures, catalogA, contract, contractProvided) {
  // ⚠️ 没有 contract 时不能拿「历史最后一个 query_data 的 metricId」当金标：历史运行时根本
  // 没有 W2 私有测度，金标恒在 A 词表里 ⇒ delta 恒 0，是个**结构性假零**。该路径显式标 meaningless。
  const hasContract =
    contractProvided !== undefined ? contractProvided : Object.keys(contract).length > 0
  /** @type {ReachabilityRow[]} */
  const matched = []
  for (const t of turns) {
    if (t.systemic) continue
    /** @type {Measure|null} */
    let best = null
    let bestLen = 0
    for (const m of measures) {
      const len = measureMatchLength(t.question, m)
      if (len > bestLen) {
        best = m
        bestLen = len
      }
    }
    if (best === null) continue
    if (!hasContract) {
      matched.push({
        question: t.question,
        matchedMeasure: best.id,
        goldMetric: null,
        aHasGold: false,
        bHasGold: false,
        delta: false,
      })
      continue
    }
    const gold = contract[t.question] ?? lastMetricId(t)
    if (gold === null) continue
    const aHasGold = catalogA.has(gold)
    const bHasGold = aHasGold || best.id === gold
    matched.push({
      question: t.question,
      matchedMeasure: best.id,
      goldMetric: gold,
      aHasGold,
      bHasGold,
      /** 只有「A 缺、B 有」才是本注入带来的可达性增量。 */
      delta: !aHasGold && bHasGold,
    })
  }
  const deltas = matched.filter((m) => m.delta === true).length
  return {
    mode: 'reachability',
    observedModelBehaviour: false,
    meaningless: !hasContract,
    meaninglessReason: hasContract
      ? null
      : '缺少 --contract：历史轨迹里不存在 W2 私有测度 id，按历史 metricId 推金标只会得到结构性 delta=0；部署后需人工提供「问题→金标」契约再测。',
    note:
      '可达性不是模型实测：available ⇒ 有机会首答即中，不等于首答即中。B 臂模型行为需要 W2 部署后用真实会话跑。',
    matched: matched.length,
    delta: deltas,
    rows: matched,
  }
}

/**
 * 取一轮里最后一个 query_data 的 metricId 作为金标（历史轨迹里模型最终用了哪条）。
 * @param {Turn} t
 * @returns {string|null}
 */
function lastMetricId(t) {
  let gold = null
  for (const c of t.calls) {
    if (c.name !== 'query_data') continue
    const id = metricIdOf(c.args)
    if (id !== null) gold = id
  }
  return gold
}

/**
 * 人读对照表。
 * @param {object} result
 * @returns {string}
 */
export function formatReport(result) {
  const a = /** @type {any} */ (result).armA
  const b = /** @type {any} */ (result).armB
  const lines = []
  lines.push('W2 双臂对照（askdata-tuning 判据）')
  lines.push(`轨迹: ${/** @type {any} */ (result).trace}`)
  lines.push('')
  lines.push('A 臂（真实轨迹，历史词表无私有测度；数字为实测）')
  lines.push(`  轮次: 全部 ${a.turns} / 业务 ${a.businessTurns}（系统 ${a.systemicTurns}）/ 数据面 ${a.dataTurns}`)
  lines.push(
    `  首答即中: ${a.firstAnswerHit.hit}/${a.firstAnswerHit.total}` +
      (a.firstAnswerHit.rate === null ? ' (n/a)' : ` = ${(a.firstAnswerHit.rate * 100).toFixed(1)}%`),
  )
  lines.push(
    `  零探索且首答即中: ${a.zeroExplorationAndHit.hit}/${a.zeroExplorationAndHit.total}` +
      (a.zeroExplorationAndHit.rate === null ? ' (n/a)' : ` = ${(a.zeroExplorationAndHit.rate * 100).toFixed(1)}%`),
  )
  lines.push(
    `  探索动作(read|tool_search|tool_describe|exec): mean=${fmt(a.exploration.mean)} ` +
      `median=${fmt(a.exploration.median)} p90=${fmt(a.exploration.p90)} max=${fmt(a.exploration.max)} ` +
      `有绕路的轮次=${a.exploration.turnsWithAny}`,
  )
  lines.push(`  分布: ${JSON.stringify(a.exploration.distribution)}`)
  lines.push(`  首答未中归因: ${JSON.stringify(a.hitReasons)}`)
  lines.push('')
  lines.push('B 臂（词表 + 私有测度档）')
  if (b === null) {
    lines.push('  NOT RUN：未提供 --inject 或 --catalog（无法建立可达性对照）。')
  } else {
    lines.push(`  模式: ${b.mode}（模型实测=${b.observedModelBehaviour ? '是' : '否'}）`)
    lines.push(`  可匹配轮次: ${b.matched}；A 缺→B 有: ${b.delta}`)
    if (b.meaningless) {
      lines.push('  ⚠️ B 臂无意义（bArmMeaningless=true）：未提供 --contract，历史轨迹里没有私有测度 id ⇒ delta 结构性为 0。')
      lines.push(`  原因: ${b.meaninglessReason}`)
    } else if (b.matched === 0) {
      lines.push('  ⇒ 本批真实样本里 0 条问题文本命中注入测度标签（子串匹配）；B 臂无可测样本，不编。')
    }
    lines.push(`  口径: ${b.note}`)
  }
  return lines.join('\n')
}

/**
 * @param {number|null} n
 * @returns {string}
 */
function fmt(n) {
  return n === null ? 'n/a' : String(Math.round(n * 1000) / 1000)
}

/**
 * 读 JSON 文件。
 * @param {string} path
 * @returns {unknown}
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * CLI。
 * @param {string[]} argv
 * @returns {number} exit code
 */
export function main(argv) {
  /** @type {Record<string, string>} */
  const opts = {}
  let json = false
  let maxExamples = 10
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') {
      json = true
    } else if (arg === '--trace' || arg === '--inject' || arg === '--catalog' || arg === '--catalog-yaml' || arg === '--contract' || arg === '--b-mode') {
      const v = argv[i + 1]
      if (typeof v !== 'string' || v.startsWith('--')) {
        console.error(`dual-arm-eval: ${arg} 需要一个参数`)
        return 2
      }
      opts[arg.slice(2)] = v
      i += 1
    } else if (arg === '--max-examples') {
      const v = Number(argv[i + 1])
      if (!Number.isFinite(v) || v < 0) {
        console.error('dual-arm-eval: --max-examples 需要非负整数')
        return 2
      }
      maxExamples = Math.floor(v)
      i += 1
    } else if (arg === '--help' || arg === '-h') {
      console.log('usage: dual-arm-eval.mjs --trace <jsonl> [--inject <json>] [--catalog <json>|--catalog-yaml dbt/semantics/l1_metrics.yml] [--contract <json>] [--b-mode reachability|model] [--json] [--max-examples N]')
      return 0
    } else {
      console.error(`dual-arm-eval: 未知参数 ${arg}`)
      return 2
    }
  }
  if (typeof opts.trace !== 'string') {
    console.error('dual-arm-eval: 缺少 --trace <jsonl>')
    return 2
  }
  const bMode = opts['b-mode'] ?? 'reachability'
  if (bMode === 'model') {
    console.error('B_ARM_MODEL_NOT_IMPLEMENTED: 本脚本没有模型通道，不能编造 B 臂模型行为；请用 reachability 或部署后跑真实会话。')
    return 1
  }
  if (bMode !== 'reachability') {
    console.error(`dual-arm-eval: 未知 --b-mode ${bMode}`)
    return 2
  }

  /** @type {TraceRow[]} */
  let rows
  try {
    rows = parseTrace(readFileSync(opts.trace, 'utf8'))
  } catch (e) {
    console.error(`dual-arm-eval: 读 ${opts.trace} 失败: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  const turns = segmentTurns(rows)
  if (turns.length === 0) {
    console.error('dual-arm-eval: trace 里没有 user 事件（切不出轮次）')
    return 1
  }
  const scores = turns.map(scoreTurn)

  /** @type {object|null} */
  let b = null
  if (opts.inject !== undefined || opts.catalog !== undefined || opts['catalog-yaml'] !== undefined) {
    if (opts.inject === undefined || (opts.catalog === undefined && opts['catalog-yaml'] === undefined)) {
      console.error('dual-arm-eval: B 臂需要 --inject，且 --catalog 或 --catalog-yaml 二选一（缺就没法判可达性）')
      return 2
    }
    /** @type {Measure[]} */
    let measures
    /** @type {Set<string>} */
    let catalogA
    /** @type {Record<string, string>} */
    let contract = {}
    try {
      measures = normalizeMeasures(readJson(opts.inject))
      if (opts['catalog-yaml'] !== undefined) {
        catalogA = catalogFromL1Yaml(readFileSync(opts['catalog-yaml'], 'utf8'))
      } else {
        catalogA = normalizeCatalog(readJson(/** @type {string} */ (opts.catalog)))
      }
      if (opts.contract !== undefined) {
        const raw = readJson(opts.contract)
        if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
          for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') contract[k] = v
        }
      }
    } catch (e) {
      console.error(`dual-arm-eval: 读 B 臂输入失败: ${e instanceof Error ? e.message : String(e)}`)
      return 1
    }
    if (catalogA.size === 0) {
      console.error('dual-arm-eval: A 词表为空（--catalog / --catalog-yaml 没解析出指标 id）')
      return 1
    }
    if (measures.length === 0) {
      console.error('dual-arm-eval: --inject 里没有合法测度卡（需要 id/label）')
      return 1
    }
    b = reachability(turns, measures, catalogA, contract, opts.contract !== undefined)
  }

  const result = {
    trace: opts.trace,
    inject: opts.inject ?? null,
    catalog: opts.catalog ?? opts['catalog-yaml'] ?? null,
    armA: summarize(scores),
    armB: b,
    examples: scores
      .filter((s) => !s.systemic)
      .sort((x, y) => y.explorationActions - x.explorationActions)
      .slice(0, maxExamples),
  }

  if (json) console.log(JSON.stringify(result, null, 2))
  else console.log(formatReport(result))
  return 0
}

// 只在直接执行时跑 CLI；被测试 import 时不跑。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
