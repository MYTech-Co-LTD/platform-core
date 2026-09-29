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
 * 签一枚编辑票据。payload `{org, did, nonce, iat, exp}`。
 * ⚠️ 格式是**跨包契约**：代理侧 `apps/mb-proxy/src/handoff.ts` 独立实现验签，两侧用同一金样本
 * 钉住（见两处测试里的 `<GOLDEN_TOKEN>`）。改这里必须同步改那边。
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
  const sig = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${sig}`
}
