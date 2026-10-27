// webhook.ts — 出站 webhook：SSRF 守卫 + HMAC 签名 + 状态映射。
// 与 providers/wecom.ts 同形的 SendResult；地址来自通道 secret_refs（url/key）。
import { createHmac } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { assertSafeWebhookUrl, isForbiddenHost } from '../domain/net-guard'

export type SendResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

const MAX_BODY_BYTES = 32 * 1024

/** HMAC-SHA256 覆盖 `${timestamp}.${body}`，头里带前缀 sha256= */
export function signBody(secret: string, timestamp: number, body: string): string {
  const hex = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return `sha256=${hex}`
}

export async function sendWebhook(a: {
  url: string
  secret: string
  payload: unknown
  fetchImpl?: typeof fetch
  resolveHost?: (host: string) => Promise<string[]>
  timeoutMs?: number
}): Promise<SendResult> {
  const guard = assertSafeWebhookUrl(a.url)
  if (!guard.ok) {
    return { ok: false, kind: 'permanent', code: 'unsafe_url', summary: guard.reason }
  }

  // DNS rebinding 防护：解析后再校验 IP 段（域名守卫只能看字面量）
  const resolve = a.resolveHost
    ?? (async (h: string) => (await lookup(h, { all: true })).map((x) => x.address))
  try {
    const ips = await resolve(guard.url.hostname)
    if (ips.length === 0 || ips.some((ip) => isForbiddenHost(ip))) {
      return { ok: false, kind: 'permanent', code: 'forbidden_ip', summary: ips.join(',') }
    }
  } catch (e) {
    return {
      ok: false, kind: 'retryable', code: 'dns',
      summary: e instanceof Error ? e.message : String(e),
    }
  }

  const body = JSON.stringify(a.payload)
  const bytes = Buffer.byteLength(body)
  if (bytes > MAX_BODY_BYTES) {
    return { ok: false, kind: 'permanent', code: 'body_too_large', summary: `${bytes}B` }
  }

  const ts = Math.floor(Date.now() / 1000)
  const f = a.fetchImpl ?? fetch
  try {
    const res = await f(a.url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/json',
        'X-Notify-Timestamp': String(ts),
        'X-Notify-Signature': signBody(a.secret, ts, body),
      },
      body,
      signal: AbortSignal.timeout(a.timeoutMs ?? 5000),
    })
    if (res.status >= 200 && res.status < 300) return { ok: true }

    const retryable = res.status === 408 || res.status === 429 || res.status >= 500
    return {
      ok: false,
      kind: retryable ? 'retryable' : 'permanent',
      code: String(res.status),
      summary: `webhook HTTP ${res.status}`,
    }
  } catch (e) {
    return {
      ok: false, kind: 'retryable', code: 'network',
      summary: e instanceof Error ? e.message : String(e),
    }
  }
}
