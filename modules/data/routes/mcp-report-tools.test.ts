// mcp-report-tools.test.ts — 报表工具面：能提、不能发（spec 2026-10-07 §3.3 的三条结构落点）
//
// 三条**承重断言**（设计稿 §6 #2/#3/#3′）+ 变异确认（#6，在计划 Task 3 Step 3 手工做）：
//   ① propose_report 建出来的行页门必然非空（agent 造不出「已发布」）；
//   ② revise_report_spec 碰已发布行 ⇒ 拒且行未变；
//   ③ 撞名 propose ⇒ 拒 TITLE_TAKEN 且既有行一字未动（「重登记重置页门」漏洞的正面落点）。
// metricId 用臆造值是刻意的：本面只判**形状**（白名单），metricId 的存在性由查询链判
//（与 HTTP 面同判据）——这里不重复那道闸。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { getReport, upsertReport } from '../domain/report-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-mcp-report'
const LEGAL_SPEC = { panels: [
  { chart: 'line', title: '趋势', metricId: 'lemeng:retail:net_sales', dims: ['bizday'], args: {} },
] }

async function rpc(app: Hono, payload: unknown): Promise<Response> {
  return await app.request('/mcp-manage', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  })
}
function toolText(body: { result: { content: { text: string }[] } }): Record<string, unknown> {
  return JSON.parse(body.result.content[0].text) as Record<string, unknown>
}

describePg('报表工具面（能提、不能发）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const app = () => buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool }, { id: 1, casdoor_org: ORG })
  beforeAll(async () => {
    await applyMigrations(pool)
    await pool.query('delete from data.reports where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    await pool.end()
  })

  it('tools/list：名字集合含报表三工具；**不含**任何发布/回收工具', async () => {
    const names = (await (await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json())
      .result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(['list_reports', 'propose_report', 'revise_report_spec']))
    // 结构约束③的机检落点：**报表**的发布/回收类工具不存在。正则必须带 report——
    // 合成端点还有口径片的 delete_custom_metric（那是口径工具，不是报表回收，别误伤）。
    expect(names.filter((n: string) => n.includes('report') && /publish|delete|recycle/i.test(n))).toEqual([])
  })

  it('★ 承重断言①：propose_report 建出来的报表**页门必然非空**（= 未发布）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'propose_report', arguments: { title: '承重①报表', spec: LEGAL_SPEC } } })).json())
    expect(out.status).toBe('ok')
    const row = await getReport(pool, ORG, out.id as string)
    expect(row!.renderer).toBe('platform')
    expect(row!.requiredScope).not.toBeNull()          // ★ 核心：agent 造不出「已发布」
  })

  it('★ 承重断言③：撞名（尤其已发布那张）⇒ 拒 TITLE_TAKEN，且既有行规格与页门一字未动', async () => {
    // 先造一张**已发布**的（页门 null）：走 store 直落（人路径的等价物）
    const publishedId = await upsertReport(pool, ORG, {
      title: '已发布的报表', metabaseId: 0, embedParams: {}, requiredScope: null,
      renderer: 'platform', spec: { panels: [] },
    })
    const before = await getReport(pool, ORG, publishedId)

    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'propose_report', arguments: { title: '已发布的报表', spec: LEGAL_SPEC } } })).json())
    expect(out.status).toBe('refused')
    expect(out.error).toBe('TITLE_TAKEN')

    const after = await getReport(pool, ORG, publishedId)
    expect(after!.requiredScope).toBeNull()                    // ★ 没被撤下
    expect(JSON.stringify(after!.spec)).toBe(JSON.stringify(before!.spec))   // ★ 规格没被换
    expect(after!.version).toBe(before!.version)
  })

  it('★ 承重断言②：改**已发布**报表的规格 ⇒ 拒 PUBLISHED_REPORT，且行未变', async () => {
    const id = await upsertReport(pool, ORG, {
      title: '已发布待改', metabaseId: 0, embedParams: {}, requiredScope: null,
      renderer: 'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(out.error).toBe('PUBLISHED_REPORT')
    expect((await getReport(pool, ORG, id))!.version).toBe(v)
  })

  it('改**未发布**报表的规格 ⇒ ok 且版本 +1；陈旧 expectedVersion ⇒ STALE_WRITE', async () => {
    const id = await upsertReport(pool, ORG, {
      title: '未发布待改', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    const okOut = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(okOut).toMatchObject({ status: 'ok', version: v + 1 })

    const stale = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(stale.error).toBe('STALE_WRITE')
  })

  it('list_reports 回管理清单（含页门与版本、含未发布行）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 7, method: 'tools/call',
      params: { name: 'list_reports', arguments: {} } })).json())
    expect(out.status).toBe('ok')
    const titles = (out.reports as { title: string }[]).map((r) => r.title)
    expect(titles).toContain('承重①报表')          // 未发布的那张也在（管理面不裁）
    expect((out.reports as Record<string, unknown>[]).every(
      (r) => typeof r.version === 'number' && 'requiredScope' in r)).toBe(true)
  })

  it('规格白名单：白名单外图型 ⇒ 拒（沿用既有码，不是 500）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'propose_report', arguments: {
        title: '非法图型', spec: { panels: [{ chart: 'pie', title: 'x', metricId: 'm', dims: [], args: {} }] } } } })).json())
    expect(out.error).toBe('UNKNOWN_CHART_TYPE')
  })
})
