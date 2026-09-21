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
 * 宿主按【本次请求所属租户】投影出的存储配置（正典「租户级配置注入」）。
 * kind 由 manifest 的 `storage.kind` 选定；五元组是 S3 兼容的通用形状（ZOS 只是实现之一）。
 *
 * ⚠️ 模块拿到的是**投影后的窄值**，不是 `TenantRow` —— 后者坐着 wecom/公众号密钥与 casdoor_org。
 * 这条是 B1 的延伸约束，不是风格问题（见 docs/architecture.md §4.3 的不变量表）。
 */
export interface TenantStorageConfig {
  kind: 's3'
  /** 已规范化（含协议、无尾斜杠）——`normalizeEndpoint` 的产物 */
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * 存储配置的 Hono context 变量键。带 `platform.` 前缀避撞（照 DECLARED_GATE_APPROVED 的既有做法）。
 * 键名是**宿主 set / 模块 get 的约定**，编译器不连线 ⇒ 改名是破坏性变更。
 */
export const TENANT_STORAGE = 'platform.tenantStorage'

/**
 * 模块端口（正典 `docs/module-protocol.md`「模块端口：`createPorts`」，2026-09-21 拍板）：
 * 有些能力宿主**必须在 `runtime.mount` 之前**就拿到（最典型的是 PAT 凭证解析——中间件要在模块
 * 路由之前把 `Bearer dkq_…` 解析成主体才能注入 `identity`），而这份能力的**数据**在模块自己的
 * schema 里 —— 宿主直接查就是 B1 违规（`scripts/lint-architecture.mjs`，无豁免机制）。
 * 解法是依赖倒置：**宿主声明它需要什么能力，模块供给实现**。宿主侧零 SQL、零模块 schema 引用。
 */
export interface ResolvedPatKey {
  keyId: number
  /** 隔离键：值 = 租户的 Casdoor org（宿主据此判跨租户，与 `TenantRow.casdoor_org` 同基准）。 */
  org: string
  /** 凭证绑定的人（Casdoor name）。**不是**授权结论——权限仍由宿主实时向 Casdoor 取。 */
  casdoorUser: string
}

/**
 * 端口集合。**只暴露宿主确实需要的能力**——端口不是「把模块业务开个后门给宿主」的地方。
 * 加新成员前先回答：宿主为什么**必须**在 `mount` 之前拿到它？
 *
 * ⚠️ 端口**只解析凭证、不施加权限**：`resolvePatKey` 回答「这个 token 是谁」，
 * 不回答「他能不能查」。授权由宿主（Casdoor 实时 scopes）与模块的授权核心各自完成。
 */
export interface ModulePorts {
  /**
   * 把 PAT 明文 token 解析成凭证主体；未命中/已吊销 ⇒ `null`。
   * **哈希与查询都在模块侧**（模块自己的 schema 里合法）；宿主侧没有第二份实现。
   * 明文 token 不得进日志/审计（正典「模块端口」安全性质第 4 条）。
   */
  resolvePatKey?(token: string): Promise<ResolvedPatKey | null>
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
  /**
   * 可选：宿主在 `mount` 前索取的能力（端口）。与 `createRouter` 同形——吃同一个
   * `ModuleContext`。**不声明 = 宿主取不到**（`runtime.port(id, name)` 恒 `undefined`，
   * 宿主据此对该通道 fail-closed）；现有模块不改仍装载通过。
   */
  createPorts?(ctx: ModuleContext): ModulePorts
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

/** 一个被声明的端点（与 manifest.api.internal[] 同形；宿主 loader 传进来） */
export interface DeclaredEndpoint {
  method: string
  path: string
  scope: string
}

/**
 * 门卫放行标记（Hono context 变量键）。`declaredScopeGate` 判定通过后置位，**唯一消费者是
 * 包裹层（`loader.applyDeclaredApiGate`）给通配 ALL 路由挂的兜底门卫**（Task 24 评审 R1）。
 *
 * 为什么需要它：通配 ALL 路由（`use('*')` / `use('/prefix/*')` / `mount()`）匹配的请求路径
 * 集合**大于**任何一条声明路径。逐条声明的门卫只覆盖声明过的那几条，其余（如 `/files/*`
 * 下的 `/files/b`）会直达模块自己的中间件/handler——**匿名可达**。兜底门卫要拒掉这些，
 * 但它自己无法用 `c.req.routePath` 判定（在通配路径上它恒为通配模式本身，见下），只能问
 * 这枚标记："本次请求是不是已经被某条声明的门卫放行了？"
 *
 * 键名带 `platform.` 前缀，避免与模块自有 context 变量撞车。
 */
export const DECLARED_GATE_APPROVED = 'platform.declaredGateApproved'

/**
 * 模块 API 门卫：**按声明授权**。
 *
 * 为什么不是模块手写 requireScope（M1 闭债 R2）：漏写一次就是**匿名可读**，且不报错、不告警、
 * CI 不红——一种纯靠人记得的契约。改由 host 按 manifest 施加后，"忘挂"这件事在结构上不可能
 * 发生（没有可挂的东西）。
 *
 * 挂载方式决定了它能不能生效（已实证，勿踩）：
 *   - 必须 `app.use(声明路径, gate)` **先于** handler 注册，否则门卫永不执行；
 *   - `use('*', gate)` 里 c.req.routePath 恒为 '/*'，**拿不到**下游 handler 的路径。
 * 故宿主用"包裹层"：新建 Hono → 先挂门卫 → 再 route('/', 模块 router)（loader.applyDeclaredApiGate）。
 *
 * 比对基准是 `c.req.routePath`，而**包裹层一旦被宿主 mount 到前缀下，routePath 就是绝对路径**
 * （实测：`route('/api/modules/mod', wrapper)` 下为 '/api/modules/mod/ping'）。故传进来的
 * `declared[].path` 必须与 routePath **同基准**：宿主装载器因此传宿主绝对路径，本文件自己的
 * 用例（未挂载）传模块相对路径。两处混用 ⇒ 门卫恒 403。
 *
 * 错误体与 requireScope 逐字一致（模块与前端无需感知差异）。
 */
export function declaredScopeGate(
  declared: ReadonlyArray<DeclaredEndpoint>,
): MiddlewareHandler {
  return async (c, next) => {
    const identity = c.get('identity') as Identity | undefined
    if (!identity) {
      return c.json({ error: 'UNAUTHENTICATED' }, 401)
    }
    // Hono 把 HEAD 按 GET 派发，但 `c.req.method` 仍是 'HEAD'。声明表里只会有 GET（没人声明 HEAD），
    // 不归一就会命中 !hit ⇒ 已声明的 GET 端点在 HEAD 下**恒 403**（issue #7：资源存在却说没有）。
    // 只归一 HEAD→GET，且仍要求该路径上存在**已声明的 GET**——未声明的路径照样 fail-closed，
    // 所以这不是“放行一切 HEAD”。
    const method = c.req.method === 'HEAD' ? 'GET' : c.req.method
    const hit = declared.find((d) => d.path === c.req.routePath && d.method === method)
    if (!hit) {
      // 未声明即不可达（fail-closed）。装载期双向核对已保证每个注册路由都被声明过，
      // 所以这条只会在"声明路径下的未声明 method"（如声明 GET 而请求 POST）时命中。
      return c.json({ error: 'FORBIDDEN' }, 403)
    }
    if (!identity.hasScope(hit.scope)) {
      return c.json({ error: 'FORBIDDEN', need: hit.scope }, 403)
    }
    // 放行即置标记：包裹层的兜底门卫据此区分"已被声明门卫放行"与"谁都没放行"
    // （见 DECLARED_GATE_APPROVED 的说明）。置标记不是授权本身，授权是上面那两行判定。
    c.set(DECLARED_GATE_APPROVED, true)
    await next()
  }
}
