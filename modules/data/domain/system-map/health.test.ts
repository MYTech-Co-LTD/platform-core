import { describe, expect, it } from 'vitest'
import { healthOf } from './health'
import type { HealthInput } from './health'

const metric = (id: string, over: Partial<HealthInput['metrics'][number]> = {}) => ({
  id, certified: 'certified', entity: 'branch', basis: 'l1_tree', ...over,
})
const base = (over: Partial<HealthInput> = {}): HealthInput => ({
  metrics: [], auditTests: [], usage: {}, demands: [], incidents: 0, ...over,
})

describe('healthOf（W5 Task 1：四个可查的数）', () => {
  it('全齐 ⇒ 绑定/对账 100%，零使用 0，开放需求按未否决计', () => {
    const out = healthOf(base({
      metrics: [metric('lemeng:retail:net_sales'), metric('lemeng:retail:sales')],
      // 对账测试按 metricToAuditFileName 映射：`:` → `__`
      auditTests: ['audit_lemeng__retail__net_sales.sql', 'audit_lemeng__retail__sales.sql'],
      usage: { 'lemeng:retail:net_sales': 5, 'lemeng:retail:sales': 1 },
      demands: [
        { kind: 'alias_gap', dismissedAt: null },
        { kind: 'new_metric', dismissedAt: '2026-11-06T00:00:00Z' },
      ],
      incidents: 2,
    }))
    expect(out).toMatchObject({
      metricTotal: 2, entityBound: 2, entityBoundPct: 100,
      auditCovered: 2, auditCoveredPct: 100, zeroUse: 0, openDemands: 1, incidents: 2,
    })
  })

  it('缺对账测试 / 缺实体 ⇒ 覆盖率按实际计（含空串实体）', () => {
    const out = healthOf(base({
      metrics: [metric('a:b:c', { entity: null }), metric('a:b:d', { entity: '  ' }), metric('a:b:e')],
      auditTests: ['audit_a__b__e.sql'],
    }))
    expect(out.entityBound).toBe(1)
    expect(out.entityBoundPct).toBe(33.3)
    expect(out.auditCovered).toBe(1)
    expect(out.auditCoveredPct).toBe(33.3)
  })

  it('零使用 = 近 30 天无 query_audit 行（缺键与 0 都算）', () => {
    const out = healthOf(base({
      metrics: [metric('a:b:c'), metric('a:b:d')],
      usage: { 'a:b:c': 0 },
    }))
    expect(out.zeroUse).toBe(2)
  })

  it('空指标集 ⇒ 百分比为 0（不出现 NaN）', () => {
    const out = healthOf(base())
    expect(out).toMatchObject({ metricTotal: 0, entityBoundPct: 0, auditCoveredPct: 0, zeroUse: 0 })
  })

  it('auditTests 传全路径也能匹配（取 basename）', () => {
    const out = healthOf(base({
      metrics: [metric('a:b:c')],
      auditTests: ['dbt/tests/lemeng/audit_a__b__c.sql'],
    }))
    expect(out.auditCovered).toBe(1)
  })
})
