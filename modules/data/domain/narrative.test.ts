// narrative.test.ts — AI 文本生成核心（计划 2026-10-26 Task 6；设计 spec §4.4–§7）。
//
// 判据（每条都对应一句硬约束）：
//  · **流式顺序**：`phase(thinking)` → `phase(writing)` → `delta…` → `done`；`reasoning` 一个字
//    都不进事件（spec §4.4：原始思考不展示）。
//  · **数字只来自事实包**：越界数字 ⇒ 流中 `replace(number_check)` + `done(fallback:true)`，
//    最终文本等于确定性模板；**末尾 `dataAsOf` 时间戳不能被误判成越界数字**（否则合规输出
//    反而永远被替换）。
//  · **未配模型 / 模型异常 ⇒ 模板**：`fallback:true`，永不空白。
//  · **JSON 端点最多重生成一次**：第二次带严格提示；两次都越界 ⇒ 模板。
//  · **缓存内容寻址**：命中回放且**不调模型**；未命中时把最终文本（含模板）写回，
//    `fallback` 标记随行落审计。
import { beforeEach, describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { ChatMessage, StreamDelta, StreamOpts, StreamingChatModel } from './llm'
import {
  allowedNumbers,
  badNumbers,
  generateNarrative,
  resetNarrativeInflight,
  streamNarrative,
  templateOf,
  type NarrativeDeps,
  type NarrativeEvent,
} from './narrative'
import type { FactBundle } from './report-facts'

const ORG = 'org-narrative'

/** 事实包夹具：数字与 `numbers` 白名单同源（真实里由 report-facts 产出）。 */
const facts: FactBundle = {
  reportTitle: '熊喵店 92 月报',
  specKey: 'published:2',
  focus: 'overview',
  period: { from: '2026-10-01', to: '2026-10-19', label: '2026-10-01 ~ 2026-10-19' },
  branchNum: '92',
  branchName: '熊喵曲靖沾益2店',
  hasData: true,
  dataAsOf: '2026-10-25 06:00:00 +08:00',
  kpis: [
    { panel: '销售额', metricId: 'n:sales', format: 'currency', current: '51,273.89', previous: '48,000.00', delta: '6.82%' },
    { panel: '订单数', metricId: 'n:orders', format: 'number', current: '1,234', previous: '1,200', delta: '2.83%' },
    { panel: '客单价', metricId: 'n:aov', format: 'currency', current: '41.55', previous: '40.00', delta: '3.88%' },
    { panel: '会员销售占比', metricId: 'n:vip', format: 'percent', current: '23.45%', previous: null, delta: '-' },
    { panel: '报损金额', metricId: 'n:loss', format: 'currency', current: '320.00', previous: null, delta: '-' },
    { panel: '费用合计（净费用）', metricId: 'n:cost', format: 'currency', current: '5,000.00', previous: null, delta: '-' },
  ],
  breakdowns: [
    { panel: '报损原因', dimension: 'cause', rows: [{ label: '自然损', value: '210.00' }, { label: '过期', value: '110.00' }] },
    { panel: '费用构成', dimension: 'item', rows: [{ label: '平台补贴', value: '3,000.00' }, { label: '配送费', value: '2,000.00' }] },
  ],
  daily: { min: { day: '2026-10-13', value: '1,024.50' }, max: { day: '2026-10-05', value: '4,800.00' } },
  missing: [],
  numbers: ['51,273.89', '48,000.00', '6.82%', '1,234', '1,200', '2.83%', '41.55', '40.00', '3.88%',
    '23.45%', '320.00', '5,000.00', '210.00', '110.00', '3,000.00', '2,000.00', '1,024.50', '4,800.00',
    '2026-10-01', '2026-10-19'],
  dates: ['2026-10-01', '2026-10-19'],
  factsHash: 'facts-hash-1',
}

/** 假流式模型：按给定 chunk 顺序吐；记录每次调用（提示词 + 参数）供断言。 */
function fakeModel(chunks: StreamDelta[]) {
  const calls: { messages: ChatMessage[]; opts?: StreamOpts }[] = []
  const model: StreamingChatModel & { id: string } = {
    id: 'deepseek-flash',
    complete: async () => ({ content: '', toolCalls: [] }),
    async *completeStream(messages, _tools, opts) {
      calls.push({ messages, opts })
      for (const c of chunks) yield c
    },
  }
  return { model, calls }
}

/** 多轮模型：第 n 次调用吐 rounds[n]（越界重试/失败恢复的判据）。 */
function sequencedModel(rounds: StreamDelta[][]) {
  const calls: { messages: ChatMessage[]; opts?: StreamOpts }[] = []
  const model: StreamingChatModel & { id: string } = {
    id: 'deepseek-flash',
    complete: async () => ({ content: '', toolCalls: [] }),
    async *completeStream(messages, _tools, opts) {
      calls.push({ messages, opts })
      const chunks = rounds[Math.min(calls.length - 1, rounds.length - 1)] ?? []
      for (const c of chunks) yield c
    },
  }
  return { model, calls }
}

/** 受门控的模型：先记录调用，等 gate 放行再吐 chunk（并发单飞用）。 */
function gatedModel(chunks: StreamDelta[], gate: Promise<void>) {
  const calls: { messages: ChatMessage[]; opts?: StreamOpts }[] = []
  const model: StreamingChatModel & { id: string } = {
    id: 'deepseek-flash',
    complete: async () => ({ content: '', toolCalls: [] }),
    async *completeStream(messages, _tools, opts) {
      calls.push({ messages, opts })
      await gate
      for (const c of chunks) yield c
    },
  }
  return { model, calls }
}

/** 手动放行的 gate。 */
function gateOf(): { gate: Promise<void>; release: () => void } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  return { gate, release }
}

/** 假池：缓存读按 seed 应答；写只记录（参数下标见 putNarrative 的列序）。 */
function fakePool(seed?: { text: string; fallback: boolean; created_at: Date }) {
  const inserts: unknown[][] = []
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      if (/from\s+data\.report_narratives/.test(sql)) {
        return seed === undefined
          ? { rowCount: 0, rows: [] }
          : { rowCount: 1, rows: [{ ...seed }] }
      }
      if (/insert\s+into\s+data\.report_narratives/.test(sql)) {
        inserts.push(params ?? [])
        return { rowCount: 1, rows: [] }
      }
      throw new Error(`fake pool: unexpected sql: ${sql}`)
    },
  }
  return { pool: pool as unknown as Pool, inserts }
}

/** putNarrative 的位置参数序：fallback 在 12、text 在 11（其余是键与溯源）。 */
const INSERT_TEXT = 11
const INSERT_FALLBACK = 12

function depsOf(
  pool: Pool,
  over: Partial<NarrativeDeps> = {},
): NarrativeDeps {
  return {
    pool, org: ORG, reportId: 'r1', specKey: 'published:2', panelIndex: 1,
    facts, focus: 'overview', userId: 'alice', model: null, ...over,
  }
}

async function collect(gen: AsyncGenerator<NarrativeEvent>): Promise<NarrativeEvent[]> {
  const evs: NarrativeEvent[] = []
  for await (const e of gen) evs.push(e)
  return evs
}

beforeEach(() => { resetNarrativeInflight() })

describe('badNumbers（日期形态）', () => {
  it('中文日期整段抹掉（10月13日 / 2026年10月16日 / 2026年10月 / 10月13号）', () => {
    const allowed = allowedNumbers(facts)
    expect(badNumbers('最低销售日为10月13日，最高为2026年10月16日；2026年10月整体平稳；10月13号。', allowed)).toEqual([])
  })

  it('年份单独 / 带空格日期 / 点号斜杠日期也整段抹掉（#1107）', () => {
    const allowed = allowedNumbers(facts)
    expect(badNumbers(
      '2026年整体平稳；2026 年 10 月 21 日；10 月 21 日；2026.10.21；2026/10/21；2026年度。',
      allowed,
    )).toEqual([])
  })

  it('尾零差异不算越界（facts 1,254.60 / -410.00，模型写 1,254.6 / -410）', () => {
    const withDecimals: FactBundle = {
      ...facts,
      numbers: [...facts.numbers, '1,254.60', '-410.00'],
    }
    const allowed = allowedNumbers(withDecimals)
    expect(badNumbers('费用 1,254.6 元，冲减 -410 元。', allowed)).toEqual([])
  })
})

describe('streamNarrative', () => {
  it('流式输出 phase → delta → done；数字合法；reasoning 不外泄', async () => {
    const { pool, inserts } = fakePool()
    const { model } = fakeModel([
      { reasoning: '思考过程：先看销售额…' },
      { content: '结论：销售额 51,273.89。' },
      { content: '\n异常：无。\n行动：核对明细。' },
    ])
    const evs = await collect(streamNarrative(depsOf(pool, { model })))

    expect(evs[0]).toMatchObject({ type: 'phase', phase: 'thinking' })
    expect(evs).toContainEqual({ type: 'phase', phase: 'writing', label: '正在生成…' })
    const deltas = evs.flatMap((e) => (e.type === 'delta' ? [e.text] : []))
    expect(deltas.length).toBeGreaterThan(0)
    // 原始 reasoning 不进任何用户可见文本
    expect(deltas.join('')).not.toContain('思考过程')
    expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: false, cached: false })
    // 成功文本写缓存且不是 fallback
    expect(inserts).toHaveLength(1)
    expect(inserts[0][INSERT_FALLBACK]).toBe(false)
    expect(inserts[0][INSERT_TEXT]).toBe('结论：销售额 51,273.89。\n异常：无。\n行动：核对明细。')
  })

  it('末尾 dataAsOf 时间戳不算越界数字（合规输出不被替换）', async () => {
    const { pool } = fakePool()
    const { model } = fakeModel([
      { content: '结论：销售额 51,273.89。\n异常：无。\n行动：核对明细。\n数据截至 2026-10-25 06:00:00 +08:00。' },
    ])
    const evs = await collect(streamNarrative(depsOf(pool, { model })))
    expect(evs.some((e) => e.type === 'replace')).toBe(false)
    expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: false })
  })

  it('越界数字 ⇒ 清屏重试一次；仍越界 ⇒ 模板（有模型时不缓存回退）', async () => {
    const { pool, inserts } = fakePool()
    const { model, calls } = fakeModel([{ content: '结论：销售额 99,999.99。' }])
    const evs = await collect(streamNarrative(depsOf(pool, { model })))

    expect(calls).toHaveLength(2)
    // 第一遍已向客户端吐过文本：重试前必须整段清空，不能两遍拼接
    expect(evs).toContainEqual({ type: 'replace', text: '', reason: 'number_check' })
    const replaces = evs.filter((e) => e.type === 'replace')
    expect(replaces.at(-1)).toMatchObject({ type: 'replace', reason: 'number_check' })
    expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: true })
    // done 的文本就是模板（客户端整段替换后看到的）
    const done = evs.at(-1)
    expect(done?.type === 'done' ? done.text : '').toBe(templateOf(facts))
    // 瞬时失败不再钉死整套缓存：下次观看会重新尝试模型
    expect(inserts).toHaveLength(0)
  })

  it('首次越界、第二次合法 ⇒ 出 AI 文本（fallback=false），不写回退缓存', async () => {
    const { pool, inserts } = fakePool()
    const { model, calls } = sequencedModel([
      [{ content: '结论：销售额 99,999.99。' }],
      [{ content: '结论：销售额 51,273.89。\n异常：无。\n行动：核对明细。' }],
    ])
    const evs = await collect(streamNarrative(depsOf(pool, { model })))

    expect(calls).toHaveLength(2)
    expect(calls[1].messages[1]?.content).toContain('上一次输出包含 facts 之外的数字')
    expect(evs).toContainEqual({ type: 'replace', text: '', reason: 'number_check' })
    expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: false })
    expect(inserts).toHaveLength(1)
    expect(inserts[0][INSERT_FALLBACK]).toBe(false)
    expect(inserts[0][INSERT_TEXT]).toContain('51,273.89')
  })

  it('未配模型 ⇒ 直接模板，done fallback', async () => {
    const { pool, inserts } = fakePool()
    const evs = await collect(streamNarrative(depsOf(pool, { model: null })))
    expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: true })
    const done = evs.at(-1)
    expect(done?.type === 'done' ? done.text : '').toContain('数据截至 2026-10-25 06:00:00 +08:00')
    expect(inserts).toHaveLength(1)
  })

  it('模型抛错 ⇒ replace(llm_failed) + done fallback，不长挂', async () => {
    const { pool, inserts } = fakePool()
    const model: StreamingChatModel & { id: string } = {
      id: 'deepseek-flash',
      complete: async () => ({ content: '', toolCalls: [] }),
      // 抛错不是 yield 错误，而是迭代时抛（模拟 HTTP 非 SSE / 超时）
      async *completeStream() {
        throw new Error('LLM_NOT_STREAMING')
      },
    }
    const evs = await collect(streamNarrative(depsOf(pool, { model })))
    expect(evs.find((e) => e.type === 'replace')).toMatchObject({ reason: 'llm_failed' })
    expect(evs.at(-1)).toMatchObject({ type: 'done', fallback: true })
    // 模型异常不缓存回退（瞬时故障下次观看重试）
    expect(inserts).toHaveLength(0)
  })

  it('缓存命中 ⇒ 回放单段 delta + done.cached，且不调模型', async () => {
    const { pool } = fakePool({
      text: '结论：缓存文本。',
      fallback: false,
      created_at: new Date('2026-10-25T00:00:00Z'),
    })
    const { model, calls } = fakeModel([{ content: '不该被调用' }])
    const evs = await collect(streamNarrative(depsOf(pool, { model })))
    expect(calls).toHaveLength(0)
    expect(evs).toContainEqual({ type: 'delta', text: '结论：缓存文本。' })
    expect(evs.at(-1)).toMatchObject({
      type: 'done',
      text: '结论：缓存文本。',
      cached: true,
      generatedAt: '2026-10-25T00:00:00.000Z',
    })
  })
})

describe('generateNarrative', () => {
  it('模型输出合法 ⇒ fallback=false，写缓存', async () => {
    const { pool, inserts } = fakePool()
    const { model } = fakeModel([{ content: '结论：销售额 51,273.89。\n异常：无。\n行动：核对明细。' }])
    const res = await generateNarrative(depsOf(pool, { model }))
    expect(res).toMatchObject({ fallback: false, cached: false, dataAsOf: facts.dataAsOf })
    expect(inserts[0][INSERT_FALLBACK]).toBe(false)
  })

  it('首次越界 ⇒ 带严格提示重生成一次；仍越界 ⇒ 模板', async () => {
    const { pool, inserts } = fakePool()
    const { model, calls } = fakeModel([{ content: '结论：销售额 99,999.99。' }])
    const res = await generateNarrative(depsOf(pool, { model }))

    expect(calls).toHaveLength(2)
    expect(calls[1].messages[1]?.content).toContain('上一次输出包含 facts 之外的数字')
    expect(res).toMatchObject({ fallback: true, cached: false })
    expect(res.text).toBe(templateOf(facts))
    // 有模型时失败不缓存回退：下次观看必须重新尝试
    expect(inserts).toHaveLength(0)
  })

  it('缓存命中 ⇒ 直接返回，不调模型', async () => {
    const { pool } = fakePool({
      text: '结论：缓存文本。',
      fallback: true,
      created_at: new Date('2026-10-25T00:00:00Z'),
    })
    const { model, calls } = fakeModel([{ content: '不该被调用' }])
    const res = await generateNarrative(depsOf(pool, { model }))
    expect(calls).toHaveLength(0)
    expect(res).toMatchObject({
      text: '结论：缓存文本。',
      fallback: true,
      cached: true,
      generatedAt: '2026-10-25T00:00:00.000Z',
    })
  })

  it('空输出不算成功（不缓存空白）', async () => {
    const { pool, inserts } = fakePool()
    const { model, calls } = fakeModel([{ reasoning: '想了很久' }])
    const res = await generateNarrative(depsOf(pool, { model }))
    expect(calls).toHaveLength(2)
    expect(res).toMatchObject({ fallback: true })
    expect(res.text).toBe(templateOf(facts))
    expect(inserts).toHaveLength(0)
  })

  it('未配模型 ⇒ 模板', async () => {
    const { pool } = fakePool()
    const res = await generateNarrative(depsOf(pool, { model: null }))
    expect(res).toMatchObject({ fallback: true, cached: false })
    expect(res.text).toBe(templateOf(facts))
  })
})

describe('templateOf', () => {
  it('只用 facts 的格式化值；缺失写 -；带当前门店（不是 reportTitle）', () => {
    const bare: FactBundle = {
      ...facts,
      kpis: [],
      breakdowns: [],
      daily: { min: null, max: null },
      dataAsOf: null,
      // 其余事实（日极值/拆解）都空，但「有数据」这一位由事实包给；本用例只判模板形态
      hasData: true,
    }
    const text = templateOf(bare)
    expect(text).toContain('销售额 -')
    expect(text).toContain('门店 92（熊喵曲靖沾益2店）')
    expect(text).toContain('数据截至 新鲜度未知。')
  })

  it('缺日极值/拆解时不留空括号（-（） / -（- -））', () => {
    const bare: FactBundle = {
      ...facts,
      kpis: [],
      breakdowns: [],
      daily: { min: null, max: null },
      dataAsOf: null,
      hasData: true,
    }
    const text = templateOf(bare)
    expect(text).not.toContain('（）')
    expect(text).not.toContain('（- -）')
    expect(text).not.toContain('（-）')
  })

  it('hasData=false ⇒ 空态：只写无数据，不输出行动建议', () => {
    const empty: FactBundle = {
      ...facts,
      kpis: [],
      breakdowns: [],
      daily: { min: null, max: null },
      hasData: false,
    }
    const text = templateOf(empty)
    expect(text).toContain('无有效数据')
    expect(text).toContain('门店 92')
    expect(text).not.toContain('行动：')
  })

  it('费用有负数明细 ⇒ 模板写主要冲减项（不把正向大项相加当合计）', () => {
    const withNeg: FactBundle = {
      ...facts,
      breakdowns: [
        ...facts.breakdowns.filter((b) => !b.panel.includes('费用')),
        {
          panel: '费用构成', dimension: 'item',
          rows: [
            { label: '抖音直播补贴', value: '1,254.60' },
            { label: '线下销售补贴-运营部', value: '1,136.00' },
            { label: '整车运费', value: '-410.00' },
          ],
        },
      ],
    }
    const text = templateOf(withNeg)
    expect(text).toContain('冲减 整车运费 -410.00')
  })
})

// 同事实并发（#1105）：一条缓存键只让一个请求调模型，其余等待并回放。
describe('同事实单飞', () => {
  const OK = '结论：销售额 51,273.89。\n异常：无。\n行动：核对明细。'

  it('JSON 并发：只调一次模型，第二个返回 cached', async () => {
    const { pool, inserts } = fakePool()
    const g = gateOf()
    const { model, calls } = gatedModel([{ content: OK }], g.gate)

    const p1 = generateNarrative(depsOf(pool, { model }))
    await new Promise((resolve) => setTimeout(resolve, 0)) // 让 p1 注册单飞并等模型
    const p2 = generateNarrative(depsOf(pool, { model }))
    g.release()
    const [a, b] = await Promise.all([p1, p2])

    expect(calls).toHaveLength(1)
    expect(a).toMatchObject({ fallback: false, cached: false })
    expect(b).toMatchObject({ fallback: false, cached: true })
    expect(inserts).toHaveLength(1)
  })

  it('SSE 并发：第二个等待后整段回放（cached），模型只调一次', async () => {
    const { pool } = fakePool()
    const g = gateOf()
    const { model, calls } = gatedModel([{ content: OK }], g.gate)

    const first = collect(streamNarrative(depsOf(pool, { model })))
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = collect(streamNarrative(depsOf(pool, { model })))
    g.release()
    const [ev1, ev2] = await Promise.all([first, second])

    expect(calls).toHaveLength(1)
    expect(ev1.at(-1)).toMatchObject({ type: 'done', fallback: false })
    expect(ev2.at(-1)).toMatchObject({ type: 'done', fallback: false, cached: true })
    const text2 = ev2.flatMap((e) => (e.type === 'delta' ? [e.text] : [])).join('')
    expect(text2).toContain('51,273.89')
  })
})
