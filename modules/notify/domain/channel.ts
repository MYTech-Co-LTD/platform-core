// channel.ts — 通道健康检查（纯网络适配；DB 写入在 storage）。
import { sendWebhook } from '../providers/webhook'
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
