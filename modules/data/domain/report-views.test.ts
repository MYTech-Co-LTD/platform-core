// report-views.test.ts — 报表访问台账与「30 天零访问」口径（R6）。
//
// 判据：
//  · 访问台账按 (org, report_id) UPSERT，重复访问推进时间与计数；
//  · 「零访问」从 max(last_viewed_at, created_at) 起算——刚建出来不报噪声；
//  · 看过一次就不再算零访问；报表删除级联清台账。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertReport } from './report-store'
import { parseReportSpec, type ReportSpec } from './report-spec'
import { recordReportView, staleReports } from './report-views'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-report-views'
/** platform 行必须有 spec（库侧 check `data_reports_spec_by_renderer`）。 */
const SPEC: ReportSpec = (() => {
  const parsed = parseReportSpec({ panels: [{ chart: 'text', content: 'x', span: 24 }] })
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.spec
})()

describePg('report views（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  const makeReport = (title: string): Promise<string> => upsertReport(pool, ORG, {
    title, metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform', spec: SPEC,
  })

  const ageReport = async (id: string, days: number): Promise<void> => {
    await pool.query(
      `update data.reports set created_at = now() - ($3::int * interval '1 day')
        where org = $1 and id = $2`,
      [ORG, id, days],
    )
  }

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.reports where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ 重复访问 UPSERT：时间推进 + 计数累加', async () => {
    const id = await makeReport('季度经营')
    await recordReportView(pool, ORG, id, 'u1')
    await recordReportView(pool, ORG, id, 'u2')
    const r = await pool.query(
      'select last_viewed_by, view_count::text as n from data.report_views where org=$1 and report_id=$2',
      [ORG, id],
    )
    expect(r.rows[0]).toMatchObject({ last_viewed_by: 'u2', n: '2' })
  })

  it('★ 零访问从创建时刻起算：刚建的不报，40 天没动才报', async () => {
    const fresh = await makeReport('刚建的')
    const old = await makeReport('很久没看')
    await ageReport(old, 40)

    const out = await staleReports(pool, ORG, 30)
    const ids = out.stale.map((x) => x.id)
    expect(ids).not.toContain(fresh)
    const hit = out.stale.find((x) => x.id === old)
    expect(hit).toMatchObject({ lastViewedAt: null, viewCount: 0 })
    expect(hit!.daysSince).toBeGreaterThanOrEqual(39)
  })

  it('★ 看过一次就不再算零访问（哪怕报表很老）', async () => {
    const id = await makeReport('老的但有人看')
    await ageReport(id, 40)
    await recordReportView(pool, ORG, id, 'u1')
    const out = await staleReports(pool, ORG, 30)
    expect(out.stale.some((x) => x.id === id)).toBe(false)
  })

  it('报表删除 ⇒ 访问台账级联清掉', async () => {
    const id = await makeReport('将被回收')
    await recordReportView(pool, ORG, id, 'u1')
    await pool.query('delete from data.reports where org = $1 and id = $2', [ORG, id])
    const r = await pool.query(
      'select 1 from data.report_views where org = $1 and report_id = $2', [ORG, id],
    )
    expect(r.rowCount).toBe(0)
  })
})
