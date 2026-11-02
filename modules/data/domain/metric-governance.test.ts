// metric-governance.test.ts — 指标治理存储行为（spec 2026-11-01 §10.4 P0）
//
// 只测 domain 层三函数的真实库行为（route 层的形状在 routes/metrics.test.ts 侧）：
//   · saveMetricDraft  往返（存进去的是什么，读出来必须还是什么）——这条抓的是
//     「$3 复用」类参数错位：set 与 where 各用一个占位符，写歪了往返必露馅
//   · 非 creator / 非 L2 写不进去（false，行不动）
//   · clearMetricDraft 真清除
// canEditMetric 是纯函数，不占库，放顶层 describe（无 DATABASE_URL 也跑）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { MetricDef } from './authz'
import { canEditMetric, clearMetricDraft, loadMetricDraft, saveMetricDraft } from './metric-governance'
import { upsertMetric } from './metric-store'
import { applyMigrations } from '../test-util'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键：各测试文件互不相同的 org，避免互相擦数据（同 metric-store.test.ts 约定）。 */
const ORG = 'org-gov-t10-metric'
const CREATOR = 'gov-creator-a'
const OTHER = 'gov-creator-b'
const DRAFT = { title: '毛利率(草稿)', expr: 'sum(gross_profit) / nullif(sum(revenue),0)' }

/** 词表形状照 domain/authz.ts 的 `MetricDef`（同 metric-store.test.ts 的 def()）。 */
function def(over: Partial<MetricDef> = {}): MetricDef {
  return {
    id: 'gov_m1',
    title: '毛利率',
    description: '毛利 ÷ 收入',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'SELECT org, day, gross_profit, revenue FROM marts.mart_sales_daily',
    groupBy: '',
    params: { day_from: { column: 'day', type: 'date', required: true } },
    ...over,
  }
}

describePg('metric-governance（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await applyMigrations(pool)
    // 夹具：creator=CREATOR 的一条 L2（upsertMetric 首插写 created_by + certified='draft'）
    await upsertMetric(pool, ORG, def(), CREATOR)
  })

  afterAll(async () => {
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('saveMetricDraft 往返：存进去的草稿，读出来必须原样（抓参数错位）', async () => {
    const ok = await saveMetricDraft(pool, ORG, 'gov_m1', CREATOR, DRAFT)
    expect(ok).toBe(true)
    const draft = await loadMetricDraft(pool, ORG, 'gov_m1', CREATOR)
    expect(draft).toEqual(DRAFT)
  })

  it('非 creator 存草稿 → false，且已有草稿不被别人覆盖/读出', async () => {
    expect(await loadMetricDraft(pool, ORG, 'gov_m1', OTHER)).toBeNull()
    const ok = await saveMetricDraft(pool, ORG, 'gov_m1', OTHER, { title: '别人的覆盖' })
    expect(ok).toBe(false)
    // creator 的草稿原封不动
    expect(await loadMetricDraft(pool, ORG, 'gov_m1', CREATOR)).toEqual(DRAFT)
  })

  it('clearMetricDraft 真清除：清后 load 回 null', async () => {
    await clearMetricDraft(pool, ORG, 'gov_m1', CREATOR)
    expect(await loadMetricDraft(pool, ORG, 'gov_m1', CREATOR)).toBeNull()
  })
})

describe('canEditMetric（纯逻辑 · 无需库）', () => {
  it('L2 且 creator 才可编辑；L1 只读；created_by 为 NULL（存量行）不可编辑', () => {
    expect(canEditMetric('l2', CREATOR, CREATOR)).toBe(true)
    expect(canEditMetric('l2', CREATOR, OTHER)).toBe(false)
    expect(canEditMetric('l1', CREATOR, CREATOR)).toBe(false)
    expect(canEditMetric('l2', null, CREATOR)).toBe(false)
  })
})
