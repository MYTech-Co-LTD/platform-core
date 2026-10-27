// health.ts — 通知健康判定（纯函数 + 查询；scripts/notify-health.mjs 只是 CLI 薄壳）。
import type { Pool } from 'pg'

export type Health = {
  dead: number
  stale: number
  workers: number
  oldestPendingSeconds: number
  failedLastHour: number
  channelErrors: number
}

/** 近 1 小时失败条数超过它 ⇒ 判不健康（与 dead/积压/心跳并列） */
export const FAILED_LAST_HOUR_LIMIT = 50

/** 1 = 不健康（有 dead / pending 超 10min / 无 worker 心跳 / 近 1 小时失败过多），0 = 干净 */
export function healthVerdict(h: Health): 0 | 1 {
  if (h.dead > 0 || h.stale > 0 || h.workers === 0) return 1
  if (h.failedLastHour > FAILED_LAST_HOUR_LIMIT) return 1
  return 0
}

export async function checkHealth(pool: Pool): Promise<Health> {
  const { rows } = await pool.query(`
    select
      (select count(*)::int from notify.delivery where status='dead') as dead,
      (select count(*)::int from notify.delivery
        where status='pending' and created_at < now()-interval '10 minutes') as stale,
      (select count(*)::int from notify.worker_heartbeat
        where beat_at > now()-interval '2 minutes') as workers,
      (select coalesce(max(extract(epoch from now()-created_at)),0)::int from notify.delivery
        where status='pending') as "oldestPendingSeconds",
      (select count(*)::int from notify.delivery
        where status='failed' and updated_at > now()-interval '1 hour') as "failedLastHour",
      (select count(*)::int from notify.channel where health like 'error%') as "channelErrors"`)
  return rows[0] as Health
}
