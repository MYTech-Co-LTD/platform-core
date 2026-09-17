// routes/auth-wecom.ts — 企微登录两路（桌面扫码 qr + 企微内静默 silent）→ platform_session
//
// 五路归一的企微两路（Task 14）：qr = 登录页 <iframe> 内嵌 Casdoor 扫码页（authorize URL
// 由本路由下发）；silent = 企微内置浏览器整页跳 open.weixin.qq.com 静默授权。两路回调都
// 落 GET /callback，收敛到同一 platform_session cookie（authVia 区分来源）。
//
// state 责任（Task 7 契约）在本路由：/qr 与 /silent 各发随机 state（randomUUID）+
// HttpOnly cookie wecom_state（Max-Age=300, SameSite=Lax）绑定，回调校验一致（CSRF/混流）。
// Lax 可携带的依据：旧仓 2026-08-31 生产实测（gateway/index.js:261）——扫码 iframe 最终跳
// 回调时父页与回调目标同站；静默流是顶层导航，Lax 天然携带。
//
// code 换身份两分（callback 内）：
//  - qr：code 是 Casdoor OIDC code → POST /api/login/oauth/access_token（旧仓 sso-shell.js
//    authorizationCodeToken :157-170 生产形状：x-www-form-urlencoded，含 redirect_uri）→
//    本地解 JWT payload 取 name（同旧 gateway decodePayload 语义：信任来自端点+TLS，不本地
//    验签；name 平铺在 claims，sub 兜位）。
//  - silent（via=silent）：code 是企微 code → wecomUserIdForCode（gettoken→getuserinfo）换
//    userid → woke 语义 userid 即 Casdoor name（wo 开头），casdoor.getUser(userid) 落账户。
// 两路拿到 name 后同 Task 13 登录路径：getUser+getPermissions → effectiveScopes →
// signSession → 审计先行 → Set-Cookie。
import { randomUUID } from 'node:crypto'
import { Hono } from 'hono'
import type { Pool } from 'pg'
import {
  buildWecomQrUrl,
  buildWecomSilentUrl,
  effectiveScopes,
  signSession,
  wecomUserIdForCode,
  type CasdoorPermission,
  type CasdoorUser,
} from '@platform/auth-core'
import type { TenantEnv } from '../tenant'
import { serializeSessionCookie, type CasdoorFactory, type SessionEnv } from '../session-middleware'
import { warnRateLimitDeny, type LoginLimiter } from '../rate-limit'

const CALLBACK_PATH = '/api/platform/auth/wecom/callback'
const STATE_COOKIE = 'wecom_state'
const STATE_TTL_SEC = 300

/** iframe（登录页内嵌扫码页）回跳分支：302 对 iframe 父页不可见 → 小 HTML 让父页壳 SPA 感知完成 */
const IFRAME_DONE_HTML = "<script>parent.postMessage({type:'sso-done'},'*')</script>"

/** iframe 失败分支（评审 I1）：与 sso-done 对称的 sso-fail 消息；error 为错误码字符串（[A-Z_]+，无注入面） */
function iframeFailHtml(err: string): string {
  return `<script>parent.postMessage({type:'sso-fail', error:'${err}'},'*')</script>`
}

export interface WecomRoutesDeps {
  casdoor: CasdoorFactory
  sessionSecret: string
  pool: Pool
  /**
   * 登录限速器（M1 闭债 R2）：与账密路共用同一实例（见 auth.ts 同名注释）。本路由是 `wecom`
   * 门（PR#5 评审 R2）——共用实例、**分开的桶键**，两件事同时成立。
   */
  limiter: LoginLimiter
  /** Casdoor 应用三件：qr authorize URL 拼接 + callback code 换票 */
  casdoorUrl: string
  casdoorClientId: string
  casdoorClientSecret: string
  /** 对外可见源（回调 redirect_uri 前缀；与宿主 PUBLIC_ORIGIN 同源配置） */
  publicOrigin: string
  /** 企微 qyapi fetch 注入口（默认 globalThis.fetch；测试注入假企微 API） */
  wecomFetch?: typeof globalThis.fetch
}

/** 登录审计一行（与 auth.ts writeAudit 同款 SQL；失败也 await——审计写不进去就不该继续发会话） */
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

/** JWT payload 本地解码（不验签：token 直接来自 Casdoor token 端点，TLS 信任边界内——旧 gateway decodePayload 同语义） */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payloadB64] = token.split('.')
  if (!payloadB64) throw new Error('token is not a jwt')
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'))
}

/**
 * Casdoor OIDC code → 用户名。sso-shell.js authorizationCodeToken 生产形状：
 * POST /api/login/oauth/access_token，application/x-www-form-urlencoded，
 * grant_type=authorization_code + client_id/client_secret/code/redirect_uri 全在 body。
 * 返回 null = code 被上游拒绝（4xx + OAuth error 载荷如 invalid_grant，或 2xx 无 access_token）；
 * 抛错 = 传输层故障（网络错、5xx（含反代 HTML 错误页）、任何状态码的非 JSON 体），
 * 路由层按 502 类 fail-loudly 处理（评审 I2：不得吞成 BAD_CODE）。
 */
async function casdoorCodeToName(
  o: { origin: string; clientId: string; clientSecret: string },
  code: string,
  redirectUri: string,
): Promise<string | null> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: o.clientId,
    client_secret: o.clientSecret,
    code,
    redirect_uri: redirectUri,
  })
  const r = await fetch(`${o.origin.replace(/\/+$/, '')}/api/login/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  // 5xx（反代/网关错误页）= 服务端/链路故障，不是坏 code——抛出走 502 类（评审 I2）
  if (r.status >= 500) throw new Error(`casdoor token endpoint http ${r.status}`)
  let j: { access_token?: string }
  try {
    j = (await r.json()) as { access_token?: string }
  } catch {
    // 非 JSON 体（任何状态码：网关截胡的 HTML 错误页/伪装 2xx 的 HTML）同归传输故障
    throw new Error('casdoor token endpoint returned non-json body')
  }
  if (!j.access_token) return null
  const claims = decodeJwtPayload(j.access_token)
  const name = String(claims.name || claims.sub || '')
  return name || null
}

/** state cookie 序列化（Task 7 契约逐字：HttpOnly + Max-Age=300 + SameSite=Lax；host-only 无 Domain。短命单用途 nonce 非长期凭据） */
function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${state}; Path=/; Max-Age=${STATE_TTL_SEC}; HttpOnly; SameSite=Lax`
}

/** 从 Cookie 头读 wecom_state（手写解析，与 session-middleware readCookie 同语义） */
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

export function wecomRoutes(deps: WecomRoutesDeps) {
  const callbackUri = trimSlash(deps.publicOrigin) + CALLBACK_PATH

  // GET /qr — 登录页 Tab 用：企微扫码登录地址 + 种 state
  return new Hono<TenantEnv & SessionEnv>()
    .get('/qr', (c) => {
      const t = c.get('tenant')
      // 自建应用三件套缺一不可：corpId/secret 后面都要用（secret 缺了只会在回调里才炸，
      // 不如在这里就 404 让登录页直接显示"二维码加载失败"）。**保留**：无 corp 的租户返 404
      // （既有测试钉着这个出口，且代开发路尚未接线）。
      if (!t.wecom_corp_id || !t.wecom_secret) {
        return c.json({ error: 'WECOM_NOT_CONFIGURED' }, 404)
      }
      const state = randomUUID()
      // **直连企微，不经 Casdoor**（issue #30）：经 Casdoor 时它把 redirect_uri 换成自己的域
      // （实测 sso.hookflow.cn/callback，我们的回调被包在 state 里），而企微自建应用的
      // **可信域名只能配一个** ⇒ 客户用自有域名（本公司内部应用 = mytech.hookflow.cn）时
      // 永远对不上，报「redirect_uri 与配置的授权完成回调域名不一致」。
      // 直连则回跳落在**我们自己的域**上，与租户自己的可信域名一致。
      // `via=qr-corp` 告诉回调"这是**企微** code 而非 Casdoor OIDC code"（见回调的分支）。
      const url = buildWecomQrUrl(
        { corpId: t.wecom_corp_id, agentId: t.wecom_agent_id ?? undefined },
        `${callbackUri}?via=qr-corp`,
        state,
      )
      c.res.headers.append('Set-Cookie', stateCookie(state))
      return c.json({ url })
    })

    // GET /silent — 企微内置浏览器整页跳转：非 wxwork UA（桌面误触）降级回登录页
    .get('/silent', (c) => {
      const ua = c.req.header('user-agent') ?? ''
      if (!ua.toLowerCase().includes('wxwork')) {
        return c.redirect('/login')
      }
      const t = c.get('tenant')
      if (!t.wecom_corp_id) {
        return c.json({ error: 'WECOM_NOT_CONFIGURED' }, 404)
      }
      const state = randomUUID()
      const url = buildWecomSilentUrl(
        { corpId: t.wecom_corp_id, agentId: t.wecom_agent_id ?? undefined },
        `${callbackUri}?via=silent`,
        state,
      )
      c.res.headers.append('Set-Cookie', stateCookie(state))
      return c.redirect(url)
    })

    // GET /callback?code&state[&via=silent] — 两路共用回调
    .get('/callback', async (c) => {
      const t = c.get('tenant')
      const state = c.req.query('state') ?? ''
      const code = c.req.query('code') ?? ''
      const viaRaw = c.req.query('via') ?? ''
      const via = viaRaw === 'silent' ? 'wecom-silent' : 'wecom-qr'
      // 是否是**企微** code（而非 Casdoor OIDC code）：silent 路与自建应用的扫码路（`qr-corp`，
      // issue #30）都是**我们直连企微**拿到的 code ⟹ 走同一个换票函数；只有经 Casdoor 的代开发路
      // 拿的是 OIDC code。**这同时决定失败时的错误码**（企微故障 vs Casdoor 故障）。
      const wecomCode = viaRaw === 'silent' || viaRaw === 'qr-corp'
      // 失败呈现（评审 I1）：回调恒为浏览器导航（Casdoor/企微 302 落地），JSON 错误体是用户
      // 死胡同——iframe 内（扫码页回跳）200 + postMessage sso-fail（与 sso-done 对称，Task 17
      // 登录页监听两种消息）；顶层 302 /login?error=<CODE>（登录页按码展示）。错误码集合与
      // 历史 JSON error 字段同名：BAD_STATE / BAD_CODE / NO_ACCOUNT / CASDOOR_UNAVAILABLE /
      // WECOM_UNAVAILABLE / WECOM_NOT_CONFIGURED / TOO_MANY_REQUESTS。
      const isIframe = c.req.header('sec-fetch-dest') === 'iframe'
      const fail = (err: string) =>
        isIframe ? c.html(iframeFailHtml(err)) : c.redirect(`/login?error=${encodeURIComponent(err)}`)

      // 限速（M1 闭债 R2）：租户层，必须早于任何 writeAudit。企微路在 code 换票前拿不到用户名
      // ⇒ 只判租户维度（spec §3.2 的已知口径落差，刻意如此）；门维度固定 'wecom'（PR#5 评审 R2
      // 拆桶：灌满企微门不得锁死同租户的账密门）。
      //
      // **为什么这条判定必须晚于上面 isIframe/fail 的定义**（PR#5 评审 R2）：本路由的失败一律是
      // 导航呈现，JSON 429 在回调上是用户死胡同——qr 路会让扫码区直接显示一坨 JSON
      // （Login.tsx 的 WecomQrTab 只认 sso-done/sso-fail 两种 postMessage，`onError` 永不触发，
      // 用户既无提示也无法重试），silent 路整页落到 JSON 文本、连 /login?error= 兜底都没有。
      // 故 429 与其它失败同走 fail：iframe 拿到对称的 sso-fail，顶层 302 回登录页按码展示。
      // Retry-After 信号照旧带上（形态变了，信号不丢），console.warn 告警也照旧（warnRateLimitDeny）。
      //
      // **check 是只读的**（Task 24 评审 R1）：它不改状态，deny 只能由既有计数触发。故本路由
      // 每一条失败路径都**必须**有对应的 record——漏一条，那条路径的流量就完全不进计数，
      // 第 2/3 层永远推不满 ⇒ 该路径**永不 429**（且它每次都在往共享 SSO 发出站调用）。
      // 口径：record 只动内存计数、**不写 audit**（record 与 writeAudit 是两个独立调用）——
      // "被拒请求不灌审计表"的既有语义因此不受影响。
      const decision = deps.limiter.check(t.id, 'wecom', null)
      if (!decision.allowed) {
        warnRateLimitDeny(t.id, decision)
        const res = fail('TOO_MANY_REQUESTS')
        res.headers.set('Retry-After', String(decision.retryAfterSec ?? 60))
        return res
      }

      if (!code || !state || readStateCookie(c.req.header('cookie')) !== state) {
        // 计数：BAD_STATE 也是一次失败的登录尝试。此前只 fail 不 record ⇒ 连 /qr 都不需要
        // （随便带个 state 循环打即可）就能无限打而计数恒为 0。不写 audit：actor 此刻根本
        // 不存在，且被拒请求不灌审计表是既有语义（评审 R1）
        deps.limiter.record(t.id, 'wecom', null, false)
        return fail('BAD_STATE')
      }

      // 身份来源两分：**企微 code**（silent 路 + 自建应用的扫码路 qr-corp，issue #30）换 userid；
      // **Casdoor OIDC code**（经 Casdoor 的代开发路）换票解 name。
      let name: string | null
      try {
        if (wecomCode) {
          if (!t.wecom_corp_id || !t.wecom_secret) {
            // 计数（PR#5 评审 R2）：口径统一——本路由上除"被限速本身"以外的**每一个**失败出口
            // 都要 record。这条不产生出站调用（危害比 catch 那条低一档），但它同样是免费的
            // 第 2/3 层填充流量：漏记就等于给攻击者留一条不计数的路
            deps.limiter.record(t.id, 'wecom', null, false)
            return fail('WECOM_NOT_CONFIGURED')
          }
          name = await wecomUserIdForCode(
            {
              corpId: t.wecom_corp_id,
              agentId: t.wecom_agent_id ?? undefined,
              secret: t.wecom_secret,
            },
            code,
            deps.wecomFetch ?? globalThis.fetch,
          )
        } else {
          name = await casdoorCodeToName(
            {
              origin: deps.casdoorUrl,
              clientId: deps.casdoorClientId,
              clientSecret: deps.casdoorClientSecret,
            },
            code,
            callbackUri,
          )
        }
      } catch {
        // 传输层故障（Casdoor/企微 5xx、网络——含 casdoorCodeToName 的非 2xx/非 JSON 抛错）
        // ≠ 坏 code：CASDOOR/WECOM_UNAVAILABLE 类如实呈现，不记 login.fail（非用户过错）
        //
        // 计数（PR#5 评审 R2）：这条 catch 是 **silent 路的唯一出口**——`wecomUserIdForCode` 对坏
        // code 是**抛错**、不返回 null（packages/auth-core/src/wecom.ts），所以 silent 路永远到
        // 不了下面的 `name === null`（那里那次 record 对 silent 是死代码）；而 qr 路在上游退化
        // （Casdoor 5xx/非 JSON）时也落这里。此前这里不 record ⇒ 这两条路**完全不进第 2/3 层**：
        // silent 路攻击面与 qr 路逐字等价（via 只来自查询串、回调上没有 wxwork UA 校验）却**永不
        // 429**，且每次都在向共享 SSO / 腾讯 getuserinfo 发出站调用——"上游一出问题刹车就失效"，
        // 与本路由自立的规矩「每一条失败路径都**必须**有 record」直接冲突
        deps.limiter.record(t.id, 'wecom', null, false)
        return fail(wecomCode ? 'WECOM_UNAVAILABLE' : 'CASDOOR_UNAVAILABLE')
      }
      if (name === null) {
        // code 被上游拒绝（无效/过期/已兑换）——不泄具体原因（qr 路；silent 路只抛不 null，
        // 那条路在 catch 里计数，见上）
        //
        // 计数（Task 24 评审 R1，本条是本路由的主打路径）：循环
        // `GET /qr → 取 state → `GET /callback?code=<垃圾>&state=<同一 uuid>` 的攻击，每次
        // 都通过 state 校验、每次都经 casdoorCodeToName 向共享 SSO 发一次出站调用、每次都在
        // 这里返回——此前这里**只 fail 不 record**，计数恒不增长 ⇒ 永不 429，把无限放大打在
        // 跨租户的 SSO 面上（与 spec"每次都会产生失败"的自陈相反）。仍不写 audit：code 被
        // 上游拒绝时拿不到可信身份，actor 无从写起；计数才是这一路要的东西
        deps.limiter.record(t.id, 'wecom', null, false)
        return fail('BAD_CODE')
      }

      // 同 Task 13 登录路径：有效会话必须带可信 scopes（fail loudly）；
      // getUser=null = 该 org 无此用户（企微 userid 未建 Casdoor 账号）→ fail-closed
      let user: CasdoorUser | null
      let perms: CasdoorPermission[]
      const casdoor = deps.casdoor(t.casdoor_org)
      try {
        ;[user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
      } catch {
        // 计数（PR#5 终轮评审 M1）：路由上最后一处漏记的出口，与上面那条 catch 理由逐字相同
        // （"上游一出问题刹车就失效"），且每次做 **2 次**对共享 SSO 的出站调用（getUser +
        // getPermissions）——比无出站的 WECOM_NOT_CONFIGURED 高一档。口径同 :243
        deps.limiter.record(t.id, 'wecom', null, false)
        return fail('CASDOOR_UNAVAILABLE')
      }
      if (user === null && wecomCode && t.wecom_auto_signup) {
        // JIT 自动建号（issue #32）：企微**直连**两路（qr-corp/silent）+ 租户显式开旗标才走。
        // 直连路拿到的 userid 已过企微身份认证（真实企业成员）⇒「企微成员即平台账号」是
        // 租户级决定；Casdoor OIDC code 路（代开发）的账号来源是 Casdoor 自己的注册/管理面，
        // **永不** JIT（上面的 wecomCode 判定即为此）。形状：2026-09-13 生产手工解卡
        // （mytech/ZhangDuo）在真 Casdoor 上验证过的 ensureUser + 全量码挂 users。
        try {
          await casdoor.ensureUser(name)
          await casdoor.bindUserToAllPermissions(name)
          // perms 是 bind 前拉的（users 不含新号）——重拉拿绑定后的全集；ensureUser 内部
          // 已处理 add 竞态（重读验证），这里 getUser 只可能拿到刚建的号
          ;[user, perms] = await Promise.all([casdoor.getUser(name), casdoor.getPermissions()])
        } catch {
          // 建号/绑定失败 = 上游故障，fail loudly：绝不静默放行一个半建成的号。
          // 注：ensureUser 成而 bind 半途失败属部分授权（只会少不会多）——下次扫码
          // getUser 已非 null、走正常路，漏挂的码由运维补 bind（幂等可重跑）
          await writeAudit(deps.pool, t.id, name, 'login.fail', { via, reason: 'jit-create-failed' })
          deps.limiter.record(t.id, 'wecom', null, false)
          return fail('CASDOOR_UNAVAILABLE')
        }
      }
      if (user === null) {
        await writeAudit(deps.pool, t.id, name, 'login.fail', { via, reason: 'no-account' })
        deps.limiter.record(t.id, 'wecom', null, false) // 企微路不建 user 桶（check 也不看它）
        return fail('NO_ACCOUNT')
      }
      const scopes = effectiveScopes(name, user.roles ?? [], perms)

      const now = Math.floor(Date.now() / 1000)
      const token = await signSession(
        { sub: name, org: t.casdoor_org, name, scopes, authVia: via },
        deps.sessionSecret,
        now,
      )
      // 审计先行（M-4，与 auth.ts 同序）：插入抛错 → 500 且未发任何会话 cookie
      await writeAudit(deps.pool, t.id, name, 'login.ok', { via })
      deps.limiter.record(t.id, 'wecom', null, true)
      c.res.headers.append('Set-Cookie', serializeSessionCookie(token))
      // iframe 分支（登录页内嵌扫码页回跳）：顶层 302 指到 iframe 外不可行 → 小 HTML 通知父页
      if (c.req.header('sec-fetch-dest') === 'iframe') {
        return c.html(IFRAME_DONE_HTML)
      }
      return c.redirect('/')
    })
}
