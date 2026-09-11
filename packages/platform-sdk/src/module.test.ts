import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { testClient } from 'hono/testing'
import type { Pool } from 'pg'
import { DECLARED_GATE_APPROVED, declaredScopeGate, defineModule, requireScope } from './module'
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

// 放行标记：包裹层（loader.applyDeclaredApiGate）给通配 ALL 路由挂的兜底门卫**唯一**能用来
// 区分"已放行 / 谁都没放行"的东西（通配路径上 c.req.routePath 恒为通配模式本身，比不了表）。
// 在这里钉死"放行才置位"，避免它被当成可随手删掉的一行。
describe('declaredScopeGate：放行标记', () => {
  const declared = [{ method: 'GET', path: '/ping', scope: 'demo:view' }]
  const flagOf = (identity?: Identity) => {
    const app = new Hono<{ Variables: { identity: Identity } }>()
    app.use('/ping', async (c, next) => {
      if (identity) c.set('identity', identity)
      await next()
    })
    app.use('/ping', declaredScopeGate(declared))
    app.get('/ping', (c) => {
      const marked = (c as unknown as { get(k: string): unknown }).get(DECLARED_GATE_APPROVED)
      return c.json({ marked: marked === true })
    })
    return app.request('/ping')
  }

  it('放行 ⇒ 置标记；无 identity / scope 不符 ⇒ 不置（标记不是授权本身）', async () => {
    const ok = await flagOf(makeIdentity(['demo:view']))
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ marked: true })

    const anon = await flagOf()
    expect(anon.status).toBe(401)

    const wrong = await flagOf(makeIdentity(['other:scope']))
    expect(wrong.status).toBe(403)
  })
})

describe('declaredScopeGate：HEAD 请求（issue #7）', () => {
  // Hono 把 HEAD 按 GET 派发，但 `c.req.method` 仍是 'HEAD'。若门卫拿原始 method 查声明表，
  // 已声明的 GET 端点在 HEAD 下会查不到声明 ⇒ 落进 !hit 分支 ⇒ **恒 403**。
  // 危害不在可达性（fail-closed），而在语义：探活/监控/CDN 预检/部分 HTTP 客户端都发 HEAD，
  // 表现为“资源存在却说没有”，容易被误读成权限问题。
  const declared = [{ method: 'GET', path: '/ping', scope: 'demo:view' }]

  const probe = (path: string, opts?: { identity?: Identity }) => {
    const app = new Hono<{ Variables: { identity: Identity } }>()
    app.use(path, async (c, next) => {
      if (opts?.identity) c.set('identity', opts.identity)
      await next()
    })
    app.use(path, declaredScopeGate(declared))
    app.get(path, (c) => c.json({ ok: true }))
    return app.request(path, { method: 'HEAD' })
  }

  it('已声明的 GET 端点：HEAD 与 GET 同权（有 scope 200 / 无 scope 403 / 匿名 401）', async () => {
    expect((await probe('/ping', { identity: makeIdentity(['demo:view']) })).status).toBe(200)
    expect((await probe('/ping', { identity: makeIdentity(['other:scope']) })).status).toBe(403)
    expect((await probe('/ping')).status).toBe(401)
  })

  it('未声明的路径：HEAD 仍 fail-closed（归一不是“放行一切 HEAD”）', async () => {
    const res = await probe('/other', { identity: makeIdentity(['demo:view']) })
    expect(res.status).toBe(403)
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
