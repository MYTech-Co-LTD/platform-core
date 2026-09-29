// rules.ts — 反代的授权规则表（spec §3⑦ ③）。**deny-by-default**：不在放行表里的一律拒。
//
// 设计上只授权**票据里那一张 dashboard**（+ 它的卡片的 query 面）：比「本租户全部已登记对象」
// 更严，代价是编辑页里不能跳去别的报表（console 列表才是导航面，每张各自领一张票据）。
// 每条放行都必须写明用途；枚举类与任意查询类**永久禁止**（见 denied 测试的注释）。
//
// ⚠️ **两条订正记录（2026-09-29，Task 4 评审轮）**：
//   ① **归一化必须按「段白名单」收口**，不能只折精确 `..` 段——实测 `/app/..;/api/search`、
//      `/app/..%20/api/search`、`/app/..%00/api/search` 都能满足 `/app/` 前缀而被放行并上行
//      （上游 Jetty 对 `;`/空白/NUL 的 canonicalization 不可控 ⇒ 不能赌它）。任何含白名单外
//      字符的段**整条路径拒**（含 `%`：合法路径里几乎不出现，fail-closed 的代价可接受）。
//   ② **dashcard 路径必须同时校验卡片归属**（`cid ∈ cards`），否则「卡片集合」那道 fail-closed
//      门形同虚设（只判 did 时，任何卡片 id 都能借本 dashboard 的壳上行）。
//
// 为什么归一化必须与判定**同一个结果**（2026-09-29 实施轮由变异确认挖出）：Hono 的 `c.req.path`
// 只走 `decodeURI`、**不解析 `%2f`** ⇒ `GET /app/..%2f..%2fapi/search` 曾命中 `/app/` 前缀被
// **放行（200）并原样上行**，「封枚举面」被整条绕过。故 app.ts 把归一化结果存进 `proxyPath`，
// 透传用的就是它——「判的是 A、发的是 B」在结构上不可能发生。
const SEG_RE = /^[A-Za-z0-9._~-]+$/

/** 归约路径；任何不合规段返回 null（= 调用方按 deny 处理）。判定与上行**共用**它的结果。 */
export function normalizePath(rawPath: string): string | null {
  const out: string[] = []
  for (const seg of rawPath.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (out.length === 0) return null; out.pop(); continue }
    if (!SEG_RE.test(seg)) return null          // '..;' / '%20' / '%00' / 空白 / 非 ASCII 一律拒
    out.push(seg)
  }
  return '/' + out.join('/')
}

const SHELL_PREFIXES = ['/app/', '/static/', '/assets/'] as const
const SHELL_EXACT = new Set(['/', '/index.html', '/favicon.ico', '/api/session/properties'])
const SHELL_METHODS = new Set(['GET', 'HEAD'])   // 壳/静态只读：PUT/DELETE /app/** 不放行

export function decide(
  path: string, method: string, ctx: { did: number; cards: ReadonlySet<number> },
): 'allow' | 'deny' {
  const isRead = SHELL_METHODS.has(method)
  if (SHELL_EXACT.has(path) && isRead) return 'allow'
  if (isRead && SHELL_PREFIXES.some((p) => path.startsWith(p))) return 'allow'

  // 本票据授权的那张 dashboard：页面 + 它的 API
  if (isRead && path === `/dashboard/${ctx.did}`) return 'allow'
  if (isRead && path === `/api/dashboard/${ctx.did}`) return 'allow'
  // dashcard 查询：**did 与 cid 都要过**（订正记录 ②）
  // ⚠️ 这一条**不加读方法闸**（订正记录 2026-09-29，重审明确）：真机上卡片查询走 **POST**
  //    （`POST /api/dashboard/:did/dashcard/:n/card/:cid/query`），若照壳/静态那套只放 GET/HEAD
  //    就会**误伤真机编辑态**。这里的口子由**路径形状**收口（三段 id 全数字 + 末段固定 `query`），
  //    方法维度不参与——别为了「看起来统一」给它补闸。
  const dc = /^\/api\/dashboard\/(\d+)\/dashcard\/\d+\/card\/(\d+)\/query$/.exec(path)
  if (dc && Number(dc[1]) === ctx.did && ctx.cards.has(Number(dc[2]))) return 'allow'

  // 卡片**查询**面：只放行属于本 dashboard 的卡片，且只有 query 这一个动作
  if (method === 'POST') {
    const cq = /^\/api\/card\/(\d+)\/query$/.exec(path)
    if (cq && ctx.cards.has(Number(cq[1]))) return 'allow'
  }
  return 'deny'
}
