// system-map.test.ts — GET /system-map 的路由层测试（W5 Task 4）。
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
  for (const p of ['/system-map', '/system-map/graph']) {
    if (identityOverride !== undefined) {
      shell.use(p, async (c, next) => {
        c.set('identity', identityOverride)
        c.set('tenant', { id: 1, casdoor_org: identityOverride.orgId })
        await next()
      })
    }
    shell.use(p, declaredScopeGate([
      { method: 'GET', path: '/system-map', scope: 'data:query' },
      { method: 'GET', path: '/system-map/graph', scope: 'data:query' },
    ]))
  }
  shell.route('/', mod.createRouter({ pool: emptyPool().pool }))
  return shell as unknown as Hono
}

afterEach(() => {
  clearSystemMapCache()
})

describe('GET /system-map（数据体系地图）', () => {
  it('未登录 ⇒ 宿主门卫 401，不生成地图', async () => {
    const res = await appWithGate().request('/system-map')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  it('已登录但缺 data:query ⇒ 403（声明即授权）', async () => {
    const res = await appWithGate(makeIdentity({ orgId: ORG, scopes: ['data:manage'] })).request('/system-map')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'data:query' })
  })

  it('有 data:query ⇒ 200 text/html，含中文标题、深链与内嵌数据脚本', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool().pool }).request('/system-map')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    for (const title of ['数据体系地图', '总览', '指标', '实体', '数据源', '需求台账']) {
      expect(html).toContain(title)
    }
    // 深链约定（W5 Task 3）：五视图 + 详情前缀
    for (const href of ['#/overview', '#/metrics', '#/entities', '#/sources', '#/demands']) {
      expect(html).toContain(`href="${href}"`)
    }
    expect(html).toContain('class="mobile-tabbar"')
    expect(html).toContain('<script type="application/json" id="system-map-data">')
    // 内嵌 JSON 必须能被解析（转义后仍是合法 JSON），健康五数在模型里
    const m = /<script type="application\/json" id="system-map-data">([\s\S]*?)<\/script>/.exec(html)
    expect(m).not.toBeNull()
    const parsed = JSON.parse(m?.[1] ?? '{}') as {
      health?: {
        metricTotal?: number; entityBoundPct?: number; auditCoveredPct?: number
        zeroUse?: number; openDemands?: number; incidents?: number; incidentsTracked?: boolean
      }
      dimensions?: unknown[]
      invariants?: unknown[]
    }
    expect(parsed.health?.metricTotal).toBe(0)
    expect(parsed.health?.entityBoundPct).toBe(0)
    expect(parsed.health?.auditCoveredPct).toBe(0)
    expect(parsed.health?.zeroUse).toBe(0)
    expect(parsed.health?.openDemands).toBe(0)
    expect(parsed.health?.incidents).toBe(0)
    expect(parsed.health?.incidentsTracked).toBe(true)
    // 仓内 W4 声明是真实读到的（不是空）
    expect((parsed.dimensions ?? []).length).toBeGreaterThan(0)
    expect((parsed.invariants ?? []).length).toBeGreaterThan(0)
  })

  it('10 分钟缓存：同一 org 二次请求不重复查库', async () => {
    const p = emptyPool()
    const app = buildTestApp(mod, identity, { pool: p.pool })
    const first = await app.request('/system-map')
    expect(first.status).toBe(200)
    const afterFirst = p.calls()
    expect(afterFirst).toBeGreaterThan(0)

    const second = await app.request('/system-map')
    expect(second.status).toBe(200)
    expect(p.calls()).toBe(afterFirst)
    expect(await second.text()).toBe(await first.text())
  })

  it('不同 org 不共用缓存（按 org 分键）', async () => {
    const p = emptyPool()
    const a = buildTestApp(mod, identity, { pool: p.pool })
    await a.request('/system-map')
    const afterA = p.calls()
    const b = buildTestApp(mod, makeIdentity({ orgId: 'org-other' }), { pool: p.pool })
    await b.request('/system-map')
    expect(p.calls()).toBeGreaterThan(afterA)
  })
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

  it('与 HTML 页共用一份模型缓存：先开 HTML 再取图，不重复查库', async () => {
    const p = emptyPool()
    const app = buildTestApp(mod, identity, { pool: p.pool })
    await app.request('/system-map')
    const afterHtml = p.calls()
    const g = await app.request('/system-map/graph')
    expect(g.status).toBe(200)
    expect(p.calls()).toBe(afterHtml)
  })
})
