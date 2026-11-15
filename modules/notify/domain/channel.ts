// channel.ts — 通道健康检查（纯网络适配；DB 写入在 storage）。
import type { Pool } from 'pg'
import { sendWebhook } from '../providers/webhook'
import { resolveWecomCredential } from './credential-store'
import { probeDirect } from './im/wecom-direct'
export async function checkWecomHealth(
  bridgeUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: boolean; detail?: string }> {
  // bridge URL 形如 https://push.hookflow.cn/wecom/<tenant>?t=<token>；healthz 在 host 根
  const url = new URL('/healthz', bridgeUrl).toString()
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) })
    return res.status === 200 ? { ok: true } : { ok: false, detail: `HTTP ${res.status}` }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * webhook 健康探测：发一个**签名 + 空探针**的请求，2xx 视为健康。
 * 走与投递同一条 sendWebhook 路径 ⇒ 守卫/签名/超时口径一致（不会出现「探测通过、投递失败」）。
 */
export async function checkWebhookHealth(a: {
  url: string
  key: string
  fetchImpl?: typeof fetch
  resolveHost?: (h: string) => Promise<string[]>
}): Promise<{ ok: boolean; detail?: string }> {
  const r = await sendWebhook({
    url: a.url,
    secret: a.key,
    payload: { probe: 'health' },
    fetchImpl: a.fetchImpl,
    resolveHost: a.resolveHost,
    timeoutMs: 5000,
  })
  return r.ok ? { ok: true } : { ok: false, detail: `${r.code}: ${r.summary}` }
}

/**
 * 直连企微的活性检查：**凭据能换到 token 才算活**。
 *
 * 不能再读 `secret_refs.bridge_url`——直连通道按设计不保留桥 env（#1219），
 * 用桥的判据测直连会恒报 `bridge_url env 未配置`，是假红。
 */
export async function checkWecomDirectHealth(a: {
  pool: Pool
  org: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
}): Promise<{ ok: boolean; detail?: string }> {
  const cred = await resolveWecomCredential(a.pool, a.org, a.env ?? process.env)
  if (!cred.ok) {
    return {
      ok: false,
      detail: `credential_${cred.reason}${cred.detail ? `: ${cred.detail}` : ''}`,
    }
  }
  return probeDirect(cred.cred, { fetchImpl: a.fetchImpl })
}
