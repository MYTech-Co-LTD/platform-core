// wecom.ts — 企微登录三件（auth-core 层）：Casdoor authorize URL（qr/silent）+ 企微静默 URL + code 换 userid。
//
// 形状移植自旧仓 gateway 生产验证版（只读参考：provider-login.js / sso-shell.js）：
//   - 静默 URL = https://open.weixin.qq.com/connect/oauth2/authorize（snsapi_base：企微内置
//     浏览器内免扫码免确认），#wechat_redirect 收尾是企微网页授权契约，不可省。
//   - code 换 userid = Casdoor WeComInternalIdProvider 同款链路：gettoken(corpid+corpsecret)
//     → access_token → auth/getuserinfo(code) → userid（memory：代开发 corp token 走 gettoken，
//     gettoken 不限 IP、get_jsapi_ticket 才有可信 IP 闸门）。
// 与旧实现的【关键差异】：旧仓 authorize state 经 btoa(内层 OAuth 参数) 编码（与 Casdoor 前端
// getStateFromQueryParams 逐字节一致）；本层 state 【原样透传】——state 的语义（编码/绑定/CSRF）
// 是宿主路由（Task 14）的责任，本层只做 URLSearchParams 的 query 序列化百分号编码。
// 纯逻辑 + 依赖注入 fetch（casdoor-client.ts 同款约定）。qyapi.weixin.qq.com / open.weixin.qq.com
// 是企微官方 API 域名字面量，非 hookflow.cn/公网 IP（B8 白名单认知，允许出现在源码）。

/** 企微 corp 配置（租户级）：agentId 可选——静默 URL 的 agentid 仅在配置时携带 */
export interface WecomCorpConfig {
  corpId: string
  agentId?: string
}

// provider 名 platform-core 固定约定：宿主租户在 Casdoor 统一建名为 provider_wecom 的
// WeCom provider，qr（iframe 内嵌扫码页）与 silent（宿主整页跳转）两流共用同一预选参数，
// mode 由宿主/前端区分渲染方式。
const WECOM_PROVIDER_NAME = 'provider_wecom'
const AUTHORIZE_PATH = '/login/oauth/authorize'
const SILENT_ENDPOINT = 'https://open.weixin.qq.com/connect/oauth2/authorize'
const GETTOKEN_URL = 'https://qyapi.weixin.qq.com/cgi-bin/gettoken'
const GETUSERINFO_URL = 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo'

/**
 * Casdoor authorize URL（企微 provider 预选）：
 * - mode='qr'：provider 二维码 iframe 地址（登录页 <iframe src> 直用）；
 * - mode='silent'：宿主用（整页导航），mode 告知前端走静默变体。
 * state 原样透传（见文件头），编码责任在调用方。
 */
export function buildAuthorizeUrl(
  casdoorOrigin: string,
  clientId: string,
  redirectUri: string,
  state: string,
  mode: 'qr' | 'silent',
): string {
  const qs = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'read',
    state,
    provider: WECOM_PROVIDER_NAME,
    mode,
  })
  return `${casdoorOrigin.replace(/\/+$/, '')}${AUTHORIZE_PATH}?${qs}`
}

/**
 * 企微内静默授权 URL（snsapi_base，免扫码免确认，仅换企微 userid）。
 * #wechat_redirect 收尾；agentid 仅在配置时携带。
 */
export function buildWecomSilentUrl(cfg: WecomCorpConfig, redirectUri: string, state: string): string {
  const qs = new URLSearchParams({
    response_type: 'code',
    scope: 'snsapi_base',
    appid: cfg.corpId,
    redirect_uri: redirectUri,
    state,
  })
  if (cfg.agentId) qs.set('agentid', cfg.agentId)
  return `${SILENT_ENDPOINT}?${qs}#wechat_redirect`
}

// access_token 缓存：模块级 Map 按 corpId 键，expire 前复用，过期判定留 60s 提前量
// （企微 access_token 有效期 7200s，提前量防边界失效；进程内缓存，重启即清可接受）。
const tokenCache = new Map<string, { token: string; expiresAt: number }>()
const TOKEN_EARLY_MS = 60_000

/**
 * 企微 code → userid：gettoken（corpid+corpsecret，企微契约只认 query 形参）→ access_token
 * → auth/getuserinfo(code) → userid。非 0 errcode 抛 Error('wecom api errcode <n>')。
 * fetchFn 默认 globalThis.fetch（测试/冒烟注入）。
 */
export async function wecomUserIdForCode(
  cfg: WecomCorpConfig & { secret: string },
  code: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string> {
  const cached = tokenCache.get(cfg.corpId)
  let token: string
  if (cached && cached.expiresAt - TOKEN_EARLY_MS > Date.now()) {
    token = cached.token
  } else {
    const qs = new URLSearchParams({ corpid: cfg.corpId, corpsecret: cfg.secret })
    const r = await fetchFn(`${GETTOKEN_URL}?${qs}`)
    const j = (await r.json()) as { errcode?: number; access_token?: string; expires_in?: number }
    if (j.errcode) throw new Error('wecom api errcode ' + j.errcode)
    if (!j.access_token) throw new Error('wecom gettoken response missing access_token')
    token = j.access_token
    const expiresIn = Number(j.expires_in)
    tokenCache.set(cfg.corpId, {
      token,
      expiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 7200) * 1000,
    })
  }

  const qs = new URLSearchParams({ access_token: token, code })
  const r = await fetchFn(`${GETUSERINFO_URL}?${qs}`)
  const j = (await r.json()) as { errcode?: number; userid?: string }
  if (j.errcode) throw new Error('wecom api errcode ' + j.errcode)
  if (!j.userid) throw new Error('wecom getuserinfo response missing userid')
  return j.userid
}
