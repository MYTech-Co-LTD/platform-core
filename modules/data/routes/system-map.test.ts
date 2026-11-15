// system-map.test.ts — 体系地图各 JSON 端点的路由层测试。
//
// 门卫归宿主（declaredScopeGate）：未登录 401、无 data:query 403。模块自身只兜
// 「门卫放行但 org 为空」的 401（与 requesterOf 的口径一致）。
// 取数用「永远空结果」的假 pool：本文件只验装配、HTML 形状与缓存，健康数字归 domain 测试。
import { Hono } from 'hono'
import { afterEach, describe, expect, it } from 'vitest'
import { declaredScopeGate } from '@platform/sdk'
import type { Pool } from 'pg'
import mod from '../index'
import { buildTestApp, makeIdentity } from '../test-util'
import { clearSystemMapCache } from './system-map'
import type { ModuleVars } from './context'

const ORG = 'org-system-map'
const identity = makeIdentity({ orgId: ORG })

/** 空结果 pool；`calls` 用来验「缓存命中后不再查库」。 */
function emptyPool(): { pool: Pool; calls: () => number } {
  let calls = 0
  const pool = {
    query: async () => { calls += 1; return { rows: [], rowCount: 0 } },
  } as unknown as Pool
  return { pool, calls: () => calls }
}

function appWithGate(identityOverride?: ReturnType<typeof makeIdentity>) {
  const shell = new Hono<ModuleVars>()
  for (const p of ['/system-map/graph', '/system-map/metrics/*', '/system-map/pipelines', '/system-map/pipelines/:id/runs', '/system-map/lineage/*']) {
    if (identityOverride !== undefined) {
      shell.use(p, async (c, next) => {
        c.set('identity', identityOverride)
        c.set('tenant', { id: 1, casdoor_org: identityOverride.orgId })
        await next()
      })
    }
    shell.use(p, declaredScopeGate([
      { method: 'GET', path: '/system-map/graph', scope: 'data:query' },
      { method: 'GET', path: '/system-map/metrics/:id/trail', scope: 'data:query' },
      { method: 'GET', path: '/system-map/pipelines', scope: 'data:query' },
      { method: 'GET', path: '/system-map/pipelines/:id/runs', scope: 'data:query' },
      { method: 'GET', path: '/system-map/lineage/:id', scope: 'data:query' },
    ]))
  }
  shell.route('/', mod.createRouter({ pool: emptyPool().pool }))
  return shell as unknown as Hono
}

afterEach(() => {
  clearSystemMapCache()
})

describe('GET /system-map/graph（本体图 JSON）', () => {
  it('未登录 ⇒ 401；缺 data:query ⇒ 403（与 HTML 页同档）', async () => {
    expect((await appWithGate().request('/system-map/graph')).status).toBe(401)
    const denied = await appWithGate(makeIdentity({ orgId: ORG, scopes: ['data:manage'] })).request('/system-map/graph')
    expect(denied.status).toBe(403)
  })

  it('有 data:query ⇒ 200 JSON：health + ontology{nodes,edges} + warnings', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map/graph')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    const body = await res.json() as {
      generatedAt: string
      health: { metricTotal: number }
      ontology: { nodes: unknown[]; edges: unknown[] }
      warnings: unknown[]
    }
    expect(typeof body.generatedAt).toBe('string')
    expect(body.health.metricTotal).toBe(0)
    expect(Array.isArray(body.ontology.nodes)).toBe(true)
    expect(Array.isArray(body.ontology.edges)).toBe(true)
    expect(Array.isArray(body.warnings)).toBe(true)
  })

  it('同一 org 二次取图不重复查库（10 分钟缓存）', async () => {
    const p = emptyPool()
    const app = buildTestApp(mod, identity, { pool: p.pool })
    await app.request('/system-map/graph')
    const afterFirst = p.calls()
    const g = await app.request('/system-map/graph')
    expect(g.status).toBe(200)
    expect(p.calls()).toBe(afterFirst)
  })
})

describe('GET /system-map/metrics/:id/trail（指标链路）', () => {
  it('未登录 ⇒ 401；缺 data:query ⇒ 403', async () => {
    expect((await appWithGate().request('/system-map/metrics/x/trail')).status).toBe(401)
    expect((await appWithGate(makeIdentity({ orgId: ORG, scopes: ['data:manage'] })).request('/system-map/metrics/x/trail')).status).toBe(403)
  })

  it('未知指标 ⇒ 404 NO_SUCH_METRIC（不编一条链路出来）', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map/metrics/no:such:metric/trail')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'NO_SUCH_METRIC' })
  })

  // 200 分支的模型来自运行库（data.metrics）；本文件用空 pool ⇒ 没有指标可查。
  // 结构正确性由 domain/system-map/trail.test.ts 钉住，端到端在真机验收。
})

describe('GET /system-map/pipelines（管线全局图）', () => {
  it('未登录 ⇒ 401；缺 data:query ⇒ 403', async () => {
    expect((await appWithGate().request('/system-map/pipelines')).status).toBe(401)
    expect((await appWithGate(makeIdentity({ orgId: ORG, scopes: ['data:manage'] })).request('/system-map/pipelines')).status).toBe(403)
  })

  it('200：资产层非空，且每条资产带 staging/marts/pipelines 三件套', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map/pipelines')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      assets: Array<{ lake: string; staging: string | null; marts: string[]; pipelines: unknown[] }>
      warnings: string[]
      runsWired: boolean
    }
    expect(body.assets.length).toBeGreaterThan(0)
    for (const a of body.assets.slice(0, 5)) {
      expect(typeof a.lake).toBe('string')
      expect(Array.isArray(a.marts)).toBe(true)
      expect(Array.isArray(a.pipelines)).toBe(true)
    }
    expect(body.runsWired).toBe(false)
    expect(Array.isArray(body.warnings)).toBe(true)
  })
})

describe('GET /system-map/pipelines/:id/runs（运行历史）', () => {
  it('未登录 ⇒ 401；缺 data:query ⇒ 403', async () => {
    expect((await appWithGate().request('/system-map/pipelines/p1/runs')).status).toBe(401)
    expect((await appWithGate(makeIdentity({ orgId: ORG, scopes: ['data:manage'] })).request('/system-map/pipelines/p1/runs')).status).toBe(403)
  })

  it('未接运行记录 ⇒ status=unknown（不是空数组冒充「没跑过」）', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map/pipelines/lemeng.retail_order_line.day/runs')
    expect(res.status).toBe(200)
    const body = await res.json() as { status: string; reason: string; runs: unknown[] }
    expect(body.status).toBe('unknown')
    expect(body.reason).toBe('runs_source_not_wired')
    expect(body.runs).toEqual([])
  })

  it('非法管線 id ⇒ 400（防注入到运行记录路径）', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map/pipelines/..%2Fetc/runs')
    expect([400, 404]).toContain(res.status)
  })
})

describe('GET /system-map/lineage/:id（数据生产线）', () => {
  it('未登录 ⇒ 401；缺 data:query ⇒ 403', async () => {
    expect((await appWithGate().request('/system-map/lineage/x')).status).toBe(401)
    expect((await appWithGate(makeIdentity({ orgId: ORG, scopes: ['data:manage'] })).request('/system-map/lineage/x')).status).toBe(403)
  })

  it('未知指标 ⇒ 404（不编一条生产线）', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map/lineage/no:such')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'NO_SUCH_METRIC' })
  })
})
