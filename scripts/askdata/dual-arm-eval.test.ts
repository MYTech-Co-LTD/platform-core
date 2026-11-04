// scripts/askdata/dual-arm-eval.test.ts — 双臂判据的可复现单元断言。
//
// ⚠️ 这里的轨迹是**测试夹具**（合成事件），不是真实样本；真实样本的度量在
// `.superpowers/sdd/2026-11-04-amd-w2-three-tier/task-6-report.md` 记录（来源 askdata_trace）。
import { describe, expect, it } from 'vitest'

import {
  catalogFromL1Yaml,
  normalizeCatalog,
  normalizeMeasures,
  parseTrace,
  reachability,
  scoreTurn,
  segmentTurns,
  summarize,
} from './dual-arm-eval.mjs'

/** @param {object[]} rows */
function rowsToText(rows: object[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n')
}

describe('parseTrace / segmentTurns：轮次切分', () => {
  it('user 事件起一轮；tool_call / tool_result 归属当前轮；系统轮标记 systemic', () => {
    const text = rowsToText([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: '昨天净销售额' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
      { seq: 4, ts: 4, kind: 'user', role: 'user', text: '[OpenClaw heartbeat poll]' },
    ])
    const turns = segmentTurns(parseTrace(text))
    expect(turns).toHaveLength(2)
    expect(turns[0].question).toBe('昨天净销售额')
    expect(turns[0].calls).toHaveLength(1)
    expect(turns[0].results).toHaveLength(1)
    expect(turns[1].systemic).toBe(true)
  })

  it('坏 JSON 行点名行号', () => {
    expect(() => parseTrace('{"seq":1}\nnot-json\n')).toThrow(/第 2 行/)
  })
})

describe('segmentTurns：多会话并发不串轮（评审 Important 1）', () => {
  it('A/B 会话事件交错 ⇒ 各轮只收本会话的 tool_call/result', () => {
    const text = rowsToText([
      { seq: 1, ts: 1, session_id: 'A', kind: 'user', role: 'user', text: 'A 的问题' },
      { seq: 2, ts: 2, session_id: 'B', kind: 'user', role: 'user', text: 'B 的问题' },
      { seq: 3, ts: 3, session_id: 'A', kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"a1"}' },
      { seq: 4, ts: 4, session_id: 'B', kind: 'tool_call', role: 'assistant', tool_name: 'exec' },
      { seq: 5, ts: 5, session_id: 'B', kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"b1"}' },
      { seq: 6, ts: 6, session_id: 'A', kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
      { seq: 7, ts: 7, session_id: 'B', kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
    ])
    const turns = segmentTurns(parseTrace(text))
    expect(turns).toHaveLength(2)
    const a = turns.find((t) => t.sessionId === 'A')
    const b = turns.find((t) => t.sessionId === 'B')
    if (a === undefined || b === undefined) throw new Error('会话 A/B 切轮缺失')
    expect(a.calls.map((c) => c.name)).toEqual(['query_data'])
    expect(b.calls.map((c) => c.name)).toEqual(['exec', 'query_data'])
    // B 的 exec 不能记到 A 的轮次里
    expect(scoreTurn(a).explorationActions).toBe(0)
    expect(scoreTurn(b).explorationActions).toBe(1)
  })
})

describe('scoreTurn：首答即中 / 探索动作', () => {
  /** @param {object[]} rows */
  function score(rows: object[]) {
    const turns = segmentTurns(parseTrace(rowsToText(rows)))
    return scoreTurn(turns[0])
  }

  it('首次 query_data 成功且无同参重放 ⇒ 命中，0 探索', () => {
    const s = score([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
    ])
    expect(s.firstAnswerHit).toBe(true)
    expect(s.explorationActions).toBe(0)
    expect(s.hitReason).toBe('ok')
  })

  it('query_data 之前的 exec/read/tool_search/tool_describe 逐次计数；数据面之后的 exec 不计', () => {
    const s = score([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'read' },
      { seq: 3, ts: 3, kind: 'tool_call', role: 'assistant', tool_name: 'exec' },
      { seq: 4, ts: 4, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      { seq: 5, ts: 5, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
      { seq: 6, ts: 6, kind: 'tool_call', role: 'assistant', tool_name: 'exec' },
    ])
    expect(s.explorationActions).toBe(2)
    expect(s.firstAnswerHit).toBe(true)
  })

  it('list_metrics 之后、query_data 之前的 exec 仍计入探索（评审 Minor 4）', () => {
    const s = score([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'list_metrics' },
      { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'list_metrics', is_error: false, tool_result: '{}' },
      { seq: 4, ts: 4, kind: 'tool_call', role: 'assistant', tool_name: 'exec' },
      { seq: 5, ts: 5, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      { seq: 6, ts: 6, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
    ])
    expect(s.explorationActions).toBe(1)
    expect(s.firstAnswerHit).toBe(true)
  })

  it('首次 query_data 报错 ⇒ 未中，归因取错误 code', () => {
    const s = score([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      {
        seq: 3,
        ts: 3,
        kind: 'tool_result',
        role: 'toolResult',
        tool_name: 'query_data',
        is_error: true,
        tool_result: '{"code":"DENIED","error":"..."}',
      },
    ])
    expect(s.firstAnswerHit).toBe(false)
    expect(s.hitReason).toBe('first_error:DENIED')
  })

  it('同参原样重放 ⇒ 未中（即使第一次成功）', () => {
    const s = score([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
      { seq: 4, ts: 4, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
      { seq: 5, ts: 5, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
    ])
    expect(s.firstAnswerHit).toBe(false)
    expect(s.hitReason).toBe('identical_retry')
  })

  it('没有 query_data 的轮次不进首答分母（null）', () => {
    const s = score([
      { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q' },
      { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'list_metrics' },
    ])
    expect(s.firstAnswerHit).toBeNull()
    expect(s.hitReason).toBe('no_query_data')
  })
})

describe('summarize：分母只算业务轮', () => {
  it('系统轮不入分母；比率按有 query_data 的轮次算', () => {
    const turns = segmentTurns(
      parseTrace(
        rowsToText([
          { seq: 1, ts: 1, kind: 'user', role: 'user', text: 'q1' },
          { seq: 2, ts: 2, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m1"}' },
          { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
          { seq: 4, ts: 4, kind: 'user', role: 'user', text: 'q2' },
          { seq: 5, ts: 5, kind: 'tool_call', role: 'assistant', tool_name: 'exec' },
          { seq: 6, ts: 6, kind: 'tool_call', role: 'assistant', tool_name: 'query_data', tool_args: '{"metricId":"m2"}' },
          { seq: 7, ts: 7, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: true, tool_result: '{"code":"X"}' },
          { seq: 8, ts: 8, kind: 'user', role: 'user', text: '[System] restart' },
        ]),
      ),
    )
    const s = summarize(turns.map(scoreTurn))
    expect(s.turns).toBe(3)
    expect(s.businessTurns).toBe(2)
    expect(s.firstAnswerHit).toEqual({ hit: 1, total: 2, rate: 0.5 })
    expect(s.zeroExplorationAndHit).toEqual({ hit: 1, total: 2, rate: 0.5 })
    expect(s.exploration.mean).toBe(0.5)
    expect(s.exploration.distribution).toEqual({ '0': 1, '1': 1 })
  })
})

describe('catalogFromL1Yaml：仓内词表即事实源（评审 Minor 7）', () => {
  it("只抽 `  - name: '...'`，忽略注释与其他键", () => {
    const yml = [
      'metrics:',
      "  - name: 'lemeng:retail:sales'",
      "    label: '销售额'",
      '    # - name: 注释里不算',
      "  - name: 'lemeng:retail:net_sales'",
    ].join('\n')
    expect([...catalogFromL1Yaml(yml)].sort()).toEqual(['lemeng:retail:net_sales', 'lemeng:retail:sales'])
  })
})

describe('reachability：B 臂可达性（确定性，不模拟模型）', () => {
  const measures = normalizeMeasures({
    measures: [
      {
        id: 'private:retail:return_amount',
        label: '零售退货金额',
        synonyms: ['退货金额'],
        relation: 'fct_retail_sale',
        expr: { agg: 'sum', column: 'return_amount' },
      },
    ],
  })

  /**
   * 真实形状：历史轨迹发生在 W2 之前，所以模型只可能调用 L1 指标（这里是 net_sales）。
   * 「问题真正想要的金标」只能由部署后人工的 `--contract` 提供——这正是评审要求的路径。
   */
  const turns = segmentTurns(
    parseTrace(
      rowsToText([
        { seq: 1, ts: 1, kind: 'user', role: 'user', text: '本月零售退货金额是多少' },
        {
          seq: 2,
          ts: 2,
          kind: 'tool_call',
          role: 'assistant',
          tool_name: 'query_data',
          tool_args: '{"metricId":"lemeng:retail:net_sales"}',
        },
        { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
      ]),
    ),
  )

  const contract = { 本月零售退货金额是多少: 'private:retail:return_amount' }

  it('没有 --contract ⇒ 显式 bArmMeaningless（结构性 delta=0，不当有效增量）', () => {
    const r = reachability(turns, measures, normalizeCatalog(['lemeng:retail:net_sales']), {}, false)
    expect(r.matched).toBe(1)
    expect(r.delta).toBe(0)
    expect(r.meaningless).toBe(true)
    expect(r.rows[0].goldMetric).toBeNull()
    expect(String(r.meaninglessReason)).toContain('--contract')
  })

  it('有 --contract（人工金标）⇒ A 缺私有测度、B 有 ⇒ delta=1；仍不声称模型实测', () => {
    const r = reachability(turns, measures, normalizeCatalog(['lemeng:retail:net_sales']), contract, true)
    expect(r.matched).toBe(1)
    expect(r.delta).toBe(1)
    expect(r.meaningless).toBe(false)
    expect(r.rows[0]).toMatchObject({ goldMetric: 'private:retail:return_amount', aHasGold: false, bHasGold: true })
    expect(r.observedModelBehaviour).toBe(false)
    expect(String(r.note)).toContain('不是模型实测')
  })

  it('A 词表已有该指标 ⇒ delta=0（私有测度不是增量）', () => {
    const r = reachability(turns, measures, normalizeCatalog(['private:retail:return_amount']), contract, true)
    expect(r.matched).toBe(1)
    expect(r.delta).toBe(0)
  })

  it('问题不命中任何注入测度 ⇒ matched=0（无样本可测，不硬凑）', () => {
    const other = segmentTurns(
      parseTrace(rowsToText([{ seq: 1, ts: 1, kind: 'user', role: 'user', text: '昨天净销售额' }])),
    )
    const r = reachability(other, measures, normalizeCatalog([]), {}, true)
    expect(r.matched).toBe(0)
    expect(r.delta).toBe(0)
  })
})
