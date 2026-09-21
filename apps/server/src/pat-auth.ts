// pat-auth.ts — 通道 B（系统外个人 Key）的鉴权中间件。
//
// ⚠️ 本文件**不得** import modules/data/**（宿主静态依赖模块 = 架构违规，且打掉 worktree 并行）。
//    ⚠️ 也**不得**引用模块 schema（B1 三同纪律）：原稿让这里自带查询 SQL，实测被
//    `scripts/lint-architecture.mjs` 报 2 处 B1 违规（gates job，PR 事件也跑）。凭证解析改走
//    **模块端口**（正典 docs/module-protocol.md「模块端口：createPorts」）：deps.resolveKey
//    由 modules/data 经 `runtime.port('data', 'resolvePatKey')` 供给。
//    ⇒ 本文件里**没有 SQL、没有哈希、没有 Pool**。哈希与查询留在模块侧那一份实现里——
//    于是“两侧逐字一致”这份人工约定整个消失了（能消失的漂移面就让它消失）。
//
// 与 sessionMiddleware 的**刻意差别**：PAT 没有「缓存的旧 scopes」可降级——权限必须实时向
// Casdoor 取。所以 Casdoor 故障时这里 **fail-closed 503**，而不是像会话那样降级继续
// （会话降级的是"本次请求的授权新鲜度"，PAT 降级就等于**没有授权**）。
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import { effectiveScopes } from '@platform/auth-core'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity, RequesterVars, ResolvedPatKey } from '@platform/sdk'
import type { CasdoorFactory, SessionEnv } from './session-middleware'
import type { TenantEnv } from './tenant'

/**
 * PAT 明文前缀。**与 modules/data 的 key-store 同值，且仍各写一份**——前缀是**协议**
 * （宿主靠它认出「这条请求该由本中间件处理」，模块靠它校验自己签发的形状），不是可以
 * 单向删掉的实现重复；**哈希**才是那份该消失的重复（见文件头注释）。
 */
export const PAT_PREFIX = 'dkq_'
const DEFAULT_RATE_PER_MIN = 60
const WINDOW_MS = 60_000

/**
 * 宿主侧两个请求者中间件共用的 Env。定义在本文件、`wecom-channel-auth.ts` 引类型复用——
 * **只写一处求交**，两处各写一份必然会写歪（一处漏 SessionEnv，`c.get('session')` 就没了）。
 */
export type RequesterEnv = TenantEnv & SessionEnv & { Variables: RequesterVars }

export interface PatAuthDeps {
  casdoor: CasdoorFactory
  /** 由 modules/data 供给（`runtime.port('data', 'resolvePatKey')`）。**缺失 ⇒ 通道 B fail-closed（503）**。 */
  resolveKey?: (token: string) => Promise<ResolvedPatKey | null>
  ratePerMin?: number
  /** 注入时钟（ms），仅供限速窗口取值。 */
  now?: () => number
}

export function patIdentityMiddleware(deps: PatAuthDeps): MiddlewareHandler<RequesterEnv> {
  const ratePerMin = deps.ratePerMin ?? DEFAULT_RATE_PER_MIN
  const now = deps.now ?? (() => Date.now())
  /** keyId → 本窗口起点。固定窗口足够（限速的目标是防 agent 循环，不是精确令牌桶）。 */
  const windows = new Map<number, { start: number; count: number }>()

  // 返回类型注解**与** createMiddleware 的泛型都不可省：只写注解，上下文类型不会反向流进
  // 回调，`c` 仍是 `Context<BlankEnv>`，`c.set('identity', …)` 报「不能赋给 never」。
  return createMiddleware<RequesterEnv>(async (c, next) => {
    // first-setter-wins：会话已解析过 → 本请求是系统内通道，PAT 不参与
    if (c.get('identity')) return next()

    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith(`Bearer ${PAT_PREFIX}`) ? header.slice('Bearer '.length).trim() : null
    // 不是 PAT 的地盘（没带 / 带了别的 Bearer）→ 放行，鉴权交给下游门卫（fail-closed 在那边）
    if (!token) return next()

    // 端口缺失 = 这个部署没装配通道 B（modules/data 未声明 createPorts）。**fail-closed 503**：
    // 调用方带了 PAT 形状的凭证，却无人能把它解析成主体 —— 放行等于让这枚凭证被当成匿名处理，
    // 「我拿着合法凭证」与「我其实是匿名的」之间的落差由调用方承担。正典「模块端口」安全性质
    // 第 3 条明确：这种放行**不要**照抄企微/访客码（那两者放行是因为“没开这个能力时，请求本来
    // 就不该由它处理”；PAT 形状的请求恰恰**就是**它该处理的）。
    if (!deps.resolveKey) return c.json({ error: 'PAT_UNAVAILABLE' }, 503)

    let key: ResolvedPatKey | null
    try {
      // 端口只解析凭证、不施加权限（正典第 2 条）。明文 token 只进端口，不进日志/审计。
      key = await deps.resolveKey(token)
    } catch {
      // 模块侧解析失败（DB 不可达等）与 Casdoor 故障同为「无法建立授权依据」⇒ 同一处置：
      // 没有凭证主体就没有任何可降级的第二套状态。用同一个码是因为**调用方的动作相同**
      // （稍后重试 / 找管理员），差异（解析器挂了 vs Casdoor 挂了）属运维面，不该漏给调用方。
      return c.json({ error: 'PAT_UNAVAILABLE' }, 503)
    }
    // 未命中 / 已吊销 ⇒ 无效凭证（与跨租户同码：不泄露「这枚 token 存在但不属于你」）
    if (key === null) return c.json({ error: 'INVALID_KEY' }, 401)

    const tenant = c.get('tenant')
    // 跨租户的 key 一律无效（域名解析出的租户与 key 的租户必须一致）
    // 隔离键是 org（text，值 = 租户的 Casdoor org）——别再按数字比：类型都不对了。
    if (key.org !== tenant.casdoor_org) return c.json({ error: 'INVALID_KEY' }, 401)

    // 限速在凭证有效之后：keyId 是限速的桶键，无效凭证走不到这里（否则攻击者可用随机 token
    // 无限占用桶）。`last_used_at` 的触碰归模块侧端口实现——宿主不再碰模块的表。
    const keyId = key.keyId
    const t = now()
    const w = windows.get(keyId)
    if (!w || t - w.start >= WINDOW_MS) windows.set(keyId, { start: t, count: 1 })
    else if (w.count >= ratePerMin) return c.json({ error: 'RATE_LIMITED' }, 429)
    else w.count += 1

    let scopes: string[]
    try {
      const casdoor = deps.casdoor(tenant.casdoor_org)
      const user = await casdoor.getUser(key.casdoorUser)
      if (user === null) return c.json({ error: 'USER_GONE' }, 401)
      const perms = await casdoor.getPermissions()
      scopes = effectiveScopes(key.casdoorUser, user.roles ?? [], perms)
    } catch {
      // 无缓存可降级 ⇒ fail-closed（没有任何第二套权限状态可以拿来用）
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 503)
    }

    const identity: Identity = {
      userId: key.casdoorUser,
      orgId: tenant.casdoor_org,
      displayName: key.casdoorUser,
      scopes,
      hasScope: (code: string) => scopes.includes(code),
    }
    c.set('identity', identity)
    c.set(REQUESTER_CHANNEL, 'pat')
    c.set(REQUESTER_KEY_ID, keyId)

    await next()
  })
}
