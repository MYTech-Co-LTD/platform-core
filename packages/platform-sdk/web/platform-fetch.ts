/**
 * platformFetch：模块用户端前端（web/console）唯一的 API 客户端。
 *
 * 约定（锁定，勿扩散参数）：
 * - 透传 globalThis.fetch，显式补 credentials: 'same-origin'（init 已带 credentials 时不覆盖），
 *   会话 cookie 依赖同源 fetch 默认携带这一行为；
 * - 响应 401 → 跳登录页（带上当前路由以便回跳），并抛 Error('UNAUTHENTICATED')；
 * - 其余原样返回 Response，调用方自行 res.ok / res.status 分支。
 */
export async function platformFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await globalThis.fetch(input, { ...init, credentials: init?.credentials ?? 'same-origin' })
  if (res.status === 401) {
    location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash)
    throw new Error('UNAUTHENTICATED')
  }
  return res
}
