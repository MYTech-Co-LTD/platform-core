// toolbox.test.ts — POST /toolbox 的契约面（Wave 2 决策 D-C1：registry 的 HTTP 薄封装）。
// 状态码映射照 /query 的 #30 口径：denied/not_found → 403，error → 502，ok → 200——
// 插件 callPlatform 的错误文案映射（401/403/502 三分支）依赖这个形状，改映射先改这里再改插件。
import { afterAll, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { Pool } from 'pg'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import mod from '../index'
import { applyMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'
import type { ModuleVars } from './context'
import { registerToolbox } from './toolbox'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip
const ORG = 'org-w2-toolbox'

const M1: MetricDef = {
  id: 'w2_sales', title: 'W2 销售额', description: '测试用销售指标',
  requiredScope: null, subjectColumn: 'org',
  selectSql: 'SELECT org, day, revenue FROM marts.w2_sales', groupBy: '',
  params: { day: { column: 'day', type: 'date', required: false } },
}

describe('POST /toolbox：入参门（不需要数据库）', () => {
  it('body 非法 → 400 INVALID_BODY（body 解析在取 tenant 之前，无库也能验）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/toolbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"tool":}' })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toBe('INVALID_BODY')
  })
  it('缺 tool 字段 → 400', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool: null as never })
    const res = await app.request('/toolbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    expect(res.status).toBe(400)
  })
})

describePg('POST /toolbox：分发与审计（需要 DATABASE_URL）', () => {
  const pool = new Pool({ connectionString: dbUrl })
  afterAll(async () => {
    await pool.query('delete from data.query_audit where org = $1', [ORG]).catch(() => {})
    await pool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await pool.end()
  })
  const fakeWh = (async () => ({ rows: [] })) as unknown as SqlExecutor
  // execute 用**变量**携带进 ctx：绕开 ModuleContext 字面量的多余属性检查（协议上只有 pool）
  const ctx = { pool, execute: fakeWh }
  const call = (app: Hono, body: Record<string, unknown>) =>
    app.request('/toolbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  it('describe_metric 命中 → 200 + payload 直通；审计 verdict=ok 且 tool 字段在', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, M1, 'fixture')
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await call(app, { tool: 'describe_metric', args: { id: 'w2_sales' } })
    expect(res.status).toBe(200)
    const payload = (await res.json()) as { status: string; id: string; title: string }
    expect(payload.status).toBe('ok')
    expect(payload.id).toBe('w2_sales')
    expect(payload.title).toBe('W2 销售额')
    const audit = await pool.query(
      "select tool, channel, verdict, reason from data.query_audit where tool = 'describe_metric' order by id desc limit 1")
    expect(audit.rows[0]).toMatchObject({ tool: 'describe_metric', channel: 'session', verdict: 'ok' })
  })

  it('未知名 → 403 {status:denied, reason:unknown_tool}（fail-closed 继承 callTool，不暴露存在性）', async () => {
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await call(app, { tool: 'no_such_tool', args: {} })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ status: 'denied', reason: 'unknown_tool' })
  })

  it('sample_dimension_values 维度不在粒度 → 403 reason=bad_param（detail 原样带出，插件文案映射靠它）', async () => {
    await applyMigrations(pool)
    await upsertMetric(pool, ORG, M1, 'fixture')
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), ctx, { id: 1, casdoor_org: ORG })
    const res = await call(app, { tool: 'sample_dimension_values', args: { metricId: 'w2_sales', dimension: 'not_a_dim' } })
    expect(res.status).toBe(403)
    const body = (await res.json()) as { status: string; reason: string; detail: string }
    expect(body.status).toBe('denied')
    expect(body.reason).toBe('bad_param')
    expect(body.detail).toContain('not_a_dim')
  })

  it('get_freshness 全局支 → 200（execute 注入 load_log 行；status=unknown 也是 200——未知≠错误）', async () => {
    const wh = (async () => ({
      rows: [['fct_x', '2026-10-20', new Date('2026-10-21T02:10:00+08:00')]],
    })) as unknown as SqlExecutor
    const app = buildTestApp(mod, makeIdentity({ orgId: ORG }), { pool, execute: wh } as never,)
    const res = await call(app, { tool: 'get_freshness', args: {} })
    expect(res.status).toBe(200)
    // 全局支回包刻意无 status 字段（health.ts 既有形状：只有 unknown 分支带 status）
    expect(await res.json()).toMatchObject({ scope: 'global', dataThrough: '2026-10-20' })
  })

  it('channel=wecom 的请求者 → 审计 channel=wecom（通道 C 单点审计的钉子）', async () => {
    await applyMigrations(pool)
    // 测试壳不挂通道变量 ⇒ 手搭一个设 REQUESTER_CHANNEL 的最小 app（与 wecom-channel-auth.test.ts 同思路）。
    // TENANT_SOURCES 不设 = 宿主未投影 ⇒ adoptedSources 空集（fail-closed）；M1 是 L2 行，不受影响。
    const a = new Hono<ModuleVars>()
    a.use('*', async (c, next) => {
      c.set('identity', makeIdentity({ orgId: ORG, userId: 'wecom-user-1' }))
      c.set('tenant', { id: 1, casdoor_org: ORG })
      c.set(REQUESTER_CHANNEL, 'wecom')
      await next()
    })
    a.route('/', mod.createRouter({ pool }))
    const res = await a.request('/toolbox', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'describe_metric', args: { id: 'w2_sales' } }),
    })
    expect(res.status).toBe(200)
    const audit = await pool.query(
      "select channel, user_id from data.query_audit where tool = 'describe_metric' order by id desc limit 1")
    expect(audit.rows[0]).toMatchObject({ channel: 'wecom', user_id: 'wecom-user-1' })
  })
})
