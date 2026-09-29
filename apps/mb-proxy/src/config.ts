/** 代理的 env 契约。缺必填一律启动期抛（照 apps/server/src/config.ts 的口径）。 */
export interface ProxyConfig {
  port: number
  sessionSecret: string
  consoleOrigin: string
  upstreamUrl: string
  upstreamApiKey: string
}

export function loadProxyConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const need = (k: string): string => {
    const v = env[k]
    if (v === undefined || v.trim() === '') throw new Error(`缺少必填环境变量 ${k}`)
    return v
  }
  const secret = need('PLATFORM_SESSION_SECRET')
  if (secret.length < 32) throw new Error(`PLATFORM_SESSION_SECRET 至少 32 字符（当前 ${secret.length}）`)
  const port = Number(need('PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT 必须是 1-65535 的整数`)
  return {
    port,
    sessionSecret: secret,
    consoleOrigin: need('MB_PROXY_CONSOLE_ORIGIN'),
    upstreamUrl: need('DATA_METABASE_URL').replace(/\/+$/, ''),
    upstreamApiKey: need('DATA_METABASE_API_KEY'),
  }
}
