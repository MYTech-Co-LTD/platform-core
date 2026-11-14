// notify-delay.ts — 一次性延迟通知的时间归一（宿主端口与模块路由共用，避免两份校验漂移）。
//
// 边界：这里只处理**一次性延迟**（notify.event.available_at）。周期排班归
// platform.scheduler，不在这条路径上；超过窗口的“未来时间”应交给调度器。

/** 一次性延迟上限：30 天。超过它不是延迟，是排班。 */
export const MAX_NOTIFY_DELAY_MS = 30 * 24 * 60 * 60 * 1000

export type NormalizedAvailableAt =
  | { ok: true; value?: string }
  | { ok: false; reason: 'available_at_invalid' | 'available_at_too_far' }

/**
 * 归一化 `availableAt`：
 * - 缺省/空串 ⇒ 立即（value undefined）；
 * - 非法时间 ⇒ `available_at_invalid`；
 * - 超过 30 天 ⇒ `available_at_too_far`；
 * - 过去时间 ⇒ 立即（不保留无意义的过去值）。
 */
export function normalizeAvailableAt(raw: string | undefined): NormalizedAvailableAt {
  if (raw === undefined || raw === '') return { ok: true }
  const at = new Date(raw)
  if (Number.isNaN(at.getTime())) return { ok: false, reason: 'available_at_invalid' }
  const now = Date.now()
  if (at.getTime() > now + MAX_NOTIFY_DELAY_MS) return { ok: false, reason: 'available_at_too_far' }
  return { ok: true, value: at.getTime() <= now ? undefined : at.toISOString() }
}
