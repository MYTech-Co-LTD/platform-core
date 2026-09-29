// app.ts — Hono 组装（与宿主 `apps/server/src/app.ts` 同款分工：**组装在这里，serve 在 index.ts**）。
//
// 为什么要拆出这一层：Task 2 的 `index.ts` 顶层就 `serve()` ⇒ 它一被 import 就**真绑端口**、
// 且在 import 期就要全量 env（`loadProxyConfig` 在模块顶层抛）。HTTP 级测试因此没法做。
// 拆开后测试可直接 `createApp(fakeCfg).request('/handoff?...')`：不绑端口、不要 env。
//
// ⚠️ 用**工厂**（`createApp(cfg)`）而不是模块级 `export const app`：配置是**参数**，不在 import 期
//    读 env——否则「import app 即要 env」这条会把上面那个目的原样带回。
import { Hono } from 'hono'
import { getCookie } from 'hono/cookie'
import type { ProxyConfig } from './config'
import { claimNonce, signProxySession, verifyEditHandoff, verifyProxySession } from './handoff'
import { decide, normalizePath } from './rules'
import { EDIT_COOKIE, serializeEditCookie } from './session'
import { fetchDashboardCards, proxy } from './upstream'

/**
 * 中间件之间传的东西：鉴权解出来的身份 + **归一化后的路径**。
 * `proxyPath` 存在的唯一理由：让兜底**发出去的就是规则表判过的那一份路径**（见 rules.normalizePath 头注）。
 */
type AppVars = { Variables: { org: string; did: number; proxyPath: string } }

export function createApp(cfg: ProxyConfig): Hono<AppVars> {
  const app = new Hono<AppVars>()

  // ① /healthz 在鉴权之前（照宿主 app.ts:205 的位置纪律：探活不带业务身份）
  app.get('/healthz', (c) => c.json({ ok: true }))

  // ② /handoff：一次性票据兑换。成功 ⇒ 种代理自有 Cookie + 302 到编辑页；失败 ⇒ 401 且**不**设 Cookie。
  app.get('/handoff', (c) => {
    const t = c.req.query('t') ?? ''
    const claims = verifyEditHandoff(t, cfg.sessionSecret)
    if (claims === null || !claimNonce(claims.nonce)) {
      // 验签失败与重放**同一个响应**：不区分（区分等于给攻击者一个「签名对了」的探针）
      // no-store：这一路也别让中间缓存留下票据兑换的痕迹（票据就在 URL 里）
      return c.json({ error: 'INVALID_HANDOFF' }, 401, { 'Cache-Control': 'no-store' })
    }
    // 兑换：发**自己的**会话票据（同样 HS256，但用途是代理侧会话，不是 handoff）
    const session = signProxySession({ org: claims.org, did: claims.did }, cfg.sessionSecret)
    return new Response(null, {
      status: 302,
      headers: {
        'set-cookie': serializeEditCookie(session),
        location: `/dashboard/${claims.did}`,
        // ⚠️ **必须 no-store**：票据在 URL 里，一次性的保证只在「同一枚 nonce 只能兑换一次」上；
        //    若 302 被共享缓存留住，同一 URL 再次命中就是**绕过** nonce 的一次性（攻击者只要拿到
        //    那个 URL 就能从缓存里拿到种 Cookie 的响应，进程内的 nonce 表根本不会被问第二次）。
        //    窗口本就很窄（票据 120s），但这条加固零成本。
        'Cache-Control': 'no-store',
      },
    })
  })

  // ③ 鉴权中间件：解 `mb_edit` Cookie（自有会话，代理侧派生密钥）⇒ 失败 **401**（Task 2 欠下的契约）。
  //    ⚠️ 这条 `use('*')` 注册在 `/healthz`、`/handoff` **之后** ⇒ 那两个路由先命中并直接返回，
  //       中间件链就此停下（Hono 按注册序执行，不调 `next()` 的处理器会短路后面所有层）。
  //       **这不是巧合而是被测试钉住的**：app.test.ts 有「/healthz 无 Cookie ⇒ 200」与
  //       handoff.test.ts 的「/handoff 无 Cookie ⇒ 仍能兑换」两侧；将来有人把 `use` 提到前面，
  //       那两处会立刻变红。故**不要**在中间件里再抄一份路径白名单——两处白名单迟早分叉。
  app.use('*', async (c, next) => {
    const token = getCookie(c, EDIT_COOKIE)
    const claims = token === undefined ? null : verifyProxySession(token, cfg.sessionSecret)
    if (claims === null) {
      // 不区分「没 Cookie」与「Cookie 坏/过期」：区分等于给攻击者一个「这枚串结构对了」的探针。
      // no-store：401 也不许被缓存（否则一次失败能在共享缓存里被回放给别的请求）。
      return c.json({ error: 'UNAUTHORIZED' }, 401, { 'Cache-Control': 'no-store' })
    }
    // ⚠️ `claims.org` 解出来但**有意不参与授权判定**（订正记录 2026-09-29，Task 4 评审轮 Minor ④）：
    //    租户隔离在**签发侧**就定死了（Task 1 只给「本 org 已登记的那一张 dashboard」签票），
    //    代理只认「票据里那一张 dashboard」，不自行按 org 放行任何东西——别把这里读成漏用。
    //    它唯一的用途是给卡片缓存做命名空间（`${org}:${did}`，见 upstream.ts）。
    //    若将来要按 org 判权，那是**新增授权语义**，必须回 spec，不是在中间件里顺手加。
    c.set('org', claims.org)
    c.set('did', claims.did)
    await next()
  })

  // ④ 授权规则表：`decide` 不过 ⇒ **403**。卡片集合现取（60s 缓存；取不到 ⇒ 空集 ⇒ fail-closed）。
  app.use('*', async (c, next) => {
    // 先归一化（判的路径 == 将要上行的路径；见 rules.normalizePath 头注）。归一不了 ⇒ 不信 ⇒ 403。
    // **绝不**在归约失败时回落到原始 path 上行（那正是本层要堵的洞）。
    const path = normalizePath(c.req.path)
    if (path === null) return c.json({ error: 'NOT_ALLOWED' }, 403, { 'Cache-Control': 'no-store' })
    const cards = await fetchDashboardCards(cfg, c.get('org'), c.get('did'))
    if (decide(path, c.req.method, { did: c.get('did'), cards }) === 'deny') {
      return c.json({ error: 'NOT_ALLOWED' }, 403, { 'Cache-Control': 'no-store' })
    }
    c.set('proxyPath', path)
    await next()
  })

  // ⑤ 兜底：走到这里的请求**已经**过了鉴权 + 规则表 ⇒ 透传到上游（头改写见 upstream.ts）。
  //    上行路径用 `proxyPath`（= 规则表判过的那一份），**不**再自己从 url 里取——那会重新打开
  //    「判的是 A、发的是 B」的口子。
  app.all('*', (c) => proxy(cfg, c.req.raw, c.get('proxyPath')))

  // 未捕获异常（如上游网络错）统一成 JSON 500：**不回显上游的错误文本**（供应商常把请求原文——
  // 含 API key——写进 message，回显即泄凭证；口径同 modules/data/domain/metabase.ts 的 MetabaseError）。
  app.onError((err, c) => {
    console.error(`[mb-proxy] unhandled: ${err.message}`)
    return c.json({ error: 'UPSTREAM_ERROR' }, 500, { 'Cache-Control': 'no-store' })
  })

  return app
}
