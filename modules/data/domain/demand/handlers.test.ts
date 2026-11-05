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

describe('callDemandTool：先取后滤（resolved 不占窗口）', () => {
  const demandRow = (id: number, kind: DemandRow['kind'], target: string, occurrences: number) => ({
    id, kind, target, detail: {}, occurrences,
    first_seen: new Date('2026-10-01T00:00:00Z'), last_seen: new Date('2026-10-02T00:00:00Z'), evidence: [],
    dismissed_at: null, dismissed_by: null, dismiss_reason: null,
  })
  /** 假 pool **尊重 SQL 的 limit**（params[3]）——否则测不出「limit 压给 SQL 会先占满窗口」。 */
  const depsWith = (rows: Record<string, unknown>[], catalog: Record<string, unknown>[] = []): DemandToolDeps => ({
    pool: {
      query: async (sql: unknown, params?: unknown[]) => {
        if (typeof sql === 'string' && /from data\.demand_signals/.test(sql)) {
          const limit = Number(params?.[3] ?? rows.length)
          return { rows: rows.slice(0, limit) }
        }
        if (typeof sql === 'string' && /from data\.metrics/.test(sql)) return { rows: catalog }
        return { rows: [] }
      },
    } as never,
    org: 'acme', requester: { userId: 'u' },
  })

  it('3 条已 resolved + 2 条未 resolved，limit=2 ⇒ 回 2 条未 resolved（旧实现回 0）', async () => {
    const rows = [
      demandRow(1, 'alias_gap', '别名一', 99),
      demandRow(2, 'alias_gap', '别名二', 98),
      demandRow(3, 'alias_gap', '别名三', 97),
      demandRow(4, 'new_metric', 'lemeng:retail:target', 2),
      demandRow(5, 'metric_hunt', 's1|2026-10-10..2026-10-16', 1),
    ]
    const catalog = [{ id: 'lemeng:retail:net_sales', synonyms: ['别名一', '别名二', '别名三'] }]
    const out = await callDemandTool(depsWith(rows, catalog), 'list_demand_signals', { limit: 2 })
    expect(out.status).toBe('ok')
    expect(out.count).toBe(2)
    expect((out.items as { id: number }[]).map((r) => r.id)).toEqual([4, 5])
    expect(out.truncated).toBe(false)
  })

  it('扫描命中 500 安全上限 ⇒ truncated:true（不静默）', async () => {
    const rows = Array.from({ length: 500 }, (_, i) => demandRow(i + 1, 'metric_hunt', `s1|day-${i}`, 1))
    const out = await callDemandTool(depsWith(rows), 'list_demand_signals', { limit: 20 })
    expect(out.count).toBe(20)
    expect(out.truncated).toBe(true)
  })
})
