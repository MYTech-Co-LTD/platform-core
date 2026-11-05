import { describe, expect, it } from 'vitest'
import { classifyAudit, huntFromConvs, isProbeTarget } from './classify'

const CATALOG = ['lemeng:retail:net_sales', 'lemeng:outbound:line_count']
const audit = (metric_id: string, reason: string, params: unknown = {}) => ({ id: 1, metric_id, reason, params })

describe('classifyAudit', () => {
  it('裸名撞末段 ⇒ alias_gap（net_sales ↔ lemeng:retail:net_sales）', () => {
    const d = classifyAudit(audit('net_sales', 'metric_not_declared'), CATALOG)
    expect(d).toMatchObject({ kind: 'alias_gap', target: 'net_sales', detail: { matchedMetricId: 'lemeng:retail:net_sales' } })
  })

  it('两段名撞末段 ⇒ alias_gap（retail:net_sales）', () => {
    expect(classifyAudit(audit('retail:net_sales', 'metric_not_declared'), CATALOG)?.kind).toBe('alias_gap')
  })

  it('三段齐全但无精确匹配 ⇒ new_metric（域不同，末段撞名不算别名）', () => {
    expect(classifyAudit(audit('lemeng:retail:line_count', 'metric_not_declared'), CATALOG)?.kind).toBe('new_metric')
    expect(classifyAudit(audit('lemeng:retail:target', 'metric_not_declared'), CATALOG)?.kind).toBe('new_metric')
  })

  it('no_detail_binding ⇒ drill_gap，dimensions 进 detail', () => {
    const d = classifyAudit(
      audit('lemeng:outbound:net_amount', 'no_detail_binding', { dimensions: ['branch_num'] }), CATALOG,
    )
    expect(d).toMatchObject({ kind: 'drill_gap', target: 'lemeng:outbound:net_amount', detail: { dimensions: ['branch_num'] } })
  })

  it('其它 reason 不产出需求（bad_param / tool_error / warehouse_error / mutating_disabled）', () => {
    for (const r of ['bad_param', 'tool_error', 'warehouse_error', 'mutating_disabled', 'unknown_tool']) {
      expect(classifyAudit(audit('m:a:b', r), CATALOG)).toBeNull()
    }
  })

  it('测试探针前缀一律排除', () => {
    for (const t of ['verify-20261007:net_sales:by-bizday', 'mcp-probe-20261007:net_sales:by-bizday', 'w1:test:by_branch', 'test-abc']) {
      expect(isProbeTarget(t)).toBe(true)
      expect(classifyAudit(audit(t, 'metric_not_declared'), CATALOG)).toBeNull()
    }
  })
})

describe('huntFromConvs', () => {
  const row = (session: string, seq: number, metricId: string, from: string, to: string) => ({
    session_id: session, seq, tool_name: 'query_data',
    tool_args: JSON.stringify({ metricId, args: { bizday: { from, to } } }),
  })

  it('同会话同时间窗 ≥2 个 metricId ⇒ metric_hunt', () => {
    const out = huntFromConvs([
      row('s1', 1, 'lemeng:retail:net_sales', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'lemeng:retail:sale_money', '2026-10-10', '2026-10-16'),
    ], new Map())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'metric_hunt', target: 's1|2026-10-10..2026-10-16',
      detail: { metricIds: ['lemeng:retail:net_sales', 'lemeng:retail:sale_money'] },
    })
  })

  it('只查了 1 个 metricId ⇒ 不产出', () => {
    expect(huntFromConvs([row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16')], new Map())).toHaveLength(0)
  })

  it('同 seq 非调用行（thinking，无 tool_args）在前、query_data 行在后 ⇒ 仍产出', () => {
    // 生产形状：同一 seq 内 thinking / text / tool_call 多个 part，thinking 的 _timestamp 更早，
    // 调用所在 seq 的第一个 part 恒为 thinking。按 seq 去重放在解析之前会把调用全部吃掉。
    const out = huntFromConvs([
      { session_id: 's1', seq: 1, tool_name: null, tool_args: null },
      row('s1', 1, 'lemeng:retail:net_sales', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'lemeng:retail:sale_money', '2026-10-10', '2026-10-16'),
    ], new Map())
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'metric_hunt', target: 's1|2026-10-10..2026-10-16',
      detail: { metricIds: ['lemeng:retail:net_sales', 'lemeng:retail:sale_money'] },
    })
  })

  it('同 seq 两条并行调用（不同 metricId）⇒ 两个 metric 都进分组', () => {
    const out = huntFromConvs([
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 1, 'm:c:d', '2026-10-10', '2026-10-16'),
    ], new Map())
    expect(out).toHaveLength(1)
    expect(out[0]?.detail).toMatchObject({ metricIds: ['m:a:b', 'm:c:d'] })
  })

  it('同一 (session_id, seq) 重复行不重复计数；不同时间窗分开成组', () => {
    const dup = [
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'm:c:d', '2026-10-10', '2026-10-16'),
    ]
    const out = huntFromConvs(dup, new Map())
    expect(out).toHaveLength(1)
    expect(out[0]?.detail).toMatchObject({ metricIds: ['m:a:b', 'm:c:d'] })
    const two = [
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'm:c:d', '2026-10-17', '2026-10-17'),
    ]
    expect(huntFromConvs(two, new Map())).toHaveLength(0)
  })

  it('stuck 证据按会话挂上', () => {
    const stuck = new Map([['s1', [{ rule: 'same_tool_retry', seq: 9 }]]])
    const out = huntFromConvs([
      row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'),
      row('s1', 2, 'm:c:d', '2026-10-10', '2026-10-16'),
    ], stuck)
    expect(out[0]?.evidence).toEqual([{ rule: 'same_tool_retry', seq: 9 }])
  })
})
