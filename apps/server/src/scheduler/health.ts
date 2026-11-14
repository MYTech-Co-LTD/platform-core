// health.ts — 调度健康面：**只读**三判据，把「该跑没跑」判成红。
//
// 判据：
//   ① 心跳：`job_heartbeat.id='scheduler'` 从未写入，或 beat_at 陈旧 > 2 分钟
//      （loop 每拍都 beat；心跳停 = 调度进程死了 / 被卡住）。
//   ② 该跑没跑：enabled 且 source='system' 的排班，超过 2×expected_interval_secs 没有 ok run。
//      起点按「最近一次成功」算；**从未成功过**时退到「最后一次运行的 started_at（任何状态）」，
//      再没有运行就用 updated_at —— 这是给刚启用 / 首轮还没跑出结果的排班的宽限窗：
//      直接按 updated_at 判会让「刚启用」立刻变红，按最后一次任何状态的运行判则等到重试机会耗尽才红。
//      注意 `coalesce` 的**顺序即语义**：曾成功过的排班即使最近刚失败过一次，只要最后一次 ok 已超窗
//      仍然要红（那不是「从未成功过」，不给宽限）。
//   ③ 连续失败：任意 enabled 排班最近 3 次 run 全是 failed/timeout。
//      （不足 3 次不判红——样本不够，先让 ② 的时窗判。）
//
// 本模块不写库、不依赖 loop.ts（健康检查在进程外跑也应当成立）。
import type { Pool } from 'pg'

export interface JobHealth {
  ok: boolean
  reasons: string[]
}

/** 心跳陈旧阈值：2 分钟。 */
const HEARTBEAT_STALE_MS = 120_000

export async function jobHealth(pool: Pool, now: Date): Promise<JobHealth> {
  const reasons: string[] = []

  // ① 心跳
  const hb = await pool.query<{ beat_at: Date | null }>(
    "select beat_at from platform.job_heartbeat where id='scheduler'",
  )
  const beatAt = hb.rows[0]?.beat_at ?? null
  if (!beatAt) {
    reasons.push('调度心跳从未写入（scheduler 心跳行不存在）')
  } else if (now.getTime() - beatAt.getTime() > HEARTBEAT_STALE_MS) {
    const secs = Math.round((now.getTime() - beatAt.getTime()) / 1000)
    reasons.push(`调度心跳陈旧：已 ${secs}s 未更新（阈值 ${HEARTBEAT_STALE_MS / 1000}s）`)
  }

  // ② 该跑没跑
  const overdue = await pool.query<{ key: string; expected_interval_secs: number }>(
    `select s.key, s.expected_interval_secs
       from platform.job_schedule s
      where s.enabled and s.source = 'system'
        and not exists (
          select 1 from platform.job_run r
           where r.schedule_id = s.id and r.status = 'ok'
             and r.started_at > $1::timestamptz - make_interval(secs => 2 * s.expected_interval_secs))
        and coalesce(
          (select max(r.started_at) from platform.job_run r
            where r.schedule_id = s.id and r.status = 'ok'),
          (select max(r.started_at) from platform.job_run r
            where r.schedule_id = s.id),
          s.updated_at
        ) < $1::timestamptz - make_interval(secs => 2 * s.expected_interval_secs)
      order by s.key`,
    [now],
  )
  for (const r of overdue.rows) {
    reasons.push(
      `${r.key}：超过 2×期望间隔（${r.expected_interval_secs}s）没有成功运行`,
    )
  }

  // ③ 连续失败（最近 3 次）
  const failing = await pool.query<{ key: string }>(
    `select s.key
       from platform.job_schedule s
      where s.enabled
        and (
          select count(*) from (
            select r.status from platform.job_run r
             where r.schedule_id = s.id
             order by r.started_at desc, r.id desc
             limit 3
          ) t where t.status in ('failed', 'timeout')
        ) >= 3
      order by s.key`,
  )
  for (const r of failing.rows) {
    reasons.push(`${r.key}：最近 3 次运行全部失败或超时`)
  }

  return { ok: reasons.length === 0, reasons }
}
