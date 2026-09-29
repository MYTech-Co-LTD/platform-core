// upstream.ts — 透传到 Metabase 上游。三条纪律：
// ① **服务身份**：注入 X-API-Key（env，与模块同一把），绝不用浏览器 Cookie；
// ② **绝不透传**浏览器的 Cookie 头（platform_session / mb_edit 都不许到上游）——浏览器到反代是
//    第一方关系，反代到上游是服务关系，两者不能混；
// ③ 头改写：剥掉上游的 X-Frame-Options（否则 console 里 iframe 打不开），换成
//    `Content-Security-Policy: frame-ancestors <MB_PROXY_CONSOLE_ORIGIN>`（**只许 console 嵌它**）。
//
// ⚠️ 请求头走**白名单**（不是「黑名单剥 cookie」）：黑名单漏一个头就是漏一条通路，而白名单的
//    默认是「不带」。凡是没在白名单里的（`cookie` / `authorization` / `referer` / `origin` /
//    `host` / `x-api-key`…）一律不上行——其中 `x-api-key` 尤其重要：**不许浏览器伪造服务身份**。
import type { ProxyConfig } from './config'

/** 允许上行的浏览器请求头（其余一律丢弃）。`content-type` 供 `POST /api/card/:id/query` 的 JSON 体。 */
const FORWARD_REQUEST_HEADERS = ['accept', 'accept-language', 'content-type'] as const

/**
 * 不许出现在响应里的上游头。
 * - `x-frame-options`：剥掉（见 ③）。
 * - `content-security-policy*`：**替换**成我们自己的（见下 `consoleCsp` 的注）。
 * - `set-cookie`：纪律 ② 的**镜像面**。浏览器→反代是第一方关系，反代→上游是服务关系；
 *   上游的浏览器态 Cookie 若原样回传，就会被种到**反代自己的域**上（第一方），与 `mb_edit`
 *   同处一个 Cookie 空间——两条关系就混了。本代理调上游一律用 `X-API-Key`，不需要上游的会话
 *   Cookie ⇒ 一律剥掉。
 * - `content-length` / `content-encoding` / `transfer-encoding`：**与 body 不对应**——
 *   Node 的 fetch（undici）会自行协商压缩并**解压**响应体，上游给的 `content-length`/`content-encoding`
 *   描述的是**压缩后**的字节；原样回传会让浏览器按错误的长度/编码解读（截断或乱码）。
 *   由运行时按实际回传的 body 重新决定这几个头。
 */
const STRIP_RESPONSE_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
  'set-cookie',
  'content-length',
  'content-encoding',
  'transfer-encoding',
] as const

/**
 * console 嵌入的唯一授权来源。**为什么是「替换」而不是「追加」**：上游（Metabase）自带的 CSP
 * 若含 `frame-ancestors 'self'`，追加一条我们的是**无效的**——CSP 解析时同名指令**先到先得**、
 * 后者被忽略（CSP2 §"parse the policy"：已见过的指令名直接丢弃）⇒ 那样写等于没放行，iframe
 * 恒白屏且完全不可观测。故这里以反代为唯一权威：剥掉上游的 CSP，只发我们这一条。
 * 代价（自审已记）：上游 CSP 里的 XSS 缓解（`script-src` 等）**不再生效**；本部署的上游是受控的
 * Metabase 单实例，可接受。若将来要保留上游指令，必须改成「解析 + 合并 + 去重」而不是拼接。
 */
function consoleCsp(consoleOrigin: string): string {
  return `frame-ancestors ${consoleOrigin}`
}

/**
 * dashboard 的卡片集合缓存：60s。
 * ⚠️ 键是 `${org}:${did}`（订正记录 2026-09-29，Task 4 评审轮）：只拿 `did` 当键要靠「did 全局唯一
 *    且单实例单 key」两个**未落码**的前提才不串味——把 org 写进键，串味的前提就不必成立。
 *    进程内状态（多副本各持一份，本任务单进程形态）。
 */
const CARD_CACHE_TTL_MS = 60_000
const cardCache = new Map<string, { cards: Set<number>; expires: number }>()

/**
 * 取 `<upstream>/api/dashboard/<did>` 的 dashcards，归成 `Set<cardId>`（`decide` 的输入口）。
 *
 * **fail-closed**：取不到（非 2xx / 网络错 / 形状不对）一律返回**空集** ⇒ 卡片 query 面不放行。
 * 绝不返回「放行一切」的哨兵——上游读不出时把门开大，正是「静默失败」最坏的一种。
 *
 * ⚠️ **失败不写缓存**：缓存一次瞬时故障的空集，等于把 60s 的锁死窗口送给一次抖动；不缓存则
 *    恢复即刻生效（代价是故障期间每个请求重试一次——但那期间透传本身就是不通的，无放大）。
 *
 * ⚠️ **已知窗口（记录，不修）**：某张卡被移出 dashboard 后，最多 60s 内仍可被 query
 *    （缓存没失效）。方向是 fail-closed 侧无害（不是「多放行了别人的数据」，只是「本 dashboard
 *    刚摘下的卡还能查一小会儿」），且该卡本就属本 dashboard，故接受。
 */
export async function fetchDashboardCards(cfg: ProxyConfig, org: string, did: number): Promise<Set<number>> {
  const now = Date.now()
  const key = `${org}:${did}`
  const hit = cardCache.get(key)
  if (hit !== undefined && hit.expires > now) return hit.cards
  try {
    const res = await fetch(`${cfg.upstreamUrl}/api/dashboard/${did}`, {
      headers: { 'x-api-key': cfg.upstreamApiKey },
      redirect: 'manual',
    })
    if (!res.ok) return new Set()
    const body = (await res.json()) as { dashcards?: unknown } | null
    if (!Array.isArray(body?.dashcards)) return new Set()
    const cards = new Set<number>()
    for (const dc of body.dashcards) {
      const cid = (dc as Record<string, unknown> | null)?.card_id
      // `card_id === null` = 文本/虚拟卡（真机实测，见 domain/metabase.ts），它没有可查询的卡 ⇒ 跳过
      if (typeof cid === 'number') cards.add(cid)
    }
    cardCache.set(key, { cards, expires: now + CARD_CACHE_TTL_MS })
    return cards
  } catch {
    return new Set()
  }
}

/**
 * 透传一个已授权的请求到上游，并把响应（含头改写）回传。调用方（app.ts 的兜底）已保证：
 * 这个请求**过了鉴权与规则表**（`decide` 放行）。
 *
 * ⚠️ `path` 是**规则表判过的那一份**（`rules.normalizePath` 的产物），不是这里现取的
 *    `new URL(req.url).pathname`——两者**不等价**（Hono 的 `c.req.path` 走 `decodeURI`，与原串不同），
 *    这里自己再取一份就等于重新打开「判的是 A、发的是 B」。查询串不走判定，原样带上。
 */
export async function proxy(cfg: ProxyConfig, req: Request, path: string): Promise<Response> {
  const url = new URL(req.url)

  // 请求头白名单（见文件头注 ⚠️）：**从零构造**，绝不 spread `req.headers`。
  const headers = new Headers({ 'x-api-key': cfg.upstreamApiKey })
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.headers.get(name)
    if (v !== null) headers.set(name, v)
  }

  const init: RequestInit = {
    method: req.method,
    headers,
    // 不跟上游的重定向：跟随会把带 `x-api-key` 的请求再打到别处（凭证外泄面）。
    // ⚠️ 代价：上游的 3xx 会原样给浏览器，其 `location` **也要落在放行表里**才走得通
    //    （否则浏览器跟过去吃 403）。Task 7 的真机 e2e 负责确认 shell 那几条路径没有 3xx 中转。
    redirect: 'manual',
  }
  // GET/HEAD 不许带 body（fetch 会抛 TypeError）。其余方法把体**缓冲**下来：
  // 流式转发在 Node 侧要 `duplex: 'half'`，而这些请求（卡片 query 的 JSON）都很小，缓冲更省心。
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const body = await req.arrayBuffer()
    if (body.byteLength > 0) init.body = body
  }

  const upstreamRes = await fetch(`${cfg.upstreamUrl}${path}${url.search}`, init)

  const out = new Headers()
  for (const [k, v] of upstreamRes.headers) {
    if ((STRIP_RESPONSE_HEADERS as readonly string[]).includes(k.toLowerCase())) continue
    out.append(k, v)
  }
  out.set('content-security-policy', consoleCsp(cfg.consoleOrigin))
  // 透传响应也 no-store（订正记录 2026-09-29，Task 4 评审轮 Minor ③）：与 401/403/handoff 同口径，
  // 且这些响应是**带服务身份取的**（同一个上游对话里既有别的租户的 dashboard，也有本租户的卡片），
  // 一律不许被中间缓存落盘复用。代价：编辑页的静态资源也不再被浏览器缓存（每刷一次多一趟上游）——
  // 本代理单实例、console 内嵌使用，接受；若将来要放开，必须**按路径**区分（只对 `/app/**` 等静态面放开）。
  out.set('cache-control', 'no-store')

  // 流式回传（不整体缓冲）：编辑页的静态资源与查询响应都可能是长流。
  // ⚠️ 透传 status：上游的 4xx/5xx 是**上游对已授权请求**的答复，不能吞成 200（那会把失败变假绿）。
  return new Response(upstreamRes.body, { status: upstreamRes.status, headers: out })
}
