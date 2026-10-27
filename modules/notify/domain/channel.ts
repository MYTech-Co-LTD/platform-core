// channel.ts — 通道健康检查（纯网络适配；DB 写入在 storage）。
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
