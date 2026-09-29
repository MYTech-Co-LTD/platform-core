// handoff.ts — 一次性票据的**验签**侧（票据由模块签，见 modules/data/domain/edit-handoff.ts）。
// 代理只验不签：它没有签的能力，也就没有「自己给自己发身份」的面。
import { createHmac, timingSafeEqual } from 'node:crypto'
import { EDIT_TTL_SEC } from './session'

interface HandoffClaims { org: string; did: number; nonce: string }

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')
const b64urlToBuf = (s: string): Buffer => Buffer.from(s, 'base64url')

/**
 * 票据密钥 = 从 root secret **派生**的子密钥，**与模块侧同式**（`'edit-handoff-v1'` 标签必须逐字相同）。
 * 域分隔保证：会话 Cookie（原始密钥签）在这里**验不过**，票据在宿主会话验签那边也**验不过**（评审 I-1/I-2）。
 */
function handoffKey(rootSecret: string): Buffer {
  return createHmac('sha256', rootSecret).update('edit-handoff-v1').digest()
}

/** 验签 + 校验 exp。任何失败返回 null（不抛——照 auth-core 的 verifySession 风格）。 */
export function verifyEditHandoff(token: string, secret: string, now?: number): HandoffClaims | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [h, p, s] = parts
  const expect = createHmac('sha256', handoffKey(secret)).update(`${h}.${p}`).digest()
  const got = b64urlToBuf(s)
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null
  try {
    const header = JSON.parse(b64urlToBuf(h).toString('utf8')) as { alg?: string }
    if (header.alg !== 'HS256') return null
    const c = JSON.parse(b64urlToBuf(p).toString('utf8')) as Record<string, unknown>
    // exp 走**严格类型**（`typeof === 'number'`）而不是 `Number(c.exp)`：与下面 org/did/nonce 的
    // 口径一致。`Number()` 会收下 `'1700000000'` 这类字符串（不可利用——签名已过——纯纵深防御：
    // 不为「载荷里能塞进非数字 exp」留任何解释空间，也别让将来某处把 claims 原样回写时带上怪类型）。
    if (typeof c.exp !== 'number' || !Number.isFinite(c.exp)) return null
    if (c.exp <= (now ?? Math.floor(Date.now() / 1000))) return null
    if (typeof c.org !== 'string' || !c.org) return null
    if (!Number.isInteger(c.did)) return null
    if (typeof c.nonce !== 'string' || !c.nonce) return null
    return { org: c.org, did: c.did as number, nonce: c.nonce }
  } catch {
    return null
  }
}

const used = new Map<string, number>()
const NONCE_TTL_SEC = 120

/** 一次性判定：首次 true。⚠️ 进程内状态 ⇒ 重启后同一 nonce 在 TTL 内可再用一次（窗口 120s，可接受）。 */
export function claimNonce(nonce: string, now = Math.floor(Date.now() / 1000)): boolean {
  for (const [k, exp] of used) if (exp <= now) used.delete(k)
  if (used.has(nonce)) return false
  used.set(nonce, now + NONCE_TTL_SEC)
  return true
}

// —— 兑换后发给浏览器的**代理自有会话**（种进 mb_edit Cookie）。以下两点是它跟票据的区别：
//    ① 可复用（无 nonce）——它是会话，不是一次性凭证；
//    ② 用**另一条**派生密钥（'mb-edit-session-v1'），不走 handoffKey。
/**
 * 代理会话的派生密钥。**为什么也要派生**（评审 I-1/I-2 的反向）：若这枚串用**原始** secret 签，
 * 宿主的 `verifySession` 会把它当**合法会话**收下——而它的载荷没有 `sub`/`scopes`，宿主侧解出的
 * 就是「已登录但空 scope」的身份（正是票据侧要堵的那类串用）。派生后两侧互不承认。
 *
 * ⚠️ Task 4（鉴权中间件）解身份时必须用**同一**函数（别再手抄标签串），且同样先验签再取 org/did。
 */
export function proxySessionKey(rootSecret: string): Buffer {
  return createHmac('sha256', rootSecret).update('mb-edit-session-v1').digest()
}

/**
 * 签一枚代理会话票据。payload `{org, did, iat, exp: now + EDIT_TTL_SEC}`——**不含 nonce**（会话可复用）。
 */
export function signProxySession(
  input: { org: string; did: number },
  secret: string,
  ttlSec: number = EDIT_TTL_SEC,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    org: input.org, did: input.did, iat: now, exp: now + ttlSec,
  }))
  const sig = createHmac('sha256', proxySessionKey(secret)).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
