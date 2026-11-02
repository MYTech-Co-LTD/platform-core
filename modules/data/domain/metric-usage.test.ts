// metric-usage.test.ts — 使用统计读面（spec 2026-11-01 §10.4.3 P1）：按 metricId 聚合 + 下线候选。
// 只钉域层聚合与候选判定（route 层形状在 routes/metrics.test.ts；caption 抽屉是 console 面）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { metricUsageStats, retireCandidatesOf } from './metric-usage'
import { upsertMetric } from './metric-store'
import { applyMigrations } from '../test-util'
import type { MetricDef } from './authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键：各测试文件互不相同的 org，避免互相擦数据（同 metric-store.test.ts 约定）。 */
const ORG = 'org-t11-usage'

function def(over: Partial<MetricDef> = {}): MetricDef {
  return {
    id: 'usage_m1',
    title: '使用统计夹具',
    description: '',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.mart_usage_daily',
    groupBy: '',
    params: {},
    ...over,
  }
}

describePg('metricUsageStats（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  beforeAll(async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, def({ id: 'usage_hot', title: '热点' }), 'u-creator')
    await upsertMetric(pool, ORG, def({ id: 'usage_cold', title: '冷的' }), 'u-creator')
    await upsertMetric(pool, ORG, def({ id: 'usage_old', title: '早期用过' }), 'u-creator')
    // 审计夹具：hot 近期被两人多次用；old 只在窗口外用过（30 天前）；cold 零审计 ⇒ 诚实零
    await pool.query(
      `insert into data.query_audit (org, user_id, channel, metric_id, verdict, created_at) values
         ($1, 'u-alice', 'session', 'usage_hot', 'ok', now() - interval '1 day'),
         ($1, 'u-alice', 'session', 'usage_hot', 'ok', now() - interval '2 day'),
         ($1, 'u-bob',   'pat',     'usage_hot', 'denied', now() - interval '3 day'),
         ($1, 'u-alice', 'session', 'usage_old', 'ok', now() - interval '60 day')`,
      [ORG],
    )
  })

  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('按 metricId 聚合：次数（全 verdict）/去重用户（盖 denied 行）/最近一次；无审计 ⇒ 诚实零', async () => {
    const stats = await metricUsageStats(pool, ORG, 30)
    const byId = new Map(stats.map((s) => [s.metricId, s]))
    const hot = byId.get('usage_hot')
    expect(hot).toMatchObject({ queries: 3, users: 2, metricId: 'usage_hot', title: '热点', source: 'l2' })
    expect(hot?.lastUsedAt).not.toBeNull()
    // cold：词表里有行、审计里没有 ⇒ 使用 0（不是缺席不报）
    expect(byId.get('usage_cold')).toMatchObject({ queries: 0, users: 0, lastUsedAt: null })
    // old：60 天前的使用在 30 天窗外 ⇒ 窗口内 0
    expect(byId.get('usage_old')).toMatchObject({ queries: 0, users: 0, lastUsedAt: null })
  })

  it('跨租户不串：别的 org 的审计行不进本租户聚合', async () => {
    await pool.query(
      `insert into data.query_audit (org, user_id, channel, metric_id, verdict, created_at)
       values ('org-t11-usage-OTHER', 'u-bob', 'session', 'usage_hot', 'ok', now())`,
    )
    const stats = await metricUsageStats(pool, ORG, 30)
    expect(new Map(stats.map((s) => [s.metricId, s])).get('usage_hot')).toMatchObject({ queries: 3 })
    await pool.query('delete from data.query_audit where org = $1', ['org-t11-usage-OTHER'])
  })

  it('下线候选：source=l2 且窗口内 0 次才候选；用过的不候选', async () => {
    const candidates = await retireCandidatesOf(pool, ORG, 30)
    const ids = candidates.map((c) => c.metricId)
    expect(ids).toContain('usage_cold')
    expect(ids).toContain('usage_old')           // 窗口外用过 = 窗口内 0 ⇒ 候选
    expect(ids, '热点用过 ⇒ 不是候选').not.toContain('usage_hot')
    for (const c of candidates) {
      expect(c.source).toBe('l2')
      expect(typeof c.createdBy).toBe('string')  // 下线候选要能找到人
    }
  })
})
