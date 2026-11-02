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

  it('条件清除（确认路径的并发守卫）：内容对得上才清；被并发新稿抢先 ⇒ false 且新稿保留', async () => {
    const v1 = { title: 'v1' }
    const v2 = { title: 'v2' }
    expect(await saveMetricDraft(pool, ORG, 'gov_m1', CREATOR, v1)).toBe(true)
    // 内容对得上：清掉，返回 true
    expect(await clearMetricDraft(pool, ORG, 'gov_m1', CREATOR, v1)).toBe(true)
    // 模拟「load 之后另一标签页存了 v2」：拿旧内容 v1 去清 ⇒ false，v2 原地保留
    expect(await saveMetricDraft(pool, ORG, 'gov_m1', CREATOR, v2)).toBe(true)
    expect(await clearMetricDraft(pool, ORG, 'gov_m1', CREATOR, v1)).toBe(false)
    expect(await loadMetricDraft(pool, ORG, 'gov_m1', CREATOR)).toEqual(v2)
  })

  it('028 回填：created_by 为 NULL 的存量行从 create 审计回填（最新一条 create 为准）', async () => {
    const { readFileSync } = await import('node:fs')
    const id = 'gov_backfill_m1'
    // 夹具：creator 未知的 L2（直接落 NULL）+ 两条 create 审计（模拟建删建，现行行属于最后一次创建）
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by,
          params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations, created_by, certified)
       values ($1, $2, '回填夹具', '', null, 'org', 'select 1 as value', '', '{}'::jsonb, 'l2', null, 'x', 1, false, null, null, null, 'draft')`,
      [ORG, id])
    await pool.query(
      `insert into data.metric_audit (org, metric_id, action, user_id, channel, key_id, row_before, row_after, created_at)
       values ($1, $2, 'create', 'gov-first-user', 'pat', 1, null, '{}'::jsonb, '2026-01-01T00:00:00Z'),
              ($1, $2, 'create', 'gov-last-user',  'pat', 1, null, '{}'::jsonb, '2026-01-02T00:00:00Z')`,
      [ORG, id])
    // 跑 028 的 SQL（幂等：只回填 NULL 行；直接跑文件内容，与部署期同源）
    const sql = readFileSync(new URL('../migrations/028_metric_creator_backfill.sql', import.meta.url), 'utf8')
    await pool.query(sql)
    const row = await pool.query(`select created_by from data.metrics where org = $1 and id = $2`, [ORG, id])
    expect(row.rows[0].created_by).toBe('gov-last-user')
    // 再跑一遍：幂等（已非 NULL，不动）
    await pool.query(sql)
    const again = await pool.query(`select created_by from data.metrics where org = $1 and id = $2`, [ORG, id])
    expect(again.rows[0].created_by).toBe('gov-last-user')
    await pool.query(`delete from data.metric_audit where org = $1 and metric_id = $2`, [ORG, id])
    await pool.query(`delete from data.metrics where org = $1 and id = $2`, [ORG, id])
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
