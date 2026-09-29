// rules.ts — 反代的授权规则表（spec §3⑦ ③）。**deny-by-default**：不在放行表里的一律拒。
//
// 设计上只授权**票据里那一张 dashboard**（+ 它的卡片的 query 面）：比「本租户全部已登记对象」
// 更严，代价是编辑页里不能跳去别的报表（console 列表才是导航面，每张各自领一张票据）。
// 每条放行都必须写明用途；枚举类与任意查询类**永久禁止**（见 denied 测试的注释）。
const SHELL_PREFIXES = ['/app/', '/static/', '/assets/'] as const
const SHELL_EXACT = new Set(['/', '/index.html', '/favicon.ico', '/api/session/properties'])

export function decide(
  path: string, method: string, ctx: { did: number; cards: ReadonlySet<number> },
): 'allow' | 'deny' {
  if (SHELL_EXACT.has(path)) return 'allow'
  if (SHELL_PREFIXES.some((p) => path.startsWith(p))) return 'allow'

  // 本票据授权的那张 dashboard：页面 + 它的 API（含 dashcard 查询路径）
  if (path === `/dashboard/${ctx.did}`) return 'allow'
  if (path === `/api/dashboard/${ctx.did}`) return 'allow'
  const dc = /^\/api\/dashboard\/(\d+)\/dashcard\/\d+\/card\/\d+\/query$/.exec(path)
  if (dc && Number(dc[1]) === ctx.did) return 'allow'

  // 卡片**查询**面：只放行属于本 dashboard 的卡片，且只有 query 这一个动作
  if (method === 'POST') {
    const cq = /^\/api\/card\/(\d+)\/query$/.exec(path)
    if (cq && ctx.cards.has(Number(cq[1]))) return 'allow'
  }
  return 'deny'
}

/** 反复转义的最大轮数（`%252f` 这类嵌套；超过即视为不可信 ⇒ deny）。 */
const MAX_DECODE_ROUNDS = 4

/**
 * 把请求路径归一化成**唯一一份**判定用的路径；不可信 ⇒ `null`（调用方一律 deny）。
 *
 * **为什么必须有这一层**（实测，非推测）：`decide` 的放行表是**前缀/正则**匹配，而「Hono 交给我们
 * 的路径」与「上游解出来的路径」**不是同一个字符串**：
 *   - Hono 的 `c.req.path` 走 `decodeURI` —— 它**不**解 `%2f`（`/` 是保留字）⇒ 拿到的是
 *     `/app/..%2f..%2fapi/search`；
 *   - 而这条路径带 `/app/` 前缀 ⇒ 命中放行表 ⇒ **放行**；上游（Jetty 等）再解一层 `%2f`
 *     就成了 `/api/search` —— 正是本表**永久禁止**的枚举面。
 * 即「判的是 A、发的是 B」。修法：先归一化出唯一一份路径，**判定用它、上行也用它**
 * （见 app.ts 的 `proxyPath`）——于是「判了 A 却发了 B」在结构上不可能发生。
 *
 * 归一化 = 反复**完全**解码（吃掉 `%2f`/`%252f`/… 嵌套）→ 折掉 `.`/`..` 段（解出 `..` 之后要再折一轮，
 * Request 构造器只折过原始串那一轮）→ 拒绝残留物（畸形转义、解不干净的 `%`、反斜杠）。
 * 全部失败方向都是 **deny**。
 */
export function normalizePath(raw: string): string | null {
  if (!raw.startsWith('/')) return null
  let cur = raw
  try {
    for (let i = 0; i < MAX_DECODE_ROUNDS && cur.includes('%'); i++) {
      const next = decodeURIComponent(cur)
      if (next === cur) break
      cur = next
    }
  } catch {
    return null   // 畸形转义（如 `%zz`）⇒ 不可信
  }
  // 解完仍有 `%` ⇒ 要么畸形、要么嵌套超过 MAX_DECODE_ROUNDS —— 两种都不许猜
  if (cur.includes('%')) return null
  try {
    // WHATWG URL 的 remove_dot_segments（顺带把 `\` 当分隔符折掉，特殊 scheme 语义）
    const collapsed = new URL(cur, 'http://placeholder').pathname
    if (collapsed.includes('\\')) return null
    return collapsed
  } catch {
    return null
  }
}
