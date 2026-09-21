// metrics.test.ts — 指标词表路由的测试（词表裁剪 + 管理面 CRUD）。
// 模块壳不挂宿主门卫：缺 data:manage 的拒绝归宿主门卫（T10 端到端验），
// 这里验裁剪语义（「看不见」不是报错）与管理面 happy path。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text）——与 query.test.ts 互不相同，避免互相擦数据。 */
const ORG = 'org-t6-metrics'

function def(over: Partial<MetricDef> = {}): MetricDef {
  return {
    id: 'sales_daily', title: '销售日明细', description: '按日销售',
    requiredScope: null, subjectColumn: 'org',
    selectSql: 'SELECT org, day FROM marts.mart_sales_daily',
    groupBy: '', params: {},
    ...over,
  }
}

// 词表两条：一条人人可见（requiredScope null），一条要 data:finance
const OPEN = def()
const FINANCE = def({
  id: 'finance_margin', title: '毛利', requiredScope: 'data:finance',
  selectSql: 'SELECT org, margin FROM marts.mart_margin',
})

describePg('指标路由（需要 DATABASE_URL：词表读写）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('GET /metrics 只回词表内：data:query 身份看不到 data:finance 指标（看不见，不是报错）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, OPEN)
    await upsertMetric(pool, ORG, FINANCE)
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:query'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const res = await app.request('/metrics')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.metrics.map((m: { id: string }) => m.id)).toEqual(['sales_daily'])
    // 消费面投影：严格三字段——selectSql/subjectColumn 属实现细节，不外泄
    expect(body.metrics[0]).toEqual({ id: 'sales_daily', title: '销售日明细', description: '按日销售' })
  })

  it('GET /metrics/all（data:manage 面）回全量，含 requiredScope / subjectColumn', async () => {
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const res = await app.request('/metrics/all')
    expect(res.status).toBe(200)
    const body = await res.json()
    const ids = body.metrics.map((m: { id: string }) => m.id)
    expect(ids).toContain('sales_daily')
    expect(ids).toContain('finance_margin')
    expect(body.metrics.find((m: { id: string }) => m.id === 'finance_margin')).toMatchObject({
      requiredScope: 'data:finance', subjectColumn: 'org',
    })
  })

  it('POST /metrics（data:manage 身份）建指标 → 201，词表立即可见', async () => {
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage', 'data:query'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const res = await app.request('/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'created_via_api', title: '新建指标', subjectColumn: 'org',
        selectSql: 'SELECT org, 1 AS n FROM marts.x',
      }),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })
    const all = await (await app.request('/metrics/all')).json()
    expect(all.metrics.map((m: { id: string }) => m.id)).toContain('created_via_api')
  })

  it('POST /metrics body 缺必填（无 title/subjectColumn/selectSql）→ 400 INVALID_BODY', async () => {
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const res = await app.request('/metrics', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'broken' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })

  it('PUT /metrics/:id 路径 id 与 body id 不一致 → 400 ID_MISMATCH（改 A 不能写 B）', async () => {
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const res = await app.request('/metrics/sales_daily', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'finance_margin', title: '偷梁换柱', subjectColumn: 'org',
        selectSql: 'SELECT org, 1 FROM marts.x',
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('ID_MISMATCH')
  })

  it('PUT /metrics/:id 同 id → 200 且内容被覆盖（text 主键不是数字解析：sales_daily 合法）', async () => {
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const res = await app.request('/metrics/sales_daily', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'sales_daily', title: '销售日明细（v2）', subjectColumn: 'org',
        selectSql: 'SELECT org, day FROM marts.mart_sales_daily_v2',
      }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    const all = await (await app.request('/metrics/all')).json()
    expect(all.metrics.find((m: { id: string }) => m.id === 'sales_daily')).toMatchObject({
      title: '销售日明细（v2）', selectSql: 'SELECT org, day FROM marts.mart_sales_daily_v2',
    })
  })

  it('DELETE /metrics/:id 命中 → ok；再删 → 404（text id 走 metricIdOf，不是数字解析）', async () => {
    const app = buildTestApp(
      mod, makeIdentity({ orgId: ORG, scopes: ['data:manage'] }), { pool }, { id: 1, casdoor_org: ORG },
    )
    const first = await app.request('/metrics/finance_margin', { method: 'DELETE' })
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true })
    const second = await app.request('/metrics/finance_margin', { method: 'DELETE' })
    expect(second.status).toBe(404)
    expect((await second.json()).error).toBe('NOT_FOUND')
  })
})
