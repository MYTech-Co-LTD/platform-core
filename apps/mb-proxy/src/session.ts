// session.ts — 反代**自己的**第一方会话 Cookie（spec §3⑦ ②）。它**不是**平台会话：
// 平台会话 Cookie 不设 Domain（host-only），专用入口收不到；一次性 handoff 兑换后由这里发一枚
// 同名不同命的自有 Cookie，浏览器只跟专用入口说话。
export const EDIT_COOKIE = 'mb_edit'
export const EDIT_TTL_SEC = 28800

export function serializeEditCookie(token: string): string {
  return `${EDIT_COOKIE}=${token}; Path=/; Max-Age=${EDIT_TTL_SEC}; HttpOnly; Secure; SameSite=Lax`
}
export function clearEditCookie(): string {
  return `${EDIT_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`
}
