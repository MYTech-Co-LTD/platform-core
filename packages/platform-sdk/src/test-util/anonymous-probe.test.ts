// 门卫自己的语义也要有测试。这里同时钉死一条【载荷性假设】：门卫靠 c.req.routePath 取
// 命中的路径模式——若 Hono 行为变化（或改用通配挂载），这些用例会立刻变红。
import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { createMiddleware } from 'hono/factory'
import { declaredScopeGate, type Identity } from '../module'
import { probeAnonymous } from './anonymous-probe'

const declared = [
  { method: 'GET', path: '/ping', scope: 'demo:view' },
  { method: 'GET', path: '/notes/:id', scope: 'demo:note' },
]

type Env = { Variables: { identity: Identity } }
const withIdentity = (scopes: string[]) =>
  createMiddleware<Env>(async (c, next) => {
    c.set('identity', {
      userId: 'u', orgId: 'o', displayName: 'U', scopes,
      hasScope: (code: string) => scopes.includes(code),
    })
    await next()
  })

function appWith(scopes: string[] | null): Hono {
  const app = new Hono()
  // 顺序即语义（见 module.ts 的挂载说明）：identity 必须**先于**门卫注册，否则门卫先跑、
  // 拿不到身份 ⇒ 全 401。真实链路同序：宿主会话中间件先于 runtime.mount（app.ts）
  if (scopes) app.use('*', withIdentity(scopes))
  const gate = declaredScopeGate(declared)
  for (const p of new Set(declared.map((d) => d.path))) app.use(p, gate)
  app.get('/ping', (c) => c.json({ hit: 'ping' }))
  app.get('/notes/:id', (c) => c.json({ hit: 'note' }))
  return app
}

describe('declaredScopeGate：未声明 = 不可达', () => {
  it('★ 负例：无 identity ⇒ 401 UNAUTHENTICATED（绝不能落到 handler）', async () => {
    const res = await appWith(null).request('/ping')
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'UNAUTHENTICATED' })
  })

  it('★ 负例：identity 在但 scope 不含 ⇒ 403 FORBIDDEN + need', async () => {
    const res = await appWith(['other:scope']).request('/ping')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'FORBIDDEN', need: 'demo:view' })
  })

  it('scope 命中 ⇒ 放行到 handler', async () => {
    const res = await appWith(['demo:view']).request('/ping')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ hit: 'ping' })
  })

  it('★ 参数化路径同样被守住（/notes/42 命中 /notes/:id 的门卫）', async () => {
    const blocked = await appWith(['demo:view']).request('/notes/42')
    expect(blocked.status).toBe(403) // 有 demo:view 但缺 demo:note
    const ok = await appWith(['demo:note']).request('/notes/42')
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ hit: 'note' })
  })

  it('★ 负例：声明外的 method 打到已声明路径 ⇒ 403 而非 404（fail-closed，不泄方法枚举）', async () => {
    const res = await appWith(['demo:view']).request('/ping', { method: 'POST' })
    expect(res.status).toBe(403)
  })
})

describe('probeAnonymous：匿名探测回归网', () => {
  it('★ 负例：门卫缺失的路由会被如实报成 200（探测不能"永远绿"）', async () => {
    const unguarded = new Hono()
    unguarded.get('/open', (c) => c.json({ leaked: true }))
    const results = await probeAnonymous(unguarded)
    expect(results).toEqual([{ method: 'GET', path: '/open', status: 200 }])
  })

  it('门卫齐备 ⇒ 每条路由都 401，含参数化路径', async () => {
    const router = new Hono()
    router.get('/ping', (c) => c.json({ hit: 'ping' }))
    router.get('/notes/:id', (c) => c.json({ hit: 'note' }))
    const guarded = new Hono()
    const gate = declaredScopeGate(declared)
    for (const p of new Set(declared.map((d) => d.path))) guarded.use(p, gate)
    guarded.route('/', router)
    const results = await probeAnonymous(guarded)
    expect(results.map((r) => r.status)).toEqual([401, 401])
  })
})
