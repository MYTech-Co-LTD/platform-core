import { describe, expect, it } from 'vitest'
import { callDemandTool, resolvedOf } from './handlers'
import type { DemandToolDeps } from './handlers'
import type { DemandRow } from './store'

const row = (kind: DemandRow['kind'], target: string): DemandRow => ({
  id: 1, kind, target, detail: {}, occurrences: 1, firstSeen: '', lastSeen: '', evidence: [],
  dismissedAt: null, dismissedBy: null, dismissReason: null,
})
const metric = (id: string, synonyms: string[] = [], drill = false) => ({
  id, synonyms, ...(drill ? { drill: { expr: 'x', dims: [], detail: { relation: 'r' } } } : {}),
}) as never

describe('resolvedOf', () => {
  it('alias_gap：synonyms 已含该说法 ⇒ resolved', () => {
    const byId = new Map([['lemeng:retail:net_sales', metric('lemeng:retail:net_sales', ['净销售额'])]])
    expect(resolvedOf(row('alias_gap', '净销售额'), byId)).toEqual({ resolved: true, resolvedBy: 'synonym@lemeng:retail:net_sales' })
    expect(resolvedOf(row('alias_gap', 'net_sales'), byId).resolved).toBe(false)
  })
  it('new_metric：id 已存在 ⇒ resolved', () => {
    expect(resolvedOf(row('new_metric', 'lemeng:retail:target'), new Map([['lemeng:retail:target', metric('lemeng:retail:target')]])).resolved).toBe(true)
  })
  it('drill_gap：指标已有 drill ⇒ resolved', () => {
    const byId = new Map([['lemeng:outbound:net_amount', metric('lemeng:outbound:net_amount', [], true)]])
    expect(resolvedOf(row('drill_gap', 'lemeng:outbound:net_amount'), byId).resolved).toBe(true)
  })
  it('metric_hunt 永不自动消解', () => {
    expect(resolvedOf(row('metric_hunt', 's1|2026-10-10..2026-10-16'), new Map())).toEqual({ resolved: false, resolvedBy: null })
  })
})

describe('callDemandTool：入参拒答（不触库）', () => {
  // 两条拒答路径都在读库之前返回 ⇒ 假 pool 永不被动到（被调就是红）。
  const deps = (): DemandToolDeps => ({
    pool: { query: async () => { throw new Error('should not touch db') } } as never,
    org: 'acme', requester: { userId: 'u' },
  })
  it('未知工具 ⇒ refused/unknown_tool', async () => {
    expect(await callDemandTool(deps(), 'nope', {})).toEqual({ status: 'refused', reason: 'unknown_tool', name: 'nope' })
  })
  it('非法 kind ⇒ refused/bad_kind', async () => {
    expect(await callDemandTool(deps(), 'list_demand_signals', { kind: 'bogus' }))
      .toEqual({ status: 'refused', reason: 'bad_kind' })
  })
  it('dismiss 缺 id / 空 reason ⇒ refused/invalid_args', async () => {
    expect(await callDemandTool(deps(), 'dismiss_demand_signal', { id: 0, reason: 'x' }))
      .toEqual({ status: 'refused', reason: 'invalid_args' })
    expect(await callDemandTool(deps(), 'dismiss_demand_signal', { id: 1, reason: '   ' }))
      .toEqual({ status: 'refused', reason: 'invalid_args' })
  })
})
