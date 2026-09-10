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

/** 模块定义：manifest（接入协议）+ createRouter（拿到 ctx 组路由）。 */
export interface ModuleDefinition {
  manifest: ModuleManifest
  createRouter(ctx: ModuleContext): Hono
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
