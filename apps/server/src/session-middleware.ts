// session-middleware.ts — platform_session cookie → Identity 注入 + 滑动续期/scopes 刷新重签
//
// 职责边界（跨任务契约）：
//  - Task 6：verifySession 仅验签不判过期——过期自检（p.exp <= now）在本中间件；
//  - Task 9：Identity.hasScope 必须实现为 scopes.includes（锁定语义，防漂移）；
//  - 时间类决策（续期/刷新）消费 auth-core 的 needsRenew/needsScopeRefresh 判定结果。
//
// 重签策略：needsScopeRefresh（now-sfa>=300）或 needsRenew（exp-now<6天）任一命中即重签一次
// （signSession 以注入的同一 now 签发，iat/exp/sfa 三值与本地构造的载荷严格一致，csrf 可复算）；
// scopes 值只在 scope 刷新命中时重算：普通会话向 Casdoor（getUser+getPermissions+
// effectiveScopes）；访客会话（authVia='wechat-oa'，审查 I1）不查 Casdoor（openid 在那没有
// 账户，查了必清会话），改用注入的 guestScopes 按当前租户已启用模块重算——见实现处注释。
//
// 可用性优先：Casdoor 拉取失败（网络/5xx → CasdoorClient 抛错）→ 降级用旧 scopes 继续本次
// 请求且【不重签】（重签会把 sfa 抹成 now，遮蔽故障 5 分钟）；仅 Casdoor 明确返回"用户不存在"
// （getUser resolve 为 null，区别于抛错）时清会话 cookie。
//
// 验签失败/过期/租户 org 不符 → 不注 identity/session，照常放行（公开路由可达），
// 鉴权交给 requireScope（@platform/sdk）。
import type { MiddlewareHandler } from 'hono'
import { createMiddleware } from 'hono/factory'
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  effectiveScopes,
  needsRenew,
  needsScopeRefresh,
  signSession,
  verifySession,
  type CasdoorClient,
  type SessionPayload,
} from '@platform/auth-core'
import type { Identity } from '@platform/sdk'
import type { TenantEnv } from './tenant'

/** 本中间件向 Hono context 注入的变量（与 TenantEnv 交并由宿主/路由组合） */
export interface SessionEnv {
  Variables: {
    identity: Identity
    session: SessionPayload
  }
}

/**
 * CasdoorClient 工厂：org 随租户变（multi 模式各租户各自 org），中间件与 auth 路由共用
 * 同一形状。构造函数轻量（仅存配置），按 org 换实例零成本；admin 会话缓存在实例内——
 * 需要跨请求复用 admin 会话的宿主应返回按 org 缓存的实例（Task 16 装配时定）。
 */
export type CasdoorFactory = (org: string) => CasdoorClient

export interface SessionMiddlewareDeps {
  casdoor: CasdoorFactory
  sessionSecret: string
  /**
   * 访客 session（authVia='wechat-oa'）的 guest 码解析器（loader runtime.enabledGuestScopes，
   * 由 app.ts 注入）。访客 session 的 scopes 刷新**不查 Casdoor**——openid 在 Casdoor 没有
   * 账户，getUser 必返 null ⇒ 走通用分支必命中「用户不存在 → 清会话」，7 天 TTL 的访客
   * session 实际活不过一个 SCOPES_TTL_SEC（审查 I1）。改由本解析器按【当前租户已启用
   * 模块】重算——「停用模块即掉码」语义因此在 session 层延续。未注入时（无 loader 的
   * 装配/部分测试）：沿用旧 scopes、不重签——任何情况下访客路都不查 Casdoor、不清会话。
   */
  guestScopes?: (tenantId: number) => Promise<string[]>
  /**
   * 降级 warn 的去重窗口（ms）：同一 org 在该窗口内最多留一条 warn。默认
   * DEGRADE_WARN_INTERVAL_MS。闸的是**窗口**、不是"只报一次"的闩——两条断言分工钉死：
   * interval=0 证"不是闩"（每次降级各一条），小正数窗口 + 真的等过窗口证"窗口会随时间
   * 重开"（auth.test.ts ㉕/㉖；只留前者的话，按次数计的闩照样全绿，评审 S2）。
   */
  degradeWarnIntervalMs?: number
  /**
   * 注入时钟（ms，默认 `Date.now`）。**只**供降级 warn 的去重窗口取值（`warnDegrade`），
   * 不参与验签/过期/续期任何时间决策——测试用它手动推进窗口，去掉真实墙钟等待（`setTimeout`）。
   * 缺省路径与改动前逐值一致，无行为变更。先例：`createLoginLimiter({ now })`（rate-limit.ts）。
   */
  now?: () => number
}

/**
 * 降级 warn 的去重窗口（默认 60s）。
 *
 * 取值理由：这条 warn 在故障期**每请求**都会命中——每一个带过期 sfa 的会话刷新请求都走
 * 降级分支。不设窗口，它自己就成了新的无界日志增长点。60s 足够让运维在日志里看见
 * "这个 org 正在降级"并形成告警面（同窗口内**首条即含全部定位信息**：org + 原因），
 * 又不至于让单租户故障刷满日志。
 */
export const DEGRADE_WARN_INTERVAL_MS = 60_000

/** 手写 cookie 序列化（不引 cookie 库）：host-only（不设 Domain）+ 安全属性全开 */
export function serializeSessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`
}

/** 清除会话 cookie：与签发同属性、Max-Age=0（属性不一致会导致部分浏览器拒清） */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}

/** 从 Cookie 头读命名值（手写：split ';'/trim，无解码语义——JWT 本身无需解码） */
function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim()
  }
  return null
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

/** SessionPayload → Identity（Task 9 契约：hasScope ≡ scopes.includes） */
function toIdentity(p: SessionPayload): Identity {
  return {
    userId: p.sub,
    orgId: p.org,
    displayName: p.name,
    scopes: p.scopes,
    hasScope: (code: string) => p.scopes.includes(code),
  }
}

export const sessionMiddleware = (
  deps: SessionMiddlewareDeps,
): MiddlewareHandler<TenantEnv & SessionEnv> => {
  const degradeWarnIntervalMs = deps.degradeWarnIntervalMs ?? DEGRADE_WARN_INTERVAL_MS
  /** 上次为某 org 打降级 warn 的时刻（中间件实例内）；见 DEGRADE_WARN_INTERVAL_MS 的取值理由 */
  const lastDegradeWarnAt = new Map<string, number>()

  /**
   * 降级路径的信号（M1 闭债 R3 评审 S2）。修好「静默登出」后，"admin 会话死掉"不再表现为
   * 登出，而是**每请求、永久、零信号**地降级用旧 scopes ⇒ 该真问题从此不可观测。这里补上
   * 唯一信号：说清后果（持续降级 = 授权变更不再生效），并按 org 限流（见上）。
   * source 标明降级的是哪个上游（默认 Casdoor；访客路的 guestScopes 解析器另传）。
   */
  const warnDegrade = (org: string, err: unknown, source = 'Casdoor'): void => {
    // 注入时钟（deps.now）**只**在这里取——窗口限流专用；验签/过期/续期一律走真实 nowSec()
    const nowMs = deps.now ? deps.now() : Date.now()
    if (nowMs - (lastDegradeWarnAt.get(org) ?? 0) < degradeWarnIntervalMs) return
    lastDegradeWarnAt.set(org, nowMs)
    console.warn(
      `[session] ${source} 拉取失败（org=${org}），本次请求降级用旧 scopes 继续、不重签：`
        + '若原因是 admin 会话已失效，该 org 的 scopes 刷新会**持续**降级'
        + '（对应上游的授权变更不再生效），而这条 warn 是唯一信号。'
        + `原因：${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return createMiddleware<TenantEnv & SessionEnv>(async (c, next) => {
    const now = nowSec()
    const token = readCookie(c.req.header('cookie'), SESSION_COOKIE)
    const p = token ? await verifySession(token, deps.sessionSecret) : null
    const tenant = c.get('tenant')

    // 三道门：验签通过 && 未过期（Task 6 契约的自检位）&& 会话 org 与当前租户一致
    // （host-only cookie 天然防跨域；org 不符只可能在异常部署形态下出现，不认即可）
    if (p && p.exp > now && p.org === tenant.casdoor_org) {
      const wantRefresh = needsScopeRefresh(p, now)
      const wantRenew = needsRenew(p, now)
      let scopes = p.scopes
      let refreshOk = false
      let userGone = false
      if (wantRefresh) {
        if (p.authVia === 'wechat-oa') {
          // 访客 session（售后 spec §1.3，审查 I1）：openid 在 Casdoor **没有账户**——走下方
          // 通用分支必命中「getUser=null → userGone 清会话」，7 天 TTL 的访客 session 实际
          // 活不过一个 SCOPES_TTL_SEC（5 分钟）。访客路的 scopes 真源是「当前租户已启用
          // 模块的 guest 码」：注入了 guestScopes（app.ts 从 loader runtime 接）就重算重签
          // ——「停用模块即掉码」语义因此在 session 层延续；解析器故障降级旧 scopes、不
          // 重签（可用性优先，同下方 Casdoor 分支口径）；未注入（无 loader 的装配/旧测试）
          // 沿用旧 scopes。任何情况下**不查 Casdoor、不清会话**——访客登出靠 TTL/主动登出，
          // 不靠 Casdoor 的用户表
          if (deps.guestScopes) {
            try {
              scopes = await deps.guestScopes(tenant.id)
              refreshOk = true
            } catch (err) {
              warnDegrade(p.org, err, '访客码解析器（guestScopes）')
            }
          }
        } else {
          try {
            const casdoor = deps.casdoor(p.org)
            const user = await casdoor.getUser(p.name)
            if (user === null) {
              // Casdoor 明确说没这个人（2xx + body status:'ok' 且 data:null）→ 唯一清会话分支。
              // **不是** status:error —— error 覆盖的是与"不存在"无关的一堆情形（admin 会话失效、
              // id 非两段、DB 出错…），CasdoorClient.getUser 对它们一律抛错（上方 catch 接住降级）
              userGone = true
            } else {
              const perms = await casdoor.getPermissions()
              scopes = effectiveScopes(p.name, user.roles ?? [], perms)
              refreshOk = true
            }
          } catch (err) {
            // 网络/5xx/上游报错：降级旧 scopes 继续（可用性优先），本次不重签（防 sfa 被抹新遮蔽故障）。
            // 降级不是"无声"的——见 warnDegrade 的注释（评审 S2）
            warnDegrade(p.org, err)
          }
        }
      }
      if (userGone) {
        c.res.headers.append('Set-Cookie', clearSessionCookie())
      } else if (refreshOk || wantRenew) {
        // 任一命中重签一次：signSession 用同一 now → iat/exp/sfa 与本地载荷逐值一致
        const fresh: SessionPayload = {
          ...p,
          scopes,
          iat: now,
          exp: now + SESSION_TTL_SEC,
          sfa: now,
        }
        const reissued = await signSession(fresh, deps.sessionSecret, now)
        c.res.headers.append('Set-Cookie', serializeSessionCookie(reissued))
        c.set('session', fresh)
        c.set('identity', toIdentity(fresh))
      } else {
        // 刷新未命中 / 命中但 Casdoor 故障降级 → 沿用原会话原 cookie
        c.set('session', p)
        c.set('identity', toIdentity(p))
      }
    }
    await next()
  })
}
