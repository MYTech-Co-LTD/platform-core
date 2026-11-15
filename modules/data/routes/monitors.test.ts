// monitors.test.ts — 业务监控管理面（W7-V1 Task 7）。
// 模块壳不挂宿主门卫：这里验入参闭集、创建期两道校验、创建者权限、影子期不可在创建时关。
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import mod from '../index'
import { applyMigrations, applyPlatformMigrations, buildTestApp, makeIdentity } from '../test-util'
import { upsertMetric } from '../domain/metric-store'
import type { MetricDef } from '../domain/authz'

const dbUrl = process.env.DATABASE_URL
const describePg = dbUrl ? describe : describe.skip

const ORG = `org-monroute-${Math.random().toString(36).slice(2, 8)}`
const CREATOR = 'alice'
const OTHER = 'bob'

const METRIC: MetricDef = {
  id: 'monroute.metric',
  title: '监控路由夹具',
  description: '',
  requiredScope: null,
  subjectColumn: 'org',
  selectSql: 'select 1 as v from t',
  groupBy: '',
  params: {},
}

function appFor(userId: string, extraScopes: string[] = []) {
  const identity = makeIdentity({ orgId: ORG, userId, scopes: ['data:query', ...extraScopes] })
  return buildTestApp(mod, identity, { pool: appPool } as never, { id: 1, casdoor_org: ORG })
}

let appPool: Pool

describe('monitors 路由 · 入参闭集（不依赖 DB）', () => {
  it('未知字段 ⇒ 400（静默丢弃 = 以为配上了）', async () => {
    appPool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const res = await appFor(CREATOR).request('/monitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x', verdict: 'missing', cadenceSecs: 300, recipients: [{ kind: 'user', ref: 'alice' }], surprise: 1 }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('UNKNOWN_FIELD')
  })

  it('threshold 在 V1 拒绝（400 MONITOR_VERDICT_UNSUPPORTED）', async () => {
    appPool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const res = await appFor(CREATOR).request('/monitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x', targetKind: 'metric', metricId: 'm', verdict: 'threshold',
        cadenceSecs: 300, recipients: [{ kind: 'user', ref: 'alice' }],
      }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('MONITOR_VERDICT_UNSUPPORTED')
  })
})

describePg('monitors 路由（需要 DATABASE_URL）', () => {
  let id = ''

  beforeAll(async () => {
    appPool = new Pool({ connectionString: dbUrl })
    await applyPlatformMigrations(appPool)
    await applyMigrations(appPool)
    await appPool.query('delete from data.monitor_run where org = $1', [ORG])
    await appPool.query('delete from data.monitor where org = $1', [ORG])
    await appPool.query('delete from data.metrics where org = $1', [ORG])
    await appPool.query('delete from data.asset_audit where org = $1', [ORG])
    await appPool.query('delete from platform.org_membership where tenant_id in (select id from platform.tenant where casdoor_org = $1)', [ORG])
    await appPool.query('delete from platform.tenant where casdoor_org = $1', [ORG])
    const t = await appPool.query(
      "insert into platform.tenant (slug, casdoor_org) values ($1, $1) returning id", [ORG])
    await appPool.query(
      `insert into platform.org_membership (tenant_id, user_name, ext_id) values ($1,$2,'1'), ($1,$3,'1')`,
      [t.rows[0].id, CREATOR, OTHER])
    await upsertMetric(appPool, ORG, METRIC, CREATOR)
  })

  afterAll(async () => {
    await appPool.query('delete from data.monitor_run where org = $1', [ORG]).catch(() => {})
    await appPool.query('delete from data.monitor where org = $1', [ORG]).catch(() => {})
    await appPool.query('delete from data.metrics where org = $1', [ORG]).catch(() => {})
    await appPool.query('delete from data.asset_audit where org = $1', [ORG]).catch(() => {})
    await appPool.query('delete from platform.org_membership where tenant_id in (select id from platform.tenant where casdoor_org = $1)', [ORG]).catch(() => {})
    await appPool.query('delete from platform.tenant where casdoor_org = $1', [ORG]).catch(() => {})
    await appPool.end().catch(() => {})
  })

  it('★ 创建：影子期恒开、收件人经过第一道门、审计留痕', async () => {
    const res = await appFor(CREATOR).request('/monitors', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: '华东断供盯防', targetKind: 'metric', metricId: METRIC.id,
        verdict: 'missing', windowDays: 2, cadenceSecs: 300,
        recipients: [{ kind: 'user', ref: CREATOR }, { kind: 'user', ref: 'gone' }],
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json() as { id: string; dryRun: boolean; recipients: string[] }
    id = body.id
    expect(body.dryRun).toBe(true) // 创建恒影子期；开闸只能走 PATCH
    expect(body.recipients).toEqual([CREATOR])
    const audit = await appPool.query(
      "select action from data.asset_audit where org = $1 and asset_id = $2", [ORG, `monitor:${id}`])
    expect(audit.rows[0].action).toBe('monitor.create')
  })

  it('目标不存在 ⇒ 400；收件人全部无效 ⇒ 400', async () => {
    const bad = await appFor(CREATOR).request('/monitors', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x', targetKind: 'metric', metricId: 'nope', verdict: 'missing',
        cadenceSecs: 300, recipients: [{ kind: 'user', ref: CREATOR }],
      }),
    })
    expect(bad.status).toBe(400)

    const noRcpt = await appFor(CREATOR).request('/monitors', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'x', targetKind: 'metric', metricId: METRIC.id, verdict: 'stale',
        cadenceSecs: 300, recipients: [{ kind: 'user', ref: 'ghost' }],
      }),
    })
    expect(noRcpt.status).toBe(400)
    expect((await noRcpt.json()).error).toBe('MONITOR_NO_RECIPIENTS')
  })

  it('★ 非创建者改 403；创建者可开闸；台账端点 200', async () => {
    const denied = await appFor(OTHER).request(`/monitors/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false }),
    })
    expect(denied.status).toBe(403)

    const ok = await appFor(CREATOR).request(`/monitors/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false }),
    })
    expect(ok.status).toBe(200)
    const row = await appPool.query('select dry_run from data.monitor where id = $1', [id])
    expect(row.rows[0].dry_run).toBe(false)

    const runs = await appFor(CREATOR).request(`/monitors/${id}/runs`)
    expect(runs.status).toBe(200)
    expect((await runs.json()).runs).toEqual([])

    const missing = await appFor(CREATOR).request('/monitors/999999/runs')
    expect(missing.status).toBe(404)
  })

  it('data:manage 可改他人监控', async () => {
    const res = await appFor(OTHER, ['data:manage']).request(`/monitors/${id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    })
    expect(res.status).toBe(200)
  })
})
