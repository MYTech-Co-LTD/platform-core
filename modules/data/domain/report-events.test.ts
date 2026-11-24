// report-events.test.ts — 报表事件遥测与漏斗（N1/N2 数据基础；迁移 055）。
//
// 判据：
//  · 事件按类型落库，source 区分 agent/http；
//  · funnelStats 的 N2 代理 =「首次发布前没有改过规格」的报表数；
//  · 窗口外的事件不进分母。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { applyMigrations } from '../test-util'
import { upsertReport } from './report-store'
import { parseReportSpec, type ReportSpec } from './report-spec'
import { funnelStats, recordReportEvent } from './report-events'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-report-events'
const SPEC: ReportSpec = (() => {
  const parsed = parseReportSpec({ panels: [{ chart: 'text', content: 'x', span: 24 }] })
  if (!parsed.ok) throw new Error(parsed.code)
  return parsed.spec
})()

describePg('report events（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const makeReport = (title: string): Promise<string> => upsertReport(pool, ORG, {
    title, metabaseId: 0, embedParams: {}, requiredScope: null, renderer: 'platform', spec: SPEC,
  })

  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.reports where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ 事件落库 + source 区分 + 漏斗计数', async () => {
    // A：agent 建 → 改过规格 → 发布（N2 代理不计入）
    const a = await makeReport('A 智能报表')
    await recordReportEvent(pool, { org: ORG, reportId: a, actor: 'u1', event: 'created', source: 'agent' })
    await recordReportEvent(pool, { org: ORG, reportId: a, actor: 'u1', event: 'spec_edited', source: 'agent' })
    await recordReportEvent(pool, { org: ORG, reportId: a, actor: 'u1', event: 'published', source: 'http' })
    await recordReportEvent(pool, { org: ORG, reportId: a, actor: 'u2', event: 'viewed' })
    await recordReportEvent(pool, { org: ORG, reportId: a, actor: 'u2', event: 'exported', meta: { kind: 'receipt', format: 'xlsx' } })

    // B：http 建 → 直接发布（N2 代理计入）
    const b = await makeReport('B 手工报表')
    await recordReportEvent(pool, { org: ORG, reportId: b, actor: 'u3', event: 'created', source: 'http' })
    await recordReportEvent(pool, { org: ORG, reportId: b, actor: 'u3', event: 'published' })

    const s = await funnelStats(pool, ORG, 30)
    expect(s.created).toBe(2)
    expect(s.published).toBe(2)
    expect(s.viewedReports).toBe(1)
    expect(s.exports).toBe(1)
    expect(s.specEdits).toBe(1)
    expect(s.createdBySource).toEqual({ agent: 1, http: 1 })
    expect(s.publishedWithoutEdit).toBe(1) // 只有 B
  })

  it('窗口外事件不进分母', async () => {
    const c = await makeReport('C 旧报表')
    await recordReportEvent(pool, { org: ORG, reportId: c, event: 'created', source: 'http' })
    await pool.query(
      `update data.report_events set created_at = now() - interval '40 days'
        where org = $1 and report_id = $2`,
      [ORG, c],
    )
    const s = await funnelStats(pool, ORG, 30)
    expect(s.created).toBe(2) // A/B 仍在窗口内，C 不计
  })

  it('事件写入失败不抛给调用方（best-effort）', async () => {
    const bad = { query: async () => { throw new Error('boom') } } as unknown as Pool
    await expect(recordReportEvent(bad, { org: ORG, reportId: 'nope', event: 'viewed' })).resolves.toBeUndefined()
  })
})
