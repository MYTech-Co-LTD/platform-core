// platform_session cookie 的载荷层（纯函数）：签发/验签/滑动续期判定/scopes 刷新判定/CSRF token。
// 宿主会话中间件（Task 13）只消费这里的判定结果决定何时重签，本模块不做任何 I/O。
import { SignJWT, compactVerify } from 'jose'
import { createHmac } from 'node:crypto'

export const SESSION_COOKIE = 'platform_session'
// 会话绝对有效期 7 天；scopes 缓存 TTL 5 分钟（needsScopeRefresh 阈值与之同源）
export const SESSION_TTL_SEC = 604800
export const SCOPES_TTL_SEC = 300

// 滑动续期阈值：剩余寿命 < 6 天即建议重签（即每活跃使用约 1 天续一次）
const RENEW_THRESHOLD_SEC = 6 * 86400

export interface SessionPayload {
  // 身份 id：Casdoor 用户（UUID）；或公众号访客 openid（wechat-oa 访客 session，售后 spec §1.3——
  // openid 即身份，不落 Casdoor 账号）
  sub: string
  org: string
  name: string
  scopes: string[]
  authVia: 'password' | 'wecom-qr' | 'wecom-silent' | 'wechat-oa'
  iat: number // 签发时刻（Unix 秒）
  exp: number // 过期时刻（Unix 秒）
  sfa: number // scopes fetched at —— scopes 上次刷新时刻，needsScopeRefresh 的基准
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

// 签发：iat = exp - SESSION_TTL_SEC，sfa 同 iat（签发即一次 scopes 刷新）。
// now 缺省取当前时间（测试/回放可注入固定时刻）。
export async function signSession(
  p: Omit<SessionPayload, 'iat' | 'exp' | 'sfa'>,
  secret: string,
  now: number = nowSec(),
): Promise<string> {
  return await new SignJWT({
    org: p.org,
    name: p.name,
    scopes: p.scopes,
    authVia: p.authVia,
    sfa: now,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(p.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + SESSION_TTL_SEC)
    .sign(key(secret))
}

// 验签：只做 HS256 签名与 JWS 格式校验，任何失败返回 null 不抛。
// 故意不用 jwtVerify 的 exp 时间判定——时间类决策（过期/滑动/scopes刷新）是宿主中间件
// （Task 13）基于载荷 exp + needsRenew/needsScopeRefresh 的职责；锁定测试以固定历史
// 时刻（iat=0，exp 落在 1970）签发并要求验签通过，即钉死了这一语义。
export async function verifySession(token: string, secret: string): Promise<SessionPayload | null> {
  try {
    // 算法白名单两侧对齐（签发 HS256 / 验签只认 HS256）——否则 alg 混淆面（如 HS512 token）会被接受
    const { payload } = await compactVerify(token, key(secret), { algorithms: ['HS256'] })
    const claims = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
    return {
      sub: String(claims.sub),
      org: String(claims.org),
      name: String(claims.name),
      scopes: (claims.scopes as string[]) ?? [],
      authVia: claims.authVia as SessionPayload['authVia'], // 载荷已过签名验证，cast 合理
      iat: claims.iat as number,
      exp: claims.exp as number,
      sfa: claims.sfa as number,
    }
  } catch {
    return null
  }
}

// 滑动续期：剩余寿命 < 6 天（活跃用户约每天被续一次；僵尸会话自然过 7 天绝对期作废）
export function needsRenew(s: SessionPayload, now: number = nowSec()): boolean {
  return s.exp - now < RENEW_THRESHOLD_SEC
}

// scopes 刷新：距上次取 scopes >= SCOPES_TTL_SEC（5 分钟）即建议重签以带新 scopes
export function needsScopeRefresh(s: SessionPayload, now: number = nowSec()): boolean {
  return now - s.sfa >= SCOPES_TTL_SEC
}

// CSRF token：HMAC(secret, sub + '.' + iat)——与会话绑定、无状态可验，签名不改则 token 稳定
export function csrfToken(s: SessionPayload, secret: string): string {
  return createHmac('sha256', secret).update(s.sub + '.' + s.iat).digest('hex')
}
