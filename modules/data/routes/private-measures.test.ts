// private-measures.test.ts — W2 Task 3：私有测度的 HTTP 写面（POST /metrics/private）与归档读面。
//
// 模块壳不挂宿主门卫（scope 拒绝归 T10 端到端），本文件钉的是：
//   · 新建写生效列 + basis=column_agg + certified=draft，且同租户另一用户立即可查；
//   · 三闸失败映射（输入类 400 / 环境类 500）；
//   · L1 id 保留 409、同档在用 409、跨档 409；
//   · 归档行默认从词表消失，但管理读面可见；租户隔离。
//
// ⚠️ 数据面用本文件的 `pm_route` schema 替身（同一 DATABASE_URL）；生产是两张库，
//    路由的 warehouse 测试缝（RouteCtx.warehouse）就是为此存在的。
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { L1_ORG, upsertL1Metric } from '../domain/metric-store'
import type { L1MetricDef } from '../domain/metric-store'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-w2-private-api'
const OTHER_ORG = 'org-w2-private-api-other'
const L1_PREFIX = 'w2route:'
const SCHEMA = 'pm_route'

let pool: Pool

function l1Def(over: Partial<L1MetricDef>): L1MetricDef {
  return {
    id: `${L1_PREFIX}net_sales`,
    title: '私有测度白名单基底',
    description: '',
    requiredScope: null,
    subjectColumn: 'org',
    selectSql: `select sum(${SCHEMA}.fct_sales.amount) as value, day from ${SCHEMA}.fct_sales`,
    groupBy: 'day',
    params: {},
    sourceSystem: 'lemeng',
    slaDays: 1,
    freshnessRelations: [],
    masks: null,
    ...over,
  }
}

const L1_OK = l1Def({})
/** 关系在白名单里，但数据面看不到任何列 ⇒ COLUMNS_UNAVAILABLE（500，不是用户输入错）。 */
const L1_MISSING = l1Def({
  id: `${L1_PREFIX}missing`,
  selectSql: `select sum(${SCHEMA}.no_such_table.x) as value from ${SCHEMA}.no_such_table`,
})

function app(org = ORG, scopes: string[] = ['data:query'], userId = 'u-private') {
  // warehouse 用变量携带：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool；
  // 与 branches.test.ts / chat.test.ts 携带 execute 测试缝同款）。
  const ctx = { pool, warehouse: pool }
  return buildTestApp(
    mod,
    makeIdentity({ orgId: org, scopes, userId }),
    ctx,
    { id: 1, casdoor_org: org },
    [],
  )
}

async function post(body: unknown, org = ORG, scopes: string[] = ['data:query'], userId = 'u-private') {
  return app(org, scopes, userId).request('/metrics/private', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

const body = (over: Record<string, unknown> = {}) => ({
  id: 'pm_route_sales',
  title: '按日销售额',
  description: '私有口径',
  agg: 'sum',
  column: 'amount',
  dims: ['day'],
  relation: `${SCHEMA}.fct_sales`,
  ...over,
})

describePg('私有测度 HTTP 面（需要 DATABASE_URL）', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl })
    await applyMigrations(pool)
    await pool.query(`drop schema if exists ${SCHEMA} cascade`)
    await pool.query(`create schema ${SCHEMA}`)
    await pool.query(`create table ${SCHEMA}.fct_sales (
      org text not null, day date, amount numeric(12,2), branch text)`)
    await upsertL1Metric(pool, L1_OK)
    await upsertL1Metric(pool, L1_MISSING)
  })

  beforeEach(async () => {
    await pool.query('delete from data.metric_audit where org = any($1)', [[ORG, OTHER_ORG]])
    await pool.query('delete from data.metrics where org = any($1)', [[ORG, OTHER_ORG]])
  })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.metric_audit where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metrics where org = any($1)', [[ORG, OTHER_ORG]]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1 and id like $2', [L1_ORG, `${L1_PREFIX}%`]).catch(() => {})
    await pool.query(`drop schema if exists ${SCHEMA} cascade`).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('★ POST /metrics/private：201 + 生效列/basis/draft；同租户另一用户 GET /metrics 立即可查', async () => {
    const res = await post(body())
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true })

    const row = (await pool.query(
      `select source, basis, certified, created_by, select_sql, group_by, draft_spec
         from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rows[0]
    expect(row).toMatchObject({
      source: 'l2', basis: 'column_agg', certified: 'draft', created_by: 'u-private',
      select_sql: `select sum(amount) as value, day from ${SCHEMA}.fct_sales`,
      group_by: 'day', draft_spec: null,
    })

    // 同租户、另一个 data:query 用户（租户共享，不是创建者私有）
    const other = await app(ORG, ['data:query'], 'u-someone-else').request('/metrics')
    const ids = (await other.json()).metrics.map((m: { id: string }) => m.id)
    expect(ids).toContain('pm_route_sales')
    // 别家 org 看不见
    const foreign = await app(OTHER_ORG, ['data:query'], 'u-other').request('/metrics')
    expect((await foreign.json()).metrics.map((m: { id: string }) => m.id)).not.toContain('pm_route_sales')
  })

  it('三闸失败映射：白名单外 400 RELATION_NOT_ALLOWED；数据面看不到列 500 COLUMNS_UNAVAILABLE', async () => {
    const notAllowed = await post(body({ id: 'pm_bad', relation: 'not_a_mart' }))
    expect(notAllowed.status).toBe(400)
    expect(await notAllowed.json()).toEqual({ error: 'RELATION_NOT_ALLOWED', detail: expect.stringContaining('not_a_mart') })

    const unavailable = await post(body({
      id: 'pm_missing', relation: `${SCHEMA}.no_such_table`, column: 'x', dims: [],
    }))
    expect(unavailable.status).toBe(500)
    expect(await unavailable.json()).toMatchObject({ error: 'COLUMNS_UNAVAILABLE' })
  })

  it('L1 的 id 被保留 ⇒ 409 ID_RESERVED_BY_L1；同档在用重复建 ⇒ 409 METRIC_EXISTS', async () => {
    const reserved = await post(body({ id: L1_OK.id }))
    expect(reserved.status).toBe(409)
    expect(await reserved.json()).toEqual({ error: 'ID_RESERVED_BY_L1' })

    expect((await post(body())).status).toBe(201)
    const again = await post(body({ title: '改个名' }))
    expect(again.status).toBe(409)
    expect(await again.json()).toEqual({ error: 'METRIC_EXISTS' })
  })

  it('非法 body ⇒ 400 INVALID_BODY（strict：selectSql 等实现细节不得混进声明）', async () => {
    for (const bad of [
      body({ id: '' }),
      body({ title: undefined }),
      body({ agg: 'median' }),
      body({ dims: 'day' }),
      body({ selectSql: 'select 1 as value' }),
    ]) {
      const res = await post(bad)
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'INVALID_BODY' })
    }
  })

  it('无身份 ⇒ 403 UNAUTHENTICATED（不写无主行）', async () => {
    const anonCtx = { pool, warehouse: pool }
    const anon = await buildTestApp(
      mod, makeIdentity({ orgId: '', scopes: ['data:query'] }), anonCtx,
      { id: 1, casdoor_org: ORG }, [],
    ).request('/metrics/private', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body()),
    })
    expect(anon.status).toBe(403)
    expect(await anon.json()).toEqual({ error: 'UNAUTHENTICATED' })
    expect((await pool.query(`select 1 from data.metrics where org = $1 and id = 'pm_route_sales'`, [ORG])).rowCount).toBe(0)
  })

  it('★ 归档读面：归档后从 GET /metrics 消失，但 GET /metrics/private/archived 可见（租户隔离）', async () => {
    expect((await post(body())).status).toBe(201)
    expect((await post(body({ id: 'pm_route_active' }))).status).toBe(201)
    await pool.query(
      `update data.metrics set archived_at = now() where org = $1 and id = 'pm_route_sales'`, [ORG])
    // 别家 org 也有一条归档行——不得串进来
    await pool.query(
      `insert into data.metrics
         (org, id, title, description, required_scope, subject_column, select_sql, group_by,
          params, source, source_system, updated_by, version, totalable, sla_days, freshness_relations,
          created_by, certified, basis, archived_at)
       values ($1, 'pm_foreign_archived', '别家', '', null, 'org',
               'select 1 as value', '', '{}'::jsonb, 'l2', null, 'u-other', 1, false, null, null,
               'u-other', 'draft', 'column_agg', now())`,
      [OTHER_ORG])

    const visible = (await (await app(ORG, ['data:query']).request('/metrics')).json())
      .metrics.map((m: { id: string }) => m.id)
    expect(visible).toContain('pm_route_active')
    expect(visible).not.toContain('pm_route_sales')

    const archivedRes = await app(ORG, ['data:manage']).request('/metrics/private/archived')
    expect(archivedRes.status).toBe(200)
    const archived = (await archivedRes.json()).metrics
    expect(archived.map((m: { id: string }) => m.id)).toEqual(['pm_route_sales'])
    expect(archived[0]).toMatchObject({
      id: 'pm_route_sales', title: '按日销售额', createdBy: 'u-private',
    })
    expect(archived[0].archivedAt).toEqual(expect.any(String))
  })
})
