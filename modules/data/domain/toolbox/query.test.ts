// query.test.ts — 数值面：preview 零仓库调用；query_metric 信封逐字段；拒绝透传。
// 不 mock runQuery 本身：真 runQuery + 假 execute/warehouseExec/假平台池（query-service.test.ts 同手法）。
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { previewImpl, queryMetricImpl } from './query'
import type { ToolboxDeps } from './registry'
import type { Requester } from '../authz'

const requester: Requester = {
  userId: 'u', orgId: 'acme', channel: 'pat', keyId: 1,
  scopes: ['data:query'], hasScope: (c) => c === 'data:query',
}

const SELECT_SQL = 'select org, bizday, sum(v) as value from marts.fct_retail_sale group by org, bizday'

/** 平台库假池：词表一行 net_sales（l1/lemeng/totalable/无掩码）；其余 SQL（审计 insert 等）回固定 id=77。 */
const catalogPool = () => ({
  query: async (sql: string) => sql.includes('from data.metrics')
    ? { rows: [{
        id: 'lemeng:retail:net_sales', title: '净销', description: '净销售额', required_scope: null,
        subject_column: 'org', select_sql: SELECT_SQL, group_by: 'org, bizday', params: {},
        source: 'l1', source_system: 'lemeng', updated_by: null, version: 3, totalable: true,
        scope_note: '', sla_days: null, freshness_relations: null, mask_spec: null,
      }] }
    : { rows: [{ id: 77, created_at: new Date('2026-10-21T10:00:00Z') }] },
}) as never

function deps(wh: ToolboxDeps['wh'], dbt?: ToolboxDeps['dbtManifest']): ToolboxDeps {
  return {
    pool: catalogPool(), org: 'acme', requester, adoptedSources: new Set(['lemeng']), wh,
    ...(dbt !== undefined ? { dbtManifest: dbt } : {}),
    now: () => new Date('2026-10-21T10:00:00+08:00'),
  }
}

describe('previewImpl：只编译不执行（0 次仓库查询）', () => {
  it('回 sql/estimatedRows/warnings/subject；deps.wh 零调用', async () => {
    const whCalls: string[] = []
    const d = deps(async (sql) => { whCalls.push(sql); return { columns: [], rows: [] } })
    const out = await previewImpl(d, { metricId: 'lemeng:retail:net_sales' })
    expect(out.isError).toBe(false)
    expect(out.auditRowCount).toBeNull()
    const p = out.payload as { sql: string; estimatedRows: number; warnings: string[]; subject: string }
    expect(p.sql).toContain("WHERE org = 'acme'")
    expect(p.estimatedRows).toBe(1000)
    expect(p.warnings[0]).toContain('上限')
    expect(p.subject).toBe('acme')
    expect(whCalls).toHaveLength(0)
  })
  it('保留键拒（subject_pinned_by_platform）——与 runQuery 同拒绝链', async () => {
    const out = await previewImpl(
      deps(async () => ({ columns: [], rows: [] })),
      { metricId: 'lemeng:retail:net_sales', args: { org: 'x' } },
    )
    expect(out.isError).toBe(true)
    expect(out.payload).toMatchObject({ status: 'denied', reason: 'subject_pinned_by_platform' })
  })
})

describe('queryMetricImpl：完整信任信封', () => {
  const wh = async (): Promise<{ columns: string[]; rows: unknown[][] }> => ({
    columns: ['org', 'bizday'], rows: [['acme', '2026-10-20']],
  })
  const manifestDep: ToolboxDeps['dbtManifest'] = async () => ({
    dependsOnOf: (m: string) => (m === 'fct_retail_sale' ? ['stg_lemeng_retail_order_line'] : []),
    childrenOf: () => [], testCountOf: () => 0,
  })

  it('信封七节（本例 load_log/水位缺席 ⇒ asOf 缺席——可辨不编造）', async () => {
    const d = deps(wh, manifestDep)
    const out = await queryMetricImpl(d, { metricId: 'lemeng:retail:net_sales' })
    expect(out.isError).toBe(false)
    const env = out.payload as Record<string, Record<string, unknown>>
    expect(env.status).toBe('ok')
    expect(env.metric).toMatchObject({ id: 'lemeng:retail:net_sales', version: 3, tier: 'certified', owner: 'data-platform', title: '净销' })
    expect(env.metric.definitionHash).toBe('sha256:' + createHash('sha256').update(SELECT_SQL + '{}').digest('hex'))
    expect(env.subject).toMatchObject({ org: 'acme', source: 'lemeng', adoptedSources: ['lemeng'] })
    expect('asOf' in env).toBe(false)
    expect(env.query).toMatchObject({ rowLimit: 1000, queryId: 'q_77' })
    expect(env.result).toMatchObject({ rowCount: 1, truncated: false })
    expect(env.lineage).toMatchObject({ model: 'fct_retail_sale', upstream: ['stg_lemeng_retail_order_line'] })
    expect(env.audit).toMatchObject({ id: 77 })
    expect(out.auditMetricId).toBe('lemeng:retail:net_sales')
    expect(out.auditRowCount).toBe(1)
  })

  it('切片请求生效（dimensions → 外层聚合 SQL）；未知指标 denied 透传', async () => {
    const seen: string[] = []
    const d = deps(async (sql) => { seen.push(sql); return { columns: ['org'], rows: [['acme']] } }, manifestDep)
    const out = await queryMetricImpl(d, { metricId: 'lemeng:retail:net_sales', dimensions: ['org'] })
    expect(out.isError).toBe(false)
    expect(seen[0]).toContain('sum(value) as value')
    const bad = await queryMetricImpl(d, { metricId: 'nope' })
    expect(bad.isError).toBe(true)
    expect(bad.payload).toMatchObject({ status: 'denied', reason: 'metric_not_declared' })
  })

  it('血缘源缺席 ⇒ 信封 lineage 节缺席（可辨，不编）', async () => {
    const d = deps(wh, async () => null)
    const out = await queryMetricImpl(d, { metricId: 'lemeng:retail:net_sales' })
    expect('lineage' in (out.payload as Record<string, unknown>)).toBe(false)
  })
})
