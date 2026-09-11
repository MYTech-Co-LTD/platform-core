import type { Hono, MiddlewareHandler } from 'hono'
import type { Pool } from 'pg'
import type { ModuleManifest } from './manifest'

/**
 * 模块接入三原语（Task 9）：模块开发者只经 defineModule / requireScope / Identity 接入宿主。
 * 身份由宿主（platform/server 的装载器）注入到 Hono context 的 'identity' 变量，模块零认证代码。
 */

/** 宿主注入的请求身份。hasScope 即 scopes.includes——权限判定只有这一条规则。 */
export interface Identity {
  userId: string
  orgId: string
  displayName: string
  scopes: string[]
  hasScope(code: string): boolean
}

/** 宿主递给 createRouter 的运行时上下文：绑定资源在此，模块不自己建连接。 */
export interface ModuleContext {
  pool: Pool
}

/**
 * 模块定义：manifest（接入协议）+ createRouter（拿到 ctx 组路由）。
 *
 * 返回类型为什么是 `Hono<any, any, any>`（Task 19 评审 I-1 修复）：
 * Hono 的 Env/Schema/Path 泛型是**不变**的（`Set`/`Handler` 的参数位逆变），任何具体化的
 * 返回类型都会反过来拒绝模块自己声明的合法 router——实测（tsc strict 逐条验证）：
 * - `Hono`（BlankEnv）拒绝 `new Hono<{ Variables: { identity: Identity } }>()`——正是本协议
 *   要模块写的形状（模块因此被迫 cast，见下）；
 * - `Hono<{ Variables: { identity: Identity } }>` 拒绝模块自有变量（`identity` + 自己的键）
 *   与宿主装载器（apps/server/src/loader.ts 的 `router: Hono`）；
 * - `Hono<Env, any, any>`（hono 自带 Env 在比较中退化成 `{}`）、
 *   `Hono<{ Variables: Record<string, unknown> }, any, any>` 同样拒绝上述全部形状；
 * - 泛型化 `ModuleDefinition<E>` 能通过，但把 Hono 的不变性问题传染给 ModuleDefinition
 *   本身：`const def: ModuleDefinition = defineModule({...})` 会因 `ModuleDefinition<M>` 不可
 *   赋给 `ModuleDefinition<Env>` 而报错——摩擦扩散，不是收敛。
 * 宿主对模块 router 只做「按路径前缀 route/use」，从不读写其变量表/Schema，故三个槽位
 * 用 `any` 表达「宿主不关心」是准确的，并未丢失真实检查：非 Hono 返回值仍被拒，
 * 模块内 `c.get('identity')` 的类型检查来自模块自己那句 `new Hono<...>()`（见 modules/demo）。
 * 宿主装配处对同一摩擦也是这么绕的：apps/server/src/app.ts 的 `mount(app as unknown as Hono)`。
 */
export interface ModuleDefinition {
  manifest: ModuleManifest
  createRouter(ctx: ModuleContext): Hono<any, any, any>
}

/** 原样返回 def——只是给模块一个类型收窄的挂点，宿主按 ModuleDefinition 消费。 */
export function defineModule(def: ModuleDefinition): ModuleDefinition {
  return def
}

/**
 * scope 门卫中间件：
 * - c.get('identity') 缺失 → 401 {"error":"UNAUTHENTICATED"}
 * - 有 identity 但 hasScope(code) 为 false → 403 {"error":"FORBIDDEN","need":code}
 * 错误体形状固定 { error: string; need?: string }。
 */
export function requireScope(code: string): MiddlewareHandler {
  return async (c, next) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    if (!identity.hasScope(code)) {
      return c.json({ error: 'FORBIDDEN', need: code }, 403)
    }
    await next()
  }
}
