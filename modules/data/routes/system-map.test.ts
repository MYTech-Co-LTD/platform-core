// system-map.test.ts — GET /system-map 的路由层测试。
//
// 门卫归宿主（declaredScopeGate）：未登录 401、无 data:query 403。模块自身只兜
// 「门卫放行但 org 为空」的 401（与 requesterOf 的口径一致）。
// 取数用「永远空结果」的假 pool：本文件只验装配与 HTML 形状，健康数字归 domain 测试。
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

/** 空结果 pool：地图的路由测试不关心运行库数字，只验「能装配出一页 HTML」。 */
const emptyPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as Pool

function appWithGate(identityOverride?: ReturnType<typeof makeIdentity>) {
  const shell = new Hono<ModuleVars>()
  if (identityOverride !== undefined) {
    shell.use('/system-map', async (c, next) => {
      c.set('identity', identityOverride)
      c.set('tenant', { id: 1, casdoor_org: identityOverride.orgId })
      await next()
    })
  }
  shell.use('/system-map', declaredScopeGate([
    { method: 'GET', path: '/system-map', scope: 'data:query' },
  ]))
  shell.route('/', mod.createRouter({ pool: emptyPool }))
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

  it('有 data:query ⇒ 200 text/html，含中文标题与内嵌数据脚本', async () => {
    const res = await buildTestApp(mod, identity, { pool: emptyPool }).request('/system-map')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    for (const title of ['数据体系地图', '总览', '指标', '实体', '数据源', '需求台账']) {
      expect(html).toContain(title)
    }
    expect(html).toContain('<script type="application/json" id="system-map-data">')
    // 内嵌 JSON 必须能被解析（转义后仍是合法 JSON）
    const m = /<script type="application\/json" id="system-map-data">([\s\S]*?)<\/script>/.exec(html)
    expect(m).not.toBeNull()
    const parsed = JSON.parse(m?.[1] ?? '{}') as { health?: { totalMetrics?: number } }
    expect(typeof parsed.health?.totalMetrics).toBe('number')
  })
})
