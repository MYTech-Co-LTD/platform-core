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
  // ⚠️ `MB_PROXY_CONSOLE_ORIGIN` 的形状**必须校验**（订正记录 2026-09-29，Task 4 评审轮）：
  //    它是 CSP `frame-ancestors` 的**唯一**来源，而本代理同时又**剥掉了上游的 X-Frame-Options**
  //    ⇒ 这个值配错（空串/写成 `*`/忘了 scheme/**带路径**）的后果不是「启动报错」而是
  //    **CSP 失效 + XFO 已剥 = 任意站点都能 iframe 编辑页**（fail-open，且线上静默）。
  //
  //    **校验口径 = 只许 `https://<host[:port]>`**（无路径 / 无查询 / 无片段）；末尾斜杠先归一
  //    （`https://a.com/` 与 `https://a.com` 必须等价，否则 CSP 值带斜杠不匹配）。实现走
  //    「解析成 URL 后比 `origin`」而不是拼正则：`origin` 恰好就是「scheme+host+port」，
  //    与我们要的语义同构。返回**规范化的 `origin`**（顺带统一大小写）。
  //
  //    为什么**带路径也必须拒**（不是洁癖）：带路径的 source 在 `frame-ancestors` 里的语义
  //    **跨引擎不一致**——CSP3 下 frame-ancestors 只按 origin 匹配、路径被忽略，而 CSP2 的
  //    host-source 是允许带路径的。即 `https://console.example/path` 到底「只许 path 下的页面嵌」
  //    还是「谁都行」，取决于浏览器 ⇒ **不是一条可以依赖的保证**，启动期直接拒掉最省心。
  const rawConsoleOrigin = requireValue('MB_PROXY_CONSOLE_ORIGIN').replace(/\/+$/, '')
  let parsedConsoleOrigin: URL
  try {
    parsedConsoleOrigin = new URL(rawConsoleOrigin)
  } catch {
    throw new Error(`MB_PROXY_CONSOLE_ORIGIN 不是合法 URL（应形如 https://console.example，当前 ${rawConsoleOrigin}）`)
  }
  if (parsedConsoleOrigin.protocol !== 'https:' || parsedConsoleOrigin.origin.toLowerCase() !== rawConsoleOrigin.toLowerCase()) {
    throw new Error(`MB_PROXY_CONSOLE_ORIGIN 只许 https://<host[:port]>（不许路径/查询/片段，当前 ${rawConsoleOrigin}）`)
  }
  return {
    port,
    sessionSecret: secret,
    consoleOrigin: parsedConsoleOrigin.origin,
    upstreamUrl: requireValue('DATA_METABASE_URL').replace(/\/+$/, ''),
    upstreamApiKey: requireValue('DATA_METABASE_API_KEY'),
  }
}
