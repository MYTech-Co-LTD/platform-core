// edit-handoff.ts — 编辑页一次性票据（spec §3⑦ ②）。**手搓 HS256**：仓内先例见
// domain/metabase.ts 的 signEmbedToken（本仓禁 jose 出现在 packages/auth-core 之外，见
// scripts/lint-architecture.mjs 的 B2）——所以这里用 node:crypto 自己拼 JWT。
//
// 为什么由**模块**签而不是平台签：登记表 data.reports 只有模块能读（B1：apps/packages 只许
// platform schema）⇒「该 dashboard 确属本 org 且已登记」这一判定只能发生在这里。
import { createHmac } from 'node:crypto'

/** 编辑票据的存活秒数。**短**是安全设计的一部分：它只用来把身份一次性渡给反代。 */
export const EDIT_HANDOFF_TTL_SEC = 120

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64url')

/**
 * 票据密钥：从 `PLATFORM_SESSION_SECRET` **派生**的子密钥（域分隔），**不是**直接复用原始密钥。
 *
 * ⚠️ 为什么必须派生（Task 1 评审 I-1/I-2，2026-09-29 人裁修）：原始密钥有**双向串用**风险——
 *   ① 票据（会出现在 URL 里）用原始密钥签的话，宿主会话验签 `verifySession` 会把 120s 票据
 *      当**合法会话**收下，甚至被「滑动续期」分支重签成 7 天 Cookie（空 scope 身份）；
 *   ② 反过来，任何登录用户的会话 Cookie（7 天、带 org）在代理眼里也是合法票据 ⇒ 只持 `data:query`
 *      的人可能绕过 `data:manage` 页门换到编辑会话。
 * 派生后两侧**互不承认**（密钥不同），且**不新增任何 env 密钥**（派生是确定性的，两侧同式）。
 */
export function editHandoffKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update('edit-handoff-v1').digest()
}

/**
 * 签一枚编辑票据。payload `{org, did, nonce, iat, exp}`。
 * ⚠️ 格式是**跨包契约**：代理侧 `apps/mb-proxy/src/handoff.ts` 独立实现验签，两侧用同一金样本
 * 钉住（见两处测试里的金样本串）。改这里必须同步改那边。
 */
export function signEditHandoff(
  input: { org: string; did: number; nonce: string },
  secret: string,
  ttlSec: number = EDIT_HANDOFF_TTL_SEC,
  now: number = Math.floor(Date.now() / 1000),
): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({
    org: input.org, did: input.did, nonce: input.nonce, iat: now, exp: now + ttlSec,
  }))
  // ⚠️ 用**派生**子密钥（editHandoffKey），不是 secret 本身——见函数头顶注（I-1/I-2）
  const sig = createHmac('sha256', editHandoffKey(secret)).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
