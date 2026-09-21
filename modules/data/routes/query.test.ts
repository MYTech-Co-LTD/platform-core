// query.test.ts — POST /query 的路由层测试。
// 模块壳（buildTestApp）不挂宿主门卫与三通道中间件——那部分归 T10 的端到端；
// 这里验：参数面拒、requesterOf 身份归一（含 M3 守卫）、状态码映射、execute 注入透传。
import { afterAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import { createPatKey } from '../domain/key-store'
import type { SqlExecutor } from '../domain/query-service'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
/** 隔离键（text，值 = 该租户的 Casdoor org）——与 metrics.test.ts 互不相同，避免互相擦数据。 */
const ORG = 'org-t6-query'

// 词表形状照 domain/authz.ts 的 MetricDef（主体列 org，与 ORG 同值 ⇒ 主体钉死可断言）
const SALES_DAILY = {
  id: 'sales_daily', title: '销售日明细', description: '',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, day, revenue FROM marts.mart_sales_daily',
  groupBy: '', params: {},
}

// ⚠️ 必须**先**建 app 再断言：`buildTestApp` 里的 `createRouter` 就是被测的模块装配，
// 建 app 这一步本身会跑装载期双向核对（声明集合 ≡ 注册集合）。
describe('POST /query 的参数面（不需要数据库）', () => {
  it('body 不是合法 JSON → 400 INVALID_BODY（在碰 DB 之前就拒）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/query', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('INVALID_BODY')
  })
})

describePg('POST /query（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })

  afterAll(async () => {
    expect(pool.ended, '池在本 afterAll 之前已被 end').toBe(false)
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.query_keys where org = $1', [ORG]).catch(() => {})
    await pool.end().catch(() => {})
  })

  it('createPorts.resolvePatKey：命中原样转交 + fire-and-forget 触碰 last_used_at（#142 唯一写入点）', async () => {
    await applyMigrations(pool)
    const { id, token } = await createPatKey(pool, ORG, 'alice', 't6-port-probe')
    // 端口存在性本身就是断言：不声明 createPorts ⇒ 宿主取到 undefined ⇒ 通道 B 全线 503
    const ports = mod.createPorts?.({ pool })
    expect(ports, '模块未声明 createPorts（通道 B fail-closed 空窗未闭合）').toBeDefined()
    expect(ports!.resolvePatKey).toBeTypeOf('function')

    const resolved = await ports!.resolvePatKey!(token)
    // 原样转交：形状 = SDK ResolvedPatKey（keyId/org/casdoorUser），一个字段不多不少
    expect(resolved).toEqual({ keyId: id, org: ORG, casdoorUser: 'alice' })
    // 未命中 ⇒ null（fail-closed）
    expect(await ports!.resolvePatKey!('dkq_nope')).toBeNull()

    // fire-and-forget 不阻断返回，但必须落库：短暂轮询等触碰出现（上限 2s）
    const deadline = Date.now() + 2000
    let touched = false
    while (Date.now() < deadline) {
      const r = await pool.query(
        'select last_used_at from data.query_keys where org = $1 and id = $2', [ORG, id],
      )
      if (r.rows[0].last_used_at !== null) { touched = true; break }
      await new Promise((ok) => setTimeout(ok, 25))
    }
    expect(touched, 'last_used_at 没被端口触碰（#142：端口化后宿主不再写，这里是唯一写入点）').toBe(true)
  })

  it('未声明的指标 → 403 + 可解释 reason（不是 500）', async () => {
    // 这条**需要真库**：`runQuery` 是先 loadCatalog 再判声明，没有 pool 会先炸在加载词表上
    // （错误信号会变成「500 而不是 403」，看着像授权坏了）。种一条真指标，再问一个没声明的。
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool }, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'nope', args: {} }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('metric_not_declared')
  })

  it('身份 orgId 为空串 → 403 unauthenticated（M3 守卫在 requesterOf 收口，空 org 不流进 SQL）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    const app = buildTestApp(mod, makeIdentity({ orgId: '' }), { pool }, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'sales_daily', args: {} }),
    })
    expect(res.status).toBe(403)
    expect((await res.json()).reason).toBe('unauthenticated')
    // 入口拒也留痕（匿名口径）：审计是失败也要留痕的地方
    const a = await pool.query(
      'select verdict, reason, user_id from data.query_audit where org = $1 order by id desc limit 1',
      [ORG],
    )
    expect(a.rows[0]).toMatchObject({ verdict: 'denied', reason: 'unauthenticated', user_id: '(anonymous)' })
  })

  it('已声明且授权 → 200；execute 注入经 RouteCtx 透传到 runQuery（不碰真仓库）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    const calls: string[] = []
    const execute: SqlExecutor = async (sql) => {
      calls.push(sql)
      return { columns: ['org', 'day'], rows: [[ORG, '2026-08-15']] }
    }
    // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool）
    const ctx = { pool, execute }
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'sales_daily', args: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.subject).toBe(ORG)
    expect(calls.length).toBe(1)
    // 主体钉死：SQL 里的主体值来自身份解析，客户端参数指定不了
    expect(calls[0]).toContain(`WHERE org = '${ORG}'`)
  })

  it('仓库执行出错 → 502 error/warehouse_error（上游仓库不可用不是本服务的 500）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, SALES_DAILY)
    const execute: SqlExecutor = async () => {
      throw new Error('boom')
    }
    const ctx = { pool, execute }
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await app.request('/query', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ metricId: 'sales_daily', args: {} }),
    })
    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.status).toBe('error')
    expect(body.reason).toBe('warehouse_error')
  })
})
