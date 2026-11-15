// monitor-eval.test.ts — 判据求值（W7-V1 Task 2）。
// 核心用例是 spec §13 的前两条：水位缺失 ⇒ unknown（不是 missing）。
import { describe, expect, it } from 'vitest'
import type { Pool } from 'pg'
import type { MetricRow } from './metric-store'
import type { MonitorRow } from './monitor-store'
import { evaluateMonitor, type MonitorEvalDeps } from './monitor-eval'
import type { MonitorOutcome } from './monitor-spec'

const NOW = new Date('2026-11-15T02:00:00Z') // 北京时间 2026-11-15 10:00

function metricRow(over: Partial<MetricRow> = {}): MetricRow {
  return {
    id: 'mon.metric',
    title: '监控夹具指标',
    description: '',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'select 1 as v from t',
    groupBy: '',
    params: { bizday: { column: 'bizday', type: 'date_range' } },
    totalable: false,
    source: 'l1',
    sourceSystem: null,
    updatedBy: null,
    version: 1,
    slaDays: 1,
    freshnessRelations: ['stg_x'],
    masks: null,
    entity: null,
    synonyms: [],
    certified: 'certified',
    createdBy: null,
    bizDescription: null,
    unit: null,
    caliberNote: null,
    ...over,
  } as unknown as MetricRow
}

function monitorRow(over: Partial<MonitorRow> = {}): MonitorRow {
  return {
    id: '1', org: 'org-mon-eval', name: '夹具', targetKind: 'metric',
    metricId: 'mon.metric', reportId: null, panelIndex: null, filters: {},
    verdict: 'missing', windowDays: 1, cadenceSecs: 300, cooldownSecs: 3600,
    dryRun: true, recipients: [{ kind: 'user', ref: 'alice' }], channelPolicy: 'in_app',
    state: 'ok', stateSince: null, lastEvalAt: null, notifiedAt: null,
    consecutiveFail: 0, enabled: true, createdBy: 'alice',
    ...over,
  }
}

function deps(wh: MonitorEvalDeps['wh'], over: Partial<MonitorEvalDeps> = {}): MonitorEvalDeps {
  return {
    wh,
    pool: {} as Pool,
    loadCatalog: async () => [metricRow()],
    now: () => NOW,
    ...over,
  }
}

const sink = (rows: unknown[][]) => async () => ({ columns: ['n'], rows })

describe('evaluateMonitor · stale', () => {
  it('★ 水位表缺席/读不到 ⇒ unknown（不是 missing）', async () => {
    const out = await evaluateMonitor(
      deps(async () => { throw new Error('relation "data.load_log" does not exist') }),
      monitorRow({ verdict: 'stale' }),
    )
    expect(out.verdict).toBe('unknown')
    expect((out as Extract<MonitorOutcome, { verdict: 'unknown' }>).error).toContain('load_log')
  })

  it('水位为 NULL ⇒ unknown', async () => {
    const out = await evaluateMonitor(deps(sink([[null]])), monitorRow({ verdict: 'stale' }))
    expect(out.verdict).toBe('unknown')
  })

  it('指标未声明水位关系 ⇒ unknown（判不了 ≠ 没问题）', async () => {
    const out = await evaluateMonitor(
      deps(sink([['2026-11-14']]), { loadCatalog: async () => [metricRow({ freshnessRelations: [] })] }),
      monitorRow({ verdict: 'stale' }),
    )
    expect(out.verdict).toBe('unknown')
    expect((out as Extract<MonitorOutcome, { verdict: 'unknown' }>).error).toBe('no_freshness_relations')
  })

  it('水位旧于 today-window ⇒ stale；不旧 ⇒ ok', async () => {
    const stale = await evaluateMonitor(deps(sink([['2026-11-13']])), monitorRow({ verdict: 'stale' }))
    expect(stale.verdict).toBe('stale')
    expect(stale.watermarkRef).toBe('load_log:stg_x')

    const ok = await evaluateMonitor(deps(sink([['2026-11-14']])), monitorRow({ verdict: 'stale' }))
    expect(ok.verdict).toBe('ok')
  })
})

describe('evaluateMonitor · missing', () => {
  it('★ 窗口内 0 行 ⇒ missing；有行 ⇒ ok', async () => {
    const calls: string[] = []
    const wh = async (sql: string) => {
      calls.push(sql)
      return { columns: ['n'], rows: [[calls.length === 1 ? 0 : 7]] }
    }
    expect((await evaluateMonitor(deps(wh), monitorRow())).verdict).toBe('missing')
    expect((await evaluateMonitor(deps(wh), monitorRow())).verdict).toBe('ok')
    expect(calls[0]).toMatch(/^select count\(\*\)::bigint as n from \(/)
  })

  it('查询抛错 ⇒ unknown（不得当 missing）', async () => {
    const out = await evaluateMonitor(
      deps(async () => { throw new Error('statement timeout') }),
      monitorRow(),
    )
    expect(out.verdict).toBe('unknown')
  })

  it('指标不存在 ⇒ unknown；授权拒绝 ⇒ unknown', async () => {
    const notFound = await evaluateMonitor(
      deps(sink([[0]]), { loadCatalog: async () => [] }), monitorRow(),
    )
    expect(notFound.verdict).toBe('unknown')

    const denied = await evaluateMonitor(
      deps(sink([[0]]), {
        loadCatalog: async () => [metricRow({ requiredScope: 'data:admin' })],
      }),
      monitorRow(),
    )
    expect(denied.verdict).toBe('unknown')
    expect((denied as Extract<MonitorOutcome, { verdict: 'unknown' }>).error).toContain('authz')
  })

  it('报表面板：解析不出指标 ⇒ unknown', async () => {
    const out = await evaluateMonitor(
      deps(sink([[0]]), { resolvePanel: async () => null }),
      monitorRow({ targetKind: 'report_panel', metricId: null, reportId: 'r1', panelIndex: 2 }),
    )
    expect(out.verdict).toBe('unknown')
  })
})
