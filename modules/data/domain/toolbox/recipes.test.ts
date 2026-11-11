// recipes.test.ts — `explore_recipe` 证据锚点：锚度量合计，不锚行数；baseline/截断 ⇒ null。
import { describe, expect, it, vi } from 'vitest'
import type { Requester } from '../authz'
import type { ToolboxDeps } from './registry'

const mocks = vi.hoisted(() => ({ executeExplore: vi.fn() }))
vi.mock('../analysis/explore-exec', () => ({ executeExplore: mocks.executeExplore }))

import { exploreRecipeImpl } from './recipes'

const requester: Requester = {
  userId: 'u', orgId: 'acme', channel: 'session', keyId: null,
  scopes: ['data:query'], hasScope: () => true,
}

const METRIC_ROW: Record<string, unknown> = {
  id: 'lemeng:retail:net_sales', title: '净销', description: '', required_scope: null,
  subject_column: 'org', select_sql: 'select sum(fct_t.value) as value from fct_t',
  group_by: 'org, bizday', params: {}, source: 'l1', source_system: 'lemeng',
  updated_by: null, version: 3, totalable: true, scope_note: '', sla_days: 1,
  freshness_relations: [], mask_spec: null, certified: 'certified', basis: 'l1_tree',
  drill_expr: null, drill_dims: null, drill_detail: null,
}

function deps(): ToolboxDeps {
  const pool = {
    query: async (sql: string) => sql.includes('from data.metrics')
      ? { rows: [METRIC_ROW] }
      : { rows: [{ id: 77, created_at: new Date('2026-11-10T00:00:00Z') }] },
  } as never
  return {
    pool, org: 'acme', requester, adoptedSources: new Set(['lemeng']),
    wh: async () => ({ columns: [], rows: [] }),
    exploreExec: async () => ({ columns: [], rows: [] }),
    now: () => new Date('2026-11-10T00:00:00Z'),
  }
}

const specOk = (over: Record<string, unknown> = {}) => ({
  ok: true, columns: ['dimension', 'value'], rows: [['a', 10], ['b', 20]],
  rowCount: 2, truncated: false, sql: 'select 1', preview: 'select 1', auditId: null,
  ...over,
})

const period = (from: string, to: string) => ({ from, to })

describe('exploreRecipeImpl：证据锚点（S2）', () => {
  it('variance：两条 spec 各自锚自己的度量合计，params 区分 A/B', async () => {
    mocks.executeExplore.mockResolvedValue(specOk())
    const args = {
      recipe: 'variance', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
      periodA: period('2026-11-08', '2026-11-08'), periodB: period('2026-11-01', '2026-11-01'),
    }
    const out = await exploreRecipeImpl(deps(), args)
    expect(out.isError).toBe(false)
    const payload = out.payload as { evidence: Array<Record<string, any>> }
    expect(payload.evidence).toHaveLength(2)
    expect(payload.evidence[0]!.anchor.value).toBe(30)
    expect(payload.evidence[0]!.anchor.params).toMatchObject({ recipe: 'variance', period: 'A', periodA: args.periodA })
    expect(payload.evidence[0]!.anchor.slicing).toEqual({ dimensions: ['branch_num'] })
    expect(payload.evidence[1]!.anchor.value).toBe(30)
    expect(payload.evidence[1]!.anchor.params).toMatchObject({ period: 'B', periodB: args.periodB })
  })

  it('top_contributors：单条 spec 锚全量合计', async () => {
    mocks.executeExplore.mockResolvedValue(specOk())
    const out = await exploreRecipeImpl(deps(), {
      recipe: 'top_contributors', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
      period: period('2026-11-01', '2026-11-07'), topN: 5,
    })
    const payload = out.payload as { evidence: Array<Record<string, any>> }
    expect(payload.evidence).toHaveLength(1)
    expect(payload.evidence[0]!.anchor.value).toBe(30)
    expect(payload.evidence[0]!.anchor.params).toMatchObject({ recipe: 'top_contributors' })
  })

  it('baseline：分布没有单值锚点 ⇒ null；params 区分 baseline/current', async () => {
    mocks.executeExplore.mockResolvedValue(specOk())
    const out = await exploreRecipeImpl(deps(), {
      recipe: 'baseline', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
      asOf: '2026-11-08', baselineWindowDays: 28,
    })
    const payload = out.payload as { evidence: Array<Record<string, any>> }
    expect(payload.evidence).toHaveLength(2)
    expect(payload.evidence[0]!.anchor.value).toBeNull()
    expect(payload.evidence[0]!.anchor.params).toMatchObject({ phase: 'baseline', baselineWindowDays: 28 })
    expect(payload.evidence[1]!.anchor.value).toBeNull()
    expect(payload.evidence[1]!.anchor.params).toMatchObject({ phase: 'current', asOf: '2026-11-08' })
  })

  it('spec 截断 ⇒ 锚点 null（不拿不完整合计冒充）', async () => {
    mocks.executeExplore.mockResolvedValue(specOk({ truncated: true }))
    const out = await exploreRecipeImpl(deps(), {
      recipe: 'top_contributors', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
      period: period('2026-11-01', '2026-11-07'),
    })
    const payload = out.payload as { evidence: Array<Record<string, any>> }
    expect(payload.evidence[0]!.anchor.value).toBeNull()
  })
})

describe('exploreRecipeImpl：证据真值（Wave 1.2）', () => {
  const withFreshness = (over: Partial<Record<string, unknown>> = {}) => {
    const d = deps()
    ;(d as { pool: unknown }).pool = {
      query: async (sql: string) => {
        if (sql.includes('from data.metrics')) return { rows: [{ ...METRIC_ROW, ...over }] }
        if (sql.includes('data.load_log')) return { rows: [{ watermark: '2026-11-09' }] }
        return { rows: [{ id: 77, created_at: new Date('2026-11-10T00:00:00Z') }] }
      },
    }
    return d
  }

  it('dataAsOf / freshness 走问数面同一判据（load_log 水位 + 指标自己的 sla）', async () => {
    mocks.executeExplore.mockResolvedValue(specOk())
    const out = await exploreRecipeImpl(withFreshness({ freshness_relations: ['fct_retail_sale'], sla_days: 3 }), {
      recipe: 'top_contributors', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
      period: period('2026-11-01', '2026-11-07'),
    })
    const ev = (out.payload as { evidence: Array<Record<string, any>> }).evidence[0]!
    expect(ev.dataAsOf).toBe('2026-11-09')
    expect(ev.freshness).toEqual({ status: 'normal', slaDays: 3 })
  })

  it('拿不到水位 ⇒ null + unknown（不冒充最新）', async () => {
    mocks.executeExplore.mockResolvedValue(specOk())
    const out = await exploreRecipeImpl(withFreshness({ freshness_relations: [] }), {
      recipe: 'top_contributors', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
      period: period('2026-11-01', '2026-11-07'),
    })
    const ev = (out.payload as { evidence: Array<Record<string, any>> }).evidence[0]!
    expect(ev.dataAsOf).toBeNull()
    expect(ev.freshness.status).toBe('unknown')
  })

  it('对账：文件名恒为真（映射自门禁）；run_results 读不到 ⇒ status=unknown 而不是 ok', async () => {
    mocks.executeExplore.mockResolvedValue(specOk())
    const prev = process.env.DATA_DBT_MANIFEST_PATH
    const prevR = process.env.DATA_DBT_RUN_RESULTS_PATH
    process.env.DATA_DBT_MANIFEST_PATH = '/nonexistent/dir/manifest.json'
    delete process.env.DATA_DBT_RUN_RESULTS_PATH
    try {
      const out = await exploreRecipeImpl(deps(), {
        recipe: 'top_contributors', metricId: 'lemeng:retail:net_sales', dimension: 'branch_num',
        period: period('2026-11-01', '2026-11-07'),
      })
      const ev = (out.payload as { evidence: Array<Record<string, any>> }).evidence[0]!
      expect(ev.reconcile).toEqual({
        auditFile: 'audit_lemeng__retail__net_sales.sql', status: 'unknown', executedAt: null,
      })
    } finally {
      if (prev === undefined) delete process.env.DATA_DBT_MANIFEST_PATH
      else process.env.DATA_DBT_MANIFEST_PATH = prev
      if (prevR === undefined) delete process.env.DATA_DBT_RUN_RESULTS_PATH
      else process.env.DATA_DBT_RUN_RESULTS_PATH = prevR
    }
  })
})
