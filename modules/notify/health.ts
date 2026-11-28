// health.ts — 通知健康判定（纯函数 + 查询；scripts/notify-health.mjs 只是 CLI 薄壳）。
import type { Pool } from 'pg'

export type Health = {
  dead: number
  /** 其中「永久性失败」（重投永远不会成功：收件人 OpenID 无效 / 模板缺配）——**不参与判红** */
  deadPermanent: number
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

/**
 * `dead` 的统计窗口（天）。
 *
 * 为什么不是全表：`dead` 是**终态**，一旦产生就不会自愈。全表计数会让一条两周前的历史失败
 * 永久把健康面按红（shanhai 2026-10-31 的 4 条 81013 就是这样：删也不是、不删也不是）。
 * 健康面要回答的是「**现在**投得出去吗」，所以只看最近窗口；更早的历史属于审计，不属于健康。
 * 窗口外仍然积压的旧行由 retention job 清理（未部署时也不会误导健康面）。
 */
export const DEAD_WINDOW_DAYS = 7

/**
 * 「永久性失败」的识别式（`notify.delivery.last_error`）。
 *
 * 为什么要把 dead 拆成两类（2026-11-28）：`dead` 里混着两种完全不同的东西——
 *   · **可重试耗尽**（超时/5xx/限流打满）：说明「现在投不出去」，是健康面该报的；
 *   · **永久性失败**（`errcode 40003` 收件人 OpenID 无效、`模板未配置 template_id`、渠道判 permanent）：
 *     重投一万次也不会成功，它说的是**收件人数据/模板配置**有问题，不是投递能力有问题。
 * 混在一起判的后果是实测的：4 条永久失败把 health 按红 7 天（`DEAD_WINDOW_DAYS` 只是把红推迟，
 * 不是解决），一天 288 条 job_run 全红 ⇒ **告警疲劳**，真故障反而看不见。
 * ⇒ 永久性失败仍**逐次打印**（可见），但只有当它**成规模**（超此上限）才判红——那时是系统性配置问题。
 */
export const DEAD_PERMANENT_PATTERN = 'errcode (40003|40013|42001|43004|48001)|permanent error|模板未配置 template_id'

/** 永久性失败超过它 ⇒ 判红（单条/少量是数据问题，成规模才是系统性问题） */
export const DEAD_PERMANENT_LIMIT = 50

/** invalid 事件的容忍上限（模板轮换期会短暂出现，给一点余量） */
export const EVENTS_INVALID_LIMIT = 5

/** 1 = 不健康（窗口内有 dead / pending 超 10min / 无 worker 心跳 / 近 1 小时失败过多），0 = 干净 */
export function healthVerdict(h: Health): 0 | 1 {
  // 只看「可重试耗尽」那部分 dead：永久性失败（40003 / 模板缺配）单独按规模判，见 DEAD_PERMANENT_*。
  if (h.dead - h.deadPermanent > 0 || h.stale > 0 || h.workers === 0) return 1
  if (h.deadPermanent > DEAD_PERMANENT_LIMIT) return 1
  if (h.failedLastHour > FAILED_LAST_HOUR_LIMIT) return 1
  // 零收件人 / 零通道是**配置错误**，不是流量波动 ⇒ 一个也算红（不给阈值）
  if (h.eventsNoRecipients > 0 || h.eventsNoChannel > 0) return 1
  if (h.eventsInvalid > EVENTS_INVALID_LIMIT) return 1
  return 0
}

export async function checkHealth(pool: Pool): Promise<Health> {
  const { rows } = await pool.query(`-- org-exempt: 健康统计（运维视角）：跨租户聚合投递/事件/通道健康，通知 worker 是平台级进程
    select
      (select count(*)::int from notify.delivery
        where status='dead' and created_at > now()-(${DEAD_WINDOW_DAYS} || ' days')::interval) as dead,
      (select count(*)::int from notify.delivery
        where status='dead' and created_at > now()-(${DEAD_WINDOW_DAYS} || ' days')::interval
          and coalesce(last_error,'') ~ '${DEAD_PERMANENT_PATTERN}') as "deadPermanent",
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
