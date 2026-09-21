// 路由层的共享层：类型 + 参数解析 + 身份归一。单独一个文件是为了让 T6–T9 各域互相不 import。
// ⚠️ 引类型务必 `import type`，别把类型当值引（#44 的形状，typecheck 拦不住）。
import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import type { Identity, RequesterVars } from '@platform/sdk'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Requester } from '../domain/authz'
import type { SqlExecutor } from '../domain/query-service'

/**
 * 宿主注入的租户信息（宿主绝对真值，模块只读）。
 * **刻意不是完整的 `TenantRow`**：模块只可能用到这两列，收窄成显式形状后测试里造值不必补
 * 十几个必填字段。`TenantRow` 结构上可赋给本类型（宿主 `c.set('tenant', row)` 那侧无须转换）。
 */
export interface DataTenant {
  id: number
  casdoor_org: string
}

/**
 * 模块路由的统一 Env。identity 由宿主注入（模块自己【不写】门禁）。
 * `TENANT_STORAGE` 不在 Env 里：本模块不声明 `storage`，宿主不会设，设了也没人读。
 * 请求者上下文（PAT/企微通道带进来的「人机区分」，会话通道下不设该键）求交在
 * `Variables` **内层**——⚠️ 写成 `ModuleVars & RequesterVars` 会把键搁到 Env 顶层，
 * `c.get(REQUESTER_CHANNEL)` 恒 undefined。见 T5 `requester-vars.ts` 的注记。
 */
export type ModuleVars = { Variables: { identity: Identity; tenant: DataTenant } & RequesterVars }

/** 模块路由实例的统一类型。 */
export type ModuleHono = Hono<ModuleVars>

/** 每个域注册时拿到的依赖。**只有 pool**（本模块无租户级存储配置）。 */
export interface RouteCtx {
  pool: Pool
  /** 缺省 = 真仓库（runQuery 惰性连）。测试注入假执行器（T8/T9 的测试也靠它）。 */
  execute?: SqlExecutor
}

/**
 * identity → Requester（三通道**唯一**的身份归一）。
 * 通道变量未设 ⇒ 系统内会话通道（sessionMiddleware 不设这两个变量）。
 *
 * M3 守卫（#143 裁决，收在这里而不是留给下游兜）：identity 缺失或 `orgId` 为空串 ⇒
 * 返回 `null`（入口拒，交给 runQuery 的 `unauthenticated`/fail-closed 路径），
 * 别让空 org 流进 SQL——下游虽是查空集 fail-safe，但「宁可入口拒」。
 *
 * ⚠️ 泛型是 `Context<ModuleVars>`（**整个 Env**），不是 `Context<{ identity: … }>`。
 */
export function requesterOf(c: Context<ModuleVars>): Requester | null {
  const identity = c.get('identity')
  if (!identity || identity.orgId === '') return null
  return {
    userId: identity.userId,
    orgId: identity.orgId,
    channel: c.get(REQUESTER_CHANNEL) ?? 'session',
    keyId: c.get(REQUESTER_KEY_ID) ?? null,
    scopes: identity.scopes,
    hasScope: (code: string) => identity.hasScope(code),
  }
}

/** 路径参数里的 id：只接受十进制正整数字面量，其余一律 null（照 aftersales/routes/context.ts）。 */
export function parseIdParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}
