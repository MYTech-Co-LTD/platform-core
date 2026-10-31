// wecom-direct.ts — 企微直连：token 缓存 + 消息发送（spec 2026-10-31 §3.1/§3.3）。
//
// 为什么要有它：`wecom_chat` 现在走共享桥，而桥要求每个客户的凭据人工搬进它的**配置文件**，
// 且租户级健康探不出来（主机 /healthz 恒 200 = 假绿）。直连后凭据只在本实例、判据 = 能取到 token。
//
// 三条工程判断：
//   ① **token 走进程内缓存 + 单飞**：企微 access_token 7200s，同 key 并发只取一次；
//      多副本各缓存即可（token 无状态、可并存）⇒ 不引 Redis（私有化少依赖）。
//   ② **errcode 分类**：40001/42001（token 无效/过期）⇒ 刷新一次重试；45009（频率超限）⇒ 可重试；
//      81013/60020（用户不存在 / IP 不受信）⇒ 永久失败（重试无用，要人去改配置）。
//   ③ **`probe` 只证明凭据活着**：取到 token 即 ok——这是唯一不撒谎的活性信号
//      （桥的 `/healthz` 只能证明桥进程活着）。
//
// 网络调用全部可注入 fetchImpl（单测不发真请求）。
import type { SendResult } from '../../providers/wecom'

const DEFAULT_API = 'https://qyapi.weixin.qq.com'

export interface WecomDirectCred {
  corpId: string
  agentId: string
  secret: string
}

interface TokenLease { token: string; expiresAt: number }

/** 进程内 token 缓存（key = corpId|agentId）。单飞：同 key 并发只发一次请求。 */
const tokenCache = new Map<string, TokenLease>()
const inflight = new Map<string, Promise<TokenLease>>()

/** 测试缝：清空缓存（跨用例不串）。 */
export function __resetTokenCache(): void {
  tokenCache.clear()
  inflight.clear()
}

/** TTL 提前 300s 失效：避免"刚好过期"的请求撞 42001。 */
const SKEW_MS = 300_000

export async function accessToken(
  cred: WecomDirectCred,
  opts: { fetchImpl?: typeof fetch; apiBase?: string; now?: () => number } = {},
): Promise<TokenLease> {
  const key = `${cred.corpId}|${cred.agentId}`
  const now = (opts.now ?? Date.now)()
  const hit = tokenCache.get(key)
  if (hit !== undefined && hit.expiresAt - SKEW_MS > now) return hit
  const running = inflight.get(key)
  if (running !== undefined) return running

  const p = (async (): Promise<TokenLease> => {
    const f = opts.fetchImpl ?? fetch
    const base = opts.apiBase ?? DEFAULT_API
    const url = `${base}/cgi-bin/gettoken?corpid=${encodeURIComponent(cred.corpId)}&corpsecret=${encodeURIComponent(cred.secret)}`
    const res = await f(url)
    const body = (await res.json().catch(() => ({}))) as {
      errcode?: number; errmsg?: string; access_token?: string; expires_in?: number
    }
    if (body.errcode !== 0 || typeof body.access_token !== 'string') {
      // 40013/40001 = corpId/secret 错；这里统一抛错，由上层按 errcode 分类
      throw Object.assign(new Error(`wecom gettoken errcode=${body.errcode ?? '?'} ${body.errmsg ?? ''}`.trim()), {
        errcode: body.errcode ?? null,
      })
    }
    const lease: TokenLease = {
      token: body.access_token,
      expiresAt: now + (body.expires_in ?? 7200) * 1000,
    }
    tokenCache.set(key, lease)
    return lease
  })().finally(() => { inflight.delete(key) })

  inflight.set(key, p)
  return p
}

/** 企微 errcode → 我们的重试分类（只列会遇到的，未列的按永久失败处理）。 */
export function classifyErrcode(errcode: number | undefined): 'retryable' | 'permanent' {
  if (errcode === undefined) return 'retryable' // 网络层/无法解析 ⇒ 当可重试
  if (errcode === 45009 || errcode === 45033 || errcode === -1) return 'retryable' // 频率/系统繁忙
  if (errcode === 40001 || errcode === 42001 || errcode === 40014) return 'retryable' // token 类（上层会刷新一次）
  return 'permanent'
}

export async function sendDirect(a: {
  cred: WecomDirectCred
  to: string
  content: string
  fetchImpl?: typeof fetch
  apiBase?: string
  now?: () => number
}): Promise<SendResult> {
  const call = async (token: string): Promise<{ status: number; body: { errcode?: number; errmsg?: string } }> => {
    const f = a.fetchImpl ?? fetch
    const base = a.apiBase ?? DEFAULT_API
    const res = await f(`${base}/cgi-bin/message/send?access_token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        touser: a.to,
        msgtype: 'markdown',
        agentid: Number(a.cred.agentId),
        markdown: { content: a.content },
      }),
    })
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
    return { status: res.status, body }
  }

  try {
    let lease = await accessToken(a.cred, { fetchImpl: a.fetchImpl, apiBase: a.apiBase, now: a.now })
    let r = await call(lease.token)
    // token 无效/过期：**重启缓存立刻换一次再试**（只重试一次，不无限循环）
    if (r.body.errcode === 40001 || r.body.errcode === 42001 || r.body.errcode === 40014) {
      tokenCache.delete(`${a.cred.corpId}|${a.cred.agentId}`)
      lease = await accessToken(a.cred, { fetchImpl: a.fetchImpl, apiBase: a.apiBase, now: a.now })
      r = await call(lease.token)
    }
    if (r.body.errcode === 0) return { ok: true }
    return {
      ok: false,
      kind: classifyErrcode(r.body.errcode),
      code: String(r.body.errcode ?? r.status),
      summary: r.body.errmsg ?? `wecom HTTP ${r.status}`,
    }
  } catch (e) {
    const errcode = (e as { errcode?: number }).errcode
    return {
      ok: false,
      kind: classifyErrcode(errcode),
      code: String(errcode ?? 'network'),
      summary: e instanceof Error ? e.message : String(e),
    }
  }
}

/** 活性判据：能取到 token 即活（覆盖「凭据失效 / 被禁用 / 出口 IP 被拒」）。 */
export async function probeDirect(
  cred: WecomDirectCred,
  opts: { fetchImpl?: typeof fetch; apiBase?: string } = {},
): Promise<{ ok: boolean; detail?: string }> {
  try {
    await accessToken(cred, opts)
    return { ok: true }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * 个人级可达性：`user/get` 查一个 userid（幂等、不发消息）。
 *
 * 与 `probeDirect` 的分工：那个回答「应用凭据活着吗」，这个回答「**这个人**收得到吗」。
 * 只有它才看得见「收件人不在应用可见范围」（`60111`/`81013`）——判据永远看不见的那一类失败。
 */
export async function probeUser(
  cred: WecomDirectCred,
  userId: string,
  opts: { fetchImpl?: typeof fetch; apiBase?: string; now?: () => number } = {},
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const lease = await accessToken(cred, opts)
    const f = opts.fetchImpl ?? fetch
    const base = opts.apiBase ?? DEFAULT_API
    const res = await f(
      `${base}/cgi-bin/user/get?access_token=${encodeURIComponent(lease.token)}&userid=${encodeURIComponent(userId)}`,
    )
    const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
    if (body.errcode === 0) return { ok: true }
    return { ok: false, detail: `${body.errcode ?? res.status} ${body.errmsg ?? ''}`.trim() }
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) }
  }
}
