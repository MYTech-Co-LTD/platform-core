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

  it('同 (session_id, seq) 重复行只算一次；不同时间窗分开成组', () => {
    const dup = [row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16'), row('s1', 1, 'm:a:b', '2026-10-10', '2026-10-16')]
    expect(huntFromConvs(dup, new Map())).toHaveLength(0)
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
