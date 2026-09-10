import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { testClient } from 'hono/testing'
import type { Pool } from 'pg'
import { defineModule, requireScope } from './module'
import type { Identity, ModuleDefinition } from './module'

// Task 9：模块接入三原语的契约。身份由宿主注入（此处用 set 中间件模拟宿主行为），
// requireScope 只消费 c.get('identity')，模块零认证代码。

const makeIdentity = (scopes: string[]): Identity => ({
  userId: 'u-1',
  orgId: 'org-9',
  displayName: '测试用户',
  scopes,
  hasScope: (code) => scopes.includes(code),
})

// 模拟宿主：挂一个把 identity 塞进 context 的中间件（identity 缺省时什么都不注入），
// 后面跟 requireScope('demo:view') 与一个 echo handler。
// 注意：路由 schema 在 app.get(...) 的返回值上，testClient 必须吃链式结果（吃 const app 会丢 schema）。
const makeApp = (identity?: Identity) => {
  const app = new Hono<{ Variables: { identity: Identity } }>()
  app.use('/zone', async (c, next) => {
    if (identity) c.set('identity', identity)
    await next()
  })
  const routes = app.get('/zone', requireScope('demo:view'), (c) => {
    const id = c.get('identity')
    return c.json({ userId: id.userId, orgId: id.orgId })
  })
  return testClient(routes)
}

describe('requireScope', () => {
  it('无 identity → 401 且 body.error=UNAUTHENTICATED', async () => {
    const res = await makeApp().zone.$get()
    expect(res.status).toBe(401)
    const body = (await res.json()) as unknown as { error: string; need?: string }
    expect(body.error).toBe('UNAUTHENTICATED')
    expect(body.need).toBeUndefined()
  })

  it('有 identity 但无该 scope → 403 且 body.error=FORBIDDEN/body.need=code', async () => {
    const res = await makeApp(makeIdentity(['demo:edit'])).zone.$get()
    expect(res.status).toBe(403)
    const body = (await res.json()) as unknown as { error: string; need?: string }
    expect(body.error).toBe('FORBIDDEN')
    expect(body.need).toBe('demo:view')
  })

  it('有 scope → 放行，handler 内 c.get("identity") 可读（echo userId/orgId）', async () => {
    const res = await makeApp(makeIdentity(['demo:view', 'demo:edit'])).zone.$get()
    expect(res.status).toBe(200)
    const body = (await res.json()) as { userId: string; orgId: string }
    expect(body.userId).toBe('u-1')
    expect(body.orgId).toBe('org-9')
  })
})

describe('defineModule', () => {
  it('原样往返：返回 === 传入，createRouter 类型可组（router 即 Hono）', () => {
    const def: ModuleDefinition = {
      manifest: {
        id: 'demo',
        name: '演示模块',
        version: '0.1.0',
        platform: '>=0.1.0',
        permissions: [{ code: 'demo:view', name: '查看' }],
      },
      createRouter: (ctx) => {
        const router = new Hono()
        router.get('/', (c) => c.json({ pool: typeof ctx.pool.query === 'function' ? 'pg' : 'other' }))
        return router
      },
    }
    const returned = defineModule(def)
    expect(returned).toBe(def)
    expect(returned.manifest.id).toBe('demo')
    // ModuleContext 组装：宿主注入 pool，模块侧只拿到类型。
    const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool
    const router = returned.createRouter({ pool: fakePool })
    expect(router).toBeInstanceOf(Hono)
  })
})
