// health.ts — 通知健康判定（纯函数 + 查询；scripts/notify-health.mjs 只是 CLI 薄壳）。
import type { Pool } from 'pg'

export type Health = {
  dead: number
  stale: number
  workers: number
  oldestPendingSeconds: number
  failedLastHour: number
  channelErrors: number
  /** 最近 1 小时：配了规则却解析不出收件人的事件数（配置错误 ⇒ 直接判红） */
  eventsNoRecipients: number
  /** 最近 1 小时：有收件人但通道全停用的事件数（同上） */
  eventsNoChannel: number
  /** 最近 1 小时：事件声明或模板缺失（阈值判红，模板轮换期可能短暂出现） */
  eventsInvalid: number
}

/** 近 1 小时失败条数超过它 ⇒ 判不健康（与 dead/积压/心跳并列） */
export const FAILED_LAST_HOUR_LIMIT = 50

/** invalid 事件的容忍上限（模板轮换期会短暂出现，给一点余量） */
export const EVENTS_INVALID_LIMIT = 5

/** 1 = 不健康（有 dead / pending 超 10min / 无 worker 心跳 / 近 1 小时失败过多），0 = 干净 */
export function healthVerdict(h: Health): 0 | 1 {
  if (h.dead > 0 || h.stale > 0 || h.workers === 0) return 1
  if (h.failedLastHour > FAILED_LAST_HOUR_LIMIT) return 1
  // 零收件人 / 零通道是**配置错误**，不是流量波动 ⇒ 一个也算红（不给阈值）
  if (h.eventsNoRecipients > 0 || h.eventsNoChannel > 0) return 1
  if (h.eventsInvalid > EVENTS_INVALID_LIMIT) return 1
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
      (select count(*)::int from notify.channel where health like 'error%') as "channelErrors",
      (select count(*)::int from notify.event
        where status='no_recipients' and created_at > now()-interval '1 hour') as "eventsNoRecipients",
      (select count(*)::int from notify.event
        where status='no_channel' and created_at > now()-interval '1 hour') as "eventsNoChannel",
      (select count(*)::int from notify.event
        where status='invalid' and created_at > now()-interval '1 hour') as "eventsInvalid"`)
  return rows[0] as Health
}
