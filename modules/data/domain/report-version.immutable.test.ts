// report-version.immutable.test.ts — 049：发布快照在**库层**拒绝 UPDATE（R6）。
//
// 为什么单独测：这条保证不在任何服务函数里，读者只能从迁移文件看出来；而它一旦被人
// 删掉（「迁移太重了」），服务层测试全部照绿——快照可被直连篡改且无人知晓。
// 需要 `DATABASE_URL`，没有就整组 skip（同 report-version.test.ts）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertMetric } from './metric-store'
import { parseReportSpec } from './report-spec'
import { upsertReport } from './report-store'
import { publishVersion } from './report-version'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = 'org-report-immutable'
const METRIC = 'rvi:sales'

const SPEC = (() => {
  const parsed = parseReportSpec({ panels: [{ chart: 'table', title: '销售', metricId: METRIC, dims: [], args: {}, span: 24 }] })
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.spec
})()

describePg('发布快照不可变（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  let reportId = ''

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.reports where org = $1', [ORG])
    await pool.query('delete from data.metrics where org = $1', [ORG])
    await upsertMetric(pool, ORG, {
      id: METRIC, title: '销售额', description: '不可变夹具', requiredScope: null,
      subjectColumn: 'org', selectSql: 'select 1 as value', groupBy: '', params: {},
    }, 'fixture')
    reportId = await upsertReport(pool, ORG, {
      title: '快照不可变', metabaseId: 0, embedParams: {}, requiredScope: null,
      renderer: 'platform', spec: SPEC,
    })
    await publishVersion(pool, ORG, reportId, 1, 'u-test', '首次发布', new Set())
  })

  afterAll(async () => {
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('UPDATE 快照 ⇒ 库层直接拒绝（REPORT_VERSION_IMMUTABLE）', async () => {
    await expect(
      pool.query('update data.report_versions set title = $1 where org = $2 and report_id = $3', ['被篡改', ORG, reportId]),
    ).rejects.toThrow(/REPORT_VERSION_IMMUTABLE/)
    // 回读确认真的没改（触发器抛错即整句回滚，不留半改状态）
    const r = await pool.query<{ title: string }>(
      'select title from data.report_versions where org = $1 and report_id = $2', [ORG, reportId],
    )
    expect(r.rows[0]?.title).toBe('快照不可变')
  })

  it('DELETE 仍可用（回收报表要级联删版本，不能拦）', async () => {
    const before = await pool.query('select count(*)::int as n from data.report_versions where org = $1', [ORG])
    expect(before.rows[0]?.n).toBeGreaterThan(0)
    await pool.query('delete from data.reports where org = $1 and id = $2', [ORG, reportId])
    const after = await pool.query('select count(*)::int as n from data.report_versions where org = $1', [ORG])
    expect(after.rows[0]?.n).toBe(0)
  })
})
