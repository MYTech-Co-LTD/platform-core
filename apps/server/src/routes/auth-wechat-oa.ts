// routes/auth-wechat-oa.ts — 公众号访客登录路（售后 spec §1.3）：外部客户，openid 即身份。
//
// 两态分流（账户统一 Task 4）：openid 查 platform.identity_link 的 active 绑定后分两态——
//  · 中间态（无 active 绑定，或绑定悬空/Casdoor 读故障降级）：openid 直接签访客 session
//    （sub=name=openid、scopes=已启用模块的 guest 码，runtime.enabledGuestScopes 按回调租户
//    收集），业务资格由模块按绑定/审批状态判定（fail-closed 在模块侧，访客码只开「访客可进
//    的门」）；降级路径的 audit 带 degraded 标记（悬空/Casdoor 故障的可观测点）。
//  · 正式态（active 绑定且 Casdoor 有户）：签正式 session（sub 仍=openid、name=acct、
//    scopes=Casdoor effectiveScopes、带 acct/ext 绑定集合）。
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
// **入口即授权（issue #560，真机试点后裁定）**：/silent 的语义是「**确保有会话**」而非「跳微信」
// ——**已有有效会话即 302 `next`**（不碰微信、不看 UA、不种 state），无会话才走上面那条静默授权路。
// 于是公众号菜单可直接指向 `/silent?next=<页面>`：SPA **只载一次**（此前要先载一遍去撞 401，
// 那条路的整包 JS 白下载）。SPA 内的 401 → `/silent?next=` 因此退化为**兜底**（cookie 丢失 /
// 会话过期时链路仍闭环）。凭据仍是 HttpOnly 的 platform_session，**不进 localStorage/sessionStorage**
// ——snsapi_base 本就没有用户可见的授权步骤，把凭据搬去前端只是白送一个 XSS 面。
//
// state 责任同企微路（Task 7 契约）：/silent 发随机 state（randomUUID）+ HttpOnly cookie
// wechat_oa_state（Max-Age=300, SameSite=Lax）绑定，回调校验一致（CSRF/混流）。静默流是
// 顶层导航，Lax 天然携带。
//
// **回跳（M3b-2，spec §3.2 未登录节）**：/silent 另收 `?next=<path>`，把它与 state **一同**
// 编进上面那个 cookie 的载荷（`<state>` 或 `<state>.<base64url(next)>`，**不新开 cookie**、
// TTL 与四个属性一字不改）；/callback 成功时 302 到该 next（**不再恒为 `/`**），无 next 时
// 与改动前同形（回 `/`）。为什么必须有：移动端 userApp 在 401 时要跳这里，不回跳的话用户
// 登录成功后被丢在 console 首页、**回不到移动端页**（只能靠再点一次公众号菜单，那不是闭环）。
// next 经 `safeNextPath()` 白名单化后才进 Location——只放行同源相对路径，这是**开放重定向**
// 防护：`next` 完全由 URL 控制，不校验则 `//evil.test` 这类协议相对 URL 会被浏览器当跨源跳走。
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
import {
  buildWechatOaSilentUrl,
  effectiveScopes,
  signSession,
  wechatOaOpenidForCode,
  type CasdoorPermission,
  type CasdoorUser,
} from '@platform/auth-core'
import type { TenantEnv } from '../tenant'
import { serializeSessionCookie, type CasdoorFactory, type SessionEnv } from '../session-middleware'
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
  /**
   * Casdoor 工厂（与 session-middleware 同形状，app.ts 传同一实例）：两态分流按租户 org 取
   * client 查正式态账户/权限。中间态（无 link）不构造实例——构造即意味着要发 getUser。
   */
  casdoor: CasdoorFactory
  /**
   * active 绑定查询（identity-links 读写层，app.ts 绑 pool 注入）：openid → 该外部身份在
   * 本 org 的 active 绑定（任一渠道）。抛错 = DB 故障，与 scopes 取数同姿态 fail-loudly。
   */
  findActiveLink: (org: string, externalId: string) => Promise<{ casdoorName: string } | null>
  /** 某账户在本 org 下全部 active 外部 id（正式态 ext 绑定集合的来源；openid 需调用方去重） */
  listActiveExternalIds: (org: string, casdoorName: string) => Promise<string[]>
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

/**
 * state cookie 序列化（Task 7 契约逐字：HttpOnly + Max-Age=300 + SameSite=Lax；host-only 无 Domain。短命单用途 nonce 非长期凭据）
 *
 * 载荷 = `<state>` 或 `<state>.<base64url(next)>`（M3b-2 回跳）。
 * **不新开 cookie**：一个 state 一个 nonce，`Path`/`Max-Age`/`HttpOnly`/`SameSite` 一字不改——
 * 少一个 cookie 名就少一处将来要一起改的属性面。base64url（不是 base64）：`+` `/` `=` 在
 * cookie 值里都要再编码一次，base64url 三个全避开。
 */
function stateCookie(state: string, next: string): string {
  const payload = next === '/' ? state : `${state}.${Buffer.from(next, 'utf8').toString('base64url')}`
  return `${STATE_COOKIE}=${payload}; Path=/; Max-Age=${STATE_TTL_SEC}; HttpOnly; SameSite=Lax`
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

/**
 * 回跳目标白名单化（spec §3.2 未登录节）：**只放行同源相对路径**，其余一律回落 `/`。
 *
 * `next` 完全由 URL 控制 ⇒ 不校验就是一个**开放重定向**：攻击者构造
 * `/silent?next=https://evil.test` 就能把刚完成微信授权的用户送去任意站点，
 * 而且是从**我们自己的可信域名**出发的跳转（钓鱼场景里这是最值钱的一种）。
 *
 * 判据只有一条「单个 `/` 开头」是不够的：`//evil.test` 是**协议相对 URL**，浏览器按跨源处理；
 * `/\evil.test` 在部分浏览器里同样被当作跨源。两者都必须在 `startsWith('/')` 之后单独挡掉。
 * 控制字符一并拒——这个值最终进 `Location` 头，CR/LF 是头注入面。
 */
export function safeNextPath(raw: string | undefined): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  // eslint 之外的理由：`\x00-\x1f` 与 `\x7f` 在 Location 头里没有合法位置
  for (const ch of raw) if (ch < ' ' || ch === '\x7f') return '/'
  return raw
}

/**
 * cookie 载荷 → `{state, next}`。**state 段照比，next 段只做白名单化**。
 * 坏 base64 不抛（`Buffer.from` 对非法输入是宽容的）——解出来是垃圾字符，`safeNextPath`
 * 自会把它挡成 `/`，所以这里不需要 try/catch。
 */
function splitStateCookie(payload: string | null): { state: string; next: string } {
  if (payload === null) return { state: '', next: '/' }
  const dot = payload.indexOf('.')
  if (dot < 0) return { state: payload, next: '/' }
  const decoded = Buffer.from(payload.slice(dot + 1), 'base64url').toString('utf8')
  return { state: payload.slice(0, dot), next: safeNextPath(decoded) }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, '')
}

export function wechatOaRoutes(deps: WechatOaRoutesDeps) {
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH

  // GET /silent — 微信内浏览器整页静默授权（snsapi_base：用户无感，只拿 openid 不拿资料）
  return new Hono<TenantEnv & SessionEnv>()
    .get('/silent', (c) => {
      const next = safeNextPath(c.req.query('next'))

      // 会话短路（入口即授权，issue #560）：本端点的语义是「**确保有会话**」，不是「跳微信」。
      // 已有有效会话 ⇒ 直接去 next——不碰微信、不看 UA、不种 state cookie，省掉一次微信往返。
      // 有效性（验签 / 过期 / 租户 org 相符）已由 sessionMiddleware 判完，这里只读它的结果；
      // 过期或缺 cookie 时中间件不注 identity ⇒ 照常落到下面去拿会话（静默授权可自愈）。
      // 因此下面两道门（UA、公众号配置）退化为**授权路的前置条件**：它们只挡「需要去微信」的情形，
      // 不该再挡「已经有会话、只想进页面」的人（桌面 UA 带着会话进来也应放行）。
      if (c.get('identity')) return c.redirect(next)

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
      c.res.headers.append('Set-Cookie', stateCookie(state, next))
      return c.redirect(url)
    })

    // GET /callback?code&state — 换 openid → 访客 session
    .get('/callback', async (c) => {
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

      const baked = splitStateCookie(readStateCookie(c.req.header('cookie')))
      if (!code || !state || baked.state !== state) {
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

      // ── 两态分流（账户统一 Task 4；四处语义即实现处）────────────────────────────
      // ① findActiveLink 抛错（DB 故障）⇒ 500 裸露、未发任何 cookie（与下方 scopes 取数
      //    同姿态 fail-loudly）——刻意不 try/catch；
      // ② active link 且 getUser 正常 ⇒ 正式态：sub 仍 = openid（设计稿 §3.1 修订：sub 不
      //    迁移、账户身份走 acct 字段），name=acct、scopes=Casdoor effectiveScopes（与 session
      //    中间件重签同源的 auth-core 唯一权威实现）、ext=本 openid + 其余 active 绑定；
      // ③ link 存在但 getUser 返 null（悬空）或抛错（Casdoor 不可达）⇒ 降级中间态照常发
      //    会话 + audit degraded 标记——登录路不因上游读故障阻塞（设计稿 §3.3：写操作才
      //    fail-loudly）；悬空标记让「link 指向已删账户」的数据漂移有观测点；
      // ④ 无 active link ⇒ 中间态，下方现状代码一字不改（本任务红线）。
      //
      // try 边界只圈 **Casdoor 读**（getUser/getPermissions）：这两者抛错 = 上游读故障，降级
      // 不阻塞登录。DB 读写（listActiveExternalIds / writeAudit）与签发全部在 try **外**——
      // 它们若被吞进降级，①的 fail-loudly 姿态与「审计先行：审计写不进去就不该发会话」
      //（M-4）都会被静默破坏。
      const active = await deps.findActiveLink(t.casdoor_org, openid)
      if (active !== null) {
        const casdoor = deps.casdoor(t.casdoor_org)
        // getUser=null 是「明确说没这个人」（真机 200+ok+data:null）→ 悬空；抛错 → 不可达。
        // 两分判据与 casdoor-client 的 ok/error 契约同源；perms 只在正式态取（降级路不发
        // 无谓出站调用）
        let degraded: 'dangling' | 'casdoor-down' | null = null
        let user: CasdoorUser | null = null
        let perms: CasdoorPermission[] = []
        try {
          user = await casdoor.getUser(active.casdoorName)
          if (user !== null) perms = await casdoor.getPermissions()
        } catch {
          degraded = 'casdoor-down'
        }
        if (user !== null && degraded === null) {
          // ② 正式态：ext = 本 openid + 账户其余 active 绑定（wecom 等）。openid 本身也在
          //    link 表里，listActiveExternalIds 会把它再吐一遍——拼接时去重，恰好一次
          const acct = active.casdoorName
          const others = await deps.listActiveExternalIds(t.casdoor_org, acct)
          const ext = [openid, ...others.filter((id) => id !== openid)]
          const now = Math.floor(Date.now() / 1000)
          const token = await signSession(
            {
              sub: openid,
              org: t.casdoor_org,
              name: acct,
              scopes: effectiveScopes(acct, user.roles ?? [], perms),
              authVia: 'wechat-oa',
              acct,
              ext,
            },
            deps.sessionSecret,
            now,
          )
          // 审计先行（M-4 同序）：actor 仍 openid——升级前后同一个审计键可检索；detail 带
          // acct 标明本次签的是正式态
          await writeAudit(deps.pool, t.id, openid, 'login.ok', {
            via: 'wechat-oa',
            acct,
          })
          deps.limiter.record(t.id, 'wechat-oa', null, true)
          c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
          return c.redirect(baked.next)
        }
        // ③ 降级（悬空 / Casdoor 不可达）：audit 留 degraded 标记后照常发中间态会话。下方
        //    的签发序列与本文件末段的中间态块同形——**刻意不复用/不抽取**：抽出来就得改
        //    现状块（红线：中间态代码一字不改），两处需同改是有意的代价
        await writeAudit(deps.pool, t.id, openid, 'login.ok', {
          via: 'wechat-oa',
          degraded: degraded === 'casdoor-down' ? 'casdoor-down' : 'dangling',
          acct: active.casdoorName,
        })
        const scopes = await deps.enabledGuestScopes(t.id)
        const now = Math.floor(Date.now() / 1000)
        const token = await signSession(
          { sub: openid, org: t.casdoor_org, name: openid, scopes, authVia: 'wechat-oa' },
          deps.sessionSecret,
          now,
        )
        deps.limiter.record(t.id, 'wechat-oa', null, true)
        c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
        return c.redirect(baked.next)
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
      // 回跳：`baked.next` 已在拆 cookie 时过了一遍 safeNextPath（非法一律被折成 '/'）
      return c.redirect(baked.next)
    })
}
