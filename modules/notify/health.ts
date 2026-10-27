// health.ts — 通知健康判定（纯函数 + 查询；scripts/notify-health.mjs 只是 CLI 薄壳）。
import type { Pool } from 'pg'

export type Health = { dead: number; stale: number; workers: number }

/** 1 = 不健康（有 dead / pending 超 10min / 无 worker 心跳），0 = 干净 */
export function healthVerdict(h: Health): 0 | 1 {
  return h.dead > 0 || h.stale > 0 || h.workers === 0 ? 1 : 0
}

export async function checkHealth(pool: Pool): Promise<Health> {
  const { rows } = await pool.query(`
    select
      (select count(*)::int from notify.delivery where status='dead') as dead,
      (select count(*)::int from notify.delivery
        where status='pending' and created_at < now()-interval '10 minutes') as stale,
      (select count(*)::int from notify.worker_heartbeat
        where beat_at > now()-interval '2 minutes') as workers`)
  return rows[0] as Health
}
