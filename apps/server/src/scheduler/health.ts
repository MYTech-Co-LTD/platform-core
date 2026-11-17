// health.ts — 调度健康面：**只读**三判据，把「该跑没跑」判成红。
//
// 判据：
//   ① 心跳：`job_heartbeat.id='scheduler'` 从未写入，或 beat_at 陈旧 > 2 分钟
//      （loop 每拍都 beat；心跳停 = 调度进程死了 / 被卡住）。
//   ② 该跑没跑：**任一** enabled 排班（system 与 agent 皆然），
//      「上次活动之后第一个该跑的时点」已过 2×expected_interval_secs 仍没有 ok run。
//      起点按「最近一次成功」算；**从未成功过**时退到「最后一次运行的 started_at（任何状态）」，
//      再没有运行就用 updated_at —— 这是给刚启用 / 首轮还没跑出结果的排班的宽限窗：
//      直接按 updated_at 判会让「刚启用」立刻变红，按最后一次任何状态的运行判则等到重试机会耗尽才红。
//      注意 `coalesce` 的**顺序即语义**：曾成功过的排班即使最近刚失败过一次，只要最后一次 ok 已超窗
//      仍然要红（那不是「从未成功过」，不给宽限）。
//      ⚠️ 时点必须由 **cron 算**（`nextRunAt(cron, timezone, ref)`），不能按墙钟 2×interval 判：
//      cron 有窗口（如 `data.dbt_tick` = UTC 1-15 点，避开北京时间 00:01–09:00 的空热 glob 窗口），
//      墙钟判法会把窗口外误判成漏跑 ⇒ worker 每天夜间恒 503 ⇒ openship 部署收尾被阻塞（#2417）。
//   ③ 连续失败：任意 enabled 排班**最近 3 次运行（不论状态）**全是 failed/timeout 才红。
//      `running`/`queued` 行会稀释连败——这是有意的（有在跑说明调度器活着），不要改成只看终态。
//      （不足 3 次也不判红——样本不够，先让 ② 的时窗判。）
//      ⚠️ **`data.dbt_audit*` 除外**：审计 exit 1 = 对账发现数据问题，不是调度故障；
//      计入会让既有数据红在 3 天后把 worker 判 503、阻断部署（2026-11-17 实测）。
//
// 本模块不写库、不依赖 loop.ts（健康检查在进程外跑也应当成立）。
import type { Pool } from 'pg'
import { nextRunAt } from './cron'

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

  // ② 该跑没跑（cron-aware）
  const candidates = await pool.query<{
    key: string
    cron: string
    timezone: string
    expected_interval_secs: number
    ref: Date
  }>(
    `select s.key, s.cron, s.timezone, s.expected_interval_secs,
            coalesce(
              (select max(r.started_at) from platform.job_run r
                where r.schedule_id = s.id and r.status = 'ok'),
              (select max(r.started_at) from platform.job_run r
                where r.schedule_id = s.id),
              s.updated_at
            ) as ref
       from platform.job_schedule s
      where s.enabled
      order by s.key`,
  )
  for (const r of candidates.rows) {
    let next: Date
    try {
      next = nextRunAt(r.cron, r.timezone, r.ref)
    } catch (e) {
      // cron 算不出下一次触发＝健康面不可观测 ⇒ fail-closed（不许静默放过）。
      reasons.push(
        `${r.key}：cron 算不出下一次触发（${r.cron} @ ${r.timezone}）：${(e as Error).message}`,
      )
      continue
    }
    if (now.getTime() - next.getTime() > 2 * r.expected_interval_secs * 1000) {
      reasons.push(
        `${r.key}：超过 2×期望间隔（${r.expected_interval_secs}s）没有成功运行`,
      )
    }
  }

  // ③ 连续失败（最近 3 次）
  // ⚠️ `data.dbt_audit*` 是**验证类**排班：exit 1 的语义是「对账发现数据问题」，不是「引擎坏了」。
  // 把它们计入健康会让「已知既有红」在 3 天后把 worker 判 503、阻断部署（2026-11-17 实测）。
  // 红仍通过 `jobs.job.failed` 通知 + jobs 控制台的 run 台账可见；健康只看执行面。
  const failing = await pool.query<{ key: string }>(
    `select s.key
       from platform.job_schedule s
      where s.enabled
        and s.key not like 'data.dbt_audit%'
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
