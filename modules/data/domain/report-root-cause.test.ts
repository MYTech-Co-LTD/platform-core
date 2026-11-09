// report-root-cause.test.ts — `ai_text` focus=root_cause 的根因事实包。
//
// 判据：从报表自身的 KPI/日趋势候选出发，走声明了 detail 绑定的指标下钻，
// 按维度算出「本期 - 基期」；所有数字进白名单；不可分解的指标如实标 unavailable。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertL1Metric, type L1MetricDef } from './metric-store'
import type { Requester } from './authz'
import { parseReportSpec, type PeriodSpec } from './report-spec'
import { buildRootCause, numOf, type RootCauseFacts } from './report-root-cause'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-report-root-cause'
const METRIC = 'rc:net_sales'
const METRIC_ITEM = 'rc:item_net_sales'
const PERIOD: PeriodSpec = { mode: 'custom', from: '2026-10-01', to: '2026-10-19' }

const metric: L1MetricDef = {
  id: METRIC, title: '净销售额', description: '根因测试夹具',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select sum(fct_retail_sale.net_amount) as value, branch_num, bizday from fct_retail_sale',
  groupBy: 'branch_num, bizday',
  params: { bizday: { column: 'bizday', type: 'date_range' } },
  sourceSystem: 'lemeng', slaDays: 1, freshnessRelations: [], masks: null,
  drill: {
    expr: 'sale_amount - return_amount',
    dims: ['system_book', 'bizday', 'branch_num', 'order_no'],
    relation: 'vw_t',
    filter: "state = 'FINISHED'",
  },
}

const metricItem: L1MetricDef = {
  ...metric,
  id: METRIC_ITEM,
  title: '净销售额（商品）',
  drill: {
    ...metric.drill!,
    dims: ['system_book', 'bizday', 'branch_num', 'item_num', 'order_no'],
  },
}

function requester(): Requester {
  const scopes = ['data:query']
  return { userId: 'u-rc', orgId: ORG, channel: 'session', keyId: null, scopes, hasScope: (c) => scopes.includes(c) }
}

/** 假仓库：10 月本期 92=500/93=800；9 月基期 92=1700/93=700。 */
const execute = async (sql: string) => {
  const s = sql.toLowerCase()
  if (s.includes('count(*)')) return { columns: ['n'], rows: [[2]] }
  if (s.includes('from vw_t')) {
    const prev = s.includes('2026-09')
    return {
      columns: ['branch_num', 'value'],
      rows: prev ? [['92', 1700], ['93', 700]] : [['92', 500], ['93', 800]],
    }
  }
  return { columns: [], rows: [] }
}

const facts: RootCauseFacts = {
  kpis: [{ panel: '销售额', metricId: METRIC, format: 'number', current: '500', previous: '1,700', delta: '-70.59%' }],
  breakdowns: [],
  daily: { min: { day: '2026-10-13', value: '500' }, max: null },
  dataAsOf: '2026-10-25 06:00:00 +08:00',
}

function specOf() {
  const parsed = parseReportSpec({
    period: PERIOD,
    panels: [
      { chart: 'kpi', title: '销售额', metricId: METRIC, format: 'number', compare: 'prev_period', args: {} },
      { chart: 'line', title: '销售额趋势', metricId: METRIC, dims: ['bizday'], args: {} },
      { chart: 'ai_text', title: '根因', focus: 'root_cause' },
    ],
  })
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.spec
}

describePg('buildRootCause（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1 and id = any($2)', ['platform', [METRIC, METRIC_ITEM]]).catch(() => {})
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('KPI 有对比 + 声明了下钻 ⇒ 按 branch_num 做「本期 - 基期」分解', async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, metric)
    const analysis = await buildRootCause(
      {
        pool, org: ORG, requester: requester(), adoptedSources: new Set(['lemeng']),
        execute,
      },
      specOf(), { from: '2026-10-01', to: '2026-10-19' }, 'custom', facts,
    )
    expect(analysis).not.toBeNull()
    const variance = analysis!.findings.find((f) => f.kind === 'variance' && f.dimension === 'branch_num')
    expect(variance).toBeDefined()
    expect(variance!.rows[0]).toMatchObject({ label: '92', value: '500', delta: '-1,200' })
    // 白名单：变化量与值都进 numbers，narrative 的数字校验才放行
    expect(analysis!.numbers).toContain('-1,200')
    expect(analysis!.numbers).toContain('500')
    expect(analysis!.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('主因不在门店 ⇒ 有界循环自动换到商品维，并下钻到订单行', async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, metricItem)
    const exec = async (sql: string) => {
      const s = sql.toLowerCase()
      if (s.includes('count(*)')) return { columns: ['n'], rows: [[3]] }
      if (s.includes('from vw_t')) {
        const prev = s.includes('2026-09')
        if (s.includes('item_num')) {
          return {
            columns: ['item_num', 'order_no', 'value'],
            rows: prev
              ? [['I1', 'O1', 0], ['I2', 'O2', 0], ['I3', 'O3', 0]]
              : [['I1', 'O1', 100], ['I2', 'O2', 10], ['I3', 'O3', 10]],
          }
        }
        return {
          columns: ['branch_num', 'order_no', 'value'],
          rows: prev
            ? [['B1', 'O1', 0], ['B2', 'O2', 0], ['B3', 'O3', 0]]
            : [['B1', 'O1', 10], ['B2', 'O2', 9], ['B3', 'O3', 8]],
        }
      }
      return { columns: [], rows: [] }
    }
    const parsed = parseReportSpec({
      period: PERIOD,
      panels: [
        { chart: 'kpi', title: '销售额', metricId: METRIC_ITEM, format: 'number', compare: 'prev_period', args: {} },
        { chart: 'line', title: '销售额趋势', metricId: METRIC_ITEM, dims: ['bizday'], args: {} },
        { chart: 'ai_text', title: '根因', focus: 'root_cause' },
      ],
    })
    if (!parsed.ok) throw new Error(parsed.code)
    const factsItem: RootCauseFacts = {
      ...facts,
      kpis: [{ ...facts.kpis[0]!, metricId: METRIC_ITEM }],
    }
    const analysis = await buildRootCause(
      {
        pool, org: ORG, requester: requester(), adoptedSources: new Set(['lemeng']),
        execute: exec,
      },
      parsed.spec, { from: '2026-10-01', to: '2026-10-19' }, 'custom', factsItem,
    )
    expect(analysis).not.toBeNull()
    // 门店维解释度 10/27 ≈ 0.37 < 0.5 ⇒ 换商品维；商品维 100/120 ≈ 0.83 ⇒ 收口
    expect(analysis!.findings.some((f) => f.dimension === 'item_num' && f.kind === 'variance')).toBe(true)
    // 胜出维度再下一层：订单行
    expect(analysis!.findings.some((f) => f.dimension === 'order_no' && f.rows.some((r) => r.label === 'O1'))).toBe(true)
    expect(analysis!.tried).toContain(`${METRIC_ITEM}:branch_num`)
    expect(analysis!.tried).toContain(`${METRIC_ITEM}:item_num`)
  })

  it('不可见/未接入源的指标不产出 findings（不与 /query 的裁剪尺打架）', async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, metric)
    const analysis = await buildRootCause(
      {
        pool, org: ORG, requester: requester(), adoptedSources: new Set([]),
        execute,
      },
      specOf(), { from: '2026-10-01', to: '2026-10-19' }, 'custom', facts,
    )
    // 拆解为空 + 两个候选都不可见 ⇒ 没有 findings ⇒ null（不编 unavailable 行）
    expect(analysis).toBeNull()
  })
})

describe('numOf', () => {
  it('格式化值 → 数字；百分号/pp/千分位/负号都归一', () => {
    expect(numOf('1,234.56')).toBe(1234.56)
    expect(numOf('-1,200')).toBe(-1200)
    expect(numOf('47.36%')).toBe(47.36)
    expect(numOf('+2.1pp')).toBe(2.1)
    expect(numOf('-')).toBeNull()
  })
})
