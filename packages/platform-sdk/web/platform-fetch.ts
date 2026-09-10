/**
 * platformFetch：模块用户端前端（web/console）唯一的 API 客户端。
 *
 * 约定（锁定，勿扩散参数）：
 * - 透传 globalThis.fetch，显式补 credentials: 'same-origin'（init 已带 credentials 时不覆盖），
 *   会话 cookie 依赖同源 fetch 默认携带这一行为；
 * - 响应 401 → 跳登录页（带上当前路由以便回跳），并抛 Error('UNAUTHENTICATED')；
 *   例外（Task 17 评审 fix-1）：当前已在 /login 页时 401 **原样返回 Response**——
 *   登录页自身就是 401 的合法生产者（账密登录失败 401 {error:'BAD_CREDENTIALS'} 等），
 *   若在此重定向会丢错误码且以 /login?next=/login 自旋重载，错误体交还调用方解析；
 * - 其余原样返回 Response，调用方自行 res.ok / res.status 分支。
 */
export async function platformFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await globalThis.fetch(input, { ...init, credentials: init?.credentials ?? 'same-origin' })
  if (res.status === 401 && !location.pathname.startsWith('/login')) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash)
    throw new Error('UNAUTHENTICATED')
  }
  return res
}
