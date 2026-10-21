// health.test.ts — 三个健康工具：未知显式化（无结论 ≠ 通过），水位判据与发布面对齐表同源。
import { describe, expect, it } from 'vitest'
import { defaultDbtManifest, freshnessImpl, lineageImpl, parseDbtManifest, qualityImpl } from './health'
import type { ToolboxDeps } from './registry'
import type { MetricRow } from '../metric-store'
import type { Requester } from '../authz'

const requester: Requester = { userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1, scopes: [], hasScope: () => true }
const row = (over: Partial<MetricRow>): MetricRow => ({
  id: 'lemeng:retail:net_sales', title: '净销', description: '', requiredScope: null,
  subjectColumn: 'org', selectSql: 'select org from fct', groupBy: 'org, bizday', params: {},
  source: 'l1', sourceSystem: 'lemeng', updatedBy: null, version: 1, totalable: true,
  scopeNote: '', slaDays: 2, freshnessRelations: ['stg_a'], masks: null, ...over,
}) as MetricRow

function deps(over: Partial<ToolboxDeps> & { catalog?: MetricRow[] }): ToolboxDeps {
  const catalog = over.catalog ?? [row({})]
  return {
    pool: { query: async () => ({ rows: catalog.map((m) => ({ id: m.id, group_by: m.groupBy, sla_days: m.slaDays, freshness_relations: m.freshnessRelations, source: m.source, source_system: m.sourceSystem })) }) } as never,
    org: 'acme', requester, adoptedSources: new Set(['lemeng']),
    wh: over.wh ?? (async () => ({ columns: [], rows: [] })),
    now: over.now ?? (() => new Date('2026-10-21T10:00:00+08:00')),
    dbtManifest: over.dbtManifest,
  }
}

describe('freshnessImpl', () => {
  it('scope=指标：链路水位 + status + line；滞后秒数由注入时钟计算', async () => {
    const d = deps({ wh: async (sql) => sql.includes('stg_a')
      ? { columns: ['watermark', 'materialized_at'], rows: [['2026-10-20', new Date('2026-10-21T02:10:00+08:00')]] }
      : { columns: [], rows: [] } })
    const out = await freshnessImpl(d, { scope: 'lemeng:retail:net_sales' })
    const p = out.payload as { dataThrough?: string; freshness_status?: string; line?: string; freshnessLagSeconds?: number }
    expect(p.dataThrough).toBe('2026-10-20')
    expect(p.freshness_status).toBe('normal')
    expect(p.line).toContain('10月20日')
    expect(p.freshnessLagSeconds).toBe(28_200)
  })
  it('无链路/水位缺失 ⇒ 字段缺席（不编造日期）', async () => {
    const out = await freshnessImpl(deps({ catalog: [row({ freshnessRelations: null, slaDays: null })] }), { scope: 'lemeng:retail:net_sales' })
    expect('dataThrough' in out.payload).toBe(false)
  })
  it('缺省 scope ⇒ 全局水位（内存 min/max）', async () => {
    const d = deps({ wh: async (sql) => sql.includes('distinct on')
      ? { columns: ['relation', 'max_bizday', 'materialized_at'], rows: [['a', '2026-10-19', new Date('2026-10-21T01:00:00+08:00')], ['b', '2026-10-20', new Date('2026-10-21T02:00:00+08:00')]] }
      : { columns: [], rows: [] } })
    const out = await freshnessImpl(d, {})
    expect((out.payload as { dataThrough?: string }).dataThrough).toBe('2026-10-19')  // 木桶短板
  })
})

describe('qualityImpl / lineageImpl：seam 缺席 = 显式 unknown', () => {
  it('seam 缺席 ⇒ unknown + reason，isError=false', async () => {
    const q = await qualityImpl(deps({}), { model: 'fct_x' })
    expect(q.isError).toBe(false)
    expect(q.payload).toMatchObject({ status: 'unknown', reason: 'dbt_manifest_unavailable' })
    const l = await lineageImpl(deps({}), { id: 'fct_x' })
    expect(l.payload).toMatchObject({ status: 'unknown', reason: 'dbt_manifest_unavailable', id: 'fct_x' })
  })
  it('depth 非法 ⇒ bad_param/invalid_depth；有 manifest ⇒ upstream/downstream 有界、去重、不含自身', async () => {
    expect((await lineageImpl(deps({}), { id: 'x', depth: 4 })).payload)
      .toMatchObject({ status: 'denied', reason: 'bad_param', detail: 'invalid_depth' })
    const raw = {
      nodes: {
        'model.d.stg': { resource_type: 'model', depends_on: { nodes: [] }, name: 'stg' },
        'model.d.fct': { resource_type: 'model', depends_on: { nodes: ['model.d.stg'] }, name: 'fct' },
        'model.d.mart': { resource_type: 'model', depends_on: { nodes: ['model.d.fct'] }, name: 'mart' },
        'test.d.t1': { resource_type: 'test', depends_on: { nodes: ['model.d.fct'] }, name: 't1' },
      },
      child_map: { 'model.d.stg': ['model.d.fct'], 'model.d.fct': ['model.d.mart', 'test.d.t1'], 'model.d.mart': [], 'test.d.t1': [] },
    }
    const d = deps({ dbtManifest: async () => raw })
    const out = await lineageImpl(d, { id: 'fct', depth: 2 })
    const p = out.payload as { status: string; upstream: string[]; downstream: string[] }
    expect(p.status).toBe('ok')
    expect(p.upstream).toEqual(['stg'])
    expect(p.downstream).toEqual(['mart', 't1'])
    const q = await qualityImpl(d, { model: 'fct' })
    expect(q.payload).toMatchObject({ status: 'ok', model: 'fct', testsDeclared: 1 })
  })
})

describe('parseDbtManifest / defaultDbtManifest', () => {
  it('坏形状 ⇒ null；缺 env ⇒ async ()=>null', async () => {
    expect(parseDbtManifest(null)).toBeNull()
    expect(parseDbtManifest({ nodes: 42 })).toBeNull()
    const loader = defaultDbtManifest({})
    expect(await loader()).toBeNull()
    await expect(defaultDbtManifest({ DATA_DBT_MANIFEST_PATH: '/no/such/file.json' })()).resolves.toBeNull()
  })
})
