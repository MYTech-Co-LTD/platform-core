// private-measure-lifecycle.test.ts — W2 Task 3：私有测度的 30 天热度淘汰 + 归档行读面。
//
// 钉住四条语义：
//   ① 只看 `source='l2'` + `basis='column_agg'` + 未归档的行（L1 与树形 L2 永不进淘汰）；
//   ② 窗口内**零使用**才归档；窗口内用过一次就留；
//   ③ 刚建出来的行即使零使用也不归档（「30 天零使用」须先活满 30 天）；
//   ④ 归档是隐藏不是删除（行与审计保留），且租户隔离（org 全查询）。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { REGRESSION_USER_ID } from './metric-usage'
import { archiveStalePrivateMeasures, listArchivedPrivateMeasures } from './private-measure-lifecycle'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-w2-lifecycle'
const OTHER_ORG = 'org-w2-lifecycle-other'
/** 平台桶的 L1 行——它绝不能进淘汰（L1 生命周期由声明/PR 管）。 */
const PLATFORM_L1 = 'w2life_l1'

let pool: Pool

/**
 * 直落一条私有测度行。
 * `createdDaysAgo` 是「这行活了多久」——淘汰的年龄闸靠它，别用默认 now()。
 */
async function seedPrivate(
  id: string,
  opts: {
    org?: string; createdDaysAgo?: number; archived?: boolean
    basis?: 'column_agg' | 'l1_tree'; revivedDaysAgo?: number
  } = {},
): Promise<void> {
  const org = opts.org ?? ORG
  await pool.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by,
        params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations,
        created_by, certified, basis, archived_at, created_at, revived_at)
     values ($1, $2, $2, '', null, 'org', 'select sum(amount) as value from fct_x', '',
             '{}'::jsonb, 'l2', null, 'u-creator', 1, false, null, null,
             'u-creator', 'draft', $3, $4, now() - make_interval(days => $5::int), $6)`,
    [
      org, id, opts.basis ?? 'column_agg', opts.archived === true ? new Date() : null,
      opts.createdDaysAgo ?? 40,
      opts.revivedDaysAgo === undefined ? null : new Date(Date.now() - opts.revivedDaysAgo * 86_400_000),
    ],
  )
}

async function seedL1(): Promise<void> {
  await pool.query(
    `insert into data.metrics
       (org, id, title, description, required_scope, subject_column, select_sql, group_by,
        params, source, source_system, totalable, sla_days, freshness_relations, basis)
     values ('platform', $1, $1, '', null, 'org', 'select sum(fct_x.amount) as value from fct_x', '',
             '{}'::jsonb, 'l1', 'lemeng', false, 1, '[]'::jsonb, 'l1_tree')
     on conflict (org, id) do nothing`,
    [PLATFORM_L1],
  )
}

/** 造一条查询审计（使用信号）。 */
async function seedAudit(metricId: string, opts: { org?: string; daysAgo?: number; userId?: string } = {}): Promise<void> {
  await pool.query(
    `insert into data.query_audit (org, user_id, channel, metric_id, params, verdict, created_at)
     values ($1, $2, 'session', $3, '{}'::jsonb, 'ok', now() - make_interval(days => $4::int))`,
    [opts.org ?? ORG, opts.userId ?? 'u-viewer', metricId, opts.daysAgo ?? 1],
  )
}

describePg('私有测度生命周期（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    await seedL1()
  })

  beforeEach(async () => {
    await pool.query('delete from data.query_audit where org = any($1)', [[ORG, OTHER_ORG]])
    await pool.query('delete from data.metrics where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metrics where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query(`delete from data.metrics where org = 'platform' and id = $1`, [PLATFORM_L1]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ 30 天零使用的私有测度 ⇒ 归档；窗口内用过 ⇒ 留；树形 L2 / L1 / 别家 org 一律不动', async () => {
    await seedPrivate('pm_unused')                     // 40 天前建、零使用 ⇒ 归档
    await seedPrivate('pm_used')                       // 40 天前建、5 天前用过 ⇒ 留
    await seedAudit('pm_used', { daysAgo: 5 })
    await seedPrivate('pm_used_long_ago')              // 40 天前用过（窗口外）⇒ 归档
    await seedAudit('pm_used_long_ago', { daysAgo: 40 })
    await seedPrivate('pm_tree', { basis: 'l1_tree' })  // 树形 L2 不属于本档 ⇒ 不动
    await seedPrivate('pm_other_org', { org: OTHER_ORG })
    await seedAudit('pm_other_org', { org: OTHER_ORG })

    const archived = await archiveStalePrivateMeasures(pool, ORG)
    expect(archived.sort()).toEqual(['pm_unused', 'pm_used_long_ago'])

    const basis = new Map((await pool.query(
      `select id, basis, archived_at from data.metrics where org = any($1)`, [[ORG, OTHER_ORG]])).rows
      .map((r) => [r.id, r]))
    expect(basis.get('pm_unused')!.archived_at).not.toBeNull()
    expect(basis.get('pm_used_long_ago')!.archived_at).not.toBeNull()
    expect(basis.get('pm_used')!.archived_at).toBeNull()
    expect(basis.get('pm_tree')!.archived_at).toBeNull()
    expect(basis.get('pm_other_org')!.archived_at).toBeNull()

    // L1 行（平台桶）不受本动作影响
    const l1 = (await pool.query(
      `select archived_at from data.metrics where org = 'platform' and id = $1`, [PLATFORM_L1])).rows[0]
    expect(l1.archived_at).toBeNull()
  })

  it('★ 「30 天零使用」须先活满 30 天：刚建的行零使用也不归档', async () => {
    await seedPrivate('pm_fresh', { createdDaysAgo: 1 })
    expect(await archiveStalePrivateMeasures(pool, ORG)).toEqual([])
    const row = (await pool.query(
      `select archived_at from data.metrics where org = $1 and id = 'pm_fresh'`, [ORG])).rows[0]
    expect(row.archived_at).toBeNull()
  })

  it('★ 复活锚点（035）：刚复活的老行从复活时刻重新起算，不立刻再归档', async () => {
    await seedPrivate('pm_revived_recently', { createdDaysAgo: 60, revivedDaysAgo: 1 })
    await seedPrivate('pm_revived_long_ago', { createdDaysAgo: 90, revivedDaysAgo: 40 })
    // 前者：coalesce(revived_at, created_at) = 1 天前 ⇒ 不在「活满 30 天」的定义域
    // 后者：复活也已 40 天且零使用 ⇒ 归档
    expect(await archiveStalePrivateMeasures(pool, ORG)).toEqual(['pm_revived_long_ago'])
  })

  it('回归重放（REGRESSION_USER_ID）不算使用 ⇒ 仍归档', async () => {
    await seedPrivate('pm_regression_only')
    await seedAudit('pm_regression_only', { daysAgo: 3, userId: REGRESSION_USER_ID })
    expect(await archiveStalePrivateMeasures(pool, ORG)).toEqual(['pm_regression_only'])
  })

  it('★ 幂等：归档行不会被二次归档（第二次运行零返回）', async () => {
    await seedPrivate('pm_idempotent')
    expect(await archiveStalePrivateMeasures(pool, ORG)).toEqual(['pm_idempotent'])
    expect(await archiveStalePrivateMeasures(pool, ORG)).toEqual([])
  })

  it('★ 归档是隐藏不是删除：行仍在、审计可见；读面只列本 org 的归档私有测度', async () => {
    await seedPrivate('pm_list')
    await seedPrivate('pm_list_other', { org: OTHER_ORG })
    await seedPrivate('pm_active')
    await seedAudit('pm_active', { daysAgo: 1 })
    await archiveStalePrivateMeasures(pool, ORG)

    const row = (await pool.query(
      `select 1 from data.metrics where org = $1 and id = 'pm_list'`, [ORG])).rowCount
    expect(row).toBe(1)                                // 没删

    const archived = await listArchivedPrivateMeasures(pool, ORG)
    expect(archived.map((m) => m.id)).toEqual(['pm_list'])
    expect(archived[0]).toMatchObject({
      id: 'pm_list',
      title: 'pm_list',
      createdBy: 'u-creator',
      lastUsedAt: null,
    })
    expect(archived[0]!.archivedAt).not.toBeNull()

    // 别家 org 的归档行不出现在我家的读面
    await archiveStalePrivateMeasures(pool, OTHER_ORG)
    expect((await listArchivedPrivateMeasures(pool, ORG)).map((m) => m.id)).toEqual(['pm_list'])
  })

  it('非法 days ⇒ 抛（不给「0 天全归档」这种静默默认）', async () => {
    await expect(archiveStalePrivateMeasures(pool, ORG, 0)).rejects.toThrow()
    await expect(archiveStalePrivateMeasures(pool, ORG, 1.5)).rejects.toThrow()
  })
})
