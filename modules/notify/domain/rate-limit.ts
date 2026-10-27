// rate-limit.ts — 每通道限流判定（纯函数）。
// 计数在 storage（窗口内 status='sent' 行数）；本层只回答「放行 / 顺延多久」。
export function rateLimitVerdict(
  sentInWindow: number,
  limit: number,
  windowMs = 60_000,
): { allow: boolean; retryAfterMs: number } {
  if (!Number.isFinite(limit) || limit <= 0) return { allow: true, retryAfterMs: 0 }
  if (sentInWindow < limit) return { allow: true, retryAfterMs: 0 }
  return { allow: false, retryAfterMs: windowMs }
}
