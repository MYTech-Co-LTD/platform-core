// wechat-oa.ts — 微信公众号网页授权（snsapi_base 静默）：售后 spec §1.3 外部客户身份。
// 形状纪律照 wecom.ts：URL 构造纯函数 + code 换身份（null=上游拒 / throw=传输层故障）。
// 微信 API 特殊形状：**HTTP 200 + body errcode 表错**（不是 4xx）——errcode≠0 或无 openid
// 归「被拒」返 null；网络错/5xx/非 JSON 归传输层 throw（路由层 502 类 fail-loudly）。
export function buildWechatOaSilentUrl(appId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    appid: appId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'snsapi_base',
    state,
  })
  return `https://open.weixin.qq.com/connect/oauth2/authorize?${q.toString()}#wechat_redirect`
}

export async function wechatOaOpenidForCode(
  cfg: { appId: string; secret: string },
  code: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | null> {
  const q = new URLSearchParams({
    appid: cfg.appId,
    secret: cfg.secret,
    code,
    grant_type: 'authorization_code',
  })
  const r = await fetchImpl(`https://api.weixin.qq.com/sns/oauth2/access_token?${q.toString()}`)
  if (r.status >= 500) throw new Error(`wechat oauth endpoint http ${r.status}`)
  let j: { errcode?: number; openid?: string }
  try {
    j = (await r.json()) as { errcode?: number; openid?: string }
  } catch {
    throw new Error('wechat oauth endpoint returned non-json body')
  }
  if (typeof j.errcode === 'number' && j.errcode !== 0) return null
  return j.openid ?? null
}
