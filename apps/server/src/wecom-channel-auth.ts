// wecom-channel-auth.ts — 通道 C（企微 × OpenClaw）的鉴权中间件。
//
// 身份模型采 data-analysis 生产方案：**企微 userid 即身份**，不建绑定码子系统
//   （内部人员身份的真相源就是企微；绑定码是多余且会漂移的第二份身份状态）。
// 「绑定」= 一次企微扫码登录：登录那一刻 Casdoor 落企微↔账号关联
//   （userid 即 Casdoor name，见 apps/server/src/routes/auth-wecom.ts 的注释）。
// 因此这里**只需** getUser(userid) 一步，无需任何绑定表。
//
// 未配 DATA_WECOM_CHANNEL_KEY 的部署 = 没开通道 C ⇒ 直接放行，不锁死 /api/modules/*。
import { createHash, timingSafeEqual } from 'node:crypto'
import { createMiddleware } from 'hono/factory'
import type { MiddlewareHandler } from 'hono'
import { effectiveScopes } from '@platform/auth-core'
import { REQUESTER_CHANNEL } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
// Env 求交只写一处：从 pat-auth 引（它是类型，不会把两个中间件绑成运行时依赖）。
import type { RequesterEnv } from './pat-auth'
import type { CasdoorFactory } from './session-middleware'

export const WECOM_USERID_HEADER = 'x-wecom-userid'

export interface WecomChannelAuthDeps {
  casdoor: CasdoorFactory
  /** 渠道服务凭证（openship env isSecret）。未配 ⇒ 通道 C 关闭。 */
  channelKey?: string
}

/** 定长比较：两侧先 sha256 归一到同长度，再 timingSafeEqual。 */
function keyMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

export function wecomChannelIdentityMiddleware(deps: WecomChannelAuthDeps): MiddlewareHandler<RequesterEnv> {
  return createMiddleware<RequesterEnv>(async (c, next) => {
    if (deps.channelKey === undefined || deps.channelKey === '') return next()  // 通道 C 未启用
    if (c.get('identity')) return next()                                        // first-setter-wins

    const provided = c.req.header('x-channel-key')
    if (!provided || !keyMatches(provided, deps.channelKey)) {
      return c.json({ error: 'CHANNEL_KEY_INVALID' }, 401)
    }

    // userid 走**头部**不走 body：body 是问数参数，让身份的来源与参数混在一个面上会诱发
    // 「参数里塞身份」这类越权（同 spec §5 约束 2 的立意）。
    const userid = c.req.header(WECOM_USERID_HEADER)?.trim()
    if (!userid) return c.json({ error: 'WECOM_USERID_REQUIRED' }, 401)

    const tenant = c.get('tenant')
    let scopes: string[]
    try {
      const casdoor = deps.casdoor(tenant.casdoor_org)
      const user = await casdoor.getUser(userid)
      // 未关联 = Casdoor 里没有这个企微账号 ⇒ fail-closed + 客户端回一句扫码登录指引
      if (user === null) return c.json({ error: 'WECOM_USER_NOT_LINKED' }, 401)
      const perms = await casdoor.getPermissions()
      scopes = effectiveScopes(userid, user.roles ?? [], perms)
    } catch {
      return c.json({ error: 'CASDOOR_UNAVAILABLE' }, 503)
    }

    const identity: Identity = {
      userId: userid,                 // 企微 userid 即 Casdoor name（本仓既有语义）
      orgId: tenant.casdoor_org,
      displayName: userid,
      scopes,
      hasScope: (code: string) => scopes.includes(code),
    }
    c.set('identity', identity)
    c.set(REQUESTER_CHANNEL, 'wecom')
    await next()
  })
}
