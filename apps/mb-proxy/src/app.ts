// app.ts — Hono 组装（与宿主 `apps/server/src/app.ts` 同款分工：**组装在这里，serve 在 index.ts**）。
//
// 为什么要拆出这一层：Task 2 的 `index.ts` 顶层就 `serve()` ⇒ 它一被 import 就**真绑端口**、
// 且在 import 期就要全量 env（`loadProxyConfig` 在模块顶层抛）。HTTP 级测试因此没法做。
// 拆开后测试可直接 `createApp(fakeCfg).request('/handoff?...')`：不绑端口、不要 env。
//
// ⚠️ 用**工厂**（`createApp(cfg)`）而不是模块级 `export const app`：配置是**参数**，不在 import 期
//    读 env——否则「import app 即要 env」这条会把上面那个目的原样带回。
import { Hono } from 'hono'
import type { ProxyConfig } from './config'
import { claimNonce, signProxySession, verifyEditHandoff } from './handoff'
import { serializeEditCookie } from './session'

export function createApp(cfg: ProxyConfig): Hono {
  const app = new Hono()

  // ① /healthz 在鉴权之前（照宿主 app.ts:205 的位置纪律：探活不带业务身份）
  app.get('/healthz', (c) => c.json({ ok: true }))

  // ② /handoff：一次性票据兑换。成功 ⇒ 种代理自有 Cookie + 302 到编辑页；失败 ⇒ 401 且**不**设 Cookie。
  app.get('/handoff', (c) => {
    const t = c.req.query('t') ?? ''
    const claims = verifyEditHandoff(t, cfg.sessionSecret)
    if (claims === null || !claimNonce(claims.nonce)) {
      // 验签失败与重放**同一个响应**：不区分（区分等于给攻击者一个「签名对了」的探针）
      return c.json({ error: 'INVALID_HANDOFF' }, 401)
    }
    // 兑换：发**自己的**会话票据（同样 HS256，但用途是代理侧会话，不是 handoff）
    const session = signProxySession({ org: claims.org, did: claims.did }, cfg.sessionSecret)
    return new Response(null, {
      status: 302,
      headers: { 'set-cookie': serializeEditCookie(session), location: `/dashboard/${claims.did}` },
    })
  })

  // ③ T4 挂鉴权中间件 + 授权规则表 + 上游透传
  return app
}
