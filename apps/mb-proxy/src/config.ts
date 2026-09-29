/** 代理的 env 契约。缺必填一律启动期抛（照 apps/server/src/config.ts 的口径）。 */
export interface ProxyConfig {
  port: number
  sessionSecret: string
  consoleOrigin: string
  upstreamUrl: string
  upstreamApiKey: string
}

export function loadProxyConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  // ⚠️ 访问器**必须叫 `requireValue`**（就是宿主 `apps/server/src/config.ts:62` 那个名字）：
  //    B9 门禁（`scripts/check-env-example.mjs:57-73`）只认四种构造——`process.env.<KEY>`（点读）、
  //    `process.env['<KEY>']`（下标读）、`env.<KEY>`（宿主注入式记录读）、以及按**标识符**匹配的
  //    `requireValue('<KEY>')`/`optional('<KEY>')`（必填/可选形参）。
  //    自己起名 `need(...)` ⇒ 这些键**不被机械守住**（删掉 `.env.example` 声明门禁也照样绿，只靠人记得）。
  //    上面例子写 `<KEY>` 而非真键名：**B9 不剥注释**（与 lint-architecture 的 maskComments 不同），
  //    注释里写真的点读/记录读（如 `process.env.<KEY>` 去掉尖括号）会被它当成真读法，
  //    报一条键名 "KEY" 未声明的假阳性。改本段注释后**必须重跑 check-env-example**。
  const requireValue = (k: string): string => {
    const v = env[k]
    if (v === undefined || v.trim() === '') throw new Error(`缺少必填环境变量 ${k}`)
    return v
  }
  const secret = requireValue('PLATFORM_SESSION_SECRET')
  if (secret.length < 32) throw new Error(`PLATFORM_SESSION_SECRET 至少 32 字符（当前 ${secret.length}）`)
  const port = Number(requireValue('PORT'))
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT 必须是 1-65535 的整数`)
  return {
    port,
    sessionSecret: secret,
    consoleOrigin: requireValue('MB_PROXY_CONSOLE_ORIGIN'),
    upstreamUrl: requireValue('DATA_METABASE_URL').replace(/\/+$/, ''),
    upstreamApiKey: requireValue('DATA_METABASE_API_KEY'),
  }
}
