// net-guard.ts — webhook 出站 URL 守卫（纯函数；域名解析后的 IP 检查在 provider 里做）。
const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal', 'metadata'])

export function isForbiddenHost(hostRaw: string): boolean {
  const host = hostRaw.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (host === '') return true
  if (BLOCKED_HOSTNAMES.has(host)) return true

  // IPv6 回环 / 链路本地 / ULA
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return true
  }

  if (host.endsWith('.local') || host.endsWith('.internal')) return true
  // 单标签主机（无点、无冒号）：内网 DNS 名
  if (!host.includes('.') && !host.includes(':')) return true

  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return false // 域名：交给 provider 的 DNS 解析后复查

  const p = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  if (p.some((n) => n > 255)) return true

  const [a, b] = p as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  return false
}

export function assertSafeWebhookUrl(raw: string):
  | { ok: true; url: URL }
  | { ok: false; reason: 'invalid_url' | 'not_https' | 'credentials_in_url' | 'forbidden_host' } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, reason: 'invalid_url' }
  }
  if (url.protocol !== 'https:') return { ok: false, reason: 'not_https' }
  if (url.username || url.password) return { ok: false, reason: 'credentials_in_url' }
  if (isForbiddenHost(url.hostname)) return { ok: false, reason: 'forbidden_host' }
  return { ok: true, url }
}
