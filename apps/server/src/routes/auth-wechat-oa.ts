// routes/auth-wechat-oa.ts — 公众号访客登录路（售后 spec §1.3）：外部客户，openid 即身份。
//
// 与企微路（auth-wecom.ts）的本质差异：**不落 Casdoor 账号**——openid 直接签访客 session
// （sub=openid、scopes=已启用模块的 guest 码，runtime.enabledGuestScopes 按回调租户收集），
// 业务资格由模块按绑定/审批状态判定（fail-closed 在模块侧，访客码只开「访客可进的门」）。
// 启用判定 = 租户行公众号配置存在（wechat_oa_app_id/secret，005 迁移；**非** login_methods，
// **非** console 登录 tab——公众号是面向外部客户的独立入口，不与内部登录方式混列）。
//
// 两路：/silent = 微信内浏览器（MicroMessenger UA）整页跳 open.weixin.qq.com 静默授权
// （snsapi_base，用户无感拿 openid）；非微信 UA（桌面误触）降级 302 /login。
// /callback = code 换 openid → 访客 session。**无 iframe 分支**（对比 auth-wecom 的 sso-done/
// sso-fail postMessage）——外部客户 H5 不经 console 登录页，回调恒为顶层导航，失败一律
// 302 /login?error=<CODE>。错误码集合：WECHAT_OA_NOT_CONFIGURED / BAD_STATE / BAD_CODE /
// WECHAT_UNAVAILABLE / TOO_MANY_REQUESTS。
//
// state 责任同企微路（Task 7 契约）：/silent 发随机 state（randomUUID）+ HttpOnly cookie
// wechat_oa_state（Max-Age=300, SameSite=Lax）绑定，回调校验一致（CSRF/混流）。静默流是
// 顶层导航，Lax 天然携带。
//
// code 换身份的失败两分（wechatOaOpenidForCode 契约，auth-core/wechat-oa.ts）：微信 API 的
// 特殊错误形状是 **HTTP 200 + body errcode**——errcode≠0 或无 openid 归「被拒」返 null
// （BAD_CODE，用户可感知的内容物失败，写 audit login.fail）；网络错/5xx/非 JSON 归传输层
// throw（WECHAT_UNAVAILABLE，非用户过错，不写 login.fail——与企微路同口径，不吞成 BAD_CODE）。
//
// 限速口径逐字照 auth-wecom.ts（M1 闭债 R2）：check 只读且**早于任何 writeAudit**；除「被限速
// 本身」外**每一条**失败路径都必须 record（漏一条 = 该路永不 429 且照常出站）；门键
// 'wechat-oa' 独立桶（与账密/企微门互不牵连）；record 只动计数、不写 audit。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import { buildWechatOaSilentUrl, signSession, wechatOaOpenidForCode } from '@platform/auth-core'
import type { TenantEnv } from '../tenant'
import { serializeSessionCookie, type SessionEnv } from '../session-middleware'
import { warnRateLimitDeny, type LoginLimiter } from '../rate-limit'

const CALLBACK_PATH = '/api/platform/auth/wechat-oa/callback'
const STATE_COOKIE = 'wechat_oa_state'
const STATE_TTL_SEC = 300

/**
 * code 被拒时 audit 行的 actor 占位（BAD_CODE 分支）：此刻拿不到 openid（code 被上游拒绝，
 * 无可信身份可写），但本路要留内容物失败的 audit 证据——访客路没有企微路的 NO_ACCOUNT/JIT
 * 后续分支，no-openid 是它唯一的内容物失败，不留行则该类失败零痕迹。占位串与真实 openid
 *（约定 o 开头）无碰撞面；按 (tenant, actor) 检索即可定位本路失败。导出供测试同源断言。
 */
export const OA_ANON_ACTOR = 'wechat-oa-anon'

export interface WechatOaRoutesDeps {
  sessionSecret: string
  pool: Pool
  /**
   * 登录限速器：与账密/企微路共用同一实例（app.ts 同一 limiter 传三处）、**独立的桶键**
   * 'wechat-oa'——灌访客回调不得锁死同租户另两扇门（拆桶口径见 rate-limit.ts 的 Door）。
   */
  limiter: LoginLimiter
  /** 对外可见源（回调 redirect_uri 前缀；与宿主 PUBLIC_ORIGIN 同源配置） */
  publicOrigin: string
  /** 该租户已启用模块声明的访客码（loader runtime.enabledGuestScopes；测试注入 stub） */
  enabledGuestScopes: (tenantId: number) => Promise<string[]>
  /** 微信 snsapi_base 端点 fetch 注入口（默认 globalThis.fetch；测试注入假微信 API） */
  wechatFetch?: typeof globalThis.fetch
}

/** 登录审计一行（与 auth.ts / auth-wecom.ts writeAudit 同款 SQL；失败也 await——审计写不进去就不该继续发会话） */
async function writeAudit(
  pool: Pool,
  tenantId: number,
  actor: string,
  action: 'login.ok' | 'login.fail',
  detail: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    'insert into platform.audit(tenant_id, actor, action, detail) values ($1, $2, $3, $4)',
    [tenantId, actor, action, detail],
  )
}

/** state cookie 序列化（Task 7 契约逐字：HttpOnly + Max-Age=300 + SameSite=Lax；host-only 无 Domain。短命单用途 nonce 非长期凭据） */
function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_TTL_SEC}; HttpOnly; SameSite=Lax`
}

/** 从 Cookie 头读 wechat_oa_state（手写解析，与 session-middleware readCookie 同语义） */
function readStateCookie(header: string | undefined): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === STATE_COOKIE) return part.slice(eq + 1).trim()
  }
  return null
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

export function wechatOaRoutes(deps: WechatOaRoutesDeps): Hono<TenantEnv & SessionEnv> {
  const app = new Hono<TenantEnv & SessionEnv>()
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH

  // GET /silent — 微信内浏览器整页静默授权（snsapi_base：用户无感，只拿 openid 不拿资料）
  app.get('/silent', (c) => {
    // 消费者公众号 H5 的 UA 标记是 MicroMessenger（带 wxwork 的是企微内部浏览器，归企微路）
    const ua = c.req.header('user-agent') ?? ''
    if (!ua.toLowerCase().includes('micromessenger')) return c.redirect('/login')
    const t = c.get('tenant')
    // 配置存在即启用（非 login_methods）：两列缺一即 404——secret 缺了只会在回调里才炸，
    // 不如在这里就 404，让入口页能直接感知「该租户没开公众号通道」
    if (!t.wechat_oa_app_id || !t.wechat_oa_secret) {
      return c.json({ error: 'WECHAT_OA_NOT_CONFIGURED' }, 404)
    }
    const state = randomUUID()
    const url = buildWechatOaSilentUrl(t.wechat_oa_app_id, callbackUri, state)
    c.res.headers.append('Set-Cookie', stateCookie(state))
    return c.redirect(url)
  })

  // GET /callback?code&state — 换 openid → 访客 session
  app.get('/callback', async (c) => {
    const t = c.get('tenant')
    const state = c.req.query('state') ?? ''
    const code = c.req.query('code') ?? ''
    // 失败呈现：顶层导航路——外部客户 H5 不经 console 登录页（无 iframe 分支，对比 auth-wecom
    // 的 sso-fail postMessage），恒 302 回登录页按码展示
    const fail = (err: string) => c.redirect(`/login?error=${encodeURIComponent(err)}`)

    // 限速：check 只读、必须早于任何 writeAudit；deny 只能由既有计数触发 ⇒ 下面**每一条**
    // 失败路径都必须 record（漏一条 = 该路流量完全不进计数 ⇒ 永不 429，而它每次都在向微信
    // 发出站调用——口径详见 auth-wecom.ts 同位注释）。只判租户维度：openid 在 code 换票前
    // 拿不到（同企微路 spec §3.2 的已知口径落差）。429 与其它失败同走 fail（302 回登录页
    // 按码展示，不是 JSON 死胡同）；Retry-After 信号照带，warnRateLimitDeny 告警照旧。
    const decision = deps.limiter.check(t.id, 'wechat-oa', null)
    if (!decision.allowed) {
      warnRateLimitDeny(t.id, decision)
      const res = fail('TOO_MANY_REQUESTS')
      res.headers.set('Retry-After', String(decision.retryAfterSec ?? 60))
      return res
    }

    if (!code || !state || readStateCookie(c.req.header('cookie')) !== state) {
      // 计数：BAD_STATE 也是一次失败的登录尝试（连 /silent 都不需要——随便带个 state 循环
      // 打即可）。不写 audit：actor 此刻不存在，且被拒请求不灌审计表是既有语义（评审 R1）
      deps.limiter.record(t.id, 'wechat-oa', null, false)
      return fail('BAD_STATE')
    }

    if (!t.wechat_oa_app_id || !t.wechat_oa_secret) {
      // 计数：/silent 种 state 后配置被撤（管理员清掉两列）的半途态。口径统一——除「被限速
      // 本身」外每个失败出口都 record（同企微路同位分支）
      deps.limiter.record(t.id, 'wechat-oa', null, false)
      return fail('WECHAT_OA_NOT_CONFIGURED')
    }

    let openid: string | null
    try {
      openid = await wechatOaOpenidForCode(
        { appId: t.wechat_oa_app_id, secret: t.wechat_oa_secret },
        code,
        deps.wechatFetch ?? globalThis.fetch,
      )
    } catch {
      // 传输层故障（微信 5xx/网络错/非 JSON——auth-core wechat-oa.ts 的 throw 契约）≠ 坏
      // code：WECHAT_UNAVAILABLE 如实呈现，不吞成 BAD_CODE；不写 login.fail（非用户过错）。
      // record 照记：这条 catch 每次都在向微信发一次出站调用，不计数 = 上游一出问题刹车就失效
      deps.limiter.record(t.id, 'wechat-oa', null, false)
      return fail('WECHAT_UNAVAILABLE')
    }
    if (openid === null) {
      // code 被微信拒绝（无效/过期/已兑换——200+errcode 形状）：本路唯一的内容物失败，留
      // audit 证据（actor 占位见 OA_ANON_ACTOR 注释——此刻无 openid 可写）；record 照记
      //（本路的主打路径：有效 state + 垃圾 code 循环打，每次都出站换票）
      await writeAudit(deps.pool, t.id, OA_ANON_ACTOR, 'login.fail', {
        via: 'wechat-oa',
        reason: 'no-openid',
      })
      deps.limiter.record(t.id, 'wechat-oa', null, false)
      return fail('BAD_CODE')
    }

    // 访客 session：scopes = 该租户已启用模块的 guest 码（manifest guest.scope，经
    // runtime.enabledGuestScopes 收集）。刻意不 try/catch：取不到 scopes 就发不出有效访客
    // 会话——此处 DB 故障一律 500 裸露且未发任何 cookie（与「审计先行」同一 fail-loudly
    // 姿态），绝不静默发一个空 scopes 的访客会话（那等于把 fail-closed 偷换成 fail-open）
    const scopes = await deps.enabledGuestScopes(t.id)

    const now = Math.floor(Date.now() / 1000)
    const token = await signSession(
      { sub: openid, org: t.casdoor_org, name: openid, scopes, authVia: 'wechat-oa' },
      deps.sessionSecret,
      now,
    )
    // 审计先行（M-4，与 auth.ts / auth-wecom.ts 同序）：插入抛错 → 500 且未发任何会话 cookie
    await writeAudit(deps.pool, t.id, openid, 'login.ok', { via: 'wechat-oa' })
    deps.limiter.record(t.id, 'wechat-oa', null, true)
    c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
    return c.redirect('/')
  })

  return app
}
