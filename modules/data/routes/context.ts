// 路由层的共享层：类型 + 参数解析 + 身份归一。单独一个文件是为了让 T6–T9 各域互相不 import。
// ⚠️ 引类型务必 `import type`，别把类型当值引（#44 的形状，typecheck 拦不住）。
import type { Context, Hono } from 'hono'
import type { Pool } from 'pg'
import type {
  ChannelAddressResolver, Identity, NotifyPort, RequesterVars, UserStatusResolver,
} from '@platform/sdk'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID, TENANT_SOURCES } from '@platform/sdk'
import type { Requester } from '../domain/authz'
import type { StreamingChatModel } from '../domain/llm'
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
export type ModuleVars = {
  Variables: {
    identity: Identity
    tenant: DataTenant
    /** 宿主投影的「本租户已接入的源」（计划 5；manifest 已声明 `tenantSources: true`）。
     *  `undefined` = 宿主没投影（本模块没声明 / 无租户上下文）/ `[]` = 声明了但一个源都没接
     *  / 非空 = enabled 的源集合 —— 三种状态，消费方别把前两者混成一种。 */
    [TENANT_SOURCES]?: string[]
  } & RequesterVars
}

/** 模块路由实例的统一类型。 */
export type ModuleHono = Hono<ModuleVars>

/** 每个域注册时拿到的依赖。**只有 pool**（本模块无租户级存储配置）。 */
export interface RouteCtx {
  pool: Pool
  /** 缺省 = 真仓库（runQuery 惰性连）。测试注入假执行器（T8/T9 的测试也靠它）。 */
  execute?: SqlExecutor
  /**
   * 参数化只读执行器（`explore_query` / `explore_recipe`；根因探针用）。
   * 缺省 = `analystPool`；与 `execute` 同款，只给测试注入。
   */
  exploreExec?: (sql: string, params: readonly unknown[]) => Promise<{ columns: string[]; rows: unknown[][] }>
  /**
   * 数据面连接（W2 私有测度的实际列白名单用）。缺省 = `warehousePool()`（生产是**另一张库**）。
   * 与 `execute` 同款：只给测试注入，不是模块协议的字段；生产装配下不传。
   */
  warehouse?: Pool
  /**
   * 通知端口（宿主注入；缺省 = 旧宿主/单测，调用点判空跳过——与 aftersales 同款注入面）。
   * 消费方：指标确认生效的变更通知（spec 2026-11-01 §10.4 D6）。
   */
  notify?: NotifyPort
  /**
   * LLM 测试缝（计划 2026-10-26 Task 7）：缺省 = `llmFromEnv()` + `openAiCompatModel`
   * （生产装配下 `index.ts` 不传 ⇒ 恒走 env）。返回 `null` = 本次无模型（模板回退）。
   * ⚠️ 与 `execute` 同款：只给测试注入，不是模块协议的字段。
   */
  llm?: () => StreamingChatModel | null
  /**
   * 宿主注入的只读能力（组织架构选择器）。**与 notify 用的是同一个注入面**
   * （`ChannelAddressResolver`）——同一个平台原语不各写一份 SQL（2026-10-30 收口：
   * 部门选择器的数据源从此只有宿主一处）。
   */
  addresses?: ChannelAddressResolver
  /** 用户活跃态（#1333）：宿主注入（Casdoor 状态）；未注入 = 未知（管理面 ownerActive=null）。 */
  userStatus?: UserStatusResolver
  /**
   * 仓根（W3 候选升级链，#1401）：propose-l1 读现行 `dbt/semantics/l1_metrics.yml` 的解析基准。
   * 缺省 = 按模块位置解析的仓根（镜像内 /app；dbt/ 整树 COPY 进镜像）。**与 execute/warehouse
   * 同款：只给测试注入，不是模块协议的字段**——生产装配下不传。
   */
  repoRoot?: string
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
    accountName: identity.accountName,
    orgId: identity.orgId,
    // 部门闭包查询要数字租户 id（v_org_membership.tenant_id）——路由层是唯一拿得到它的地方
    tenantId: c.get('tenant').id,
    channel: c.get(REQUESTER_CHANNEL) ?? 'session',
    keyId: c.get(REQUESTER_KEY_ID) ?? null,
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
    scopes: identity.scopes,
    hasScope: (code: string) => identity.hasScope(code),
    ...(identity.roles !== undefined ? { roles: identity.roles } : {}),
  }
}

/** 路径参数里的 id：只接受十进制正整数字面量，其余一律 null（照 aftersales/routes/context.ts）。 */
export function parseIdParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d+$/.test(raw)) return null
  const n = Number(raw)
  return Number.isSafeInteger(n) && n > 0 ? n : null
}

/**
 * 写路径的判别式结果（域层判定 → HTTP 的**唯一**形状）。
 * 各域（指标 / 已验证问答）共用本形状与 `writeOutcome`——「错误码怎么映射成 HTTP」
 * 只应有一份实现，路由层不要各自拼状态码。
 */
export type RouteWriteOutcome =
  | { ok: true }
  | { ok: false; http: 400 | 403 | 404 | 409 | 500; error: string; extra?: Record<string, unknown> }

/**
 * 域层判别式结果 → HTTP。`okStatus` 区分建 201 / 改 200——那是路由层才知道的事
 * （HTTP 语义不属于判定链）。
 */
export function writeOutcome(c: Context<ModuleVars>, r: RouteWriteOutcome, okStatus: 200 | 201) {
  return r.ok
    ? c.json({ ok: true }, okStatus)
    : c.json({ error: r.error, ...(r.extra ?? {}) }, r.http)
}
