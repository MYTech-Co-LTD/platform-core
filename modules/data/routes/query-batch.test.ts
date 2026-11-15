// query-batch.test.ts — POST /query/batch 的路由层测试（R4）。
//
// 判据：① 参数面（上限 12 / 空数组 / 坏 JSON）② 逐条走同一 runQuery 授权链（未声明 ⇒
// 逐条 denied，不拖垮整批）③ id 原样回带 ④ 每条审计照写 ⑤ 200 恒定（部分失败不炸整批）。
// 形状与 query.test.ts 同源（L1 夹具 + buildTestApp + 假执行器）。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertL1Metric } from '../domain/metric-store'
import type { L1MetricDef } from '../domain/metric-store'
import type { SqlExecutor } from '../domain/query-service'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-t6-batch'
const L1_PREFIX = 't6b:'

const PANEL: L1MetricDef = {
  id: `${L1_PREFIX}panel_a`, title: '面板 A', description: '',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'select org, day, sum(t6b_fct.panel_a) as value from t6b_fct',
  groupBy: 'org, day', params: {},
  sourceSystem: 'lemeng', slaDays: 1, freshnessRelations: [], masks: null,
}

describePg('POST /query/batch（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  const calls: string[] = []

  const execute: SqlExecutor = async (sql) => {
    calls.push(sql)
    return { columns: ['org', 'day', 'value'], rows: [[ORG, '2026-11-14', 7]] }
  }

  // execute 用**变量**携带（query.test.ts 同款）：绕开 ModuleContext 字面量的多余属性检查。
  const ctx = { pool, execute }
  const app = () => buildTestApp(
    mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG }, ['lemeng'],
  )

  const post = (body: unknown) => app().request('/query/batch', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })

  beforeAll(async () => {
    await applyMigrations(pool)
    await upsertL1Metric(pool, PANEL)
    await pool.query('delete from data.query_audit where org = $1', [ORG])
  })

  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1 and id like $2', ['platform', `${L1_PREFIX}%`])
      .catch(() => {})
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.end().catch(() => {})
  })

  it('★ 两条面板一次请求：id 回带、逐条 ok、各自落审计', async () => {
    calls.length = 0
    const before = await pool.query('select count(*)::int as n from data.query_audit where org = $1', [ORG])
    const res = await post({ queries: [
      { id: 'p0', metricId: PANEL.id, args: {} },
      { id: 'p1', metricId: PANEL.id, args: {} },
    ] })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: Array<{ id: string; status: string; columns?: string[] }> }
    expect(body.results.map((r) => r.id)).toEqual(['p0', 'p1'])
    expect(body.results.every((r) => r.status === 'ok')).toBe(true)
    // 逐条审计（不因批量而合并）：前后差 = 2
    const after = await pool.query('select count(*)::int as n from data.query_audit where org = $1', [ORG])
    expect(after.rows[0].n - before.rows[0].n).toBe(2)
  })

  it('★ 一条未声明指标 ⇒ 该条 denied，其余照常（200，不炸整批）', async () => {
    const res = await post({ queries: [
      { id: 'a', metricId: PANEL.id, args: {} },
      { id: 'b', metricId: 't6b:nope', args: {} },
    ] })
    expect(res.status).toBe(200)
    const body = await res.json() as { results: Array<{ id: string; status: string; reason?: string }> }
    expect(body.results.find((r) => r.id === 'a')?.status).toBe('ok')
    const denied = body.results.find((r) => r.id === 'b')
    expect(denied?.status).toBe('denied')
    expect(denied?.reason).toBe('metric_not_declared')
  })

  it('参数面：空数组 / 超过 12 条 / 坏 JSON ⇒ 400（在触达任何查询之前）', async () => {
    calls.length = 0
    expect((await post({ queries: [] })).status).toBe(400)
    expect((await post({ queries: Array.from({ length: 13 }, (_, i) => ({ id: String(i), metricId: PANEL.id })) })).status).toBe(400)
    expect((await app().request('/query/batch', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    })).status).toBe(400)
    expect(calls.length).toBe(0)   // 参数面被拒 ⇒ 从未触达仓库
  })

  it('id 缺失 ⇒ 400 INVALID_BODY（id 是客户端对位键，必须给）', async () => {
    const res = await post({ queries: [{ metricId: PANEL.id }] })
    expect(res.status).toBe(400)
  })
})
