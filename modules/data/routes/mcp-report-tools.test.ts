// mcp-report-tools.test.ts — 报表工具面：能提、不能发（spec 2026-10-07 §3.3 的三条结构落点）
//
// 三条**承重断言**（设计稿 §6 #2/#3/#3′）+ 变异确认（#6，在计划 Task 3 Step 3 手工做）：
//   ① propose_report 建出来的行页门必然非空（agent 造不出「已发布」）；
//   ② revise_report_spec 碰已发布行 ⇒ 拒且行未变；
//   ③ 撞名 propose ⇒ 拒 TITLE_TAKEN 且既有行一字未动（「重登记重置页门」漏洞的正面落点）。
// metricId 现在要过**写入侧校验**（存在性 / 源接入 / 可加性，与 HTTP 面同一份判定：
// domain/report-scope）⇒ beforeAll 种两条测试 L1：可加的 net_sales（line 合法）与
// 不可加的 ratio（line/bar 应被拒）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import type { Hono } from 'hono'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertL1Metric } from '../domain/metric-store'
import { getReport, updateSpec, upsertReport } from '../domain/report-store'
import { getVersion, publishVersion } from '../domain/report-version'
import type { ReportSpec } from '../domain/report-spec'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与其它测试文件互不相同，避免互相擦数据。 */
const ORG = 'org-mcp-report'
/** 测试口径 id 自成一族：L1 桶（org='platform'）是**全局**的，别撞别的测试文件的夹具。 */
const NET_ID = 'mrpt_net_sales'
const RATIO_ID = 'mrpt_ratio'
/** 合法面板的**归一后**形状（parseReportSpec 会把 span/timeScoped 补默认值）。 */
const LEGAL_SPEC: ReportSpec = { panels: [
  { chart: 'line', title: '趋势', metricId: NET_ID, dims: ['bizday'], args: {}, span: 12, timeScoped: true },
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
  /** 一次工具调用 + 工具级载荷（省掉每个用例重复的 JSON-RPC 信封）。 */
  async function call(name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return toolText(await (await rpc(app(), {
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
    })).json())
  }

  /** 种一条平台 L1：写入侧校验（存在性 / 源接入 / 可加性）的输入。 */
  async function seedMetric(id: string, totalable: boolean): Promise<void> {
    await upsertL1Metric(pool, {
      id, title: id, description: '',
      requiredScope: null, subjectColumn: 'org',
      // selectSql 的形状只被取数链读；报表写面只读 requiredScope/totalable/sourceSystem
      selectSql: 'select sum(mart_sales_daily.revenue) as value, bizday from mart_sales_daily',
      groupBy: 'bizday',
      params: { bizday: { column: 'bizday', type: 'date_range' } },
      sourceSystem: null, slaDays: 1, freshnessRelations: [], masks: null, totalable,
    })
  }

  beforeAll(async () => {
    await applyMigrations(pool)
    await seedMetric(NET_ID, true)
    await seedMetric(RATIO_ID, false)
    await pool.query('delete from data.reports where org = $1', [ORG])
  })
  afterAll(async () => {
    await pool.query('delete from data.reports where org = $1', [ORG]).catch(() => {})
    // 只清本文件种的两条（L1 桶是全局的，别误删别人的夹具）
    await pool.query('delete from data.metrics where org = $1 and id = any($2)',
      ['platform', [NET_ID, RATIO_ID]]).catch(() => {})
    await pool.end()
  })

  it('tools/list：名字集合含报表四工具；**不含**任何发布/回收工具', async () => {
    const names = (await (await rpc(app(), { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json())
      .result.tools.map((t: { name: string }) => t.name)
    expect(names).toEqual(expect.arrayContaining(
      ['list_reports', 'propose_report', 'revise_report_spec', 'get_report_spec']))
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
    // 先造一张**已发布**的：走 store + publishVersion（人路径的等价物）。
    // 「已发布」= 发布指针非空（定义版本上线后的口径），不是页门是否为 null。
    const publishedId = await upsertReport(pool, ORG, {
      title: '已发布的报表', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: { panels: [] },
    })
    const draftV = (await getReport(pool, ORG, publishedId))!.version
    expect(await publishVersion(pool, ORG, publishedId, draftV, 'u-test', '', new Set()))
      .toMatchObject({ ok: true, publishedVersion: 1 })
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
    // 经发布通路造出真「已发布」：LEGAL_SPEC 的页门快照是 null（指标无 scope），发布后
    // reports.required_scope 也是 null——旧的「页门清空」判据在这里看不出与未发布的差别，
    // 承重断言要落在发布指针上。
    const id = await upsertReport(pool, ORG, {
      title: '已发布待改', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: LEGAL_SPEC,
    })
    const v = (await getReport(pool, ORG, id))!.version
    expect(await publishVersion(pool, ORG, id, v, 'u-test', '', new Set()))
      .toMatchObject({ ok: true, publishedVersion: 1 })
    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'revise_report_spec', arguments: { id, spec: LEGAL_SPEC, expectedVersion: v } } })).json())
    expect(out.error).toBe('PUBLISHED_REPORT')
    expect((await getReport(pool, ORG, id))!.version).toBe(v)
  })

  it('页门为 null 但**没有发布指针**的草稿仍可改（判据是发布指针，不是页门）', async () => {
    // 定义版本上线后，「页门 null」不再等同「已发布」——发布要看 `published_version_id`。
    // 这条是上述分支改动的判别用例：若把判据改回 `requiredScope === null` 会误拒这里。
    const id = await upsertReport(pool, ORG, {
      title: '页门空的草稿', metabaseId: 0, embedParams: {}, requiredScope: null,
      renderer: 'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    expect((await getReport(pool, ORG, id))!.publishedVersionId).toBeNull()
    const out = await call('revise_report_spec', { id, spec: LEGAL_SPEC, expectedVersion: v })
    expect(out).toMatchObject({ status: 'ok', version: v + 1 })
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

  it('list_reports 带 publishedVersion / hasUnpublishedChanges（未发布 ⇒ null/false；发布后草稿改动 ⇒ true）', async () => {
    const id = await upsertReport(pool, ORG, {
      title: '列表版本报表', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    expect(await publishVersion(pool, ORG, id, v, 'u-test', '', new Set()))
      .toMatchObject({ ok: true, publishedVersion: 1 })

    const rows = async (): Promise<Record<string, unknown>[]> =>
      (await call('list_reports')).reports as Record<string, unknown>[]

    // 刚发布、草稿没再动 ⇒ 已发布 v1 且无未发布改动
    expect((await rows()).find((r) => r.id === id))
      .toMatchObject({ publishedVersion: 1, hasUnpublishedChanges: false })

    // 草稿再登记一次（人路径 updateSpec，版本 +1）⇒ 线上仍是 v1，但草稿领先
    expect(await updateSpec(pool, ORG, id, { panels: [] }, v)).not.toBeNull()
    expect((await rows()).find((r) => r.id === id))
      .toMatchObject({ publishedVersion: 1, hasUnpublishedChanges: true })

    // 从未发布的行：publishedVersion null，且不算「有未发布改动」
    expect((await rows()).find((r) => r.title === '承重①报表'))
      .toMatchObject({ publishedVersion: null, hasUnpublishedChanges: false })
  })

  it('规格白名单：白名单外图型 ⇒ 拒（沿用既有码，不是 500）', async () => {
    const out = toolText(await (await rpc(app(), { jsonrpc: '2.0', id: 8, method: 'tools/call',
      params: { name: 'propose_report', arguments: {
        title: '非法图型', spec: { panels: [{ chart: 'pie', title: 'x', metricId: 'm', dims: [], args: {} }] } } } })).json())
    expect(out.error).toBe('UNKNOWN_CHART_TYPE')
  })

  // ── get_report_spec（改报前先读，别凭记忆重写整份 spec）──────────────────────────
  it('get_report_spec 回草稿规格 + 版本（与 propose 建出来的行同源）', async () => {
    const created = await call('propose_report', { title: '读规格报表', spec: LEGAL_SPEC })
    expect(created.status).toBe('ok')
    const out = await call('get_report_spec', { id: created.id })
    expect(out).toMatchObject({
      status: 'ok', id: created.id, title: '读规格报表', renderer: 'platform',
      // 建出来的恒是「未发布」：页门挂在管理档（结构落点①不变）
      requiredScope: 'data:manage', version: created.version, spec: LEGAL_SPEC,
      // 未发布 ⇒ 没有发布版本，也没有发布时间
      publishedVersion: null, publishedAt: null,
    })
  })

  it('get_report_spec 已发布 ⇒ 带 publishedVersion 与 publishedAt（取自版本快照）', async () => {
    const created = await call('propose_report', { title: '已发布读规格', spec: LEGAL_SPEC })
    expect(created.status).toBe('ok')
    const id = created.id as string
    expect(await publishVersion(pool, ORG, id, created.version as number, 'u-test', '', new Set()))
      .toMatchObject({ ok: true, publishedVersion: 1 })
    const snapshot = await getVersion(pool, ORG, id, 1)
    const out = await call('get_report_spec', { id })
    // 草稿仍是可改的 spec；发布信息来自指针指向的那一版（不是草稿）
    expect(out).toMatchObject({
      status: 'ok', id, version: created.version, spec: LEGAL_SPEC,
      publishedVersion: 1, publishedAt: snapshot!.publishedAt,
    })
  })

  it('get_report_spec 不存在的 id ⇒ NOT_FOUND（不是 500）', async () => {
    expect(await call('get_report_spec', { id: 'mrpt_no_such_report' }))
      .toMatchObject({ status: 'refused', error: 'NOT_FOUND' })
  })

  // ── list_metrics 的参数面 / 可加标记（agent 据此才知道能填什么、能不能画线）────────
  it('list_metrics 回 params（name/type/required）与 totalable', async () => {
    const out = await call('list_metrics')
    expect(out.status).toBe('ok')
    const bases = out.bases as { id: string; params: unknown[]; totalable: boolean }[]
    expect(bases.find((b) => b.id === NET_ID)!.params)
      .toEqual(expect.arrayContaining([{ name: 'bizday', type: 'date_range', required: false }]))
    expect(bases.find((b) => b.id === NET_ID)!.totalable).toBe(true)
    expect(bases.find((b) => b.id === RATIO_ID)!.totalable).toBe(false)
  })

  // ── 提报/改报的写入侧校验（与 HTTP 面同一份 domain/report-scope）────────────────
  it('propose 不可加指标画 line ⇒ CHART_REQUIRES_ADDITIVE（点名 metricId，不是写进库再炸）', async () => {
    const out = await call('propose_report', { title: '不可加折线', spec: { panels: [
      { chart: 'line', title: 't', metricId: RATIO_ID, dims: [], args: {}, span: 24 }] } })
    expect(out).toMatchObject({ status: 'refused', error: 'CHART_REQUIRES_ADDITIVE', metricId: RATIO_ID })
  })

  it('propose 词表里没有的指标 ⇒ UNKNOWN_PANEL_METRIC，且不落行', async () => {
    const out = await call('propose_report', { title: '未知指标', spec: { panels: [
      { chart: 'table', title: 't', metricId: 'mrpt_ghost', dims: [], args: {}, span: 24 }] } })
    expect(out).toMatchObject({ status: 'refused', error: 'UNKNOWN_PANEL_METRIC', metricId: 'mrpt_ghost' })
    const rows = await pool.query('select 1 from data.reports where org = $1 and title = $2', [ORG, '未知指标'])
    expect(rows.rowCount).toBe(0)
  })

  it('revise 与 propose 同一道闸：不可加指标画 bar ⇒ CHART_REQUIRES_ADDITIVE，行未变', async () => {
    const id = await upsertReport(pool, ORG, {
      title: '待改不可加', metabaseId: 0, embedParams: {}, requiredScope: 'data:manage',
      renderer: 'platform', spec: { panels: [] },
    })
    const v = (await getReport(pool, ORG, id))!.version
    const out = await call('revise_report_spec', { id, expectedVersion: v, spec: { panels: [
      { chart: 'bar', title: 't', metricId: RATIO_ID, dims: [], args: {}, span: 24 }] } })
    expect(out).toMatchObject({ status: 'refused', error: 'CHART_REQUIRES_ADDITIVE', metricId: RATIO_ID })
    expect((await getReport(pool, ORG, id))!.version).toBe(v)
  })
})
