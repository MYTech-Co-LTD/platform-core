// internal-identity.ts — 网关→模块的进程内身份断言（HMAC，30s TTL）。
//
// 场景：`/api/agent/mcp` 网关已解析过一次调用方身份，向下游模块端点转发时不再透传
// 原始 PAT / 企微渠道凭证，而是带一枚内部签名头（`x-internal-identity`）。模块侧由本
// 中间件验签并注入 Identity，避免二次 Casdoor 查询与 token 透传。
//
// 安全边界：
//   · 密钥**进程内**生成（randomBytes，不落 env、不跨进程）——网关与模块同进程部署时才有意义。
//   · 外部请求伪造同名头验不过 ⇒ 本中间件**不设 identity**，放行下游门卫（fail-closed 在那）。
//   · first-setter-wins：会话/其他通道已注入 identity 时不覆盖。
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { REQUESTER_CHANNEL, REQUESTER_KEY_ID } from '@platform/sdk'
import type { Identity } from '@platform/sdk'
import { createMiddleware } from 'hono/factory'
import type { RequesterEnv } from './pat-auth'

export const INTERNAL_IDENTITY_HEADER = 'x-internal-identity'
const SECRET = randomBytes(32)
const TTL_MS = 30_000

export interface InternalIdentityPayload {
  org: string
  userId: string
  displayName?: string
  accountName?: string
  channel: 'pat' | 'session' | 'wecom'
  keyId?: number | null
  scopes: string[]
  roles?: string[]
  sessionId?: string
  exp: number
}

const sign = (payload: string): string =>
  createHmac('sha256', SECRET).update(payload).digest('base64url')

export function issueInternalIdentity(p: Omit<InternalIdentityPayload, 'exp'>): string {
  const payload = Buffer.from(JSON.stringify({ ...p, exp: Date.now() + TTL_MS })).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyInternalIdentity(header: string | undefined, now = Date.now()): InternalIdentityPayload | null {
  if (!header) return null
  // 必须恰两段：`validHeader + '.garbage'` 不能被 split 的宽松解构放过。
  const parts = header.split('.')
  if (parts.length !== 2) return null
  const [payload, mac] = parts
  if (!payload || !mac) return null
  const expected = sign(payload)
  // 长度守卫必须比**字节**长度：字符串 length 是 UTF-16 码元数，多字节 MAC（如 43 个 `中`）
  // 可与 43 字符的 base64url MAC 同字符数、不同字节数——那样 timingSafeEqual 会抛 RangeError。
  const macBuf = Buffer.from(mac)
  const expectedBuf = Buffer.from(expected)
  if (macBuf.length !== expectedBuf.length || !timingSafeEqual(macBuf, expectedBuf)) return null
  try {
    const p = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as InternalIdentityPayload
    return Number.isFinite(p.exp) && p.exp > now ? p : null
  } catch {
    return null
  }
}

export function identityFromInternal(p: InternalIdentityPayload): Identity {
  return {
    userId: p.userId, orgId: p.org,
    displayName: p.displayName ?? p.userId,
    scopes: p.scopes, hasScope: (code) => p.scopes.includes(code),
    ...(p.roles ? { roles: p.roles } : {}),
    ...(p.accountName ? { accountName: p.accountName } : {}),
    ...(p.sessionId ? { sessionId: p.sessionId } : {}),
  }
}

/** 只接受网关签发的内部头；外部同名头验不过即放行给下游门卫（fail-closed 在那）。 */
export function internalIdentityMiddleware() {
  return createMiddleware<RequesterEnv>(async (c, next) => {
    if (c.get('identity')) return next()
    const p = verifyInternalIdentity(c.req.header(INTERNAL_IDENTITY_HEADER))
    if (p) {
      c.set('identity', identityFromInternal(p))
      // 'session' 是 REQUESTER_* 的缺省语义（requester-vars.ts：未设置 = 系统内会话通道），
      // 且 RequesterVars 的通道联合只含 'pat' | 'wecom'——故会话通道不显式写变量。
      if (p.channel !== 'session') c.set(REQUESTER_CHANNEL, p.channel)
      if (p.keyId != null) c.set(REQUESTER_KEY_ID, p.keyId)
    }
    await next()
  })
}
