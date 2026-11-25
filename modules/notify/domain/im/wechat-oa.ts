// wechat-oa.ts — 公众号模板消息（服务号）：access_token 缓存 + 模板消息发送（#2805）。
//
// 为什么要有它：员工在公众号里提交售后工单，回执与处理结果要回推给**提交人本人**；
// 现有通道只有企微（发给管理员）与站内信（要人回控制台看），触达不到「只在公众号里活动的人」。
//
// 四条工程判断（与 wecom-direct.ts 同款纪律）：
//   ① **token 走进程内缓存 + 单飞**：公众号 access_token 7200s、**全局唯一且取新会让旧的失效**，
//      所以同 key 并发只取一次（多取 = 互相踢掉对方 token）。
//   ② **errcode 分类**：40001/42001/40014（token 无效/过期/不合法）⇒ 刷新一次重试；
//      45009（频率超限）、45047（客服消息超限）⇒ **可重试**；
//      43004（用户未关注）、40003（openid 非法）、40037（模板 ID 非法）⇒ **永久失败**（重试无用，要人改配置）。
//   ③ **48 小时窗口**：模板消息只对「最近 48h 与公众号有交互或已关注」的用户可达。超窗时微信
//      返回 43004，我们判**永久失败**并保留原文——把「窗口问题」与「真错误」在同一列里可分辨
//      （last_error 带 errcode），不静默丢弃。
//   ④ **`probe` 只证明凭据活着**：取到 token 即 ok——与企微直连同一口径（唯一不撒谎的活性信号）。
//
// 网络调用全部可注入 fetchImpl（单测不发真请求）。
import type { ProviderResult, SendContext, DeliveryLike } from './senders'

const DEFAULT_API = 'https://api.weixin.qq.com'

/** 单次出站请求的默认超时：挂起的微信 API 不能卡住整个 worker。 */
export const DEFAULT_WECHAT_TIMEOUT_MS = 10_000

export interface WechatOaCred {
  appId: string
  appSecret: string
}

interface TokenLease { token: string; expiresAt: number }

/** 进程内 token 缓存（key = appId）。单飞：同 key 并发只发一次请求。 */
const tokenCache = new Map<string, TokenLease>()
const inflight = new Map<string, Promise<TokenLease>>()

/** 测试缝：清空缓存（跨用例不串）。 */
export function __resetWechatTokenCache(): void {
  tokenCache.clear()
  inflight.clear()
}

/** TTL 提前 300s 失效：避免「刚好过期」的请求撞 42001。 */
const SKEW_MS = 300_000

export async function wechatAccessToken(
  cred: WechatOaCred,
  opts: {
    fetchImpl?: typeof fetch
    apiBase?: string
    now?: () => number
    noCache?: boolean
    timeoutMs?: number
  } = {},
): Promise<{ ok: true; token: string } | { ok: false; code: string; summary: string }> {
  const now = opts.now ?? Date.now
  const base = opts.apiBase ?? DEFAULT_API
  const key = cred.appId

  if (!opts.noCache) {
    const hit = tokenCache.get(key)
    if (hit && hit.expiresAt > now()) return { ok: true, token: hit.token }
    const pending = inflight.get(key)
    if (pending) {
      try {
        return { ok: true, token: (await pending).token }
      } catch (e) {
        return { ok: false, code: 'token_fetch_failed', summary: (e as Error)?.message ?? 'token fetch failed' }
      }
    }
  }

  const run = async (): Promise<TokenLease> => {
    const url = `${base}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(cred.appId)}&secret=${encodeURIComponent(cred.appSecret)}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_WECHAT_TIMEOUT_MS)
    try {
      const res = await (opts.fetchImpl ?? fetch)(url, { signal: ctrl.signal })
      const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string }
      if (!res.ok || !body.access_token) {
        throw Object.assign(new Error(`wechat token failed: ${body.errcode ?? res.status} ${body.errmsg ?? ''}`.trim()), {
          code: String(body.errcode ?? res.status),
        })
      }
      const ttlMs = Math.max(((body.expires_in ?? 7200) * 1000) - SKEW_MS, 60_000)
      return { token: body.access_token, expiresAt: now() + ttlMs }
    } finally {
      clearTimeout(timer)
    }
  }

  const p = run()
  if (!opts.noCache) inflight.set(key, p)
  try {
    const lease = await p
    if (!opts.noCache) {
      tokenCache.set(key, lease)
      inflight.delete(key)
    }
    return { ok: true, token: lease.token }
  } catch (e) {
    if (!opts.noCache) inflight.delete(key)
    return { ok: false, code: 'token_fetch_failed', summary: (e as Error)?.message ?? 'token fetch failed' }
  }
}

/** token 失效类 errcode：刷新后重试一次（与原实现同一判据）。 */
const TOKEN_ERRCODES = new Set([40001, 42001, 40014])
/** 永久失败：重试无用，要人去改公众号配置（关注/模板/openid）。 */
const PERMANENT_ERRCODES = new Set([43004, 40003, 40037])

function classify(errcode: number): ProviderResult | null {
  if (TOKEN_ERRCODES.has(errcode)) return { ok: false, kind: 'retryable', code: `wechat_${errcode}`, summary: 'access_token invalid/expired' }
  if (PERMANENT_ERRCODES.has(errcode)) {
    return {
      ok: false, kind: 'permanent', code: `wechat_${errcode}`,
      // summary 必须带 errcode：`notify.delivery` 只存 last_error（没有 code 列），
      // 2026-11-25 实测把 40037 简化成「wechat permanent error」后，运维无法判断
      // 是「模板无效」还是「用户未关注」——两者的处置完全不同。
      summary: errcode === 43004
        ? `user not subscribed or outside 48h window (errcode ${errcode})`
        : `wechat permanent error (errcode ${errcode})`,
    }
  }
  if (errcode === 45009 || errcode === 45047) return { ok: false, kind: 'retryable', code: `wechat_${errcode}`, summary: 'rate limited' }
  return null
}

/**
 * 渲染出的 `wechat_oa` 内容形状（模板 contents 里按 provider 分组的那一份）：
 * `{ template_id, url?, first?, keyword1?, ..., remark? }` —— 除保留键外，其余键都进 `data`。
 */
const RESERVED = new Set(['template_id', 'url'])

export async function sendWechatOa(
  ctx: SendContext,
  d: DeliveryLike,
  opts: { apiBase?: string; now?: () => number; timeoutMs?: number; noTokenCache?: boolean } = {},
): Promise<ProviderResult> {
  const cred = ctx.credential as WechatOaCred | undefined
  if (!cred?.appId || !cred?.appSecret) {
    return { ok: false, kind: 'permanent', code: 'credential_missing', summary: 'wechat_oa 通道未配置 appId/appSecret' }
  }
  if (!d.address) {
    return { ok: false, kind: 'permanent', code: 'missing_channel_address', summary: 'wechat_oa 需要 openid' }
  }

  const content = (d.rendered ?? {}) as Record<string, unknown>
  const templateId = typeof content.template_id === 'string' ? content.template_id : ''
  if (!templateId) {
    return { ok: false, kind: 'permanent', code: 'template_id_missing', summary: '模板未配置 template_id' }
  }

  const data: Record<string, { value: string }> = {}
  for (const [k, v] of Object.entries(content)) {
    if (RESERVED.has(k)) continue
    if (v === undefined || v === null) continue
    data[k] = { value: String(v) }
  }

  const url = typeof content.url === 'string' && content.url !== '' ? content.url : undefined

  const attempt = async (token: string) => {
    const api = opts.apiBase ?? DEFAULT_API
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? DEFAULT_WECHAT_TIMEOUT_MS)
    try {
      const res = await (ctx.fetchImpl ?? fetch)(`${api}/cgi-bin/message/template/send?access_token=${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ touser: d.address, template_id: templateId, ...(url ? { url } : {}), data }),
        signal: ctrl.signal,
      })
      const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  const tokenOf = () =>
    wechatAccessToken(cred, {
      fetchImpl: ctx.fetchImpl, apiBase: opts.apiBase, now: opts.now, noCache: opts.noTokenCache, timeoutMs: opts.timeoutMs,
    })

  const first = await tokenOf()
  if (!first.ok) return { ok: false, kind: 'retryable', code: first.code, summary: first.summary }

  let body = await attempt(first.token)
  const errcode = Number(body.errcode ?? 0)
  if (TOKEN_ERRCODES.has(errcode)) {
    // ① token 被判失效 ⇒ **强制刷新一次**再试（缓存里那份可能已被别的实例踢掉）
    const fresh = await wechatAccessToken(cred, {
      fetchImpl: ctx.fetchImpl, apiBase: opts.apiBase, now: opts.now, noCache: true, timeoutMs: opts.timeoutMs,
    })
    if (!fresh.ok) return { ok: false, kind: 'retryable', code: fresh.code, summary: fresh.summary }
    body = await attempt(fresh.token)
  }

  const finalCode = Number(body.errcode ?? 0)
  if (finalCode !== 0) {
    const cls = classify(finalCode)
    if (cls) return cls
    return { ok: false, kind: 'retryable', code: `wechat_${finalCode}`, summary: body.errmsg ?? 'wechat send failed' }
  }
  return { ok: true }
}
