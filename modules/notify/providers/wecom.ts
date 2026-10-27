// providers/wecom.ts — 企微 bridge 投递（平台直发；不再经 Novu）。
// bridge 契约（实测）：POST /wecom/:tenant?t=<token>&to=<userid>，body {content}
//   204 = 成功；401/400 = 永久失败；429/5xx = 可重试（body 带企微 errcode）；网络 = 可重试。
export type SendResult =
  | { ok: true }
  | { ok: false; kind: 'retryable' | 'permanent'; code: string; summary: string }

export async function sendWecom(a: {
  bridgeUrl: string
  to: string
  content: string
  fetchImpl?: typeof fetch
}): Promise<SendResult> {
  const f = a.fetchImpl ?? fetch
  const sep = a.bridgeUrl.includes('?') ? '&' : '?'
  const url = `${a.bridgeUrl}${sep}to=${encodeURIComponent(a.to)}`

  try {
    const res = await f(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: a.content }),
    })
    if (res.status === 204) return { ok: true }
    if (res.status === 400 || res.status === 401) {
      return { ok: false, kind: 'permanent', code: String(res.status), summary: `bridge HTTP ${res.status}` }
    }
    if (res.status === 429 || res.status >= 500) {
      const body = (await res.json().catch(() => ({}))) as { errcode?: number; error?: string }
      return {
        ok: false,
        kind: 'retryable',
        code: String(body.errcode ?? res.status),
        summary: body.error ?? `bridge HTTP ${res.status}`,
      }
    }
    return { ok: false, kind: 'permanent', code: String(res.status), summary: `bridge HTTP ${res.status}` }
  } catch (e) {
    return {
      ok: false,
      kind: 'retryable',
      code: 'network',
      summary: e instanceof Error ? e.message : String(e),
    }
  }
}
