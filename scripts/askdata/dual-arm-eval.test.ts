// scripts/askdata/dual-arm-eval.test.ts — 双臂判据的可复现单元断言。
//
// ⚠️ 这里的轨迹是**测试夹具**（合成事件），不是真实样本；真实样本的度量在
// `.superpowers/sdd/2026-11-04-amd-w2-three-tier/task-6-report.md` 记录（来源 askdata_trace）。
import { describe, expect, it } from 'vitest'

import {
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
    expect(s.exploration.mean).toBe(0.5)
    expect(s.exploration.distribution).toEqual({ '0': 1, '1': 1 })
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

  /** 一条真实形状的轨迹：问题里出现注入测度的 label；金标是它。 */
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
          tool_args: '{"metricId":"private:retail:return_amount"}',
        },
        { seq: 3, ts: 3, kind: 'tool_result', role: 'toolResult', tool_name: 'query_data', is_error: false, tool_result: '{}' },
      ]),
    ),
  )

  it('A 词表缺该指标 ⇒ delta=1；B 臂只是可达性上界，不声称模型实测', () => {
    const r = reachability(turns, measures, normalizeCatalog([]), {})
    expect(r.matched).toBe(1)
    expect(r.delta).toBe(1)
    expect(r.observedModelBehaviour).toBe(false)
    expect(String(r.note)).toContain('不是模型实测')
  })

  it('A 词表已有该指标 ⇒ delta=0（私有测度不是增量）', () => {
    const r = reachability(turns, measures, normalizeCatalog(['private:retail:return_amount']), {})
    expect(r.matched).toBe(1)
    expect(r.delta).toBe(0)
  })

  it('问题不命中任何注入测度 ⇒ matched=0（无样本可测，不硬凑）', () => {
    const other = segmentTurns(
      parseTrace(rowsToText([{ seq: 1, ts: 1, kind: 'user', role: 'user', text: '昨天净销售额' }])),
    )
    const r = reachability(other, measures, normalizeCatalog([]), {})
    expect(r.matched).toBe(0)
    expect(r.delta).toBe(0)
  })
})
