// registry.ts — 系统 job 目录（代码）与幂等 seed。
//
// 目录在代码：新增 job 必须发版、经评审；排班状态在库：改时间/开关不用发版。
// seed 三条语义：① 只补新增 key，**不覆盖**人改过的 cron/enabled；
// ② `params` 恒 `{}`（source='system' 时 params 不生效，见 spec §3.6）；
// ③ enabled 行缺 next_run_at 时补算（补算 ≠ 立即执行）。
import type { Pool } from 'pg'
import { isValidCron, nextRunAt } from './cron'

export interface JobDef {
  key: string
  script: string
  cron: string
  timezone: string
  timeoutMs: number
  maxAttempts: number
  expectedIntervalSecs: number
  description: string
  /**
   * handler-only：只登记 handler 供 runner 按 key 查找，**不建系统排班行**。
   * 用于「没有系统排班、只在被 agent/console 排班调用时才存在」的 job（如 `notify.emit`）。
   * 这类条目的 cron/timezone 只是 JobDef 的 schema 占位，seed 不读、也不会落库。
   */
  noSystemSchedule?: boolean
}

/** P1 首迁三个系统 job。时区一律 UTC——与 openship 上现有 cron 的 UTC 语义逐字一致。 */
export const JOB_REGISTRY: JobDef[] = [
  { key: 'notify.reconcile', script: 'scripts/notify-reconcile.mjs', cron: '7 * * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 3600, description: '通知指派与催办对账' },
  { key: 'metric.candidates', script: 'scripts/metric-candidates-job.mjs', cron: '40 6 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 1, expectedIntervalSecs: 86400, description: '指标候选池生成' },
  { key: 'report.scope_scan', script: 'scripts/report-scope-scan.mjs', cron: '37 1 * * *', timezone: 'UTC', timeoutMs: 300000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '报表受众 × 指标可见性巡检' },
  // handler-only：排班由 agent/console 经 SchedulerPort 建（source≠'system'），seed 不建行。
  // cron/timezone 是 JobDef 必填字段的占位值（不会被 seed 使用），真实时间以排班行为准。
  { key: 'notify.emit', script: 'scripts/notify-emit-job.mjs', cron: '0 0 1 1 *', timezone: 'UTC', timeoutMs: 60000, maxAttempts: 2, expectedIntervalSecs: 86400, description: '周期消息：把一条事件入队（由 agent/console 建按其 cron 排班）', noSystemSchedule: true },
]

export async function seedSchedules(
  pool: Pool,
  registry: JobDef[] = JOB_REGISTRY,
  now: Date = new Date(),
): Promise<{ inserted: string[]; filled: string[] }> {
  for (const d of registry) {
    if (!isValidCron(d.cron)) throw new Error(`registry: ${d.key} 的 cron 非法（${d.cron}）`)
    if (!d.script.startsWith('scripts/')) throw new Error(`registry: ${d.key} 的 script 必须在 scripts/ 下`)
  }
  const inserted: string[] = []
  for (const d of registry) {
    // handler-only 条目只登记 handler（loop 按 key 查找用），不建系统排班行。
    if (d.noSystemSchedule) continue
    const { rowCount } = await pool.query(
      `insert into platform.job_schedule
         (key, cron, timezone, params, source, enabled, next_run_at, timeout_ms, max_attempts, expected_interval_secs)
       values ($1,$2,$3,'{}'::jsonb,'system',false,null,$4,$5,$6)
       on conflict (key) where source = 'system' do nothing`,
      [d.key, d.cron, d.timezone, d.timeoutMs, d.maxAttempts, d.expectedIntervalSecs],
    )
    if ((rowCount ?? 0) > 0) inserted.push(d.key)
  }
  const filled: string[] = []
  const { rows } = await pool.query(
    `select id, key, cron, timezone from platform.job_schedule
      where source='system' and enabled and next_run_at is null`,
  )
  for (const r of rows) {
    const { rowCount } = await pool.query('update platform.job_schedule set next_run_at=$2, updated_at=now() where id=$1 and next_run_at is null',
      [r.id, nextRunAt(String(r.cron), String(r.timezone), now)])
    // 并发下另一个 seed 可能已先补算 ⇒ rowCount=0，此时不算本进程“补过”。
    if ((rowCount ?? 0) > 0) filled.push(String(r.key))
  }
  return { inserted, filled }
}
